import { app, dialog } from "electron";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  LocalPetAvatarImportResult,
  LocalPetBasicInfoDraft,
  LocalPetDeleteResult,
  LocalPetScreenAwarenessDraft,
  LocalPetAvatarCropSaveRequest,
  LocalPetEventSettingsDraft,
  PetMoodSettings,
  LocalPetExpressionMappingDraft,
  LocalPetPersonaDraft,
  LocalPetUiSettingsDraft,
  LocalPetVoiceInputDraft,
  LocalPetVoiceModelConnectionResult,
  LocalPetVoiceModelDraft,
  LocalPetVoiceModelFilePickResult,
  LocalPetVoiceResourceKind,
  LocalPetSaveResult,
  PetCustomTheme,
  PetCustomThemeImportResult,
  PetCustomThemeMoodRangeStyle,
  PetCustomThemeRadialMenu,
  PetCustomThemeRadialMenuAction,
  PetCustomThemeTokens,
  PetChatDecorations,
  PetDefinition,
  PetDesktopPosition,
  PetEventSettingsMap,
  PetFeature,
  PetLine,
  PetLineMap,
  PetPresetAudio,
  PetVoiceModelVersion
} from "../../../shared/types/pet";
import type { PresetVoiceTarget } from "../../../shared/types/presetVoice";
import { petMoodRanges } from "../../../shared/mood";
import {
  petChatDecorationIcons,
  petChatDecorationSlots,
  petRadialMenuActionKinds
} from "../../../shared/types/pet";
import type { MemorySettings } from "../../../shared/types/memory";
import { normalizeMemorySettings } from "../../../shared/validation/memory";
import { normalizeLegacyPetDefinition, normalizePetMoodSettings } from "../../../shared/validation/petDefinition";
import type { LocalPetMoodSettingsDraft, PetMoodVoiceImportRequest, PetMoodVoiceImportResult, PetMoodVoiceRemoveRequest } from "../../../shared/types/mood";
import { getMoodVoiceRangePath, getMoodVoiceRootPath } from "../mood/moodPaths";
import {
  normalizePetDesktopPosition,
  normalizePetDesktopScale
} from "../../../shared/validation/petUiSettings";
import { isPetVoiceModelVersion } from "../../../shared/validation/petVoiceModel";
import { petResourceProtocol, toPetResourceUrl } from "./petResourceProtocol";
import { validateLive2DFolder } from "./live2dImportService";
import { resolveLegacyVoiceModelPaths } from "./legacyVoiceModelPath";
import {
  testTextToSpeechConnection,
  warmUpTextToSpeech
} from "../speech/textToSpeech";
import {
  ensureGptSoVitsEndpoint,
  resetGptSoVitsRuntimeEndpoints
} from "../speech/gptSoVitsRuntime";
import { hashPresetVoiceText } from "../presetVoice/presetVoiceFingerprint";
import { removePresetVoiceAudio } from "../presetVoice/presetVoiceStorage";
import {
  sanitizeVoiceDiagnosticText,
  validateReadableVoiceFile,
  validateVoiceModelResources
} from "../speech/voiceResourceValidation";
import { deletePetSecrets, getSecureString, setSecureString } from "./secureConfigStore";
import { UnsupportedConfigVersionError } from "../../../shared/validation/configVersion";
import {
  writeBufferFileAtomically,
  writeJsonFileAtomically,
  syncParentDirectory,
  writeTextFileAtomically
} from "./durableJsonFile";
import { withPetConfigWriteLock } from "./petConfigWriteQueue";
import {
  assertPathContained,
  assertExistingLocalPetDirectoryContained,
  ensureSafeLocalPetDirectory as ensureSafePetDirectory,
  ensureSafeLocalPetSubdirectory as ensureSafePetSubdirectory,
  getLocalPetConfigPath as getPetConfigPath,
  getLocalPetDirectoryPath as getPetDirectoryPath,
  getLocalPetsRootPath as getPetsRootPath,
  getPetIdFromDeletionDirectory,
  isStoredPetDefinitionForId as isStoredPetDefinition,
  readValidPetConfigBackup,
  restorePetConfigBackupAtomically,
  writePetConfigFileAtomically as writePetConfigUnlocked
} from "./petConfigPersistence";
import {
  MAX_PET_ID_LENGTH,
  assertValidPetId,
  isValidPetId
} from "../../../shared/validation/petId";

const live2dDirectoryName = "live2d";
const avatarDraftPetIdPattern = /^draft-[a-z0-9]+$/;
const avatarDraftFileNamePattern = /^avatar(?:-[A-Za-z0-9-]+)?\.(?:png|jpe?g|webp)$/i;
const themeIdPattern = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
const builtInThemeIds = new Set(["soft", "rock", "pixel", "journal", "cyber", "minimal", "custom"]);
const expressionMappingKeyPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const allowedAvatarExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const defaultVoiceInferenceDevice = "auto" as const;
const defaultVoiceHalfPrecision = true;
const minReferenceAudioDurationSeconds = 3;
const maxReferenceAudioDurationSeconds = 10;
const referenceAudioDurationProbeTimeoutMs = 10_000;
const minVoiceInputSilenceSeconds = 0.4;
const maxVoiceInputSilenceSeconds = 2;
const defaultVoiceInputSilenceSeconds = 1;
const tencentAsrSecretScope = "tencent-asr";
const managedGptSoVitsProcesses = new Map<string, ChildProcess>();
let voiceConnectionQueue: Promise<void> = Promise.resolve();
let petIdAllocationQueue: Promise<void> = Promise.resolve();
const avatarMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

interface TencentAsrCredentials {
  appId: string;
  secretId: string;
  secretKey: string;
}

interface VoiceCredentialMigrationResult {
  pet: PetDefinition;
  blocked: boolean;
}

function isReferenceAudioDurationAllowed(durationSeconds: number): boolean {
  return (
    Number.isFinite(durationSeconds) &&
    durationSeconds >= minReferenceAudioDurationSeconds &&
    durationSeconds <= maxReferenceAudioDurationSeconds
  );
}

async function readReferenceAudioDurationSeconds(filePath: string): Promise<number> {
  await validateReadableVoiceFile(filePath, "referenceAudio");

  const probeScript = [
    "$ErrorActionPreference = 'Stop'",
    "$audioPath = $env:ZHUOMIANLING_REFERENCE_AUDIO_PATH",
    "$shell = New-Object -ComObject Shell.Application",
    "$folder = $shell.Namespace([System.IO.Path]::GetDirectoryName($audioPath))",
    "$item = $folder.ParseName([System.IO.Path]::GetFileName($audioPath))",
    "$duration = $item.ExtendedProperty('System.Media.Duration')",
    "if ($null -eq $duration) { throw '未读取到音频时长。' }",
    "[Console]::Out.WriteLine((([double]$duration / 10000000).ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)))"
  ].join("; ");

  return await new Promise<number>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", probeScript],
      {
        timeout: referenceAudioDurationProbeTimeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          ZHUOMIANLING_REFERENCE_AUDIO_PATH: filePath
        }
      },
      (error, stdout) => {
        const durationSeconds = Number.parseFloat(stdout.trim());

        if (error || !Number.isFinite(durationSeconds)) {
          reject(new Error("无法读取参考音频时长，请使用系统可播放的本地音频文件。"));
          return;
        }

        resolve(durationSeconds);
      }
    );
  });
}

export async function validateReferenceAudioDuration(filePath: string): Promise<void> {
  let durationSeconds: number;

  try {
    durationSeconds = await readReferenceAudioDurationSeconds(filePath);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "无法读取参考音频时长，请重新选择文件。"
    );
  }

  if (!isReferenceAudioDurationAllowed(durationSeconds)) {
    throw new Error(
      `参考音频时长为 ${durationSeconds.toFixed(1)} 秒，必须在 ${minReferenceAudioDurationSeconds}-${maxReferenceAudioDurationSeconds} 秒之间。`
    );
  }
}

class VoiceCredentialMigrationBlockedError extends Error {
  constructor() {
    super("旧版腾讯云语音凭据尚未安全迁移，本次修改已取消，请确认系统安全存储可用后重试。");
    this.name = "VoiceCredentialMigrationBlockedError";
  }
}

type LegacyVoiceInputSettings = NonNullable<PetDefinition["voiceInputSettings"]> & {
  appId?: unknown;
  secretId?: unknown;
  secretKey?: unknown;
};

function parseTencentAsrCredentials(value: string | undefined): TencentAsrCredentials | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<TencentAsrCredentials>;
    const appId = typeof parsed.appId === "string" ? parsed.appId.trim() : "";
    const secretId = typeof parsed.secretId === "string" ? parsed.secretId.trim() : "";
    const secretKey = typeof parsed.secretKey === "string" ? parsed.secretKey.trim() : "";

    return appId && secretId && secretKey ? { appId, secretId, secretKey } : undefined;
  } catch {
    return undefined;
  }
}

function areTencentAsrCredentialsEqual(
  left: TencentAsrCredentials | undefined,
  right: TencentAsrCredentials
): boolean {
  return Boolean(
    left &&
      left.appId === right.appId &&
      left.secretId === right.secretId &&
      left.secretKey === right.secretKey
  );
}

function readLegacyTencentAsrCredentials(pet: PetDefinition): TencentAsrCredentials | undefined {
  const settings = pet.voiceInputSettings as LegacyVoiceInputSettings | undefined;
  const appId = typeof settings?.appId === "string" ? settings.appId.trim() : "";
  const secretId = typeof settings?.secretId === "string" ? settings.secretId.trim() : "";
  const secretKey = typeof settings?.secretKey === "string" ? settings.secretKey.trim() : "";

  return appId && secretId && secretKey ? { appId, secretId, secretKey } : undefined;
}

function stripVoiceInputCredentials(pet: PetDefinition, hasCredentials?: boolean): PetDefinition {
  const settings = pet.voiceInputSettings as LegacyVoiceInputSettings | undefined;

  if (!settings) {
    return pet;
  }

  const {
    appId: _legacyAppId,
    secretId: _legacySecretId,
    secretKey: _legacySecretKey,
    ...publicSettings
  } = settings;
  const credentialsAvailable = hasCredentials ?? Boolean(publicSettings.hasCredentials);

  return {
    ...pet,
    capabilities: {
      ...pet.capabilities,
      voiceInput: Boolean(pet.capabilities.voiceInput && credentialsAvailable)
    },
    voiceInputSettings: {
      ...publicSettings,
      hasCredentials: credentialsAvailable,
      connected: Boolean(publicSettings.connected && credentialsAvailable)
    }
  };
}

export function toPublicPetDefinition(pet: PetDefinition): PetDefinition {
  return stripVoiceInputCredentials(normalizeLegacyPetDefinition(pet));
}

export function toPetRuntimeDefinition(pet: PetDefinition): PetDefinition {
  const publicPet = toPublicPetDefinition(pet);
  const ranges = Object.fromEntries(
    Object.entries(publicPet.moodSettings?.ranges ?? {}).map(([id, settings]) => [id, {
      ...(settings.enterSource ? { enterSource: settings.enterSource } : {}),
      ...(settings.enterLine ? { enterLine: settings.enterLine } : {})
    }]).filter(([, settings]) => Object.keys(settings).length)
  ) as NonNullable<PetDefinition["moodSettings"]>["ranges"];
  return { ...publicPet, moodSettings: Object.keys(ranges ?? {}).length ? { ranges } : undefined };
}

export class PetConfigCorruptedError extends Error {
  readonly code = "PET_CONFIG_CORRUPTED";
  readonly petId: string;
  readonly backupAvailable: boolean;
  readonly originalError?: unknown;

  constructor(petId: string, backupAvailable: boolean, originalError?: unknown) {
    super(
      backupAvailable
        ? `桌宠「${petId}」的配置已损坏，原文件未被覆盖。可恢复最近一次有效备份后重试。`
        : `桌宠「${petId}」的配置无法读取或已损坏，原文件未被覆盖，且没有可用备份。请从外部备份恢复。`
    );
    this.name = "PetConfigCorruptedError";
    this.petId = petId;
    this.backupAvailable = backupAvailable;
    this.originalError = originalError;
  }
}

export class PetConfigVersionUnsupportedError extends UnsupportedConfigVersionError {
  readonly backupAvailable = false;

  constructor(readonly petId: string) {
    super();
    this.name = "PetConfigVersionUnsupportedError";
  }
}

function assertContainedPath(rootPath: string, targetPath: string, message: string): void {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(message);
  }
}

function withPetWriteLock<T>(petId: string, operation: () => Promise<T>): Promise<T> {
  return withPetConfigWriteLock(petId, operation);
}

async function withPetIdAllocationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = petIdAllocationQueue;
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  petIdAllocationQueue = previous.catch(() => undefined).then(() => current);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent?.();
  }
}

