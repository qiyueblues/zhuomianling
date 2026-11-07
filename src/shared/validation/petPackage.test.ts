import { describe, expect, it } from "vitest";
import type { PetDefinition } from "../types/pet";
import { PET_PACKAGE_KIND } from "../types/petPackage";
import {
  allocateImportedPetId,
  createPortablePetDefinition,
  normalizePetPackageEntryPath,
  parsePetPackageManifest,
  parsePortablePetDefinition,
  sanitizePetPackageFileName
} from "./petPackage";

const pet: PetDefinition = {
  id: "pet-a",
  name: "测试桌宠",
  description: "desc",
  modelPath: "pet-resource://local/pet-a/live2d/model.model3.json",
  avatar: "pet-resource://local/pet-a/assets/avatar.png",
  avatarImage: "data:image/png;base64,secret",
  personaPrompt: "persona",
  memorySettings: { onboardingCompleted: true, recallEnabled: true, autoCaptureEnabled: true, retainSources: true, recallLimit: 6, contextBudgetChars: 4000 },
  voiceInputSettings: {
    provider: "tencent-asr", hasCredentials: true, connected: true, autoEndEnabled: true,
    silenceSeconds: 2, volumeThreshold: 0.1, continuousConversationEnabled: false
  },
  capabilities: { chat: true, voiceOutput: false, subtitles: true },
  details: { role: "role", personality: "kind", scenes: [], features: [] },
  uiSettings: { theme: "soft", desktopPosition: { x: 1, y: 2 } },
  isLocal: true
};

describe("pet package protocol", () => {
  it("parses a bounded v1 manifest", () => {
    expect(parsePetPackageManifest({
      kind: PET_PACKAGE_KIND,
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: "1.0.0",
      pet: { originalPetId: "pet-a", name: "A" },
      requirements: { ai: false, gptSoVits: false },
      entries: [
        { path: "pet.json", size: 2, sha256: "a".repeat(64) },
        { path: "live2d/model.model3.json", size: 2, sha256: "b".repeat(64) }
      ]
    }).pet.originalPetId).toBe("pet-a");
  });

  it.each(["../pet.json", "/pet.json", "C:/pet.json", "live2d\\model.json", "live2d/CON", "live2d/a:b", "live2d/trailing. ", "unknown/a"])(
    "rejects unsafe archive path %s",
    (entry) => expect(() => normalizePetPackageEntryPath(entry)).toThrow()
  );

  it("rejects duplicate case-folded entries", () => {
    expect(() => parsePetPackageManifest({
      kind: PET_PACKAGE_KIND, formatVersion: 1, exportedAt: new Date().toISOString(), appVersion: "1",
      pet: { originalPetId: "a", name: "A" }, requirements: { ai: false, gptSoVits: false },
      entries: [
        { path: "pet.json", size: 1, sha256: "a".repeat(64) },
        { path: "assets/avatar.png", size: 1, sha256: "b".repeat(64) },
        { path: "assets/AVATAR.PNG", size: 1, sha256: "d".repeat(64) },
        { path: "live2d/model.json", size: 1, sha256: "c".repeat(64) }
      ]
    })).toThrow(/重复|冲突/);
  });

  it("creates a portable allowlisted definition", () => {
    const portable = createPortablePetDefinition(pet, "live2d/model.model3.json");
    const json = JSON.stringify(portable);
    expect(json).not.toContain("memorySettings");
    expect(json).not.toContain("voiceInputSettings");
    expect(json).not.toContain("desktopPosition");
    expect(json).not.toContain("avatarImage");
    expect(portable.uiSettings?.customTheme).toBeUndefined();
  });

  it.each(["v5dev", "v5turbo"] as const)("preserves %s through portable export and import", (modelVersion) => {
    const portable = createPortablePetDefinition({
      ...pet,
      voiceModelSettings: {
        enabled: false, connected: false, modelVersion,
        referenceText: "参考文本", language: "zh", playMode: "sentence"
      }
    }, "live2d/model.model3.json", {
      sovitsModel: "voice/models/sovits/voice.pth",
      gptModel: "voice/models/gpt/voice.ckpt",
      referenceAudio: "voice/reference/reference.wav"
    });

    const imported = parsePortablePetDefinition(JSON.parse(JSON.stringify(portable)));
    expect(imported.voiceModelSettings?.modelVersion).toBe(modelVersion);
    expect(imported.voiceModelSettings?.sovitsModel).toBe("voice/models/sovits/voice.pth");
  });

  it("rejects secrets and absolute paths in portable data", () => {
    const base = createPortablePetDefinition(pet, "live2d/model.model3.json");
    expect(() => parsePortablePetDefinition({ ...base, apiKey: "secret" })).toThrow(/禁止字段|未知字段/);
    expect(() => parsePortablePetDefinition({ ...base, description: "C:\\private\\file" })).toThrow(/绝对路径/);
  });

  it("preserves an imported theme even when a built-in theme is active", () => {
    const retainedTheme = {
      id: "mint-plaid",
      name: "薄荷格纹",
      description: "retained",
      version: 1,
      tokens: {
        background: "#f3fbf8",
        surface: "#ffffff",
        text: "#273047",
        mutedText: "#6d7f89",
        accent: "#0f7281",
        border: "#668987"
      }
    } as const;
    const portable = createPortablePetDefinition({
      ...pet,
      uiSettings: { theme: "soft", customTheme: retainedTheme }
    }, "live2d/model.model3.json");

    expect(portable.uiSettings).toMatchObject({ theme: "soft", customTheme: retainedTheme });
    expect(parsePortablePetDefinition(portable).uiSettings).toMatchObject({
      theme: "soft",
      customTheme: retainedTheme
    });
  });

  it("allocates collision-safe canonical ids and safe file names", () => {
    expect(allocateImportedPetId("pet", "ignored", new Set(["pet", "pet-2"]))).toBe("pet-3");
    expect(allocateImportedPetId("bad id", "小 宠物", new Set())).toBe("小-宠物");
    expect(sanitizePetPackageFileName(" A:pet. ")).toBe("桌面灵-A-pet.zmling");
  });
});
