import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { getOpenAiCompatibleProviderName, type AiConnectionDraft, type AiOutputCapability } from "../../../shared/types/ai";
import type { PetDefinition } from "../../../shared/types/pet";
import type {
  PetPackageImportAiRequest,
  PetPackageImportAiModelsRequest,
  PetPackageImportAiModelsResult,
  PetPackageImportBeginResult,
  PetPackageImportCommitResult,
  PetPackageImportStepResult,
  PetPackageManifestV1,
  PortablePetDefinitionV1
} from "../../../shared/types/petPackage";
import type { VisionCapability } from "../../../shared/types/screen";
import { PET_PACKAGE_LIMITS, allocateImportedPetId, normalizePetPackageEntryPath, parsePetPackageManifest, parsePortablePetDefinition } from "../../../shared/validation/petPackage";
import { normalizeLegacyPetDefinition } from "../../../shared/validation/petDefinition";
import { deleteAiConnectionWhilePetConfigLocked, listAiModels, saveAiConnectionWhilePetConfigLocked, testAiOutputCapability } from "../ai/aiSettings";
import {
  clearChatVisionCapabilityWhilePetConfigLocked,
  saveChatVisionCapabilityWhilePetConfigLocked
} from "../screen/ScreenVisionConnectionStore";
import { testChatVisionDraft } from "../screen/ScreenVisionService";
import { writeJsonFileAtomically } from "../config/durableJsonFile";
import { assertNoPendingPetDeletion, getLocalPetsRootPath } from "../config/petConfigPersistence";
import { withPetConfigWriteLock } from "../config/petConfigWriteQueue";
import { listLocalPets, stopManagedGptSoVitsApi, validateReferenceAudioDuration } from "../config/petConfigStore";
import { validateVoiceModelResources } from "../speech/voiceResourceValidation";
import { validateLive2DFolder } from "../config/live2dImportService";
import { beginPetPackageOperation, finishPetPackageOperation, updatePetPackageProgress } from "./petPackageOperation";
import { validateIpcArguments } from "../../ipcValidation";
import { isAllowedLive2DPackagePath, selectLive2DDependencyFiles } from "./petPackageLive2d";
import { enumerateRegularFiles } from "./petPackagePaths";

interface ImportSession {
  id: string;
  ownerWebContentsId: number;
  stagingPath: string;
  markerPath: string;
  manifest: PetPackageManifestV1;
  portable: PortablePetDefinitionV1;
  candidatePetId: string;
  aiDraft?: Omit<AiConnectionDraft, "petId">;
  aiCapability?: AiOutputCapability;
  aiVisionCapability?: VisionCapability;
  voiceRoot?: string;
  operationId: string;
  signal: AbortSignal;
}

const sessions = new Map<string, ImportSession>();
const pendingOperationByOwner = new Map<number, string>();
const markerName = ".zmling-import.json";
const presetMimeExtension: Record<string, string> = { "audio/wav": ".wav", "audio/wave": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/ogg": ".ogg", "audio/aac": ".aac" };

async function assertStagedFile(stagingPath: string, relativePath: string): Promise<void> {
  const target = path.resolve(stagingPath, ...relativePath.split("/"));
  const relative = path.relative(stagingPath, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("便携配置资源引用越界。");
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("便携配置引用的资源无效。");
  const [realRoot, realTarget] = await Promise.all([fs.realpath(stagingPath), fs.realpath(target)]);
  const realRelative = path.relative(realRoot, realTarget);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("便携配置资源 realpath 越界。");
}

function collectPresetAudio(pet: PetDefinition): Array<{ resourceId: string; mimeType: string }> {
  const result = new Map<string, { resourceId: string; mimeType: string }>();
  const add = (line: unknown): void => {
    if (!line || typeof line !== "object" || !("presetAudio" in line)) return;
    const audio = (line as { presetAudio?: { resourceId: string; mimeType: string } }).presetAudio;
    if (audio) result.set(`${audio.resourceId}:${audio.mimeType}`, audio);
  };
  Object.values(pet.lines ?? {}).forEach((lines) => lines?.forEach(add));
  Object.values(pet.moodSettings?.ranges ?? {}).forEach((range) => add(range?.enterLine));
  return [...result.values()];
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(filePath, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error ?? new Error("无法读取桌宠包。")) : resolve(zip)));
}