async function migrateLegacyVoiceInputCredentials(
  pet: PetDefinition
): Promise<VoiceCredentialMigrationResult> {
  const legacyCredentials = readLegacyTencentAsrCredentials(pet);

  if (!legacyCredentials) {
    return {
      pet: toPublicPetDefinition(pet),
      blocked: false
    };
  }

  try {
    await setSecureString(tencentAsrSecretScope, pet.id, JSON.stringify(legacyCredentials));
    const verifiedCredentials = parseTencentAsrCredentials(
      await getSecureString(tencentAsrSecretScope, pet.id)
    );

    if (!areTencentAsrCredentialsEqual(verifiedCredentials, legacyCredentials)) {
      throw new Error("腾讯云语音凭据迁移后的安全存储校验失败。");
    }

    const migratedPet = stripVoiceInputCredentials(pet, true);
    await writePetConfigUnlocked(pet.id, migratedPet, "replacement");
    return {
      pet: migratedPet,
      blocked: false
    };
  } catch (error) {
    console.error(`Failed to migrate Tencent ASR credentials for pet ${pet.id}.`, error);
    return {
      pet: stripVoiceInputCredentials(pet, false),
      blocked: true
    };
  }
}

async function ensureRealDirectoryContained(
  rootPath: string,
  targetDirectoryPath: string,
  message: string
): Promise<void> {
  const userDataPath = path.resolve(app.getPath("userData"));
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.mkdir(rootPath, { recursive: true });
  const [realUserDataPath, realRootPath] = await Promise.all([
    fs.realpath(userDataPath),
    fs.realpath(rootPath)
  ]);
  assertContainedPath(realUserDataPath, realRootPath, message);

  await fs.mkdir(targetDirectoryPath, { recursive: true });
  const realTargetPath = await fs.realpath(targetDirectoryPath);

  if (path.resolve(realRootPath) !== path.resolve(realTargetPath)) {
    assertContainedPath(realRootPath, realTargetPath, message);
  }
}

function getGptSoVitsLogPath(petId: string): string {
  return path.resolve(process.cwd(), "logs", `gpt-sovits-${assertValidPetId(petId)}.log`);
}

async function isGptSoVitsApiListening(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(baseUrl, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);

    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

async function waitForGptSoVitsApi(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isGptSoVitsApiListening(baseUrl)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  return false;
}

async function readRecentGptSoVitsLog(petId: string): Promise<string | undefined> {
  try {
    const log = await fs.readFile(getGptSoVitsLogPath(petId), "utf8");
    const diagnostic = sanitizeVoiceDiagnosticText(log);

    return diagnostic || undefined;
  } catch {
    return undefined;
  }
}

function toYamlPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function normalizeVoiceInputSilenceSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultVoiceInputSilenceSeconds;
  }

  return Math.min(
    Math.max(Math.round(value * 10) / 10, minVoiceInputSilenceSeconds),
    maxVoiceInputSilenceSeconds
  );
}

interface CudaProbeResult {
  available: boolean;
  deviceName?: string;
  message?: string;
}

interface ResolvedVoiceRuntimeOptions {
  requestedDevice: LocalPetVoiceModelDraft["inferenceDevice"];
  device: "cuda" | "cpu";
  isHalf: boolean;
  cudaProbe?: CudaProbeResult;
}

function normalizeVoiceInferenceDevice(
  value: LocalPetVoiceModelDraft["inferenceDevice"] | undefined
): LocalPetVoiceModelDraft["inferenceDevice"] {
  return value === "cuda" || value === "cpu" || value === "auto"
    ? value
    : defaultVoiceInferenceDevice;
}

function requireVoiceModelVersion(value: unknown): PetVoiceModelVersion {
  if (!isPetVoiceModelVersion(value)) {
    throw new Error("请选择受支持的 GPT-SoVITS 模型版本。");
  }

  return value;
}

async function probeCudaWithPython(pythonExePath: string): Promise<CudaProbeResult> {
  const probeScript = [
    "import json",
    "try:",
    "    import torch",
    "    available = bool(torch.cuda.is_available())",
    "    device_name = torch.cuda.get_device_name(0) if available else ''",
    "    print(json.dumps({'available': available, 'deviceName': device_name}, ensure_ascii=False))",
    "except Exception as exc:",
    "    print(json.dumps({'available': False, 'message': str(exc)}, ensure_ascii=False))"
  ].join("\n");

  return await new Promise<CudaProbeResult>((resolve) => {
    execFile(
      pythonExePath,
      ["-c", probeScript],
      {
        timeout: 15000,
        windowsHide: true
      },
      (_error, stdout) => {
        try {
          const outputLines = stdout.trim().split(/\r?\n/).filter(Boolean);
          const output = outputLines[outputLines.length - 1] ?? "";
          const parsed = JSON.parse(output) as Partial<CudaProbeResult>;

          resolve({
            available: Boolean(parsed.available),
            deviceName: parsed.deviceName,
            message: parsed.message
          });
        } catch {
          resolve({
            available: false,
            message: "无法解析 CUDA 检测结果。"
          });
        }
      }
    );
  });
}

async function resolveVoiceRuntimeOptions(
  draft: LocalPetVoiceModelDraft,
  pythonExePath: string
): Promise<ResolvedVoiceRuntimeOptions> {
  const requestedDevice = normalizeVoiceInferenceDevice(draft.inferenceDevice);
  const wantsCudaProbe = requestedDevice === "auto" || requestedDevice === "cuda";
  const cudaProbe = wantsCudaProbe ? await probeCudaWithPython(pythonExePath) : undefined;
  const device = requestedDevice === "cpu" ? "cpu" : cudaProbe?.available ? "cuda" : "cpu";

  if (requestedDevice === "cuda" && device !== "cuda") {
    throw new Error(
      [
        "当前 GPT-SoVITS Python 环境没有检测到可用 CUDA。",
        cudaProbe?.message ? `检测信息：${cudaProbe.message}` : "",
        "请确认 NVIDIA 驱动和 CUDA 版 PyTorch 已安装到 GPT-SoVITS 的 runtime/python.exe。"
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return {
    requestedDevice,
    device,
    isHalf: device === "cuda" && (draft.halfPrecision ?? defaultVoiceHalfPrecision),
    cudaProbe
  };
}

async function writeGptSoVitsRuntimeConfig(
  draft: LocalPetVoiceModelDraft,
  runtimeOptions: ResolvedVoiceRuntimeOptions
): Promise<string> {
  if (!draft.gptSoVitsRootPath || !draft.gptModelPath || !draft.sovitsModelPath) {
    throw new Error("请先填写 GPT-SoVITS 本地路径，并选择 SoVITS / GPT 模型。");
  }

  const configDirectoryPath = await ensureSafePetSubdirectory(draft.petId, "voice");
  const configPath = path.join(configDirectoryPath, "gpt-sovits.generated.yaml");
  const content = buildGptSoVitsRuntimeConfigContent(draft, runtimeOptions);

  await writeTextFileAtomically(configPath, content);

  return configPath;
}

export function buildGptSoVitsRuntimeConfigContent(
  draft: Pick<
    LocalPetVoiceModelDraft,
    "gptSoVitsRootPath" | "gptModelPath" | "sovitsModelPath" | "modelVersion"
  >,
  runtimeOptions: Pick<ResolvedVoiceRuntimeOptions, "device" | "isHalf">
): string {
  if (!draft.gptSoVitsRootPath || !draft.gptModelPath || !draft.sovitsModelPath) {
    throw new Error("请先填写 GPT-SoVITS 本地路径，并选择 SoVITS / GPT 模型。");
  }

  const rootPath = toYamlPath(draft.gptSoVitsRootPath);
  const modelVersion = requireVoiceModelVersion(draft.modelVersion);

  return [
    "custom:",
    `  bert_base_path: ${rootPath}/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large`,
    `  cnhuhbert_base_path: ${rootPath}/GPT_SoVITS/pretrained_models/chinese-hubert-base`,
    `  device: ${runtimeOptions.device}`,
    `  is_half: ${runtimeOptions.isHalf ? "true" : "false"}`,
    `  t2s_weights_path: ${toYamlPath(draft.gptModelPath)}`,
    `  version: ${modelVersion}`,
    `  vits_weights_path: ${toYamlPath(draft.sovitsModelPath)}`,
    ""
  ].join("\n");
}

async function launchGptSoVitsApiIfNeeded(draft: LocalPetVoiceModelDraft): Promise<void> {
  const endpoint = await ensureGptSoVitsEndpoint(draft.petId);
  if (await isGptSoVitsApiListening(endpoint.baseUrl)) {
    return;
  }

  if (!draft.gptSoVitsRootPath) {
    throw new Error("请填写 GPT-SoVITS 本地路径。");
  }

  const gptSoVitsRootPath = draft.gptSoVitsRootPath;
  const pythonExePath = path.join(gptSoVitsRootPath, "runtime", "python.exe");
  const apiScriptPath = path.join(gptSoVitsRootPath, "api_v2.py");

  for (const requiredPath of [pythonExePath, apiScriptPath]) {
    try {
      await fs.access(requiredPath);
    } catch {
      throw new Error(`找不到 GPT-SoVITS 必要文件：${requiredPath}`);
    }
  }

  const runtimeOptions = await resolveVoiceRuntimeOptions(draft, pythonExePath);
  const runtimeConfigPath = await writeGptSoVitsRuntimeConfig(draft, runtimeOptions);
  const logPath = getGptSoVitsLogPath(draft.petId);
  const logDirectoryPath = path.dirname(logPath);

  await fs.mkdir(logDirectoryPath, { recursive: true });

  await fs.writeFile(
    logPath,
    [
      `[${new Date().toISOString()}] Starting GPT-SoVITS API`,
      `root=${gptSoVitsRootPath}`,
      `python=${pythonExePath}`,
      `api=${apiScriptPath}`,
      `config=${runtimeConfigPath}`,
      `port=${endpoint.port}`,
      `requestedDevice=${runtimeOptions.requestedDevice}`,
      `resolvedDevice=${runtimeOptions.device}`,
      `isHalf=${runtimeOptions.isHalf}`,
      runtimeOptions.cudaProbe?.deviceName ? `cudaDevice=${runtimeOptions.cudaProbe.deviceName}` : "",
      runtimeOptions.cudaProbe?.message ? `cudaProbe=${runtimeOptions.cudaProbe.message}` : "",
      ""
    ].filter((line) => line !== "").join("\n"),
    "utf8"
  );

  const logFd = fsSync.openSync(logPath, "a");
  const runtimePath = path.join(gptSoVitsRootPath, "runtime");
  const child = spawn(
    pythonExePath,
    [apiScriptPath, "-c", runtimeConfigPath, "-a", endpoint.host, "-p", String(endpoint.port)],
    {
      cwd: gptSoVitsRootPath,
      detached: true,
      env: {
        ...process.env,
        PATH: [gptSoVitsRootPath, runtimePath, process.env.PATH ?? ""].join(path.delimiter)
      },
      windowsHide: true,
      stdio: ["ignore", logFd, logFd]
    }
  );
  managedGptSoVitsProcesses.set(draft.petId, child);
  child.once("exit", () => {
    if (managedGptSoVitsProcesses.get(draft.petId)?.pid === child.pid) {
      managedGptSoVitsProcesses.delete(draft.petId);
    }
  });
  child.unref();
  fsSync.closeSync(logFd);
}

export function stopManagedGptSoVitsApi(): void {
  for (const [petId, child] of managedGptSoVitsProcesses) {
    if (!child.pid) {
      managedGptSoVitsProcesses.delete(petId);
      continue;
    }

    try {
      if (process.platform === "win32") {
        spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        }).unref();
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // The app may be shutting down while the child process already exited.
    } finally {
      managedGptSoVitsProcesses.delete(petId);
    }
  }
  resetGptSoVitsRuntimeEndpoints();
}

export async function resetLocalPetVoiceRuntimeState(): Promise<void> {
  let entries: fsSync.Dirent[];

  try {
    entries = await fs.readdir(getPetsRootPath(), { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isValidPetId(entry.name))
      .map((entry) => withPetWriteLock(entry.name, async () => {
        const configPath = getPetConfigPath(entry.name);
        let pet: PetDefinition | undefined;

        try {
          pet = await readPetConfigUnlocked(configPath, { forMutation: true });
        } catch (error) {
          if (error instanceof VoiceCredentialMigrationBlockedError) {
            return;
          }

          throw error;
        }

        if (!pet?.voiceModelSettings) {
          return;
        }

        const hasRuntimeVoiceState = Boolean(
          pet.voiceModelSettings.connected ||
            pet.voiceModelSettings.enabled ||
            pet.capabilities.voiceOutput
        );

        if (!hasRuntimeVoiceState) {
          return;
        }

        const nextPet: PetDefinition = {
          ...pet,
          capabilities: {
            ...pet.capabilities,
            voiceOutput: false
          },
          voiceModelSettings: {
            ...pet.voiceModelSettings,
            connected: false,
            enabled: false
          }
        };

        await writePetConfigUnlocked(entry.name, nextPet);
      }))
  );
}

function slugifyName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PET_ID_LENGTH);

  return normalized || `pet-${Date.now().toString(36)}`;
}

async function ensureUniquePetId(baseId: string, existingId?: string): Promise<string> {
  if (existingId) {
    return assertValidPetId(existingId);
  }

  const safeBaseId = assertValidPetId(baseId);
  let candidate = safeBaseId;
  let index = 2;

  while (true) {
    try {
      await fs.access(getPetDirectoryPath(candidate));
      const suffix = `-${index}`;
      candidate = `${safeBaseId.slice(0, MAX_PET_ID_LENGTH - suffix.length)}${suffix}`;
      index += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }

      throw error;
    }
  }
}

