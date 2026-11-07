import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalPetVoiceModelDraft, PetDefinition } from "../../../shared/types/pet";
import { normalizeMemorySettings } from "../../../shared/validation/memory";

type ProtocolHandler = (request: { url: string }) => Promise<Response>;

const electronMock = vi.hoisted(() => ({
  userDataPath: "",
  encryptionAvailable: true,
  encryptString: vi.fn((value: string) => Buffer.from(value, "utf8").reverse()),
  decryptString: vi.fn((value: Buffer) => Buffer.from(value).reverse().toString("utf8")),
  netFetch: vi.fn(async () => new Response("fixture-resource", { status: 200 })),
  protocolHandlers: new Map<string, ProtocolHandler>()
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath,
    isReady: () => true
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  safeStorage: {
    isEncryptionAvailable: () => electronMock.encryptionAvailable,
    encryptString: electronMock.encryptString,
    decryptString: electronMock.decryptString
  },
  net: {
    fetch: electronMock.netFetch
  },
  protocol: {
    handle: vi.fn((scheme: string, handler: ProtocolHandler) => {
      electronMock.protocolHandlers.set(scheme, handler);
    })
  }
}));

const legacyCredentials = {
  appId: "fixture-app-id",
  secretId: "fixture-secret-id",
  secretKey: "fixture-secret-key"
};

let temporaryDirectory = "";

function getPetDirectory(petId = "pet-a"): string {
  return path.join(temporaryDirectory, "pets", petId);
}

function getPetConfigPath(petId = "pet-a"): string {
  return path.join(getPetDirectory(petId), "pet.local.json");
}