function listEntries(zip: ZipFile, signal: AbortSignal): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    const fail = (error: unknown): void => { zip.close(); reject(error); };
    zip.on("entry", (entry: Entry) => {
      try {
        signal.throwIfAborted();
        entries.push(entry);
        if (entries.length > PET_PACKAGE_LIMITS.maxEntries + 1) throw new Error("桌宠包文件数量超出限制。");
        zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.once("end", () => resolve(entries));
    zip.once("error", fail);
    zip.readEntry();
  });
}

function readEntryBuffer(zip: ZipFile, entry: Entry, maximumBytes: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) { reject(error ?? new Error("无法读取桌宠包文件。")); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      const abort = (): void => { stream.destroy(Object.assign(new Error("操作已取消。"), { name: "AbortError" })); };
      signal.addEventListener("abort", abort, { once: true });
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumBytes) stream.destroy(new Error("桌宠包元数据超出限制。"));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => { signal.removeEventListener("abort", abort); resolve(Buffer.concat(chunks)); });
    });
  });
}

function isSpecialZipEntry(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  return fileType !== 0 && fileType !== 0o100000;
}

async function extractEntry(zip: ZipFile, entry: Entry, targetPath: string, expectedSize: number, expectedHash: string, signal: AbortSignal, onBytes: (count: number) => void): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, value) => error || !value ? reject(error ?? new Error("无法解压文件。")) : resolve(value)));
  const output = fsSync.createWriteStream(targetPath, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let size = 0;
  const abort = (): void => { (stream as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy(Object.assign(new Error("操作已取消。"), { name: "AbortError" })); output.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > expectedSize || size > PET_PACKAGE_LIMITS.maxEntryBytes) {
          (stream as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy(new Error("桌宠包文件大小与清单不符。"));
          return;
        }
        hash.update(chunk);
        onBytes(chunk.length);
      });
      stream.once("error", reject);
      output.once("error", reject);
      output.once("close", resolve);
      stream.pipe(output);
    });
    if (size !== expectedSize || hash.digest("hex") !== expectedHash) throw new Error("桌宠包文件校验失败。");
    const handle = await fs.open(targetPath, "r+");
    await handle.sync();
    await handle.close();
  } finally { signal.removeEventListener("abort", abort); }
}

async function allocateCandidateId(manifest: PetPackageManifestV1): Promise<string> {
  const occupied = new Set((await listLocalPets()).map((pet) => pet.id.toLocaleLowerCase("en-US")));
  return allocateImportedPetId(manifest.pet.originalPetId, manifest.pet.name, occupied);
}