function normalizeScenes(scenes: string[]): string[] {
  return Array.from(
    new Set(scenes.map((scene) => scene.trim()).filter(Boolean))
  );
}

function buildPetDefinition(draft: LocalPetBasicInfoDraft, petId: string): PetDefinition {
  const name = draft.name.trim();
  const description = draft.description.trim() || "待设定";
  const role = draft.role.trim() || "待设定";
  const personality = draft.personality.trim() || "待设定";
  const scenes = normalizeScenes(draft.scenes);

  return {
    id: petId,
    name,
    description,
    modelPath: "",
    avatar: name.slice(0, 2).toUpperCase(),
    avatarImage: draft.avatarImage,
    personaPrompt: "",
    capabilities: {
      chat: false,
      voiceOutput: false,
      subtitles: true
    },
    details: {
      role,
      personality,
      scenes,
      features: [
        {
          title: "Live2D 显示",
          description: "等待导入 Live2D 模型文件夹。",
          status: "ready"
        },
        {
          title: "字幕反馈",
          description: "可配置事件台词和字幕。",
          status: "ready"
        }
      ]
    },
    lines: {},
    expressions: {},
    expressionDescriptions: {},
    uiSettings: {
      theme: "soft",
      clickThroughOpacity: 0.45,
      desktopScale: 1
    },
    screenAwarenessSettings: {
      enabled: false,
      mode: "quiet",
      persistentCaptureEnabled: false
    },
    isLocal: true,
    subtitleStyle: {
      tone: "soft",
      maxWidth: 228
    }
  };
}

function withLive2DFeatureReady(features: PetFeature[] = []): PetFeature[] {
  const nextFeatures = [...features];
  const index = nextFeatures.findIndex((feature) => feature.title === "Live2D 显示");
  const live2dFeature: PetFeature = {
    title: "Live2D 显示",
    description: "已导入 Live2D 模型文件夹。",
    status: "ready"
  };

  if (index >= 0) {
    nextFeatures[index] = live2dFeature;
  } else {
    nextFeatures.unshift(live2dFeature);
  }

  return nextFeatures;
}

function hasLocalPetResourceModelPath(modelPath: string, petId: string): boolean {
  try {
    const parsedUrl = new URL(modelPath);
    const expectedPathPrefix = `/${encodeURIComponent(petId)}/live2d/`;

    return (
      parsedUrl.protocol === `${petResourceProtocol}:` &&
      parsedUrl.hostname === "local" &&
      parsedUrl.pathname.startsWith(expectedPathPrefix)
    );
  } catch {
    return false;
  }
}

async function syncImportedLive2DConfig(
  petId: string,
  existingPet: PetDefinition | undefined
): Promise<PetDefinition | undefined> {
  if (!existingPet) {
    return undefined;
  }

  const live2dDirectoryPath = path.join(getPetDirectoryPath(petId), live2dDirectoryName);

  try {
    const scan = await validateLive2DFolder(live2dDirectoryPath);

    if (!scan.ok || !scan.entryFilePath) {
      return existingPet;
    }

    const basePet = existingPet;
    const nextPet: PetDefinition = {
      ...basePet,
      id: petId,
      modelPath: toPetResourceUrl(scan.entryFilePath),
      live2dSettings: {
        entryFileName: scan.entryFileName,
        textureCount: scan.textureCount,
        motionCount: scan.motionCount,
        expressionCount: scan.expressionCount
      },
      details: {
        ...basePet.details,
        features: withLive2DFeatureReady(basePet.details.features)
      },
      isLocal: true
    };

    await writePetConfigUnlocked(petId, nextPet);

    return nextPet;
  } catch {
    return existingPet;
  }
}

function mergeBasicInfoIntoPet(
  existingPet: PetDefinition | undefined,
  draft: LocalPetBasicInfoDraft,
  petId: string,
  avatarImage: string
): PetDefinition {
  const nextBasicPet = buildPetDefinition(
    {
      ...draft,
      avatarImage
    },
    petId
  );

  if (!existingPet) {
    return nextBasicPet;
  }

  return {
    ...existingPet,
    name: nextBasicPet.name,
    description: nextBasicPet.description,
    avatar: nextBasicPet.avatar,
    avatarImage: nextBasicPet.avatarImage,
    details: {
      ...existingPet.details,
      role: nextBasicPet.details.role,
      personality: nextBasicPet.details.personality,
      scenes: nextBasicPet.details.scenes,
      features: existingPet.details.features?.length
        ? existingPet.details.features
        : nextBasicPet.details.features
    },
    isLocal: true
  };
}

function decodeSafeResourcePathParts(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .map((part) => {
      if (!part || part === "." || part === ".." || /[\\/\0]/.test(part)) {
        throw new Error("Invalid avatar resource path.");
      }

      return part;
    });
}

function getLocalAvatarResourcePetId(avatarImage: string): string | undefined {
  if (!avatarImage.startsWith(`${petResourceProtocol}://`)) {
    return undefined;
  }

  try {
    const parsedUrl = new URL(avatarImage);

    if (parsedUrl.hostname !== "local") {
      return undefined;
    }

    const [petId, resourceRoot, ...resourceParts] = decodeSafeResourcePathParts(parsedUrl.pathname);

    return resourceRoot === "assets" && resourceParts.length ? assertValidPetId(petId) : undefined;
  } catch {
    return undefined;
  }
}

function avatarImageToPath(avatarImage: string, expectedPetId?: string): string {
  if (avatarImage.startsWith("file://")) {
    return fileURLToPath(avatarImage);
  }

  if (avatarImage.startsWith(`${petResourceProtocol}://`)) {
    const parsedUrl = new URL(avatarImage);

    if (parsedUrl.hostname !== "local") {
      throw new Error("Invalid avatar resource host.");
    }

    const [petId, resourceRoot, ...resourceParts] = decodeSafeResourcePathParts(parsedUrl.pathname);
    const targetPetId = assertValidPetId(petId);

    if (
      resourceRoot !== "assets" ||
      !resourceParts.length ||
      (expectedPetId && targetPetId !== expectedPetId)
    ) {
      throw new Error("Invalid avatar resource path.");
    }

    const assetRootPath = path.resolve(getPetDirectoryPath(targetPetId), "assets");
    const targetPath = path.resolve(assetRootPath, ...resourceParts);
    assertContainedPath(assetRootPath, targetPath, "Invalid avatar resource path.");
    return targetPath;
  }

  return avatarImage;
}

async function copyAvatarIntoPetDirectory(avatarImage: string, petId: string): Promise<string> {
  const sourcePath = avatarImageToPath(avatarImage);
  const extension = path.extname(sourcePath).toLowerCase();

  if (!allowedAvatarExtensions.has(extension)) {
    return avatarImage;
  }

  const assetDirectoryPath = await ensureSafePetSubdirectory(petId, "assets");
  const targetPath = path.join(assetDirectoryPath, `avatar-${Date.now().toString(36)}${extension}`);

  if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
    await fs.copyFile(sourcePath, targetPath);
  }

  return toPetResourceUrl(targetPath);
}

async function isRemovableAvatarDraftDirectory(petId: string): Promise<boolean> {
  if (!avatarDraftPetIdPattern.test(petId)) {
    return false;
  }

  const draftDirectoryPath = await assertExistingLocalPetDirectoryContained(petId);
  const draftStat = await fs.lstat(draftDirectoryPath);

  if (!draftStat.isDirectory() || draftStat.isSymbolicLink()) {
    return false;
  }

  try {
    await fs.access(getPetConfigPath(petId));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const entries = await fs.readdir(draftDirectoryPath, { withFileTypes: true });

  if (!entries.length) {
    return true;
  }

  if (entries.length !== 1 || entries[0]?.name !== "assets" || !entries[0].isDirectory()) {
    return false;
  }

  const assetsDirectoryPath = path.join(draftDirectoryPath, "assets");
  const assetsStat = await fs.lstat(assetsDirectoryPath);

  if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) {
    return false;
  }

  const assetEntries = await fs.readdir(assetsDirectoryPath, { withFileTypes: true });

  return assetEntries.every(
    (entry) =>
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      avatarDraftFileNamePattern.test(entry.name) &&
      allowedAvatarExtensions.has(path.extname(entry.name).toLowerCase())
  );
}

async function removeAvatarDraftDirectory(petId: string): Promise<void> {
  if (!(await isRemovableAvatarDraftDirectory(petId))) {
    return;
  }

  await fs.rm(getPetDirectoryPath(petId), { recursive: true, force: true });
}

async function cleanupAvatarDraftAfterSave(avatarImage: string, savedPetId: string): Promise<void> {
  const sourcePetId = getLocalAvatarResourcePetId(avatarImage);

  if (!sourcePetId || sourcePetId === savedPetId || !avatarDraftPetIdPattern.test(sourcePetId)) {
    return;
  }

  await withPetWriteLock(sourcePetId, () => removeAvatarDraftDirectory(sourcePetId));
}

async function createPetConfigCorruptedError(
  petId: string,
  originalError?: unknown
): Promise<PetConfigCorruptedError> {
  return new PetConfigCorruptedError(
    petId,
    Boolean(await readValidPetConfigBackup(petId)),
    originalError
  );
}

async function readPetConfigUnlocked(
  filePath: string,
  options: { forMutation?: boolean } = {}
): Promise<PetDefinition | undefined> {
  const petId = assertValidPetId(path.basename(path.dirname(filePath)));

  try {
    await assertExistingLocalPetDirectoryContained(petId);
    const content = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(content) as unknown;

    if (!isStoredPetDefinition(parsed, petId)) {
      throw new Error("桌宠配置缺少有效的 id/name，或配置 ID 与目录不一致。");
    }

    const migration = await migrateLegacyVoiceInputCredentials(
      normalizeLegacyPetDefinition(parsed)
    );

    if (migration.blocked) {
      if (options.forMutation) {
        throw new VoiceCredentialMigrationBlockedError();
      }

      let avatarImage: string | undefined;

      try {
        avatarImage = migration.pet.avatarImage
          ? toPetResourceUrl(avatarImageToPath(migration.pet.avatarImage, petId))
          : undefined;
      } catch {
        avatarImage = undefined;
      }

      return {
        ...migration.pet,
        avatarImage,
        isLocal: true
      };
    }

    let nextPet = migration.pet;
    const voicePathResolution = await resolveLegacyVoiceModelPaths(nextPet);

    if (voicePathResolution.changed) {
      nextPet = voicePathResolution.pet;
      await writePetConfigUnlocked(nextPet.id, nextPet, "replacement");
    }

    // Older releases stored a relative model path. In a packaged app the renderer
    // resolves that against app.asar, so Cubism tries to load the window URL instead
    // of the imported model. Rebuild it from the validated local import directory.
    if (
      !nextPet.modelPath ||
      !nextPet.live2dSettings ||
      !hasLocalPetResourceModelPath(nextPet.modelPath, nextPet.id)
    ) {
      const syncedPet = await syncImportedLive2DConfig(nextPet.id, nextPet);

      if (syncedPet) {
        nextPet = syncedPet;
      }
    }

    return toPublicPetDefinition({
      ...nextPet,
      avatarImage: nextPet.avatarImage
        ? toPetResourceUrl(avatarImageToPath(nextPet.avatarImage, petId))
        : undefined,
      isLocal: true
    });
  } catch (error) {
    if (error instanceof UnsupportedConfigVersionError) throw new PetConfigVersionUnsupportedError(petId);
    if (
      error instanceof VoiceCredentialMigrationBlockedError ||
      error instanceof PetConfigCorruptedError
    ) {
      throw error;
    }

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw await createPetConfigCorruptedError(petId, error);
  }
}

function assertSafePetDirectory(petId: string): string {
  return getPetDirectoryPath(assertValidPetId(petId));
}