async function writeLegacyPet(petId = "pet-a"): Promise<void> {
  await fs.mkdir(getPetDirectory(petId), { recursive: true });
  await fs.writeFile(
    getPetConfigPath(petId),
    JSON.stringify(
      {
        id: petId,
        name: "Fixture Pet",
        description: "",
        modelPath: "",
        personaPrompt: "",
        capabilities: {
          chat: true,
          voiceInput: true,
          voiceOutput: false,
          subtitles: true
        },
        details: {
          role: "",
          personality: "",
          scenes: [],
          features: []
        },
        expressions: {},
        expressionDescriptions: {},
        lines: {},
        subtitleStyle: {
          tone: "soft"
        },
        voiceInputSettings: {
          provider: "tencent-asr",
          ...legacyCredentials,
          connected: true,
          autoEndEnabled: true,
          silenceSeconds: 1,
          volumeThreshold: 0.18,
          continuousConversationEnabled: false
        }
      },
      null,
      2
    ),
    "utf8"
  );
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-pet-config-"));
  electronMock.userDataPath = temporaryDirectory;
  electronMock.encryptionAvailable = true;
  electronMock.encryptString.mockClear();
  electronMock.decryptString.mockClear();
  electronMock.netFetch.mockClear();
  electronMock.netFetch.mockImplementation(
    async () => new Response("fixture-resource", { status: 200 })
  );
  electronMock.protocolHandlers.clear();
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Tencent ASR credential migration", () => {
  it("moves legacy plaintext credentials out of pet.local.json and returns only public state", async () => {
    await writeLegacyPet();
    const { listLocalPets } = await import("./petConfigStore");

    const pets = await listLocalPets();
    const pet = pets[0];
    const metadataContent = await fs.readFile(getPetConfigPath(), "utf8");
    const secureContent = await fs.readFile(
      path.join(temporaryDirectory, "secure-secrets.json"),
      "utf8"
    );

    expect(pet?.voiceInputSettings?.hasCredentials).toBe(true);
    expect(pet?.voiceInputSettings?.connected).toBe(true);
    expect(pet?.capabilities.voiceInput).toBe(true);
    expect(pet?.voiceInputSettings).not.toHaveProperty("appId");
    expect(pet?.voiceInputSettings).not.toHaveProperty("secretId");
    expect(pet?.voiceInputSettings).not.toHaveProperty("secretKey");

    for (const credential of Object.values(legacyCredentials)) {
      expect(JSON.stringify(pet)).not.toContain(credential);
      expect(metadataContent).not.toContain(credential);
      expect(secureContent).not.toContain(credential);
    }

    expect(metadataContent).not.toContain('"appId"');
    expect(metadataContent).not.toContain('"secretId"');
    expect(metadataContent).not.toContain('"secretKey"');
    expect(electronMock.encryptString).toHaveBeenCalledTimes(1);
  });

  it("treats legacy plaintext as authoritative until the verified migration completes", async () => {
    await writeLegacyPet();
    const { getSecureString, setSecureString } = await import("./secureConfigStore");
    await setSecureString(
      "tencent-asr",
      "pet-a",
      JSON.stringify({
        appId: "stale-app-id",
        secretId: "stale-secret-id",
        secretKey: "stale-secret-key"
      })
    );
    const { listLocalPets } = await import("./petConfigStore");

    await listLocalPets();
    const migrated = JSON.parse(
      (await getSecureString("tencent-asr", "pet-a")) ?? "{}"
    ) as Record<string, string>;

    expect(migrated).toEqual(legacyCredentials);
  });

  it("preserves the safely stored credential group when all three editor fields are blank", async () => {
    await writeLegacyPet();
    const { listLocalPets, saveLocalPetVoiceInput } = await import("./petConfigStore");
    const { getSecureString } = await import("./secureConfigStore");
    await listLocalPets();

    const result = await saveLocalPetVoiceInput({
      petId: "pet-a",
      appId: "",
      secretId: "",
      secretKey: "",
      connected: true,
      autoEndEnabled: true,
      silenceSeconds: 1,
      volumeThreshold: 0.18,
      continuousConversationEnabled: false
    });
    const storedCredentials = JSON.parse(
      (await getSecureString("tencent-asr", "pet-a")) ?? "{}"
    ) as Record<string, string>;
    const metadataContent = await fs.readFile(getPetConfigPath(), "utf8");

    expect(result.ok).toBe(true);
    expect(storedCredentials).toEqual(legacyCredentials);
    expect(metadataContent).not.toContain(legacyCredentials.appId);
    expect(metadataContent).not.toContain(legacyCredentials.secretId);
    expect(metadataContent).not.toContain(legacyCredentials.secretKey);
  });

  it("removes all secure secrets for a deleted pet without deleting another pet's secret", async () => {
    await writeLegacyPet();
    const { deleteLocalPet, listLocalPets } = await import("./petConfigStore");
    const { getSecureString, setSecureString } = await import("./secureConfigStore");
    await listLocalPets();
    await setSecureString("fixture-scope", "pet-a", "delete-with-pet-a");
    await setSecureString("fixture-scope", "pet-b", "keep-with-pet-b");

    const result = await deleteLocalPet("pet-a");
    const secureContent = await fs.readFile(
      path.join(temporaryDirectory, "secure-secrets.json"),
      "utf8"
    );

    expect(result.ok).toBe(true);
    await expect(fs.access(getPetDirectory())).rejects.toThrow();
    await expect(getSecureString("tencent-asr", "pet-a")).resolves.toBeUndefined();
    await expect(getSecureString("fixture-scope", "pet-a")).resolves.toBeUndefined();
    await expect(getSecureString("fixture-scope", "pet-b")).resolves.toBe("keep-with-pet-b");
    expect(secureContent).not.toContain("pet-a");
    expect(secureContent).toContain("pet-b");
  });

  it("keeps a partially deleted pet hidden and completes cleanup after restart", async () => {
    await writeLegacyPet();
    const memoryFile = path.join(getPetDirectory(), "memory", "pending", "turn.json");
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, "durable-memory", "utf8");
    const { deleteLocalPet } = await import("./petConfigStore");
    const { setSecureString } = await import("./secureConfigStore");
    await setSecureString("fixture", "pet-a", "old-secret");

    await expect(deleteLocalPet("pet-a", {
      removeDirectory: async (directory) => {
        await fs.rm(path.join(directory, "memory"), { recursive: true });
        throw new Error("injected deletion failure");
      }
    })).resolves.toMatchObject({ ok: true, pendingCleanup: true });

    await expect(fs.access(getPetDirectory())).rejects.toThrow();
    await expect(fs.access(memoryFile)).rejects.toThrow();
    expect((await fs.readdir(path.join(temporaryDirectory, "pets"))).some((name) =>
      name.startsWith(".deleting-pet-a-")
    )).toBe(true);
    const { ensureSafeLocalPetDirectory } = await import("./petConfigPersistence");
    await expect(ensureSafeLocalPetDirectory("PET-A")).rejects.toThrow(/待完成的删除/);
    vi.resetModules();
    const restarted = await import("./petConfigStore");
    await expect(restarted.cleanupInterruptedPetDeletions()).resolves.toEqual(["pet-a"]);
    expect(await fs.readdir(path.join(temporaryDirectory, "pets"))).toEqual([]);
    const { getSecureString } = await import("./secureConfigStore");
    await expect(getSecureString("fixture", "pet-a")).resolves.toBeUndefined();
  });

  it("resumes both AI and vision metadata cleanup after a failed normal finalizer", async () => {
    await writeLegacyPet();
    const aiPath = path.join(temporaryDirectory, "ai-connections.json");
    const visionPath = path.join(temporaryDirectory, "screen-vision-connections.json");
    const connection = { petId: "pet-a", baseUrl: "https://fixture.example", model: "model-a" };
    await fs.writeFile(aiPath, JSON.stringify({ version: 3, connections: { "pet-a": connection } }));
    await fs.writeFile(visionPath, JSON.stringify({ version: 1, pets: { "pet-a": { independent: connection }, "pet-b": {} } }));
    const { setSecureString, getSecureString } = await import("./secureConfigStore");
    await setSecureString("ai-api-key", "pet-a", "ai-secret", connection.baseUrl);
    await setSecureString("screen-vision-api-key", "pet-a", "vision-secret", connection.baseUrl);
    await setSecureString("fixture", "pet-b", "keep-me");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (String(target) === visionPath) throw new Error("injected vision write failure");
      return originalRename(source, target);
    });
    const { deleteLocalPet } = await import("./petConfigStore");
    try {
      await expect(deleteLocalPet("pet-a")).resolves.toMatchObject({ ok: true, pendingCleanup: true });
      await expect(fs.access(getPetDirectory())).rejects.toThrow();
      expect(JSON.parse(await fs.readFile(visionPath, "utf8")).pets).toHaveProperty("pet-a");
    } finally {
      renameSpy.mockRestore();
    }
    vi.resetModules();
    const restarted = await import("./petConfigStore");
    await expect(restarted.cleanupInterruptedPetDeletions()).resolves.toEqual(["pet-a"]);
    expect(JSON.parse(await fs.readFile(aiPath, "utf8")).connections).not.toHaveProperty("pet-a");
    const vision = JSON.parse(await fs.readFile(visionPath, "utf8")).pets;
    expect(vision).not.toHaveProperty("pet-a");
    expect(vision).toHaveProperty("pet-b");
    await expect(getSecureString("screen-vision-api-key", "pet-a")).resolves.toBeUndefined();
    await expect(getSecureString("fixture", "pet-b")).resolves.toBe("keep-me");
  });

  it("does not clean a tombstone's credentials when its pet ID is occupied", async () => {
    await writeLegacyPet();
    const tombstone = path.join(temporaryDirectory, "pets", ".deleting-pet-a-123e4567-e89b-12d3-a456-426614174000");
    await fs.mkdir(tombstone);
    const { setSecureString, getSecureString } = await import("./secureConfigStore");
    await setSecureString("fixture", "pet-a", "active-secret");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { cleanupInterruptedPetDeletions } = await import("./petConfigStore");
      await expect(cleanupInterruptedPetDeletions()).resolves.toEqual([]);
      await expect(getSecureString("fixture", "pet-a")).resolves.toBe("active-secret");
      await expect(fs.access(tombstone)).resolves.toBeUndefined();
    } finally { warn.mockRestore(); }
  });

  it("cleans only recognized interrupted deletion tombstones on startup", async () => {
    const petsRoot = path.join(temporaryDirectory, "pets");
    const recognized = path.join(
      petsRoot,
      ".deleting-pet-a-123e4567-e89b-12d3-a456-426614174000"
    );
    const unknown = path.join(petsRoot, ".deleting-unknown");
    await fs.mkdir(recognized, { recursive: true });
    await fs.mkdir(unknown, { recursive: true });
    const { cleanupInterruptedPetDeletions } = await import("./petConfigStore");

    await expect(cleanupInterruptedPetDeletions()).resolves.toEqual(["pet-a"]);

    await expect(fs.access(recognized)).rejects.toThrow();
    await expect(fs.access(unknown)).resolves.toBeUndefined();
  });

  it.each(["中文桌宠", "123-pet"])("resumes deletion for canonical pet ID %s", async (petId) => {
    const directory = path.join(temporaryDirectory, "pets", `.deleting-${petId}-123e4567-e89b-12d3-a456-426614174000`);
    await fs.mkdir(directory, { recursive: true });
    const { setSecureString, getSecureString } = await import("./secureConfigStore");
    await setSecureString("fixture", petId, "pending-secret");
    const { assertNoPendingPetDeletion } = await import("./petConfigPersistence");
    await expect(assertNoPendingPetDeletion(petId)).rejects.toThrow(/待完成的删除/);
    const { cleanupInterruptedPetDeletions } = await import("./petConfigStore");
    await expect(cleanupInterruptedPetDeletions()).resolves.toEqual([petId]);
    await expect(getSecureString("fixture", petId)).resolves.toBeUndefined();
    await expect(fs.access(directory)).rejects.toThrow();
  });

  it("keeps an interrupted deletion tombstone when external cleanup cannot finish", async () => {
    const tombstone = path.join(
      temporaryDirectory,
      "pets",
      ".deleting-pet-a-123e4567-e89b-12d3-a456-426614174000"
    );
    await fs.mkdir(tombstone, { recursive: true });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { cleanupInterruptedPetDeletions } = await import("./petConfigStore");
    try {
      await expect(cleanupInterruptedPetDeletions(async () => {
        throw new Error("secure cleanup unavailable");
      })).resolves.toEqual([]);
      await expect(fs.access(tombstone)).resolves.toBeUndefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("durably saves normalized memory settings inside the pet definition", async () => {
    await writeLegacyPet();
    const {
      getLocalPetMemorySettings,
      saveLocalPetMemorySettings
    } = await import("./petConfigStore");
    await saveLocalPetMemorySettings("pet-a", {
      recallEnabled: true,
      autoCaptureEnabled: false,
      recallLimit: 4,
      contextBudgetChars: 1536,
      retainSources: false
    });

    await expect(getLocalPetMemorySettings("pet-a")).resolves.toEqual({
      onboardingCompleted: true,
      recallEnabled: true,
      autoCaptureEnabled: false,
      recallLimit: 4,
      contextBudgetChars: 1536,
      retainSources: false
    });
    expect(JSON.parse(await fs.readFile(getPetConfigPath(), "utf8"))).toMatchObject({
      memorySettings: { onboardingCompleted: true, recallEnabled: true, recallLimit: 4 }
    });
  });

  it("keeps legacy plaintext on disk but redacts the DTO when safe storage is unavailable", async () => {
    await writeLegacyPet();
    electronMock.encryptionAvailable = false;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { listLocalPets, resetLocalPetVoiceRuntimeState } = await import("./petConfigStore");

    try {
      const pets = await listLocalPets();
      const pet = pets[0];
      await expect(resetLocalPetVoiceRuntimeState()).resolves.toBeUndefined();
      const metadataContent = await fs.readFile(getPetConfigPath(), "utf8");

      expect(pet?.voiceInputSettings?.hasCredentials).toBe(false);
      expect(pet?.voiceInputSettings?.connected).toBe(false);
      expect(pet?.capabilities.voiceInput).toBe(false);
      expect(pet?.voiceInputSettings).not.toHaveProperty("appId");
      expect(pet?.voiceInputSettings).not.toHaveProperty("secretId");
      expect(pet?.voiceInputSettings).not.toHaveProperty("secretKey");
      expect(metadataContent).toContain(legacyCredentials.appId);
      expect(metadataContent).toContain(legacyCredentials.secretId);
      expect(metadataContent).toContain(legacyCredentials.secretKey);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("legacy memory settings compatibility", () => {
  it("loads a pet without memorySettings and treats every memory capability as disabled", async () => {
    await writeLegacyPet();
    const { listLocalPets } = await import("./petConfigStore");

    const [pet] = await listLocalPets();

    expect(pet?.memorySettings).toBeUndefined();
    expect(normalizeMemorySettings(pet?.memorySettings)).toMatchObject({
      onboardingCompleted: false,
      recallEnabled: false,
      autoCaptureEnabled: false,
      retainSources: false
    });
  });
});

describe("expression mapping persistence", () => {
  it("rebuilds mappings from the current draft so an empty draft clears old mappings", async () => {
    await writeLegacyPet();
    const configPath = getPetConfigPath();
    const existing = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;

    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...existing,
          expressions: { angry: "Tap" },
          expressionDescriptions: { angry: "旧描述" },
          expressionSourceKinds: { angry: "motion" },
          expressionSourceFiles: { angry: "angry01.mtn" },
          expressionEffects: { angry: { parameters: [{ id: "ParamAngleX", value: 1 }] } },
          expressionSources: [
            { sourceFileName: "angry01.mtn", runtimeName: "Tap", sourceKind: "motion" }
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    const { saveLocalPetExpressionMappings } = await import("./petConfigStore");

    const result = await saveLocalPetExpressionMappings({
      petId: "pet-a",
      mappings: [],
      expressionSelectionMode: "semantic",
      expressionRandomScope: "all"
    });

    expect(result.ok).toBe(true);
    expect(result.pet?.expressions).toEqual({});
    expect(result.pet?.expressionDescriptions).toEqual({});
    expect(result.pet?.expressionSourceKinds).toEqual({});
    expect(result.pet?.expressionSourceFiles).toEqual({});
    expect(result.pet?.expressionEffects).toEqual({});
    expect(result.pet?.expressionSources).toEqual([
      { sourceFileName: "angry01.mtn", runtimeName: "Tap", sourceKind: "motion" }
    ]);
  });

  it("rejects mappings that do not reference an imported source", async () => {
    await writeLegacyPet();
    const configPath = getPetConfigPath();
    const existing = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    existing.expressionSources = [
      { sourceFileName: "tap.motion3.json", runtimeName: "Tap", sourceKind: "motion" }
    ];
    await fs.writeFile(configPath, JSON.stringify(existing), "utf8");
    const { saveLocalPetExpressionMappings } = await import("./petConfigStore");

    const result = await saveLocalPetExpressionMappings({
      petId: "pet-a",
      mappings: [{ sourceFileName: "forged.motion3.json", runtimeName: "Tap", sourceKind: "motion", mappingKey: "tap", description: "测试" }],
      sources: [{ sourceFileName: "forged.motion3.json", runtimeName: "Tap", sourceKind: "motion" }]
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("不属于当前已导入");
  });
});

describe("legacy Live2D model path migration", () => {
  it("replaces a relative packaged-app model path with the validated local resource URL", async () => {
    await writeLegacyPet();
    const live2dDirectory = path.join(getPetDirectory(), "live2d");
    const configPath = getPetConfigPath();
    const existing = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;

    await fs.mkdir(live2dDirectory, { recursive: true });
    await fs.writeFile(
      path.join(live2dDirectory, "model.json"),
      JSON.stringify({ model: "model.moc", textures: [] }),
      "utf8"
    );
    await fs.writeFile(path.join(live2dDirectory, "model.moc"), "fixture", "utf8");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...existing,
          modelPath: "pet-a/live2d/model.json",
          live2dSettings: {
            entryFileName: "model.json",
            textureCount: 0,
            motionCount: 0,
            expressionCount: 0
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const { listLocalPets } = await import("./petConfigStore");
    const [pet] = await listLocalPets();
    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as { modelPath: string };

    expect(pet?.modelPath).toBe("pet-resource://local/pet-a/live2d/model.json");
    expect(persisted.modelPath).toBe("pet-resource://local/pet-a/live2d/model.json");
  });
});

describe("旧版桌宠配置结构兼容", () => {
  it("读取时补齐新增字段但不擅自改写原配置文件", async () => {
    const petId = "legacy-shape";
    const configPath = getPetConfigPath(petId);
    const oldConfig = {
      id: petId,
      name: "Legacy Shape",
      details: {
        scenarios: ["学习"]
      },
      voiceModelSettings: {
        enabled: true,
        connected: false,
        referenceAudioPath: "reference.wav"
      }
    };
    await fs.mkdir(getPetDirectory(petId), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(oldConfig, null, 2), "utf8");
    const originalContent = await fs.readFile(configPath, "utf8");

    const { getLocalPetDefinition } = await import("./petConfigStore");
    const pet = await getLocalPetDefinition(petId);

    expect(pet).toMatchObject({
      id: petId,
      modelPath: "",
      personaPrompt: "",
      details: {
        scenes: ["学习"],
        features: []
      },
      voiceModelSettings: {
        referenceAudioPath: "reference.wav",
        referenceText: "",
        language: "zh"
      },
      uiSettings: {
        desktopScale: 1
      }
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(originalContent);
  });

  it("只迁移能够相对根目录精确解析的旧版声音模型路径", async () => {
    const petId = "legacy-voice-path";
    const configPath = getPetConfigPath(petId);
    const voiceRoot = path.join(temporaryDirectory, "voice-runtime");
    const modelDirectory = path.join(voiceRoot, "GPT_SoVITS", "pretrained_models");
    const sovitsPath = path.join(modelDirectory, "legacy.pth");
    const gptPath = path.join(modelDirectory, "legacy.ckpt");
    await Promise.all([
      fs.mkdir(getPetDirectory(petId), { recursive: true }),
      fs.mkdir(modelDirectory, { recursive: true })
    ]);
    await Promise.all([
      fs.writeFile(sovitsPath, "fixture"),
      fs.writeFile(gptPath, "fixture")
    ]);
    await fs.writeFile(configPath, JSON.stringify({
      id: petId,
      name: "Legacy Voice Path",
      gptSoVitsRootPath: voiceRoot,
      voiceModelSettings: {
        enabled: false,
        connected: false,
        gptSoVitsRootPath: voiceRoot,
        sovitsModelPath: "GPT_SoVITS/pretrained_models/legacy.pth",
        gptModelPath: "GPT_SoVITS/pretrained_models/legacy.ckpt",
        referenceText: "",
        language: "zh"
      }
    }, null, 2), "utf8");

    const { getLocalPetDefinition } = await import("./petConfigStore");
    const pet = await getLocalPetDefinition(petId);
    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as PetDefinition;
    const [realSovitsPath, realGptPath] = await Promise.all([
      fs.realpath(sovitsPath),
      fs.realpath(gptPath)
    ]);

    await expect(fs.realpath(pet?.voiceModelSettings?.sovitsModelPath ?? ""))
      .resolves.toBe(realSovitsPath);
    await expect(fs.realpath(pet?.voiceModelSettings?.gptModelPath ?? ""))
      .resolves.toBe(realGptPath);
    await expect(fs.realpath(persisted.voiceModelSettings?.sovitsModelPath ?? ""))
      .resolves.toBe(realSovitsPath);
    await expect(fs.realpath(persisted.voiceModelSettings?.gptModelPath ?? ""))
      .resolves.toBe(realGptPath);
    await expect(fs.access(`${configPath}.bak`)).resolves.toBeUndefined();
  });
});

describe("avatar draft cleanup", () => {
  it("removes the temporary avatar draft after the new pet has been saved", async () => {
    const draftPetId = "draft-avatar1";
    const sourceAvatarPath = path.join(
      getPetDirectory(draftPetId),
      "assets",
      "avatar-crop.png"
    );
    await fs.mkdir(path.dirname(sourceAvatarPath), { recursive: true });
    await fs.writeFile(sourceAvatarPath, "avatar", "utf8");

    const { saveLocalPetBasicInfo } = await import("./petConfigStore");
    const result = await saveLocalPetBasicInfo({
      name: "Saved pet",
      avatarImage: `pet-resource://local/${draftPetId}/assets/avatar-crop.png`,
      description: "",
      role: "",
      personality: "",
      scenes: []
    });

    expect(result.ok).toBe(true);
    await expect(fs.access(getPetDirectory(draftPetId))).rejects.toThrow();
    await expect(fs.access(path.join(getPetDirectory("saved-pet"), "pet.local.json"))).resolves.toBeUndefined();
  });

  it("removes legacy avatar-only drafts but preserves formal or unknown directories", async () => {
    const removableDraftId = "draft-old1";
    const preservedDraftId = "draft-unknown1";
    const removableAvatar = path.join(
      getPetDirectory(removableDraftId),
      "assets",
      "avatar.png"
    );
    const unknownFile = path.join(getPetDirectory(preservedDraftId), "assets", "notes.txt");
    await fs.mkdir(path.dirname(removableAvatar), { recursive: true });
    await fs.mkdir(path.dirname(unknownFile), { recursive: true });
    await fs.writeFile(removableAvatar, "avatar", "utf8");
    await fs.writeFile(unknownFile, "keep", "utf8");
    await writeLegacyPet("draft-config1");

    const { cleanupOrphanedAvatarDrafts } = await import("./petConfigStore");
    await cleanupOrphanedAvatarDrafts();

    await expect(fs.access(getPetDirectory(removableDraftId))).rejects.toThrow();
    await expect(fs.access(getPetDirectory(preservedDraftId))).resolves.toBeUndefined();
    await expect(fs.access(getPetConfigPath("draft-config1"))).resolves.toBeUndefined();
  });
});

describe("GPT-SoVITS resource validation", () => {
  it.each(["v5dev", "v5turbo"] as const)("persists and reloads a disabled %s configuration without requiring resources", async (modelVersion) => {
    await writeLegacyPet();
    const { saveLocalPetVoiceModel, listLocalPets } = await import("./petConfigStore");
    const result = await saveLocalPetVoiceModel({
      petId: "pet-a", enabled: false, connected: false, modelVersion,
      referenceText: "", referenceLanguage: "zh", language: "zh", playMode: "sentence",
      inferenceDevice: "cpu", halfPrecision: false, syncTextWithVoice: true
    });

    expect(result.ok, result.message).toBe(true);
    const stored = JSON.parse(await fs.readFile(getPetConfigPath(), "utf8"));
    expect(stored.voiceModelSettings.modelVersion).toBe(modelVersion);
    const reloaded = (await listLocalPets()).find((pet) => pet.id === "pet-a");
    expect(reloaded?.voiceModelSettings).toMatchObject({ modelVersion, enabled: false, connected: false });
  });

  it("does not append historical inference logs to a missing-resource error", async () => {
    const petId = "voice-resource-test";
    const voiceRootPath = path.join(temporaryDirectory, "gpt-sovits");
    const sovitsModelPath = path.join(temporaryDirectory, "voice.pth");
    const gptModelPath = path.join(temporaryDirectory, "voice.ckpt");
    const missingReferencePath = path.join(temporaryDirectory, "moved-reference.wav");
    const logPath = path.resolve(process.cwd(), "logs", `gpt-sovits-${petId}.log`);
    await fs.mkdir(path.join(voiceRootPath, "runtime"), { recursive: true });
    await fs.mkdir(path.join(voiceRootPath, "GPT_SoVITS", "pretrained_models", "chinese-roberta-wwm-ext-large"), { recursive: true });
    await fs.mkdir(path.join(voiceRootPath, "GPT_SoVITS", "pretrained_models", "chinese-hubert-base"), { recursive: true });
    await fs.writeFile(path.join(voiceRootPath, "runtime", "python.exe"), "python", "utf8");
    await fs.writeFile(path.join(voiceRootPath, "api_v2.py"), "api", "utf8");
    await fs.writeFile(sovitsModelPath, "fixture", "utf8");
    await fs.writeFile(gptModelPath, "fixture", "utf8");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, "HISTORICAL_INFERENCE_PROGRESS 1499/1500 99%", "utf8");

    const draft: LocalPetVoiceModelDraft = {
      petId,
      enabled: true,
      connected: false,
      modelVersion: "v2ProPlus",
      gptSoVitsRootPath: voiceRootPath,
      sovitsModelPath,
      gptModelPath,
      referenceAudioPath: missingReferencePath,
      referenceText: "参考文本",
      referenceLanguage: "zh",
      language: "zh",
      playMode: "sentence",
      inferenceDevice: "cpu",
      halfPrecision: false,
      syncTextWithVoice: true
    };

    const { testLocalPetVoiceModelConnection } = await import("./petConfigStore");
    const result = await testLocalPetVoiceModelConnection(draft).finally(() =>
      fs.rm(logPath, { force: true })
    );

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("找不到参考音频")
    });
    expect(result.message).not.toContain("HISTORICAL_INFERENCE_PROGRESS");
    expect(result.message).not.toContain("最近日志");
  });

  it.each(["v4", "v5dev", "v5turbo"] as const)("writes %s into the managed runtime config", async (modelVersion) => {
    const { buildGptSoVitsRuntimeConfigContent } = await import("./petConfigStore");
    const content = buildGptSoVitsRuntimeConfigContent(
      {
        gptSoVitsRootPath: "D:\\GPT-SoVITS",
        sovitsModelPath: "D:\\weights\\voice.pth",
        gptModelPath: "D:\\weights\\voice.ckpt",
        modelVersion
      },
      {
        device: "cpu",
        isHalf: false
      }
    );

    expect(content).toContain(`  version: ${modelVersion}\n`);
    expect(content).not.toContain("version: v2ProPlus");
  });
});

describe("pet-resource protocol handler boundary", () => {
  it("rejects local config and voice paths while serving assets and Live2D resources", async () => {
    const petDirectory = getPetDirectory();
    const assetPath = path.join(petDirectory, "assets", "avatar.png");
    const modelPath = path.join(petDirectory, "live2d", "model.model3.json");
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.mkdir(path.join(petDirectory, "voice"), { recursive: true });
    await fs.writeFile(getPetConfigPath(), "{}", "utf8");
    await fs.writeFile(path.join(petDirectory, "voice", "reference.wav"), "voice", "utf8");
    await fs.writeFile(assetPath, "image", "utf8");
    await fs.writeFile(modelPath, "{}", "utf8");

    const { registerPetResourceProtocol } = await import("./petResourceProtocol");
    registerPetResourceProtocol();
    const handler = electronMock.protocolHandlers.get("pet-resource");

    expect(handler).toBeDefined();
    await expect(
      handler?.({ url: "pet-resource://local/pet-a/pet.local.json" })
    ).rejects.toThrow();
    await expect(
      handler?.({ url: "pet-resource://local/pet-a/voice/reference.wav" })
    ).rejects.toThrow();

    const assetResponse = await handler?.({
      url: "pet-resource://local/pet-a/assets/avatar.png"
    });
    const modelResponse = await handler?.({
      url: "pet-resource://local/pet-a/live2d/model.model3.json"
    });

    expect(assetResponse?.status).toBe(200);
    expect(modelResponse?.status).toBe(200);
    expect(assetResponse?.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(electronMock.netFetch).toHaveBeenCalledTimes(2);
  });
});

describe("preset voice resource cleanup", () => {
  it("persists a disabled event subtitle without requiring a custom line and removes the override when re-enabled", async () => {
    await writeLegacyPet();
    const { saveLocalPetEventSettings } = await import("./petConfigStore");

    const disabledResult = await saveLocalPetEventSettings({
      petId: "pet-a",
      events: [{ event: "click", lines: [], showSubtitle: false }]
    });

    expect(disabledResult.ok).toBe(true);
    expect(disabledResult.pet?.eventSettings?.click).toMatchObject({ showSubtitle: false });

    const enabledResult = await saveLocalPetEventSettings({
      petId: "pet-a",
      events: [{ event: "click", lines: [], showSubtitle: true }]
    });

    expect(enabledResult.ok).toBe(true);
    expect(enabledResult.pet?.eventSettings?.click).toBeUndefined();
  });

  it("removes deleted line audio only after its final event or mood reference is gone", async () => {
    await writeLegacyPet();
    const config = JSON.parse(await fs.readFile(getPetConfigPath(), "utf8")) as PetDefinition;
    const sharedAudio = {
      schemaVersion: 1 as const,
      resourceId: "shared_audio",
      sourceTextHash: "a".repeat(64),
      spokenText: "共享台词",
      language: "zh" as const,
      mimeType: "audio/wav",
      voiceFingerprint: "b".repeat(64),
      generatedAt: 1
    };
    const moodOnlyAudio = {
      ...sharedAudio,
      resourceId: "mood_only_audio",
      sourceTextHash: "c".repeat(64),
      spokenText: "心情台词"
    };
    config.lines = {
      click: [{ id: "event_line", text: "共享台词", presetAudio: sharedAudio }]
    };
    config.moodSettings = {
      ranges: {
        calm: {
          enterLine: { id: "calm_line", text: "共享台词", presetAudio: sharedAudio }
        },
        joyful: {
          enterLine: { id: "joyful_line", text: "心情台词", presetAudio: moodOnlyAudio }
        }
      }
    };
    await fs.writeFile(getPetConfigPath(), JSON.stringify(config, null, 2), "utf8");
    const presetDirectory = path.join(getPetDirectory(), "voice", "presets");
    const sharedPath = path.join(presetDirectory, "shared_audio.wav");
    const moodOnlyPath = path.join(presetDirectory, "mood_only_audio.wav");
    await fs.mkdir(presetDirectory, { recursive: true });
    await Promise.all([
      fs.writeFile(sharedPath, "shared", "utf8"),
      fs.writeFile(moodOnlyPath, "mood", "utf8")
    ]);

    const { saveLocalPetEventSettings, saveLocalPetMoodSettings } = await import("./petConfigStore");
    const eventResult = await saveLocalPetEventSettings({
      petId: "pet-a",
      events: [{ event: "click", lines: [] }]
    });

    expect(eventResult.ok).toBe(true);
    await expect(fs.access(sharedPath)).resolves.toBeUndefined();

    const moodResult = await saveLocalPetMoodSettings({ petId: "pet-a", settings: {} });

    expect(moodResult.ok).toBe(true);
    await expect(fs.access(sharedPath)).rejects.toThrow();
    await expect(fs.access(moodOnlyPath)).rejects.toThrow();
  });

  it("clears one binding without orphaning a resource that another line still references", async () => {
    await writeLegacyPet();
    const config = JSON.parse(await fs.readFile(getPetConfigPath(), "utf8")) as PetDefinition;
    const sharedAudio = {
      schemaVersion: 1 as const,
      resourceId: "shared_single_audio",
      sourceTextHash: "a".repeat(64),
      spokenText: "共享台词",
      language: "zh" as const,
      mimeType: "audio/wav",
      voiceFingerprint: "b".repeat(64),
      generatedAt: 1
    };
    config.lines = {
      click: [{ id: "event-shared", text: "共享台词", presetAudio: sharedAudio }]
    };
    config.moodSettings = {
      ranges: {
        calm: { enterLine: { id: "mood-shared", text: "共享台词", presetAudio: sharedAudio } }
      }
    };
    await fs.writeFile(getPetConfigPath(), JSON.stringify(config, null, 2), "utf8");

    const { clearLocalPetPresetAudioTarget, getLocalPetDefinition } = await import("./petConfigStore");
    const { collectPresetVoiceTargets } = await import("../presetVoice/presetVoiceTargets");
    const pet = (await getLocalPetDefinition("pet-a"))!;
    const eventTarget = collectPresetVoiceTargets(pet).find((target) => target.targetId === "event-shared")!;
    const first = await clearLocalPetPresetAudioTarget({ petId: "pet-a", target: eventTarget });

    expect(first.removed?.resourceId).toBe("shared_single_audio");
    expect(first.shouldDeleteFile).toBe(false);

    const nextPet = (await getLocalPetDefinition("pet-a"))!;
    const moodTarget = collectPresetVoiceTargets(nextPet).find((target) => target.targetId === "mood-shared")!;
    const second = await clearLocalPetPresetAudioTarget({ petId: "pet-a", target: moodTarget });

    expect(second.removed?.resourceId).toBe("shared_single_audio");
    expect(second.shouldDeleteFile).toBe(true);
  });
});
