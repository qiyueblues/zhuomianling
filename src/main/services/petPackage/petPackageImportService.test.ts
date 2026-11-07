import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import { ZipFile } from "yazl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PetVoiceModelVersion } from "../../../shared/types/pet";

let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData, getVersion: () => "test" } }));
vi.mock("../config/petConfigStore", () => ({
  listLocalPets: vi.fn(async () => []), stopManagedGptSoVitsApi: vi.fn(),
  testLocalPetVoiceModelConnection: vi.fn(), validateReferenceAudioDuration: vi.fn()
}));
vi.mock("../ai/aiSettings", () => ({
  deleteAiConnection: vi.fn(), listAiModels: vi.fn(), saveAiConnection: vi.fn(), testAiOutputCapability: vi.fn()
}));
// TIMED DIAGNOSTICS TEST MODULE: screen-vision capability import coverage.
vi.mock("../screen/ScreenVisionConnectionStore", () => ({
  clearChatVisionCapabilityWhilePetConfigLocked: vi.fn(),
  saveChatVisionCapabilityWhilePetConfigLocked: vi.fn()
}));
vi.mock("../screen/ScreenVisionService", () => ({
  testChatVisionDraft: vi.fn()
}));
vi.mock("../config/live2dImportService", () => ({ validateLive2DFolder: vi.fn() }));

import { beginPetPackageImport, cancelPetPackageImport, cleanupInterruptedPetPackageImports, commitPetPackageImport, listPetPackageImportAiModels, testPetPackageImportAi, testPetPackageImportVoice } from "./petPackageImportService";
import { validateLive2DFolder } from "../config/live2dImportService";
import { deleteAiConnection, listAiModels, saveAiConnection, testAiOutputCapability } from "../ai/aiSettings";
import {
  clearChatVisionCapabilityWhilePetConfigLocked,
  saveChatVisionCapabilityWhilePetConfigLocked
} from "../screen/ScreenVisionConnectionStore";
import { testChatVisionDraft } from "../screen/ScreenVisionService";