const defaultCustomThemeTokens: PetCustomThemeTokens = {
  background: "#eef6ff",
  surface: "rgba(255, 255, 255, 0.92)",
  petSurface: "rgba(255, 255, 255, 0.82)",
  headerSurface: "#2684ff",
  headerText: "#ffffff",
  inputSurface: "rgba(255, 255, 255, 0.92)",
  userSurface: "#2684ff",
  text: "#17202a",
  mutedText: "#607080",
  accent: "#2684ff",
  accentStrong: "#ff7ab8",
  decorationPrimary: "#2684ff",
  decorationSecondary: "#ff7ab8",
  watermarkColor: "rgba(38, 132, 255, 0.09)",
  border: "rgba(38, 132, 255, 0.28)",
  danger: "#ef4444",
  shadow: "0 18px 44px rgba(38, 50, 65, 0.18)",
  radius: 14
};

const defaultCustomThemeRadialMenu: PetCustomThemeRadialMenu = {
  radius: 15,
  surface: "rgba(255, 255, 255, 0.92)",
  text: "#344255",
  border: "rgba(38, 132, 255, 0.24)",
  shadow: "0 8px 16px rgba(38, 50, 65, 0.12)",
  activeBorder: "#2684ff",
  center: {
    surface: "#eef6ff",
    text: "#1766c2",
    border: "rgba(38, 132, 255, 0.28)"
  },
  actions: {
    passThrough: { surface: "#edf9f6", text: "#287968", border: "rgba(40, 121, 104, 0.24)" },
    touch: { surface: "#fff9e8", text: "#8a6b22", border: "rgba(138, 107, 34, 0.22)" },
    chat: { surface: "#edf5ff", text: "#2768a8", border: "rgba(39, 104, 168, 0.24)" },
    mood: { surface: "#f3edff", text: "#6741a5", border: "rgba(103, 65, 165, 0.24)" },
    danger: { surface: "#fff3f5", text: "#a64861", border: "rgba(166, 72, 97, 0.26)" },
    vision: { surface: "#eefbff", text: "#19718c", border: "rgba(25, 113, 140, 0.28)" }
  }
};

const defaultCustomThemeMoodMeter: NonNullable<PetCustomTheme["moodMeter"]> = {
  upColor: "#ff7ab8",
  downColor: "#6f7bd9",
  calmColor: "#8b95a7",
  surface: "rgba(30, 24, 44, 0.5)",
  emptyColor: "rgba(255, 255, 255, 0.35)",
  textColor: "#ffffff",
  shadow: "0 8px 24px rgba(20, 24, 42, 0.22)",
  insetShadow: "inset 0 0 7px rgba(255, 255, 255, 0.08)",
  frame: "soft-pill",
  particleStyle: "minimal",
  effectStyle: "halo",
  ranges: {
    darkened: { frameOpacity: .82, glowOpacity: .56, glowRadius: 17, liquidOpacity: .9, boundaryWidth: 1.8, waveAmplitude: 3.2, particleOpacity: .82, auraOpacity: .88, accentOpacity: .96, animationSeconds: 1.8 },
    slump: { frameOpacity: .55, glowOpacity: .32, glowRadius: 11, liquidOpacity: .84, boundaryWidth: 1.35, waveAmplitude: 1.8, particleOpacity: .52, auraOpacity: .5, accentOpacity: .52, animationSeconds: 2.9 },
    downcast: { frameOpacity: .35, glowOpacity: .18, glowRadius: 7, liquidOpacity: .8, boundaryWidth: 1, waveAmplitude: .9, particleOpacity: .24, auraOpacity: .24, accentOpacity: .2, animationSeconds: 3.8 },
    calm: { frameOpacity: .22, glowOpacity: .1, glowRadius: 4, liquidOpacity: .55, boundaryWidth: .8, waveAmplitude: .45, particleOpacity: .1, auraOpacity: .08, accentOpacity: .04, animationSeconds: 4.8 },
    pleasant: { frameOpacity: .35, glowOpacity: .18, glowRadius: 7, liquidOpacity: .8, boundaryWidth: 1, waveAmplitude: .9, particleOpacity: .24, auraOpacity: .24, accentOpacity: .2, animationSeconds: 3.8 },
    joyful: { frameOpacity: .55, glowOpacity: .32, glowRadius: 11, liquidOpacity: .84, boundaryWidth: 1.35, waveAmplitude: 1.8, particleOpacity: .52, auraOpacity: .5, accentOpacity: .52, animationSeconds: 2.9 },
    excited: { frameOpacity: .82, glowOpacity: .56, glowRadius: 17, liquidOpacity: .9, boundaryWidth: 1.8, waveAmplitude: 3.2, particleOpacity: .82, auraOpacity: .88, accentOpacity: .96, animationSeconds: 1.8 }
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeChatDecorations(value: unknown): PetChatDecorations | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("主题聊天框装饰格式不正确。");

  const allowedSlots = new Set<string>(petChatDecorationSlots);
  const allowedIcons = new Set<string>(petChatDecorationIcons);
  const decorations: PetChatDecorations = {};

  for (const [slot, icon] of Object.entries(value)) {
    if (!allowedSlots.has(slot) || typeof icon !== "string" || !allowedIcons.has(icon)) {
      throw new Error("主题包含不支持的聊天框装饰。");
    }
    decorations[slot as keyof PetChatDecorations] = icon as PetChatDecorations[keyof PetChatDecorations];
  }

  return Object.keys(decorations).length ? decorations : undefined;
}

function sanitizeThemeId(value: unknown, fallbackName: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallbackName;
  const slug = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  if (themeIdPattern.test(slug) && !builtInThemeIds.has(slug)) {
    return slug;
  }

  return `theme-${Date.now().toString(36)}`;
}

function normalizeThemeText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const text = value.trim();

  return text ? text.slice(0, maxLength) : fallback;
}

function isSafeCssValue(value: string, maxLength = 180): boolean {
  if (!value || value.length > maxLength) {
    return false;
  }

  return !/[;{}<>@]/.test(value) && !/(?:url|expression|import)\s*\(/i.test(value);
}

function normalizeThemeToken(
  tokens: Record<string, unknown>,
  key: string,
  fallback: string
): string {
  const value = tokens[key];

  if (typeof value !== "string") {
    return fallback;
  }

  const text = value.trim();

  return isSafeCssValue(text) ? text : fallback;
}

function normalizeThemeRadius(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultCustomThemeTokens.radius ?? 14;
  }

  return Math.min(Math.max(Math.round(value), 0), 24);
}

function normalizeCustomTheme(rawTheme: unknown, fallbackName: string): PetCustomTheme {
  if (!isRecord(rawTheme)) {
    throw new Error("主题文件格式不正确。");
  }

  const rawTokens = isRecord(rawTheme.tokens) ? rawTheme.tokens : undefined;

  if (!rawTokens) {
    throw new Error("主题文件缺少 tokens。");
  }

  const name = normalizeThemeText(rawTheme.name, "自定义主题", 32);

  return {
    id: sanitizeThemeId(rawTheme.id, name || fallbackName),
    name,
    description: normalizeThemeText(rawTheme.description, "用户导入的本地主题。", 72),
    version: typeof rawTheme.version === "number" && Number.isFinite(rawTheme.version)
      ? Math.max(1, Math.round(rawTheme.version))
      : 1,
    author: typeof rawTheme.author === "string" && rawTheme.author.trim()
      ? rawTheme.author.trim().slice(0, 32)
      : undefined,
    importedAt: typeof rawTheme.importedAt === "string" && rawTheme.importedAt.trim()
      ? rawTheme.importedAt.trim()
      : new Date().toISOString(),
    tokens: {
      background: normalizeThemeToken(rawTokens, "background", defaultCustomThemeTokens.background),
      surface: normalizeThemeToken(rawTokens, "surface", defaultCustomThemeTokens.surface),
      petSurface: normalizeThemeToken(rawTokens, "petSurface", defaultCustomThemeTokens.petSurface ?? defaultCustomThemeTokens.surface),
      headerSurface: normalizeThemeToken(rawTokens, "headerSurface", defaultCustomThemeTokens.headerSurface ?? defaultCustomThemeTokens.accent),
      headerText: normalizeThemeToken(rawTokens, "headerText", defaultCustomThemeTokens.headerText ?? defaultCustomThemeTokens.surface),
      inputSurface: normalizeThemeToken(rawTokens, "inputSurface", defaultCustomThemeTokens.inputSurface ?? defaultCustomThemeTokens.surface),
      userSurface: normalizeThemeToken(rawTokens, "userSurface", defaultCustomThemeTokens.userSurface ?? defaultCustomThemeTokens.accent),
      text: normalizeThemeToken(rawTokens, "text", defaultCustomThemeTokens.text),
      mutedText: normalizeThemeToken(rawTokens, "mutedText", defaultCustomThemeTokens.mutedText),
      accent: normalizeThemeToken(rawTokens, "accent", defaultCustomThemeTokens.accent),
      accentStrong: normalizeThemeToken(rawTokens, "accentStrong", defaultCustomThemeTokens.accentStrong ?? defaultCustomThemeTokens.accent),
      decorationPrimary: normalizeThemeToken(rawTokens, "decorationPrimary", defaultCustomThemeTokens.decorationPrimary ?? defaultCustomThemeTokens.accent),
      decorationSecondary: normalizeThemeToken(rawTokens, "decorationSecondary", defaultCustomThemeTokens.decorationSecondary ?? defaultCustomThemeTokens.accentStrong ?? defaultCustomThemeTokens.accent),
      watermarkColor: normalizeThemeToken(rawTokens, "watermarkColor", defaultCustomThemeTokens.watermarkColor ?? "rgba(38, 132, 255, 0.09)"),
      border: normalizeThemeToken(rawTokens, "border", defaultCustomThemeTokens.border),
      danger: normalizeThemeToken(rawTokens, "danger", defaultCustomThemeTokens.danger ?? "#ef4444"),
      shadow: normalizeThemeToken(rawTokens, "shadow", defaultCustomThemeTokens.shadow ?? "none"),
      radius: normalizeThemeRadius(rawTokens.radius)
    },
    chatDecorations: normalizeChatDecorations(rawTheme.chatDecorations),
    radialMenu: normalizeCustomThemeRadialMenu(rawTheme.radialMenu),
    moodMeter: normalizeCustomThemeMoodMeter(rawTheme.moodMeter)
  };
}

function normalizeCustomThemeRadialAction(
  rawAction: unknown,
  fallback: PetCustomThemeRadialMenuAction
): PetCustomThemeRadialMenuAction {
  const action = isRecord(rawAction) ? rawAction : {};

  return {
    surface: normalizeThemeToken(action, "surface", fallback.surface),
    text: normalizeThemeToken(action, "text", fallback.text),
    border: normalizeThemeToken(action, "border", fallback.border ?? fallback.surface)
  };
}

function normalizeCustomThemeRadialMenu(value: unknown): PetCustomThemeRadialMenu {
  const menu = isRecord(value) ? value : {};
  const actions = isRecord(menu.actions) ? menu.actions : {};

  return {
    radius: normalizeThemeRadius(menu.radius),
    surface: normalizeThemeToken(menu, "surface", defaultCustomThemeRadialMenu.surface),
    text: normalizeThemeToken(menu, "text", defaultCustomThemeRadialMenu.text),
    border: normalizeThemeToken(menu, "border", defaultCustomThemeRadialMenu.border),
    shadow: normalizeThemeToken(menu, "shadow", defaultCustomThemeRadialMenu.shadow ?? "none"),
    activeBorder: normalizeThemeToken(menu, "activeBorder", defaultCustomThemeRadialMenu.activeBorder ?? defaultCustomThemeRadialMenu.border),
    center: normalizeCustomThemeRadialAction(menu.center, defaultCustomThemeRadialMenu.center),
    actions: Object.fromEntries(
      petRadialMenuActionKinds.map((kind) => [
        kind,
        normalizeCustomThemeRadialAction(actions[kind], defaultCustomThemeRadialMenu.actions[kind])
      ])
    ) as PetCustomThemeRadialMenu["actions"]
  };
}

export interface LocalPetRecoveryScanResult {
  pets: PetDefinition[];
  corruptions: Array<PetConfigCorruptedError | PetConfigVersionUnsupportedError>;
}

export async function scanLocalPetsForRecovery(): Promise<LocalPetRecoveryScanResult> {
  try {
    const entries = await fs.readdir(getPetsRootPath(), { withFileTypes: true });
    const results = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isValidPetId(entry.name))
        .map(async (entry) => {
          try {
            return {
              pet: await withPetWriteLock(entry.name, () =>
                readPetConfigUnlocked(getPetConfigPath(entry.name))
              )
            };
          } catch (error: unknown) {
            if (error instanceof PetConfigCorruptedError || error instanceof PetConfigVersionUnsupportedError) {
              return { corruption: error };
            }

            throw error;
          }
        })
    );

    return {
      pets: results
        .map((result) => result.pet)
        .filter((pet): pet is PetDefinition => Boolean(pet)),
      corruptions: results
        .map((result) => result.corruption)
        .filter((error): error is PetConfigCorruptedError | PetConfigVersionUnsupportedError => Boolean(error))
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { pets: [], corruptions: [] };
    }

    throw error;
  }
}