export async function beginPetPackageImport(packagePath: string, ownerWebContentsId: number): Promise<PetPackageImportBeginResult> {
  const operation = beginPetPackageOperation("import");
  pendingOperationByOwner.set(ownerWebContentsId, operation.operationId);
  const sessionId = randomUUID();
  const petsRoot = getLocalPetsRootPath();
  const stagingPath = path.join(petsRoot, `.importing-${sessionId}`);
  const markerPath = path.join(stagingPath, markerName);
  let processed = 0;
  let zip: ZipFile | undefined;
  try {
    const archiveStat = await fs.stat(packagePath);
    if (!archiveStat.isFile() || archiveStat.size > PET_PACKAGE_LIMITS.maxArchiveBytes) throw new Error("桌宠包大小超出限制。");
    const magicHandle = await fs.open(packagePath, "r");
    const magic = Buffer.alloc(4);
    await magicHandle.read(magic, 0, 4, 0);
    await magicHandle.close();
    if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error("选择的文件不是有效桌宠包。");
    await fs.mkdir(petsRoot, { recursive: true });
    await fs.mkdir(stagingPath, { recursive: false });
    await writeJsonFileAtomically(markerPath, { kind: "zmling-import-staging", sessionId });
    zip = await openZip(packagePath);
    const entries = await listEntries(zip, operation.signal);
    const names = new Map<string, Entry>();
    for (const entry of entries) {
      const name = normalizePetPackageEntryPath(entry.fileName);
      if (entry.fileName.endsWith("/") || isSpecialZipEntry(entry)) throw new Error("桌宠包包含链接、目录或特殊文件。");
      const folded = name.toLocaleLowerCase("en-US");
      if (names.has(folded)) throw new Error("桌宠包包含重复或大小写冲突路径。");
      if (entry.uncompressedSize > PET_PACKAGE_LIMITS.maxEntryBytes || (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > PET_PACKAGE_LIMITS.maxCompressionRatio)) throw new Error("桌宠包文件大小或压缩比超出限制。");
      names.set(folded, entry);
    }
    const manifestEntry = names.get("manifest.json");
    if (!manifestEntry) throw new Error("桌宠包缺少 manifest.json。");
    const manifest = parsePetPackageManifest(JSON.parse((await readEntryBuffer(zip, manifestEntry, PET_PACKAGE_LIMITS.maxManifestBytes, operation.signal)).toString("utf8")));
    const expectedNames = new Set(["manifest.json", ...manifest.entries.map((item) => item.path.toLocaleLowerCase("en-US"))]);
    if (names.size !== expectedNames.size || [...names.keys()].some((name) => !expectedNames.has(name))) throw new Error("桌宠包包含清单之外的文件。");
    const total = manifest.entries.reduce((sum, item) => sum + item.size, 0);
    updatePetPackageProgress(operation.operationId, "import", "extract", 0, total, true);
    for (const item of manifest.entries) {
      const entry = names.get(item.path.toLocaleLowerCase("en-US"));
      if (!entry || entry.uncompressedSize !== item.size) throw new Error("桌宠包清单与实际文件不一致。");
      const targetPath = path.resolve(stagingPath, ...item.path.split("/"));
      const relative = path.relative(stagingPath, targetPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("桌宠包解压路径越界。");
      await extractEntry(zip, entry, targetPath, item.size, item.sha256, operation.signal, (count) => {
        processed += count;
        updatePetPackageProgress(operation.operationId, "import", "extract", processed, total, true);
      });
    }
    zip.close();
    zip = undefined;
    updatePetPackageProgress(operation.operationId, "import", "validate", processed, total, true);
    const petContent = await fs.readFile(path.join(stagingPath, "pet.json"), "utf8");
    if (Buffer.byteLength(petContent) > PET_PACKAGE_LIMITS.maxPetJsonBytes) throw new Error("pet.json 超出限制。");
    const portable = parsePortablePetDefinition(JSON.parse(petContent));
    if (portable.uiSettings) {
      validateIpcArguments("pet-config:save-ui-settings", [{ petId: "package", ...portable.uiSettings }]);
    }
    const { schemaVersion: _portableSchema, live2dEntry: _portableEntry, voiceModelSettings: _portableVoice, ...portableConfig } = portable;
    const normalizedPortablePet = normalizeLegacyPetDefinition({
      ...portableConfig,
      id: "package",
      modelPath: "",
      voiceModelSettings: portable.voiceModelSettings,
      isLocal: true
    } as PetDefinition);
    if (portable.avatar) await assertStagedFile(stagingPath, portable.avatar);
    for (const [rangeId, range] of Object.entries(normalizedPortablePet.moodSettings?.ranges ?? {})) {
      const reference = range?.voiceOverride?.referenceAudio;
      if (!reference) continue;
      if (path.basename(reference) !== reference || reference.includes("\0")) throw new Error("心情语音资源引用无效。");
      await assertStagedFile(stagingPath, `voice/mood/${rangeId}/${reference}`);
    }
    for (const audio of collectPresetAudio(normalizedPortablePet)) {
      const extension = presetMimeExtension[audio.mimeType.split(";", 1)[0].toLowerCase()];
      if (!extension) throw new Error("预设语音格式无效。");
      await assertStagedFile(stagingPath, `voice/presets/${audio.resourceId}${extension}`);
    }
    const live2dScan = await validateLive2DFolder(path.join(stagingPath, "live2d"));
    if (!live2dScan.ok || `live2d/${live2dScan.entryRelativePath}` !== portable.live2dEntry) throw new Error("包内 Live2D 入口或依赖无效。");
    const live2dEntries = manifest.entries.filter((item) => item.path.startsWith("live2d/"));
    if (live2dEntries.some((item) => !isAllowedLive2DPackagePath(item.path))) throw new Error("桌宠包包含不允许的 Live2D 文件类型。");
    const stagedLive2dRoot = path.join(stagingPath, "live2d");
    const allLive2dFiles = await enumerateRegularFiles(stagedLive2dRoot, "live2d", operation.signal);
    const selectedLive2dFiles = await selectLive2DDependencyFiles({ rootPath: stagedLive2dRoot, entryRelativePath: live2dScan.entryRelativePath!, allFiles: allLive2dFiles, fallbackRelativePaths: live2dScan.checks.flatMap((check) => check.files) });
    const selectedPaths = new Set(selectedLive2dFiles.map((file) => file.archivePath.toLocaleLowerCase("en-US")));
    if (live2dEntries.some((item) => !selectedPaths.has(item.path.toLocaleLowerCase("en-US")))) throw new Error("桌宠包包含未被模型引用的 Live2D 文件。");
    const voice = portable.voiceModelSettings;
    if (manifest.requirements.gptSoVits !== Boolean(voice?.sovitsModel && voice.gptModel && voice.referenceAudio)) throw new Error("桌宠包语音 requirement 与资源不一致。");
    if (manifest.requirements.gptSoVits) {
      if (!voice!.sovitsModel!.toLowerCase().endsWith(".pth") || !voice!.gptModel!.toLowerCase().endsWith(".ckpt") || !/[.](wav|mp3|flac|ogg|m4a)$/i.test(voice!.referenceAudio!)) throw new Error("包内语音资源类型无效。");
      await validateReferenceAudioDuration(path.join(stagingPath, ...voice!.referenceAudio!.split("/")));
    }
    const candidatePetId = await allocateCandidateId(manifest);
    const session: ImportSession = { id: sessionId, ownerWebContentsId, stagingPath, markerPath, manifest, portable, candidatePetId, operationId: operation.operationId, signal: operation.signal };
    sessions.set(sessionId, session);
    pendingOperationByOwner.delete(ownerWebContentsId);
    let avatarDataUrl: string | undefined;
    if (portable.avatar?.startsWith("assets/")) {
      const avatarPath = path.join(stagingPath, ...portable.avatar.split("/"));
      const stat = await fs.stat(avatarPath);
      if (stat.size <= 2 * 1024 * 1024) {
        const extension = path.extname(avatarPath).slice(1).toLowerCase();
        if (["png", "jpg", "jpeg", "webp"].includes(extension)) avatarDataUrl = `data:image/${extension === "jpg" ? "jpeg" : extension};base64,${(await fs.readFile(avatarPath)).toString("base64")}`;
      }
    }
    updatePetPackageProgress(operation.operationId, "import", "validate", total, total, true);
    return { ok: true, message: "桌宠包检查完成。", sessionId, packageName: path.basename(packagePath), petName: portable.name, avatarDataUrl, requirements: manifest.requirements, contents: { live2d: true, avatar: Boolean(portable.avatar), voice: manifest.entries.some((item) => item.path.startsWith("voice/")), customTheme: Boolean(portable.uiSettings?.customTheme) } };
  } catch (error) {
    zip?.close();
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    const canceled = operation.signal.aborted || (error as Error).name === "AbortError";
    updatePetPackageProgress(operation.operationId, "import", canceled ? "canceled" : "failed", processed, Math.max(processed, 1), false, canceled ? "canceled" : "failed", canceled ? "CANCELED" : "IMPORT_INVALID");
    finishPetPackageOperation(operation.operationId);
    pendingOperationByOwner.delete(ownerWebContentsId);
    return { ok: false, canceled, message: canceled ? "已取消导入。" : error instanceof Error ? error.message : "桌宠包检查失败。" };
  }
}

function getOwnedSession(sessionId: string, ownerWebContentsId: number): ImportSession {
  const session = sessions.get(sessionId);
  if (!session || session.ownerWebContentsId !== ownerWebContentsId) throw new Error("导入会话不存在或已失效。");
  return session;
}

export async function testPetPackageImportAi(request: PetPackageImportAiRequest, ownerWebContentsId: number): Promise<PetPackageImportStepResult> {
  const session = getOwnedSession(request.sessionId, ownerWebContentsId);
  if (!session.manifest.requirements.ai) throw new Error("此桌宠包不需要 AI 配置。");
  session.aiDraft = undefined;
  session.aiCapability = undefined;
  session.aiVisionCapability = undefined;
  const draft = {
    ...request.draft,
    petId: session.candidatePetId,
    providerName: getOpenAiCompatibleProviderName(request.draft.baseUrl)
  };
  updatePetPackageProgress(session.operationId, "import", "test-ai", 0, 0, true);
  const models = await listAiModels(draft, session.signal);
  if (!models.ok) return { ok: false, message: models.message };
  if (!models.models.some((model) => model.id === draft.model)) return { ok: false, message: "所选模型不在服务返回的模型列表中。" };
  const testedDraft = { ...draft, models: models.models };
  const result = await testAiOutputCapability(testedDraft, session.signal);
  if (!result.ok) return { ok: false, message: result.message };

  const vision = await testChatVisionDraft(testedDraft, session.signal);
  if (!vision.ok) return { ok: false, message: vision.message };
  if (!result.capability || !vision.capability) return { ok: false, message: "AI 能力测试没有返回完整结果。" };

  const { petId: _petId, ...portableDraft } = testedDraft;
  session.aiDraft = portableDraft;
  session.aiCapability = result.capability;
  session.aiVisionCapability = vision.capability;
  return { ok: true, message: `${result.message} ${vision.message}` };
}

export async function listPetPackageImportAiModels(request: PetPackageImportAiModelsRequest, ownerWebContentsId: number): Promise<PetPackageImportAiModelsResult> {
  const session = getOwnedSession(request.sessionId, ownerWebContentsId);
  if (!session.manifest.requirements.ai) throw new Error("此桌宠包不需要 AI 配置。");
  const providerName = getOpenAiCompatibleProviderName(request.baseUrl);
  updatePetPackageProgress(session.operationId, "import", "test-ai", 0, 0, true);
  const result = await listAiModels({
    petId: session.candidatePetId,
    providerName,
    baseUrl: request.baseUrl,
    apiKey: request.apiKey,
    model: ""
  }, session.signal);
  return { ...result, providerName };
}

function materializePet(session: ImportSession): PetDefinition {
  const { schemaVersion: _schema, live2dEntry, avatar: portableAvatar, voiceModelSettings, ...portable } = session.portable;
  const id = session.candidatePetId;
  const voice = voiceModelSettings ? {
    ...voiceModelSettings,
    connected: false,
    gptSoVitsRootPath: session.voiceRoot,
    sovitsModelPath: voiceModelSettings.sovitsModel ? path.join(session.stagingPath, ...voiceModelSettings.sovitsModel.split("/")) : undefined,
    gptModelPath: voiceModelSettings.gptModel ? path.join(session.stagingPath, ...voiceModelSettings.gptModel.split("/")) : undefined,
    referenceAudioPath: voiceModelSettings.referenceAudio ? path.join(session.stagingPath, ...voiceModelSettings.referenceAudio.split("/")) : undefined
  } : undefined;
  if (voice) { delete voice.sovitsModel; delete voice.gptModel; delete voice.referenceAudio; }
  return normalizeLegacyPetDefinition({
    ...portable,
    id,
    modelPath: `pet-resource://local/${encodeURIComponent(id)}/live2d/${live2dEntry.slice("live2d/".length).split("/").map(encodeURIComponent).join("/")}`,
    avatarImage: portableAvatar ? `pet-resource://local/${encodeURIComponent(id)}/${portableAvatar.split("/").map(encodeURIComponent).join("/")}` : undefined,
    voiceModelSettings: voice,
    isLocal: true
  } as PetDefinition);
}

export async function testPetPackageImportVoice(sessionId: string, gptSoVitsRootPath: string, ownerWebContentsId: number): Promise<PetPackageImportStepResult> {
  const session = getOwnedSession(sessionId, ownerWebContentsId);
  if (!session.manifest.requirements.gptSoVits) throw new Error("此桌宠包不需要语音配置。");
  const voiceRoot = gptSoVitsRootPath.trim();
  updatePetPackageProgress(session.operationId, "import", "test-voice", 0, 0, true);
  try {
    await validateVoiceModelResources({
      ...materializePet(session).voiceModelSettings,
      gptSoVitsRootPath: voiceRoot
    });
    session.voiceRoot = voiceRoot;
    return { ok: true, message: "GPT-SoVITS 完整目录检测通过。" };
  } catch (error) {
    session.voiceRoot = undefined;
    return { ok: false, message: error instanceof Error ? error.message : "GPT-SoVITS 目录检测失败。" };
  }
}

export async function commitPetPackageImport(sessionId: string, ownerWebContentsId: number): Promise<PetPackageImportCommitResult> {
  const session = getOwnedSession(sessionId, ownerWebContentsId);
  if (session.manifest.requirements.ai && (!session.aiDraft || !session.aiCapability || !session.aiVisionCapability)) return { ok: false, message: "请先完成 AI 和视觉能力检测。" };
  if (session.manifest.requirements.gptSoVits && !session.voiceRoot) return { ok: false, message: "请先完成 GPT-SoVITS 完整目录检测。" };
  updatePetPackageProgress(session.operationId, "import", "commit", 0, 0, false);
  try {
    const result = await withPetConfigWriteLock(session.candidatePetId, async () => {
      const occupied = new Set((await listLocalPets()).map((pet) => pet.id.toLocaleLowerCase("en-US")));
      if (occupied.has(session.candidatePetId.toLocaleLowerCase("en-US"))) throw new Error("桌宠 ID 已被占用，请重新导入。");
      await assertNoPendingPetDeletion(session.candidatePetId);
      let pet = materializePet(session);
      const finalDirectory = path.join(getLocalPetsRootPath(), session.candidatePetId);
      pet = {
        ...pet,
        voiceModelSettings: pet.voiceModelSettings ? {
          ...pet.voiceModelSettings,
          sovitsModelPath: pet.voiceModelSettings.sovitsModelPath?.replace(session.stagingPath, finalDirectory),
          gptModelPath: pet.voiceModelSettings.gptModelPath?.replace(session.stagingPath, finalDirectory),
          referenceAudioPath: pet.voiceModelSettings.referenceAudioPath?.replace(session.stagingPath, finalDirectory)
        } : undefined
      };
      await fs.rm(path.join(session.stagingPath, "pet.json"), { force: true });
      await fs.rm(session.markerPath, { force: true });
      await writeJsonFileAtomically(path.join(session.stagingPath, "pet.local.json"), pet);
      await fs.rename(session.stagingPath, finalDirectory);
      try {
        if (session.aiDraft) {
          const saved = await saveAiConnectionWhilePetConfigLocked(
            { ...session.aiDraft, petId: pet.id },
            {
              models: session.aiDraft.models ?? [],
              outputCapability: session.aiCapability!,
              checkedAt: session.aiCapability!.checkedAt
            }
          );
          if (!saved.test.ok) throw new Error(saved.test.message);
          await saveChatVisionCapabilityWhilePetConfigLocked(pet.id, session.aiVisionCapability!);
        }
      } catch (error) {
        if (session.aiVisionCapability) await clearChatVisionCapabilityWhilePetConfigLocked(pet.id).catch(() => undefined);
        await deleteAiConnectionWhilePetConfigLocked(pet.id).catch(() => undefined);
        await fs.rename(finalDirectory, session.stagingPath).catch(() => undefined);
        await writeJsonFileAtomically(session.markerPath, { kind: "zmling-import-staging", sessionId: session.id }).catch(() => undefined);
        throw error;
      }
      return pet;
    });
    sessions.delete(sessionId);
    updatePetPackageProgress(session.operationId, "import", "complete", 1, 1, false, "success");
    finishPetPackageOperation(session.operationId);
    return { ok: true, message: "桌宠已安装。", pet: result };
  } catch (error) {
    updatePetPackageProgress(session.operationId, "import", "failed", 0, 1, false, "failed", "COMMIT_FAILED");
    return { ok: false, message: error instanceof Error ? error.message : "安装失败。" };
  }
}

export async function cancelPetPackageImport(sessionId: string | undefined, ownerWebContentsId: number): Promise<PetPackageImportStepResult> {
  if (!sessionId) {
    const operationId = pendingOperationByOwner.get(ownerWebContentsId);
    if (operationId) {
      pendingOperationByOwner.delete(ownerWebContentsId);
      const { cancelPetPackageOperation } = await import("./petPackageOperation");
      cancelPetPackageOperation(operationId);
    }
    return { ok: true, message: "已取消。" };
  }
  const session = getOwnedSession(sessionId, ownerWebContentsId);
  sessions.delete(sessionId);
  const { cancelPetPackageOperation } = await import("./petPackageOperation");
  cancelPetPackageOperation(session.operationId);
  stopManagedGptSoVitsApi();
  await fs.rm(session.stagingPath, { recursive: true, force: true });
  updatePetPackageProgress(session.operationId, "import", "canceled", 0, 1, false, "canceled", "CANCELED");
  finishPetPackageOperation(session.operationId);
  return { ok: true, message: "已取消导入。" };
}

export async function cleanupInterruptedPetPackageImports(): Promise<void> {
  const petsRoot = getLocalPetsRootPath();
  let entries: fsSync.Dirent[];
  try { entries = await fs.readdir(petsRoot, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\.importing-[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const directory = path.join(petsRoot, entry.name);
    try {
      const marker = JSON.parse(await fs.readFile(path.join(directory, markerName), "utf8")) as Record<string, unknown>;
      if (marker.kind === "zmling-import-staging" && typeof marker.sessionId === "string" && entry.name === `.importing-${marker.sessionId}`) await fs.rm(directory, { recursive: true, force: true });
    } catch { /* Unknown staging is deliberately preserved. */ }
  }
}

export async function shutdownPetPackageImports(): Promise<void> {
  const active = [...sessions.values()];
  sessions.clear();
  pendingOperationByOwner.clear();
  await Promise.all(active.map((session) => fs.rm(session.stagingPath, { recursive: true, force: true }).catch(() => undefined)));
}