async function createValidPackage(filePath: string, options?: {
  disabledVoiceResources?: boolean;
  ai?: boolean;
  retainedTheme?: boolean;
  modelVersion?: PetVoiceModelVersion;
  sovitsHeader?: string;
}): Promise<void> {
  const disabledVoiceResources = options?.disabledVoiceResources === true;
  const portable = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, live2dEntry: "live2d/model.json", name: "Imported", description: "ok", personaPrompt: "",
    avatar: "assets/avatar.png",
    capabilities: { chat: false, voiceOutput: false, subtitles: true }, details: { role: "", personality: "", scenes: [], features: [] }, uiSettings: {
      theme: "soft",
      ...(options?.retainedTheme ? {
        customTheme: {
          id: "retained-theme", name: "Retained", description: "theme", version: 1,
          tokens: { background: "#fff", surface: "#fff", text: "#111", mutedText: "#666", accent: "#08f", border: "#ddd" }
        }
      } : {})
    },
    ...(disabledVoiceResources ? { voiceModelSettings: {
      enabled: false, connected: false, modelVersion: options?.modelVersion ?? "v2ProPlus", referenceText: "测试",
      referenceLanguage: "zh", language: "zh", playMode: "sentence",
      sovitsModel: "voice/models/sovits/voice.pth", gptModel: "voice/models/gpt/voice.ckpt", referenceAudio: "voice/reference/reference.wav"
    } } : {})
  }, null, 2)}\n`);
  const model = Buffer.from(JSON.stringify({ model: "model.moc" }));
  const moc = Buffer.from("moc");
  const data = new Map([["pet.json", portable], ["assets/avatar.png", Buffer.from("avatar-image")], ["live2d/model.json", model], ["live2d/model.moc", moc]]);
  if (disabledVoiceResources) {
    data.set("voice/models/sovits/voice.pth", Buffer.from(`${options?.sovitsHeader ?? ""}sovits`));
    data.set("voice/models/gpt/voice.ckpt", Buffer.from("gpt"));
    data.set("voice/reference/reference.wav", Buffer.from("RIFF0000WAVE"));
  }
  const manifest = {
    kind: "zhuomianling-pet-package", formatVersion: 1, exportedAt: new Date().toISOString(), appVersion: "test",
    pet: { originalPetId: "imported", name: "Imported" }, requirements: { ai: options?.ai === true, gptSoVits: disabledVoiceResources },
    entries: [...data].map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))
  };
  const zip = new ZipFile();
  const output = fsSync.createWriteStream(filePath);
  const done = new Promise<void>((resolve, reject) => { output.on("close", resolve); output.on("error", reject); });
  zip.outputStream.pipe(output);
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
  for (const [entryPath, bytes] of data) zip.addBuffer(bytes, entryPath);
  zip.end();
  await done;
}

describe("pet package import staging safety", () => {
  beforeEach(async () => { userData = await fs.mkdtemp(path.join(os.tmpdir(), "zmling-import-")); });
  afterEach(async () => { await fs.rm(userData, { recursive: true, force: true }); });

  it("rejects non-ZIP input without leaving a staging pet", async () => {
    const input = path.join(userData, "bad.zmling");
    await fs.writeFile(input, "not a zip");
    const result = await beginPetPackageImport(input, 1);
    expect(result.ok).toBe(false);
    const petsRoot = path.join(userData, "pets");
    const entries = await fs.readdir(petsRoot).catch(() => []);
    expect(entries.filter((name) => name.startsWith(".importing-"))).toEqual([]);
  });

  it("only cleans strict staging names with a matching marker", async () => {
    const petsRoot = path.join(userData, "pets");
    const safeId = "11111111-1111-4111-8111-111111111111";
    const safe = path.join(petsRoot, `.importing-${safeId}`);
    const unknownId = "22222222-2222-4222-8222-222222222222";
    const unknown = path.join(petsRoot, `.importing-${unknownId}`);
    await fs.mkdir(safe, { recursive: true }); await fs.mkdir(unknown, { recursive: true });
    await fs.writeFile(path.join(safe, ".zmling-import.json"), JSON.stringify({ kind: "zmling-import-staging", sessionId: safeId }));
    await fs.writeFile(path.join(unknown, ".zmling-import.json"), JSON.stringify({ kind: "unknown", sessionId: unknownId }));
    await cleanupInterruptedPetPackageImports();
    await expect(fs.access(safe)).rejects.toThrow();
    await expect(fs.access(unknown)).resolves.toBeUndefined();
  });

  it("extracts, verifies, and atomically commits a valid package under the final id", async () => {
    vi.mocked(validateLive2DFolder).mockResolvedValue({ ok: true, message: "ok", entryRelativePath: "model.json", checks: [], missingFiles: [], textureCount: 0, motionCount: 0, expressionCount: 0 });
    const input = path.join(userData, "valid.zmling");
    await createValidPackage(input);
    const begun = await beginPetPackageImport(input, 7);
    expect(begun.ok, begun.message).toBe(true);
    expect(begun).toMatchObject({ ok: true, sessionId: expect.any(String), petName: "Imported" });
    expect(begun.avatarDataUrl).toMatch(/^data:image\/png;base64,/);
    const committed = await commitPetPackageImport(begun.sessionId!, 7);
    expect(committed.ok).toBe(true);
    expect(committed.pet?.id).toBe("imported");
    expect(committed.pet?.modelPath).toBe("pet-resource://local/imported/live2d/model.json");
    expect(committed.pet?.avatarImage).toBe("pet-resource://local/imported/assets/avatar.png");
    expect(committed.pet?.screenAwarenessSettings).toBeUndefined();
    const stored = JSON.parse(await fs.readFile(path.join(userData, "pets", "imported", "pet.local.json"), "utf8"));
    expect(stored.modelPath).toBe("pet-resource://local/imported/live2d/model.json");
    expect(stored.avatarImage).toBe("pet-resource://local/imported/assets/avatar.png");
    expect(stored).not.toHaveProperty("screenAwarenessSettings");
    await expect(fs.access(path.join(userData, "pets", "imported", "pet.json"))).rejects.toThrow();
  });

  it("accepts packaged voice resources even when voice output is disabled and disconnected", async () => {
    vi.mocked(validateLive2DFolder).mockResolvedValue({ ok: true, message: "ok", entryRelativePath: "model.json", checks: [], missingFiles: [], textureCount: 0, motionCount: 0, expressionCount: 0 });
    const input = path.join(userData, "disabled-voice.zmling");
    await createValidPackage(input, { disabledVoiceResources: true });
    const begun = await beginPetPackageImport(input, 9);
    expect(begun.ok, begun.message).toBe(true);
    expect(begun.requirements?.gptSoVits).toBe(true);
    await cancelPetPackageImport(begun.sessionId, 9);
  });

  it("imports a retained custom theme alongside an active built-in theme", async () => {
    vi.mocked(validateLive2DFolder).mockResolvedValue({ ok: true, message: "ok", entryRelativePath: "model.json", checks: [], missingFiles: [], textureCount: 0, motionCount: 0, expressionCount: 0 });
    const input = path.join(userData, "retained-theme.zmling");
    await createValidPackage(input, { retainedTheme: true });
    const begun = await beginPetPackageImport(input, 13);
    expect(begun.ok, begun.message).toBe(true);
    expect(begun.contents?.customTheme).toBe(true);
    const committed = await commitPetPackageImport(begun.sessionId!, 13);
    expect(committed.ok, committed.message).toBe(true);
    expect(committed.pet?.uiSettings).toMatchObject({
      theme: "soft",
      customTheme: { id: "retained-theme" }
    });
    await expect(fs.access(path.join(userData, "pets", "imported", "pet.local.json"))).resolves.toBeUndefined();
  });

  it("rejects an arbitrary folder selected as the GPT-SoVITS root", async () => {
    vi.mocked(validateLive2DFolder).mockResolvedValue({ ok: true, message: "ok", entryRelativePath: "model.json", checks: [], missingFiles: [], textureCount: 0, motionCount: 0, expressionCount: 0 });
    const input = path.join(userData, "voice-root-check.zmling");
    await createValidPackage(input, { disabledVoiceResources: true });
    const begun = await beginPetPackageImport(input, 10);
    expect(begun.ok, begun.message).toBe(true);
    const arbitraryFolder = path.join(userData, "not-gpt-sovits");
    await fs.mkdir(arbitraryFolder);

    const checked = await testPetPackageImportVoice(begun.sessionId!, arbitraryFolder, 10);

    expect(checked).toMatchObject({ ok: false, message: expect.stringContaining("不是完整的 GPT-SoVITS 文件夹") });
    await cancelPetPackageImport(begun.sessionId, 10);
  });

  it.each([["v5dev", "07"], ["v5turbo", "08"]] as const)("checks %s runtime and LoRA dependencies before committing an import", async (modelVersion, sovitsHeader) => {
    vi.mocked(validateLive2DFolder).mockResolvedValue({ ok: true, message: "ok", entryRelativePath: "model.json", checks: [], missingFiles: [], textureCount: 0, motionCount: 0, expressionCount: 0 });
    const input = path.join(userData, "v5-voice.zmling");
    await createValidPackage(input, { disabledVoiceResources: true, modelVersion, sovitsHeader });
    const begun = await beginPetPackageImport(input, 14);
    expect(begun.ok, begun.message).toBe(true);
    const voiceRoot = path.join(userData, "gpt-sovits");
    for (const relativePath of ["runtime/python.exe", "api_v2.py"]) {
      const target = path.join(voiceRoot, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "fixture");
    }
    for (const name of ["chinese-roberta-wwm-ext-large", "chinese-hubert-base"]) {
      await fs.mkdir(path.join(voiceRoot, "GPT_SoVITS", "pretrained_models", name), { recursive: true });
    }

    const oldRuntime = await testPetPackageImportVoice(begun.sessionId!, voiceRoot, 14);
    expect(oldRuntime).toMatchObject({ ok: false, message: expect.stringContaining("models_v5.py") });
    for (const relativePath of ["GPT_SoVITS/module/models_v5.py", "GPT_SoVITS/pretrained_models/gsv-v5-pretrained/vocoder.pth"]) {
      const target = path.join(voiceRoot, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "fixture");
    }
    const missingBase = await testPetPackageImportVoice(begun.sessionId!, voiceRoot, 14);
    expect(missingBase).toMatchObject({ ok: false, message: expect.stringContaining(`s2G${modelVersion}.pth`) });
    await fs.writeFile(path.join(voiceRoot, "GPT_SoVITS", "pretrained_models", "gsv-v5-pretrained", `s2G${modelVersion}.pth`), "fixture");
    expect(await testPetPackageImportVoice(begun.sessionId!, voiceRoot, 14)).toMatchObject({ ok: true });

    const committed = await commitPetPackageImport(begun.sessionId!, 14);
    expect(committed.ok, committed.message).toBe(true);
    expect(committed.pet?.voiceModelSettings).toMatchObject({ modelVersion, connected: false, gptSoVitsRootPath: voiceRoot });
  });

  it("lists import-session models with a main-process-derived provider name", async () => {
    vi.mocked(validateLive2DFolder).mockResolvedValue({ ok: true, message: "ok", entryRelativePath: "model.json", checks: [], missingFiles: [], textureCount: 0, motionCount: 0, expressionCount: 0 });
    vi.mocked(listAiModels).mockResolvedValue({ ok: true, message: "ok", checkedAt: new Date().toISOString(), models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] });
    const input = path.join(userData, "ai.zmling");
    await createValidPackage(input, { ai: true });
    const begun = await beginPetPackageImport(input, 11);
    expect(begun.ok, begun.message).toBe(true);
    const listed = await listPetPackageImportAiModels({ sessionId: begun.sessionId!, baseUrl: "https://api.deepseek.com/v1", apiKey: "secret" }, 11);
    expect(listed).toMatchObject({ ok: true, providerName: "DeepSeek", models: [{ id: "deepseek-chat" }] });
    expect(vi.mocked(listAiModels)).toHaveBeenCalledWith(expect.objectContaining({ providerName: "DeepSeek", model: "" }), expect.any(AbortSignal));
    await cancelPetPackageImport(begun.sessionId, 11);
  });

  it("commits AI settings with the capability already tested by the import session", async () => {
    vi.mocked(validateLive2DFolder).mockResolvedValue({ ok: true, message: "ok", entryRelativePath: "model.json", checks: [], missingFiles: [], textureCount: 0, motionCount: 0, expressionCount: 0 });
    const checkedAt = "2026-07-28T00:00:00.000Z";
    vi.mocked(listAiModels).mockResolvedValue({ ok: true, message: "ok", checkedAt, models: [{ id: "model-a", name: "Model A" }] });
    vi.mocked(testAiOutputCapability).mockResolvedValue({
      ok: true,
      message: "ok",
      checkedAt,
      capability: { baseUrl: "https://api.example.com/v1", model: "model-a", mode: "json-schema", protocolTier: "full", streaming: true, confidence: "tested", checkedAt, probeVersion: 2 }
    });
    vi.mocked(testChatVisionDraft).mockResolvedValue({
      ok: true,
      message: "vision-ok",
      checkedAt,
      state: "tested",
      capability: {
        visionInput: "tested",
        checkedAt,
        fingerprint: {
          normalizedBaseUrl: "https://api.example.com/v1",
          model: "model-a",
          providerProtocol: "openai-compatible",
          visionInputFormat: "image_url-data-url",
          probeVersion: 1
        },
        probeVersion: 1
      }
    });
    vi.mocked(saveAiConnection).mockResolvedValue({
      config: { petId: "imported", providerName: "OpenAI Compatible", baseUrl: "https://api.example.com/v1", model: "model-a", models: [{ id: "model-a", name: "Model A" }], hasApiKey: true },
      test: { ok: true, message: "saved", checkedAt }
    });
    const input = path.join(userData, "ai-commit.zmling");
    await createValidPackage(input, { ai: true });
    const begun = await beginPetPackageImport(input, 12);
    expect(begun.ok, begun.message).toBe(true);
    const tested = await testPetPackageImportAi({
      sessionId: begun.sessionId!,
      draft: { baseUrl: "https://api.example.com/v1", apiKey: "secret", model: "model-a" }
    }, 12);
    expect(tested.ok).toBe(true);

    const committed = await commitPetPackageImport(begun.sessionId!, 12);

    expect(committed.ok, committed.message).toBe(true);
    expect(vi.mocked(saveAiConnection)).toHaveBeenCalledWith(
      expect.objectContaining({ petId: "imported", model: "model-a" }),
      expect.objectContaining({
        models: [{ id: "model-a", name: "Model A" }],
        outputCapability: expect.objectContaining({ mode: "json-schema", confidence: "tested" })
      })
    );
    expect(vi.mocked(testChatVisionDraft)).toHaveBeenCalledWith(
      expect.objectContaining({ petId: "imported", model: "model-a", apiKey: "secret" }),
      expect.any(AbortSignal)
    );
    expect(vi.mocked(saveChatVisionCapabilityWhilePetConfigLocked)).toHaveBeenCalledWith(
      "imported",
      expect.objectContaining({ visionInput: "tested", fingerprint: expect.objectContaining({ model: "model-a" }) })
    );
    expect(vi.mocked(clearChatVisionCapabilityWhilePetConfigLocked)).not.toHaveBeenCalled();
  });

  it("rolls back an AI import when locked vision capability persistence fails", async () => {
    vi.mocked(validateLive2DFolder).mockResolvedValue({ ok: true, message: "ok", entryRelativePath: "model.json", checks: [], missingFiles: [], textureCount: 0, motionCount: 0, expressionCount: 0 });
    const checkedAt = "2026-07-29T00:00:00.000Z";
    vi.mocked(listAiModels).mockResolvedValue({ ok: true, message: "ok", checkedAt, models: [{ id: "model-a", name: "Model A" }] });
    vi.mocked(testAiOutputCapability).mockResolvedValue({
      ok: true,
      message: "ok",
      checkedAt,
      capability: { baseUrl: "https://api.example.com/v1", model: "model-a", mode: "json-schema", protocolTier: "full", streaming: true, confidence: "tested", checkedAt, probeVersion: 2 }
    });
    vi.mocked(testChatVisionDraft).mockResolvedValue({
      ok: true,
      message: "vision-ok",
      checkedAt,
      state: "tested",
      capability: {
        visionInput: "tested",
        checkedAt,
        fingerprint: {
          normalizedBaseUrl: "https://api.example.com/v1",
          model: "model-a",
          providerProtocol: "openai-compatible",
          visionInputFormat: "image_url-data-url",
          probeVersion: 1
        },
        probeVersion: 1
      }
    });
    vi.mocked(saveAiConnection).mockResolvedValue({
      config: { petId: "imported", providerName: "OpenAI Compatible", baseUrl: "https://api.example.com/v1", model: "model-a", models: [{ id: "model-a", name: "Model A" }], hasApiKey: true },
      test: { ok: true, message: "saved", checkedAt }
    });
    vi.mocked(saveChatVisionCapabilityWhilePetConfigLocked).mockRejectedValueOnce(new Error("vision store unavailable"));
    vi.mocked(clearChatVisionCapabilityWhilePetConfigLocked).mockResolvedValue(undefined);
    vi.mocked(deleteAiConnection).mockResolvedValue(undefined);

    const input = path.join(userData, "ai-rollback.zmling");
    await createValidPackage(input, { ai: true });
    const begun = await beginPetPackageImport(input, 14);
    expect(begun.ok, begun.message).toBe(true);
    const tested = await testPetPackageImportAi({
      sessionId: begun.sessionId!,
      draft: { baseUrl: "https://api.example.com/v1", apiKey: "secret", model: "model-a" }
    }, 14);
    expect(tested.ok).toBe(true);

    const committed = await commitPetPackageImport(begun.sessionId!, 14);

    expect(committed).toMatchObject({ ok: false, message: "vision store unavailable" });
    expect(vi.mocked(clearChatVisionCapabilityWhilePetConfigLocked)).toHaveBeenCalledWith("imported");
    await expect(fs.access(path.join(userData, "pets", "imported", "pet.local.json"))).rejects.toThrow();
    const entries = await fs.readdir(path.join(userData, "pets"));
    expect(entries.some((name) => name.startsWith(".importing-"))).toBe(true);
  });
});