export async function listLocalPets(): Promise<PetDefinition[]> {
  const result = await scanLocalPetsForRecovery();

  if (result.corruptions[0]) {
    throw result.corruptions[0];
  }

  return result.pets;
}

export async function getLocalPetMemorySettings(petId: string): Promise<MemorySettings | undefined> {
  const validPetId = assertValidPetId(petId);
  const pet = await withPetWriteLock(validPetId, () =>
    readPetConfigUnlocked(getPetConfigPath(validPetId))
  );
  return pet ? normalizeMemorySettings(pet.memorySettings) : undefined;
}

export async function getLocalPetDefinition(petId: string): Promise<PetDefinition | undefined> {
  const validPetId = assertValidPetId(petId);
  return withPetWriteLock(validPetId, () =>
    readPetConfigUnlocked(getPetConfigPath(validPetId))
  );
}

export async function saveLocalPetDesktopPosition(
  petId: string,
  positionValue: PetDesktopPosition
): Promise<PetDefinition | undefined> {
  const validPetId = assertValidPetId(petId);
  const desktopPosition = normalizePetDesktopPosition(positionValue);

  if (!desktopPosition) {
    throw new Error("桌宠窗口位置无效。");
  }

  return withPetWriteLock(validPetId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(validPetId), { forMutation: true });

    if (!pet) {
      return undefined;
    }

    const nextPet: PetDefinition = {
      ...pet,
      uiSettings: {
        ...pet.uiSettings,
        theme: pet.uiSettings?.theme ?? "soft",
        desktopPosition
      },
      isLocal: true
    };
    await writePetConfigUnlocked(validPetId, nextPet);
    return nextPet;
  });
}

export async function saveLocalPetMemorySettings(
  petId: string,
  settingsValue: MemorySettings
): Promise<{ settings: MemorySettings; pet: PetDefinition }> {
  const validPetId = assertValidPetId(petId);
  const settings = normalizeMemorySettings(settingsValue);
  return withPetWriteLock(validPetId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(validPetId), { forMutation: true });
    if (!pet) throw new Error("The local pet does not exist.");
    const nextPet: PetDefinition = {
      ...pet,
      memorySettings: settings,
      isLocal: true
    };
    await writePetConfigUnlocked(validPetId, nextPet);
    return { settings: { ...settings }, pet: nextPet };
  });
}

function normalizeOptionalThemeToken(tokens: Record<string, unknown>, key: string): string | undefined {
  const value = tokens[key];
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return isSafeCssValue(text) ? text : undefined;
}

function normalizeMoodRangeStyle(
  value: unknown,
  fallback: PetCustomThemeMoodRangeStyle
): PetCustomThemeMoodRangeStyle {
  const raw = isRecord(value) ? value : {};
  const number = (key: keyof PetCustomThemeMoodRangeStyle, min: number, max: number): number => {
    const candidate = raw[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return fallback[key];
    return Math.round(Math.min(max, Math.max(min, candidate)) * 100) / 100;
  };
  return {
    frameOpacity: number("frameOpacity", 0, 1),
    glowOpacity: number("glowOpacity", 0, 1),
    glowRadius: number("glowRadius", 0, 32),
    liquidOpacity: number("liquidOpacity", 0, 1),
    boundaryWidth: number("boundaryWidth", .25, 4),
    waveAmplitude: number("waveAmplitude", 0, 5),
    particleOpacity: number("particleOpacity", 0, 1),
    auraOpacity: number("auraOpacity", 0, 1),
    accentOpacity: number("accentOpacity", 0, 1),
    animationSeconds: number("animationSeconds", .6, 12)
  };
}

function normalizeCustomThemeMoodMeter(value: unknown): NonNullable<PetCustomTheme["moodMeter"]> {
  const raw = isRecord(value) ? value : {};
  const rawRanges = isRecord(raw.ranges) ? raw.ranges : {};
  const ranges = Object.fromEntries(petMoodRanges.map(({ id }) => [
    id,
    normalizeMoodRangeStyle(rawRanges[id], defaultCustomThemeMoodMeter.ranges[id])
  ])) as NonNullable<PetCustomTheme["moodMeter"]>["ranges"];
  return {
    upColor: normalizeThemeToken(raw, "upColor", defaultCustomThemeMoodMeter.upColor),
    downColor: normalizeThemeToken(raw, "downColor", defaultCustomThemeMoodMeter.downColor),
    calmColor: normalizeThemeToken(raw, "calmColor", defaultCustomThemeMoodMeter.calmColor ?? defaultCustomThemeTokens.mutedText),
    surface: normalizeThemeToken(raw, "surface", defaultCustomThemeMoodMeter.surface ?? defaultCustomThemeTokens.petSurface ?? defaultCustomThemeTokens.surface),
    emptyColor: normalizeThemeToken(raw, "emptyColor", defaultCustomThemeMoodMeter.emptyColor ?? "rgba(255,255,255,.35)"),
    textColor: normalizeThemeToken(raw, "textColor", defaultCustomThemeMoodMeter.textColor ?? defaultCustomThemeTokens.text),
    frameColor: normalizeOptionalThemeToken(raw, "frameColor"),
    boundaryColor: normalizeOptionalThemeToken(raw, "boundaryColor"),
    particleColor: normalizeOptionalThemeToken(raw, "particleColor"),
    shadow: normalizeThemeToken(raw, "shadow", defaultCustomThemeMoodMeter.shadow ?? "none"),
    insetShadow: normalizeThemeToken(raw, "insetShadow", defaultCustomThemeMoodMeter.insetShadow ?? "none"),
    frame: ["soft-pill","rounded","sharp","pixel","cut-corner"].includes(String(raw.frame))
      ? raw.frame as NonNullable<PetCustomTheme["moodMeter"]>["frame"] : defaultCustomThemeMoodMeter.frame,
    particleStyle: ["float","dust","pixel","scan","minimal"].includes(String(raw.particleStyle))
      ? raw.particleStyle as NonNullable<PetCustomTheme["moodMeter"]>["particleStyle"] : defaultCustomThemeMoodMeter.particleStyle,
    effectStyle: ["halo","lightning","pixel","ink","scan","minimal"].includes(String(raw.effectStyle))
      ? raw.effectStyle as NonNullable<PetCustomTheme["moodMeter"]>["effectStyle"] : defaultCustomThemeMoodMeter.effectStyle,
    ranges
  };
}

export async function saveLocalPetMoodSettings(
  draft: LocalPetMoodSettingsDraft
): Promise<LocalPetSaveResult> {
  const petId = assertValidPetId(draft.petId);
  const settings = normalizePetMoodSettings(draft.settings) ?? {};
  return withPetWriteLock(petId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });
    if (!pet) return { ok: false, message: "请先保存基础信息，再配置心情。" };
    const availableSources = new Set((pet.expressionSources ?? []).map((source) =>
      `${source.sourceKind}:${source.sourceFileName}:${String(source.runtimeName ?? "")}`));
    for (const range of Object.values(settings.ranges ?? {})) {
      const source = range.enterSource;
      if (source && !availableSources.has(`${source.sourceKind}:${source.sourceFileName}:${String(source.runtimeName ?? "")}`)) {
        return { ok: false, message: "所选心情表现源已不存在，请重新选择。" };
      }
    }
    const nextPet: PetDefinition = { ...pet, moodSettings: settings, isLocal: true };
    await writePetConfigUnlocked(petId, nextPet);
    await removeUnreferencedPresetAudio(petId, pet, nextPet);
    return { ok: true, message: "心情配置已保存。", pet: nextPet };
  });
}

export async function importLocalPetMoodVoice(request: PetMoodVoiceImportRequest): Promise<PetMoodVoiceImportResult & { pet?: PetDefinition }> {
  const petId = assertValidPetId(request.petId);
  const referenceText = request.referenceText.trim();
  if (referenceText.length > 500) return { ok: false, message: "请填写 500 字以内的参考文本。" };
  const picked = await dialog.showOpenDialog({ title: "选择心情参考音频", properties: ["openFile"], filters: [{ name: "音频", extensions: ["wav","mp3","flac","ogg","m4a"] }] });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true, message: "已取消导入。" };
  const sourcePath = picked.filePaths[0];
  try { await validateReferenceAudioDuration(sourcePath); } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "参考音频无效。" }; }
  return withPetWriteLock(petId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });
    if (!pet) return { ok: false, message: "桌宠不存在。" };
    const extension = path.extname(sourcePath).toLowerCase();
    const fileName = `reference${extension}`;
    const voiceRoot = getMoodVoiceRootPath(petId);
    const rangePath = getMoodVoiceRangePath(petId, request.rangeId);
    const stagingPath = path.join(voiceRoot, `.staging-${request.rangeId}-${randomUUID()}`);
    const backupPath = path.join(voiceRoot, `.backup-${request.rangeId}-${randomUUID()}`);
    await fs.mkdir(voiceRoot, { recursive: true });
    const realPet = await fs.realpath(getPetDirectoryPath(petId));
    const realVoiceRoot = await fs.realpath(voiceRoot);
    assertContainedPath(realPet, realVoiceRoot, "心情语音目录越界。");
    await fs.mkdir(stagingPath);
    try {
      const stagedFile = path.join(stagingPath, fileName);
      await fs.copyFile(sourcePath, stagedFile);
      await validateReferenceAudioDuration(stagedFile);
      const realStaged = await fs.realpath(stagedFile);
      assertContainedPath(await fs.realpath(stagingPath), realStaged, "心情语音文件越界。");
      const oldExists = await fs.access(rangePath).then(() => true, () => false);
      if (oldExists) {
        const oldStat = await fs.lstat(rangePath);
        if (oldStat.isSymbolicLink()) throw new Error("心情语音目录不能是符号链接或联接。");
        assertContainedPath(realVoiceRoot, await fs.realpath(rangePath), "心情语音目录越界。");
        await fs.rename(rangePath, backupPath);
      }
      await fs.rename(stagingPath, rangePath);
      let nextPet: PetDefinition | undefined;
      if (referenceText) {
        nextPet = {
          ...pet,
          moodSettings: { ranges: { ...(pet.moodSettings?.ranges ?? {}), [request.rangeId]: {
            ...(pet.moodSettings?.ranges?.[request.rangeId] ?? {}),
            voiceOverride: { referenceAudio: fileName, referenceText }
          } } },
          isLocal: true
        };
        try { await writePetConfigUnlocked(petId, nextPet); }
        catch (error) {
          await fs.rm(rangePath, { recursive: true, force: true });
          if (oldExists) await fs.rename(backupPath, rangePath);
          throw error;
        }
      }
      await fs.rm(backupPath, { recursive: true, force: true });
      return referenceText
        ? { ok: true, message: "心情参考音频已导入。", fileName, persisted: true, pet: nextPet }
        : { ok: true, message: "参考音频已导入，请填写音频中实际说出的内容并保存。", fileName, persisted: false };
    } finally { await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined); }
  });
}

export async function removeLocalPetMoodVoice(request: PetMoodVoiceRemoveRequest): Promise<LocalPetSaveResult> {
  const petId = assertValidPetId(request.petId);
  return withPetWriteLock(petId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });
    if (!pet) return { ok: false, message: "桌宠不存在。" };
    const ranges = { ...(pet.moodSettings?.ranges ?? {}) };
    const current = ranges[request.rangeId];
    if (current) {
      const { voiceOverride: _removed, ...remaining } = current;
      if (Object.keys(remaining).length) ranges[request.rangeId] = remaining;
      else delete ranges[request.rangeId];
    }
    const nextPet = { ...pet, moodSettings: { ranges }, isLocal: true };
    await writePetConfigUnlocked(petId, nextPet);
    const rangePath = getMoodVoiceRangePath(petId, request.rangeId);
    const exists = await fs.access(rangePath).then(() => true, () => false);
    if (exists) {
      const stat = await fs.lstat(rangePath);
      if (stat.isSymbolicLink()) throw new Error("拒绝删除符号链接或联接形式的心情语音目录。");
      const voiceRoot = await fs.realpath(getMoodVoiceRootPath(petId));
      assertContainedPath(voiceRoot, await fs.realpath(rangePath), "心情语音目录越界。");
      await fs.rm(rangePath, { recursive: true, force: true });
    }
    return { ok: true, message: "心情参考音频已移除。", pet: nextPet };
  });
}

export async function cleanupOrphanedAvatarDrafts(): Promise<void> {
  let entries: fsSync.Dirent[];

  try {
    entries = await fs.readdir(getPetsRootPath(), { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && avatarDraftPetIdPattern.test(entry.name))
      .map((entry) =>
        withPetWriteLock(entry.name, async () => {
          try {
            await removeAvatarDraftDirectory(entry.name);
          } catch (error) {
            console.warn("Failed to clean orphaned avatar draft.", entry.name, error);
          }
        })
      )
  );
}

export async function cleanupInterruptedPetDeletions(
  finalizeDeletion?: (petId: string) => Promise<void>
): Promise<string[]> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(getPetsRootPath(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const deletedPetIds: string[] = [];
  for (const entry of entries) {
    const petId = getPetIdFromDeletionDirectory(entry.name);
    if (!petId) continue;
    const target = path.join(getPetsRootPath(), entry.name);
    try {
      await withPetWriteLock(petId, async () => {
        // Never clean credentials belonging to a new/externally restored pet.
        const active = path.join(getPetsRootPath(), petId);
        if (await fs.lstat(active).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        })) throw new Error("PET_DELETION_ID_CONFLICT");
        await completePetDeletion(petId, target, { finalizeDeletion });
      });
      deletedPetIds.push(petId);
    } catch (error) {
      console.warn("Failed to resume an interrupted pet deletion.", petId);
    }
  }
  return deletedPetIds;
}

export async function importLocalUiTheme(): Promise<PetCustomThemeImportResult> {
  const result = await dialog.showOpenDialog({
    title: "导入主题风格",
    properties: ["openFile"],
    filters: [
      {
        name: "主题 JSON",
        extensions: ["json"]
      }
    ]
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      ok: false,
      canceled: true,
      message: "已取消导入。"
    };
  }

  try {
    const filePath = result.filePaths[0];
    const stat = await fs.stat(filePath);

    if (stat.size > 256 * 1024) {
      return {
        ok: false,
        message: "主题文件过大，请导入 256KB 以内的 JSON 文件。"
      };
    }

    const content = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    const theme = {
      ...normalizeCustomTheme(JSON.parse(content), path.basename(filePath, path.extname(filePath))),
      importedAt: new Date().toISOString()
    };
    return {
      ok: true,
      message: `已读取主题「${theme.name}」，保存后仅应用于当前桌宠。`,
      theme
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "主题导入失败。"
    };
  }
}

async function saveLocalPetBasicInfoForId(
  draft: LocalPetBasicInfoDraft,
  petId: string
): Promise<LocalPetSaveResult> {
  return withPetWriteLock(petId, async () => {
    const avatarImage = await copyAvatarIntoPetDirectory(draft.avatarImage as string, petId);
    const existingPet = await readPetConfigUnlocked(getPetConfigPath(petId), {
      forMutation: true
    });
    const pet = mergeBasicInfoIntoPet(existingPet, draft, petId, avatarImage);

    await writePetConfigUnlocked(petId, pet);
    await cleanupAvatarDraftAfterSave(draft.avatarImage as string, petId);

    return {
      ok: true,
      message: "保存成功。",
      pet
    };
  });
}

export async function saveLocalPetBasicInfo(
  draft: LocalPetBasicInfoDraft
): Promise<LocalPetSaveResult> {
  const name = draft.name.trim();

  if (!name) {
    return {
      ok: false,
      message: "请填写桌宠名称。"
    };
  }

  if (!draft.avatarImage) {
    return {
      ok: false,
      message: "请上传桌宠头像。"
    };
  }

  if (draft.id) {
    return saveLocalPetBasicInfoForId(draft, assertValidPetId(draft.id));
  }

  return withPetIdAllocationLock(async () => {
    const petId = await ensureUniquePetId(slugifyName(name));
    return saveLocalPetBasicInfoForId(draft, petId);
  });
}

export async function saveLocalPetPersona(
  draft: LocalPetPersonaDraft
): Promise<LocalPetSaveResult> {
  const rawPetId = draft.petId;

  if (!rawPetId.trim()) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petId = assertValidPetId(rawPetId);

  assertSafePetDirectory(petId);

  return withPetWriteLock(petId, async () => {
  const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再编辑角色人设。"
    };
  }

  const nextPet: PetDefinition = {
    ...pet,
    personaPrompt: draft.personaPrompt,
    personaSettings: {
      chatLanguage: draft.chatLanguage,
      replyLength: draft.replyLength
    },
    isLocal: true
  };

  await writePetConfigUnlocked(petId, nextPet);

  return {
    ok: true,
    message: "角色人设已保存。",
    pet: nextPet
  };
  });
}

export async function saveLocalPetExpressionMappings(
  draft: LocalPetExpressionMappingDraft
): Promise<LocalPetSaveResult> {
  const rawPetId = draft.petId;

  if (!rawPetId.trim()) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petId = assertValidPetId(rawPetId);

  assertSafePetDirectory(petId);

  return withPetWriteLock(petId, async () => {
  const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置表现映射。"
    };
  }

  const expressions: PetDefinition["expressions"] = {};
  const expressionDescriptions: PetDefinition["expressionDescriptions"] = {};
  const expressionSourceKinds: PetDefinition["expressionSourceKinds"] = {};
  const expressionSourceFiles: PetDefinition["expressionSourceFiles"] = {};
  const expressionEffects: NonNullable<PetDefinition["expressionEffects"]> = {};
  const importedSources = pet.expressionSources ?? [];
  const importedSourceIds = new Set(importedSources.map((source) =>
    `${source.sourceKind}\u0000${source.sourceFileName}\u0000${String(source.runtimeName ?? "")}`));
  const mappingKeyCounts = new Map<string, number>();

  for (const item of draft.mappings) {
    const key = item.mappingKey.trim();

    if (!key) {
      continue;
    }

    mappingKeyCounts.set(key, (mappingKeyCounts.get(key) ?? 0) + 1);
  }

  const invalidKeys = [...mappingKeyCounts.keys()].filter((key) => !expressionMappingKeyPattern.test(key));
  const duplicateKeys = [...mappingKeyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);

  if (invalidKeys.length || duplicateKeys.length) {
    return {
      ok: false,
      message: [
        invalidKeys.length ? `映射 key 只能填写英文开头的英文、数字、下划线或短横线：${invalidKeys.join("、")}。` : "",
        duplicateKeys.length ? `映射 key 不能重复：${duplicateKeys.join("、")}。` : ""
      ].filter(Boolean).join(" ")
    };
  }

  for (const item of draft.mappings) {
    const key = item.mappingKey.trim();
    const sourceFileName = item.sourceFileName.trim();
    const description = item.description.trim();
    const runtimeName =
      typeof item.runtimeName === "number" ? item.runtimeName : item.runtimeName?.trim();

    if (!key || !sourceFileName || !description) {
      continue;
    }

    const sourceId = `${item.sourceKind}\u0000${sourceFileName}\u0000${String(runtimeName ?? "")}`;
    if (!importedSourceIds.has(sourceId)) {
      return {
        ok: false,
        message: `表现源「${sourceFileName}」不属于当前已导入的 Live2D 模型，请刷新后重试。`
      };
    }

    expressions[key] = runtimeName === undefined || runtimeName === "" ? sourceFileName : runtimeName;
    expressionSourceKinds[key] = item.sourceKind;
    expressionSourceFiles[key] = sourceFileName;
    expressionDescriptions[key] = description;

    const effects = item.effects ?? pet.expressionEffects?.[key];

    if (effects) {
      expressionEffects[key] = effects;
    }
  }

  const nextPet: PetDefinition = {
    ...pet,
    expressions,
    expressionDescriptions,
    expressionSelectionMode: draft.expressionSelectionMode ?? "semantic",
    expressionRandomScope: draft.expressionRandomScope ?? "all",
    expressionSourceKinds,
    expressionSourceFiles,
    expressionEffects,
    // The import scanner owns this catalog. Mapping saves may reference it but
    // must never replace it with renderer-provided values.
    expressionSources: importedSources,
    isLocal: true
  };

  await writePetConfigUnlocked(petId, nextPet);

  return {
    ok: true,
    message: "表现映射已保存，AI 会使用这些 key 和描述。",
    pet: nextPet
  };
  });
}

function normalizeDurationMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(Math.min(Math.max(value ?? fallback, 500), 12000));
}

function getPetLineText(line: PetLine): string {
  return typeof line === "string" ? line : line.text;
}

function normalizePetLine(line: PetLine): PetLine | undefined {
  const text = getPetLineText(line).trim();

  if (!text) {
    return undefined;
  }

  return typeof line === "string" ? text : { ...line, text };
}

function normalizeExpressionSource(
  source: LocalPetEventSettingsDraft["events"][number]["source"] | undefined
): NonNullable<LocalPetEventSettingsDraft["events"][number]["source"]> | undefined {
  const sourceFileName = source?.sourceFileName.trim();

  if (!source || !sourceFileName) {
    return undefined;
  }

  const runtimeName =
    typeof source.runtimeName === "number" ? source.runtimeName : source.runtimeName?.trim();

  return {
    sourceFileName,
    runtimeName,
    sourceKind: source.sourceKind,
    description: source.description?.trim() || undefined,
    effects: source.effects
  };
}

export async function saveLocalPetEventSettings(
  draft: LocalPetEventSettingsDraft
): Promise<LocalPetSaveResult> {
  const rawPetId = draft.petId;

  if (!rawPetId.trim()) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petId = assertValidPetId(rawPetId);

  assertSafePetDirectory(petId);

  return withPetWriteLock(petId, async () => {
  const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置事件。"
    };
  }

  const mappedExpressionKeys = new Set(Object.keys(pet.expressions ?? {}));
  const lines: PetLineMap = { ...(pet.lines ?? {}) };
  const eventSettings: PetEventSettingsMap = { ...(pet.eventSettings ?? {}) };

  for (const item of draft.events) {
    const eventName = item.event.trim();

    if (!eventName) {
      continue;
    }

    const nextLines = item.lines
      .map(normalizePetLine)
      .filter((line): line is PetLine => Boolean(line));
    const source = normalizeExpressionSource(item.source);
    const expression = item.expression?.trim();
    const hasMappedExpression = Boolean(expression && mappedExpressionKeys.has(expression));
    const hasEventOverride =
      Boolean(source) || hasMappedExpression || nextLines.length > 0 || item.showSubtitle === false;
    const previousEventSettings = eventSettings[eventName] ?? {};
    const preservedEventSettings = { ...previousEventSettings };

    delete preservedEventSettings.expression;
    delete preservedEventSettings.expressionDurationMs;
    delete preservedEventSettings.source;
    delete preservedEventSettings.sourceDurationMs;
    delete preservedEventSettings.subtitleHoldMs;
    delete preservedEventSettings.showSubtitle;

    delete lines[eventName];

    if (!hasEventOverride) {
      if (Object.keys(preservedEventSettings).length) {
        eventSettings[eventName] = preservedEventSettings;
      } else {
        delete eventSettings[eventName];
      }
      continue;
    }

    if (nextLines.length) {
      lines[eventName] = nextLines;
    }

    eventSettings[eventName] = {
      ...preservedEventSettings,
      ...(item.showSubtitle === false ? { showSubtitle: false } : {}),
      ...(source
        ? {
            source,
            sourceDurationMs: normalizeDurationMs(
              item.sourceDurationMs ?? item.expressionDurationMs,
              2600
            )
          }
        : {
            expression: hasMappedExpression ? expression : undefined,
            expressionDurationMs: normalizeDurationMs(item.expressionDurationMs, 2600)
          })
    };
  }

  const nextPet: PetDefinition = {
    ...pet,
    lines,
    eventSettings,
    isLocal: true
  };

  await writePetConfigUnlocked(petId, nextPet);
  await removeUnreferencedPresetAudio(petId, pet, nextPet);

  return {
    ok: true,
    message: "事件配置已保存。",
    pet: nextPet
  };
  });
}

function collectPresetAudioReferences(pet: PetDefinition): Map<string, PetPresetAudio> {
  const references = new Map<string, PetPresetAudio>();
  const add = (line: PetLine | undefined): void => {
    if (!line || typeof line === "string" || !line.presetAudio) return;
    const audio = line.presetAudio;
    references.set(`${audio.mimeType}\u0000${audio.resourceId}`, audio);
  };

  for (const eventLines of Object.values(pet.lines ?? {})) {
    for (const line of eventLines ?? []) add(line);
  }
  for (const range of Object.values(pet.moodSettings?.ranges ?? {})) {
    add(range?.enterLine);
  }

  return references;
}

async function removeUnreferencedPresetAudio(
  petId: string,
  previousPet: PetDefinition,
  nextPet: PetDefinition
): Promise<void> {
  const previous = collectPresetAudioReferences(previousPet);
  const next = collectPresetAudioReferences(nextPet);
  await Promise.all([...previous].flatMap(([key, audio]) =>
    next.has(key) ? [] : [removePresetVoiceAudio({ petId, ...audio })]
  ));
}

export async function commitLocalPetPresetAudio(options: {
  petId: string;
  target: PresetVoiceTarget;
  audio: PetPresetAudio;
}): Promise<{ pet: PetDefinition; previousAudio?: PetPresetAudio }> {
  const petId = assertValidPetId(options.petId);
  return withPetWriteLock(petId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });
    if (!pet) throw new Error("当前桌宠配置不存在。");
    let previousAudio: PetPresetAudio | undefined;
    let changed = false;
    const stableLineId = options.target.lineId ?? `line_${randomUUID().replace(/-/g, "")}`;

    if (options.target.kind === "event-line") {
      const event = options.target.event;
      if (!event) throw new Error("事件台词目标无效。");
      const currentLines = [...(pet.lines?.[event] ?? [])];
      const indexById = options.target.lineId
        ? currentLines.findIndex((line) => typeof line === "object" && line.id === options.target.lineId)
        : -1;
      const lineIndex = indexById >= 0 ? indexById : options.target.lineIndex ?? -1;
      const currentLine = currentLines[lineIndex];
      if (!currentLine || hashPresetVoiceText(getPetLineText(currentLine)) !== options.audio.sourceTextHash) {
        throw new Error("台词在生成期间已修改，本次结果未保存。");
      }
      previousAudio = typeof currentLine === "object" ? currentLine.presetAudio : undefined;
      currentLines[lineIndex] = {
        ...(typeof currentLine === "object" ? currentLine : {}),
        id: stableLineId,
        text: getPetLineText(currentLine).trim(),
        presetAudio: options.audio,
        audioPath: undefined
      };
      pet.lines = { ...(pet.lines ?? {}), [event]: currentLines };
      changed = true;
    } else {
      const rangeId = options.target.moodRangeId;
      if (!rangeId) throw new Error("心情台词目标无效。");
      const currentRange = pet.moodSettings?.ranges?.[rangeId];
      const currentLine = currentRange?.enterLine;
      if (!currentLine || hashPresetVoiceText(getPetLineText(currentLine)) !== options.audio.sourceTextHash) {
        throw new Error("心情台词在生成期间已修改，本次结果未保存。");
      }
      if (options.target.lineId && (typeof currentLine !== "object" || currentLine.id !== options.target.lineId)) {
        throw new Error("心情台词标识已变化，本次结果未保存。");
      }
      previousAudio = typeof currentLine === "object" ? currentLine.presetAudio : undefined;
      pet.moodSettings = {
        ...(pet.moodSettings ?? {}),
        ranges: {
          ...(pet.moodSettings?.ranges ?? {}),
          [rangeId]: {
            ...currentRange,
            enterLine: {
              ...(typeof currentLine === "object" ? currentLine : {}),
              id: stableLineId,
              text: getPetLineText(currentLine).trim(),
              presetAudio: options.audio,
              audioPath: undefined
            }
          }
        }
      };
      changed = true;
    }

    if (!changed) throw new Error("没有找到待保存的预设台词。");
    const nextPet = { ...pet, isLocal: true };
    await writePetConfigUnlocked(petId, nextPet);
    return { pet: nextPet, ...(previousAudio ? { previousAudio } : {}) };
  });
}

export async function clearLocalPetPresetAudioTarget(options: {
  petId: string;
  target: PresetVoiceTarget;
}): Promise<{
  pet: PetDefinition;
  removed?: PetPresetAudio;
  shouldDeleteFile: boolean;
}> {
  const petId = assertValidPetId(options.petId);
  return withPetWriteLock(petId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });
    if (!pet) throw new Error("当前桌宠配置不存在。");
    let removed: PetPresetAudio | undefined;

    if (options.target.kind === "event-line") {
      const event = options.target.event;
      if (!event) throw new Error("事件台词目标无效。");
      const currentLines = [...(pet.lines?.[event] ?? [])];
      const indexById = options.target.lineId
        ? currentLines.findIndex((line) => typeof line === "object" && line.id === options.target.lineId)
        : -1;
      const lineIndex = indexById >= 0 ? indexById : options.target.lineIndex ?? -1;
      const currentLine = currentLines[lineIndex];
      if (!currentLine || hashPresetVoiceText(getPetLineText(currentLine)) !== hashPresetVoiceText(options.target.text)) {
        throw new Error("台词已修改，请刷新后重试。");
      }
      if (typeof currentLine === "object" && currentLine.presetAudio) {
        removed = currentLine.presetAudio;
        const { presetAudio: _audio, ...rest } = currentLine;
        currentLines[lineIndex] = rest;
        pet.lines = { ...(pet.lines ?? {}), [event]: currentLines };
      }
    } else {
      const rangeId = options.target.moodRangeId;
      if (!rangeId) throw new Error("心情台词目标无效。");
      const currentRange = pet.moodSettings?.ranges?.[rangeId];
      const currentLine = currentRange?.enterLine;
      if (!currentLine || hashPresetVoiceText(getPetLineText(currentLine)) !== hashPresetVoiceText(options.target.text)) {
        throw new Error("心情台词已修改，请刷新后重试。");
      }
      if (typeof currentLine === "object" && currentLine.presetAudio) {
        removed = currentLine.presetAudio;
        const { presetAudio: _audio, ...rest } = currentLine;
        pet.moodSettings = {
          ...(pet.moodSettings ?? {}),
          ranges: {
            ...(pet.moodSettings?.ranges ?? {}),
            [rangeId]: { ...currentRange, enterLine: rest }
          }
        };
      }
    }

    if (!removed) return { pet, shouldDeleteFile: false };
    const nextPet: PetDefinition = { ...pet, isLocal: true };
    await writePetConfigUnlocked(petId, nextPet);
    const key = `${removed.mimeType}\u0000${removed.resourceId}`;
    return {
      pet: nextPet,
      removed,
      shouldDeleteFile: !collectPresetAudioReferences(nextPet).has(key)
    };
  });
}

export async function clearLocalPetPresetAudio(petIdValue: string): Promise<{
  pet: PetDefinition;
  removed: PetPresetAudio[];
}> {
  const petId = assertValidPetId(petIdValue);
  return withPetWriteLock(petId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });
    if (!pet) throw new Error("当前桌宠配置不存在。");
    const removed: PetPresetAudio[] = [];
    const lines = Object.fromEntries(Object.entries(pet.lines ?? {}).map(([event, eventLines]) => [
      event,
      (eventLines ?? []).map((line) => {
        if (typeof line === "string" || !line.presetAudio) return line;
        removed.push(line.presetAudio);
        const { presetAudio: _audio, ...rest } = line;
        return rest;
      })
    ])) as PetLineMap;
    const ranges = Object.fromEntries(Object.entries(pet.moodSettings?.ranges ?? {}).map(([rangeId, range]) => {
      const line = range?.enterLine;
      if (!line || typeof line === "string" || !line.presetAudio) return [rangeId, range];
      removed.push(line.presetAudio);
      const { presetAudio: _audio, ...rest } = line;
      return [rangeId, { ...range, enterLine: rest }];
    })) as NonNullable<PetMoodSettings["ranges"]>;
    const nextPet: PetDefinition = {
      ...pet,
      lines,
      moodSettings: pet.moodSettings ? { ...pet.moodSettings, ranges } : undefined,
      isLocal: true
    };
    if (removed.length) await writePetConfigUnlocked(petId, nextPet);
    return { pet: nextPet, removed };
  });
}

export async function saveLocalPetUiSettings(
  draft: LocalPetUiSettingsDraft
): Promise<LocalPetSaveResult> {
  const rawPetId = draft.petId;

  if (!rawPetId.trim()) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petId = assertValidPetId(rawPetId);

  assertSafePetDirectory(petId);

  return withPetWriteLock(petId, async () => {
  const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置交互面板。"
    };
  }

  const customThemeSource = draft.removeCustomTheme
    ? undefined
    : draft.customTheme ?? pet.uiSettings?.customTheme;
  const customTheme = customThemeSource
    ? normalizeCustomTheme(customThemeSource, customThemeSource.name)
    : undefined;

  if (draft.theme === "custom" && !customTheme) {
    return {
      ok: false,
      message: "没有找到这个本地主题，请重新导入。"
    };
  }

  const clickThroughOpacitySource =
    typeof draft.clickThroughOpacity === "number" && Number.isFinite(draft.clickThroughOpacity)
      ? draft.clickThroughOpacity
      : pet.uiSettings?.clickThroughOpacity;
  const clickThroughOpacity =
    typeof clickThroughOpacitySource === "number" && Number.isFinite(clickThroughOpacitySource)
      ? Math.min(1, Math.max(0.2, Math.round(clickThroughOpacitySource * 100) / 100))
      : 0.45;
  const cursorFollowEnabled =
    typeof draft.cursorFollowEnabled === "boolean"
      ? draft.cursorFollowEnabled
      : pet.uiSettings?.cursorFollowEnabled !== false;
  const desktopScale = normalizePetDesktopScale(
    draft.desktopScale ?? pet.uiSettings?.desktopScale
  );
  const desktopPosition = normalizePetDesktopPosition(pet.uiSettings?.desktopPosition);

  const nextPet: PetDefinition = {
    ...pet,
    uiSettings: {
      theme: draft.theme,
      ...(customTheme ? { customTheme } : {}),
      clickThroughOpacity,
      cursorFollowEnabled,
      desktopScale,
      desktopPosition
    },
    isLocal: true
  };

  await writePetConfigUnlocked(petId, nextPet);

  return {
    ok: true,
    message: "交互面板已保存。",
    pet: nextPet
  };
  });
}

export async function saveLocalPetScreenAwareness(
  draft: LocalPetScreenAwarenessDraft
): Promise<LocalPetSaveResult> {
  const rawPetId = draft.petId;
  if (!rawPetId.trim()) {
    return { ok: false, message: "缺少桌宠 ID。" };
  }

  const petId = assertValidPetId(rawPetId);
  const mode = draft.mode ?? "quiet";
  if (mode !== "quiet" && mode !== "companion") {
    return { ok: false, message: "屏幕观察模式无效。" };
  }

  return withPetWriteLock(petId, async () => {
    const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });
    if (!pet) return { ok: false, message: "请先保存基础信息，再开启视觉功能。" };

    const nextPet: PetDefinition = {
      ...pet,
      screenAwarenessSettings: {
        enabled: draft.enabled,
        mode,
        persistentCaptureEnabled:
          draft.persistentCaptureEnabled ?? pet.screenAwarenessSettings?.persistentCaptureEnabled ?? false
      },
      isLocal: true
    };
    await writePetConfigUnlocked(petId, nextPet);
    return {
      ok: true,
      message: draft.enabled ? "视觉功能已开启。" : "视觉功能已关闭。",
      pet: nextPet
    };
  });
}

export async function saveLocalPetVoiceInput(
  draft: LocalPetVoiceInputDraft
): Promise<LocalPetSaveResult> {
  const rawPetId = draft.petId;

  if (!rawPetId.trim()) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petId = assertValidPetId(rawPetId);

  const enteredCredentials: TencentAsrCredentials = {
    appId: draft.appId.trim(),
    secretId: draft.secretId.trim(),
    secretKey: draft.secretKey.trim()
  };
  const enteredCredentialValues = Object.values(enteredCredentials);
  const hasEnteredCredential = enteredCredentialValues.some(Boolean);
  const hasCompleteEnteredCredentials = enteredCredentialValues.every(Boolean);

  if (hasEnteredCredential && !hasCompleteEnteredCredentials) {
    return {
      ok: false,
      message: "更新腾讯云凭据时，请完整填写 AppID、SecretId 和 SecretKey。"
    };
  }

  assertSafePetDirectory(petId);

  return withPetWriteLock(petId, async () => {
  const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置语音输入。"
    };
  }

  let existingCredentials: TencentAsrCredentials | undefined;

  try {
    existingCredentials = parseTencentAsrCredentials(
      await getSecureString(tencentAsrSecretScope, petId)
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "本机安全凭据读取失败。"
    };
  }

  const credentials = hasCompleteEnteredCredentials ? enteredCredentials : existingCredentials;

  if (!credentials) {
    return {
      ok: false,
      message: "请先填写 AppID、SecretId 和 SecretKey。"
    };
  }

  if (hasCompleteEnteredCredentials) {
    try {
      await setSecureString(tencentAsrSecretScope, petId, JSON.stringify(credentials));
      const verifiedCredentials = parseTencentAsrCredentials(
        await getSecureString(tencentAsrSecretScope, petId)
      );

      if (!areTencentAsrCredentialsEqual(verifiedCredentials, credentials)) {
        throw new Error("腾讯云语音凭据保存后的安全存储校验失败。");
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "本机安全凭据保存失败。"
      };
    }
  }

  const nextPet: PetDefinition = {
    ...pet,
    capabilities: {
      ...pet.capabilities,
      voiceInput: draft.connected
    },
    voiceInputSettings: {
      provider: "tencent-asr",
      hasCredentials: true,
      connected: draft.connected,
      autoEndEnabled: draft.autoEndEnabled,
      silenceSeconds: normalizeVoiceInputSilenceSeconds(draft.silenceSeconds),
      volumeThreshold: draft.volumeThreshold,
      continuousConversationEnabled: draft.continuousConversationEnabled
    },
    isLocal: true
  };

  await writePetConfigUnlocked(petId, nextPet);

  return {
    ok: true,
    message: "语音输入配置已保存。",
    pet: nextPet
  };
  });
}

export async function pickLocalPetVoiceModelFile(
  kind: LocalPetVoiceResourceKind
): Promise<LocalPetVoiceModelFilePickResult> {
  const filters: Record<LocalPetVoiceResourceKind, Electron.FileFilter[]> = {
    sovits: [{ name: "SoVITS 模型", extensions: ["pth"] }],
    gpt: [{ name: "GPT 模型", extensions: ["ckpt"] }],
    referenceAudio: [{ name: "参考音频", extensions: ["wav", "mp3", "flac", "ogg", "m4a"] }]
  };

  const result = await dialog.showOpenDialog({
    title: "选择声音资源",
    filters: filters[kind],
    properties: ["openFile"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      ok: false,
      message: "未选择文件。"
    };
  }

  if (kind === "referenceAudio") {
    try {
      await validateReferenceAudioDuration(result.filePaths[0]);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "参考音频校验失败。"
      };
    }
  }

  return {
    ok: true,
    message: "已选择文件。",
    filePath: result.filePaths[0],
    fileName: path.basename(result.filePaths[0])
  };
}

async function testLocalPetVoiceModelConnectionInternal(
  draft: LocalPetVoiceModelDraft
): Promise<LocalPetVoiceModelConnectionResult> {
  try {
    requireVoiceModelVersion(draft.modelVersion);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "声音模型版本无效。"
    };
  }

  if (!draft.referenceText.trim()) {
    return {
      ok: false,
      message: "请先填写参考文本。"
    };
  }

  try {
    await validateVoiceModelResources(draft);
    await validateReferenceAudioDuration(draft.referenceAudioPath ?? "");
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "声音模型资源校验失败，请重新选择。"
    };
  }

  try {
    const endpoint = await ensureGptSoVitsEndpoint(draft.petId);
    await launchGptSoVitsApiIfNeeded(draft);
    const connected = await waitForGptSoVitsApi(endpoint.baseUrl, 120_000);

    if (!connected) {
      return {
        ok: false,
        message: [
          "已尝试启动 GPT-SoVITS，但 120 秒内没有检测到 API 服务。",
          await readRecentGptSoVitsLog(draft.petId)
        ]
          .filter(Boolean)
          .join("\n\n最近日志：\n")
      };
    }

    const synthesisController = new AbortController();
    const synthesisTimeout = setTimeout(() => synthesisController.abort("timeout"), 45_000);
    const synthesis = await testTextToSpeechConnection(
      {
        petId: draft.petId,
        requestId: `connection-test-${Date.now()}`,
        text: draft.language === "ja" ? "うん。" : draft.language === "en" ? "Mm." : "嗯。"
      },
      {
        baseUrl: endpoint.baseUrl,
        apiMode: "v2",
        refAudioPath: draft.referenceAudioPath ?? "",
        promptText: draft.referenceText.trim(),
        promptLang: draft.referenceLanguage ?? draft.language,
        textLang: draft.language,
        textSplitMethod: "cut5",
        mediaType: "wav"
      },
      synthesisController.signal
    ).finally(() => clearTimeout(synthesisTimeout));

    if (!synthesis.ok || !synthesis.audioBase64?.trim()) {
      return {
        ok: false,
        message: `API 已连接，但真实语音合成失败：${synthesis.message || "没有返回音频数据。"}`
      };
    }

    return {
      ok: true,
      message: "已连接，并完成真实语音合成测试。"
    };
  } catch (error) {
    const recentLog = await readRecentGptSoVitsLog(draft.petId);

    return {
      ok: false,
      message: [
        error instanceof Error ? error.message : "无法启动或连接本机 GPT-SoVITS。",
        recentLog
      ]
        .filter(Boolean)
        .join("\n\n最近日志：\n")
    };
  }
}

/** Serialize endpoint allocation and managed process startup across editor actions. */
export async function testLocalPetVoiceModelConnection(
  draft: LocalPetVoiceModelDraft
): Promise<LocalPetVoiceModelConnectionResult> {
  const run = voiceConnectionQueue.then(() => testLocalPetVoiceModelConnectionInternal(draft));
  voiceConnectionQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function saveLocalPetVoiceModel(
  draft: LocalPetVoiceModelDraft
): Promise<LocalPetSaveResult> {
  const rawPetId = draft.petId;

  if (!rawPetId.trim()) {
    return {
      ok: false,
      message: "缺少桌宠 ID。"
    };
  }

  const petId = assertValidPetId(rawPetId);

  assertSafePetDirectory(petId);

  let modelVersion: PetVoiceModelVersion;

  try {
    modelVersion = requireVoiceModelVersion(draft.modelVersion);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "声音模型版本无效。"
    };
  }

  if (draft.enabled || draft.connected) {
    if (!draft.referenceText.trim()) {
      return {
        ok: false,
        message: "请先填写参考文本。"
      };
    }

    try {
      await validateVoiceModelResources(draft);
      await validateReferenceAudioDuration(draft.referenceAudioPath ?? "");
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "声音模型资源校验失败，请重新选择。"
      };
    }
  }

  return withPetWriteLock(petId, async () => {
  const pet = await readPetConfigUnlocked(getPetConfigPath(petId), { forMutation: true });

  if (!pet) {
    return {
      ok: false,
      message: "请先保存基础信息，再配置声音模型。"
    };
  }

  const nextPet: PetDefinition = {
    ...pet,
    capabilities: {
      ...pet.capabilities,
      voiceOutput: draft.enabled
    },
    voiceModelSettings: {
      enabled: draft.enabled,
      connected: draft.connected,
      modelVersion,
      gptSoVitsRootPath: draft.gptSoVitsRootPath,
      sovitsModelPath: draft.sovitsModelPath,
      gptModelPath: draft.gptModelPath,
      referenceAudioPath: draft.referenceAudioPath,
      referenceText: draft.referenceText,
      referenceLanguage: draft.referenceLanguage,
      language: draft.language,
      playMode: "sentence",
      inferenceDevice: normalizeVoiceInferenceDevice(draft.inferenceDevice),
      halfPrecision: draft.halfPrecision ?? defaultVoiceHalfPrecision,
      syncTextWithVoice: draft.syncTextWithVoice ?? true
    },
    isLocal: true
  };

  await writePetConfigUnlocked(petId, nextPet);

  if (nextPet.voiceModelSettings?.enabled && nextPet.voiceModelSettings.connected) {
    void warmUpTextToSpeech(petId);
  }

  return {
    ok: true,
    message: "声音模型配置已保存。",
    pet: nextPet
  };
  });
}

export async function restoreLocalPetConfigBackup(
  petId: string
): Promise<LocalPetSaveResult> {
  const targetPetId = assertValidPetId(petId);
  let publicPet: PetDefinition | undefined;

  try {
    const restoredPet = await restorePetConfigBackupAtomically(
      targetPetId,
      (backupPet) => {
        if (readLegacyTencentAsrCredentials(backupPet)) {
          throw new Error(
            "备份仍包含旧版明文语音凭据，为避免凭据重新落盘，已拒绝直接恢复。"
          );
        }

        publicPet = toPublicPetDefinition({
          ...backupPet,
          avatarImage: backupPet.avatarImage
            ? toPetResourceUrl(avatarImageToPath(backupPet.avatarImage, targetPetId))
            : undefined,
          isLocal: true
        });
      }
    );

    if (!restoredPet || !publicPet) {
      return {
        ok: false,
        message: "没有找到可用的最近有效配置备份。"
      };
    }

    return {
      ok: true,
      message: "已恢复最近一次有效配置备份。",
      pet: publicPet
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "配置备份恢复失败。"
    };
  }
}

export async function importLocalPetAvatar(petId?: string): Promise<LocalPetAvatarImportResult> {
  const result = await dialog.showOpenDialog({
    title: "选择桌宠头像",
    filters: [
      {
        name: "图片",
        extensions: ["png", "jpg", "jpeg", "webp"]
      }
    ],
    properties: ["openFile"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return {
      ok: false,
      message: "未选择头像。"
    };
  }

  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase();

  if (!allowedAvatarExtensions.has(extension)) {
    return {
      ok: false,
      message: "请选择 PNG、JPG 或 WebP 图片。"
    };
  }

  const imageBytes = await fs.readFile(sourcePath);

  return {
    ok: true,
    message: "请选择头像裁剪区域。",
    sourceImage: `data:${avatarMimeTypes[extension]};base64,${imageBytes.toString("base64")}`
  };
}

export async function saveLocalPetAvatarCrop(
  request: LocalPetAvatarCropSaveRequest
): Promise<LocalPetAvatarImportResult> {
  const targetPetId = assertValidPetId(
    request.petId || `draft-${Date.now().toString(36)}`
  );
  const dataUrlMatch = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(request.dataUrl);

  if (!dataUrlMatch) {
    return {
      ok: false,
      message: "裁剪图片格式无效。"
    };
  }

  const extension = dataUrlMatch[1].toLowerCase() === "jpeg" ? ".jpg" : `.${dataUrlMatch[1].toLowerCase()}`;
  const avatarDirectoryPath = await ensureSafePetSubdirectory(targetPetId, "assets");
  const targetPath = path.join(
    avatarDirectoryPath,
    `avatar-${Date.now().toString(36)}-${randomUUID()}${extension}`
  );

  await writeBufferFileAtomically(targetPath, Buffer.from(dataUrlMatch[2], "base64"));

  return {
    ok: true,
    message: "头像已裁剪并保存。",
    avatarImage: toPetResourceUrl(targetPath)
  };
}

export interface LocalPetDeleteOptions {
  removeDirectory?: (directoryPath: string) => Promise<void>;
  finalizeDeletion?: (petId: string) => Promise<void>;
}

async function completePetDeletion(petId: string, directory: string, options: LocalPetDeleteOptions): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe pet deletion directory.");
  const realRoot = await fs.realpath(getPetsRootPath());
  const realUserData = await fs.realpath(app.getPath("userData"));
  const realTarget = await fs.realpath(directory);
  assertPathContained(realUserData, realRoot, "Unsafe pets root.");
  assertPathContained(realRoot, realTarget, "Unsafe pet deletion directory.");
  const finalize = options.finalizeDeletion ?? (await import("./petDeletionFinalizer")).finalizePetDeletionWhilePetConfigLocked;
  await finalize(petId);
  await deletePetSecrets(petId);
  await (options.removeDirectory ?? ((target) => fs.rm(target, { recursive: true, force: true })))(directory);
  await syncParentDirectory(directory);
}

export async function deleteLocalPet(
  petId: string,
  options: LocalPetDeleteOptions = {}
): Promise<LocalPetDeleteResult> {
  const rawPetId = petId;

  if (!rawPetId.trim()) {
    return {
      ok: false,
      message: "缺少要删除的桌宠 ID。",
      petId
    };
  }

  const targetPetId = assertValidPetId(rawPetId);

  const petDirectoryPath = assertSafePetDirectory(targetPetId);

  return withPetWriteLock(targetPetId, async () => {
    try {
      await assertExistingLocalPetDirectoryContained(targetPetId);
      await fs.access(getPetConfigPath(targetPetId));
    } catch {
      return {
        ok: false,
        message: "只能删除本地创建的桌宠。",
        petId: targetPetId
      };
    }

    const deletingPath = path.join(
      getPetsRootPath(),
      `.deleting-${targetPetId}-${randomUUID()}`
    );
    await fs.rename(petDirectoryPath, deletingPath);
    try {
      await syncParentDirectory(deletingPath);
      await completePetDeletion(targetPetId, deletingPath, options);
    } catch {
      // Removal may have partially succeeded, including files and credentials.
      // Keep the durable tombstone for idempotent forward recovery.
      return {
        ok: true, pendingCleanup: true, petId: targetPetId,
        message: "桌宠已移除，部分本地数据暂未清理完成，将在下次启动时重试。"
      };
    }
    return {
      ok: true,
      message: "桌宠已删除。",
      petId: targetPetId
    };
  });
}
