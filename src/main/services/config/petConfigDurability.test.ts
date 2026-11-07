import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  userDataPath: "",
  openDialogResult: { canceled: true, filePaths: [] as string[] },
  validateLive2DFolder: vi.fn(async () => ({ ok: false, message: "not imported" }))
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => testState.userDataPath,
    isReady: () => true
  },
  dialog: {
    showOpenDialog: vi.fn(async () => testState.openDialogResult)
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8")
  },
  net: {
    fetch: vi.fn()
  },
  protocol: {
    handle: vi.fn()
  }
}));

vi.mock("./live2dImportService", () => ({
  validateLive2DFolder: testState.validateLive2DFolder
}));

vi.mock("../speech/textToSpeech", () => ({
  warmUpTextToSpeech: vi.fn()
}));

let temporaryDirectory = "";

function getPetDirectory(petId = "pet-a"): string {
  return path.join(temporaryDirectory, "pets", petId);
}

function getPetConfigPath(petId = "pet-a"): string {
  return path.join(getPetDirectory(petId), "pet.local.json");
}

function getPetBackupPath(petId = "pet-a"): string {
  return `${getPetConfigPath(petId)}.bak`;
}

function createPet(petId = "pet-a", personaPrompt = "old persona") {
  return {
    id: petId,
    name: "Fixture Pet",
    description: "fixture",
    modelPath: "",
    personaPrompt,
    capabilities: {
      chat: true,
      voiceInput: false,
      voiceOutput: false,
      subtitles: true
    },
    details: {
      role: "fixture",
      personality: "fixture",
      scenes: [],
      features: []
    },
    expressions: {},
    expressionDescriptions: {},
    lines: {},
    uiSettings: {
      theme: "soft",
      clickThroughOpacity: 0.45
    },
    subtitleStyle: {
      tone: "soft"
    },
    isLocal: true
  };
}

async function writePetFixture(petId = "pet-a", personaPrompt = "old persona"): Promise<void> {
  await fs.mkdir(getPetDirectory(petId), { recursive: true });
  await fs.writeFile(
    getPetConfigPath(petId),
    `${JSON.stringify(createPet(petId, personaPrompt), null, 2)}\n`,
    "utf8"
  );
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-durability-"));
  testState.userDataPath = temporaryDirectory;
  testState.openDialogResult = { canceled: true, filePaths: [] };
  testState.validateLive2DFolder.mockReset();
  testState.validateLive2DFolder.mockResolvedValue({ ok: false, message: "not imported" });
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("pet config durable persistence", () => {
  it("never overwrites a future local schema, including through backup restoration", async () => {
    await writePetFixture();
    const future = JSON.stringify({ ...createPet(), schemaVersion: 2, futureField: { keep: true } });
    await fs.writeFile(getPetBackupPath(), JSON.stringify(createPet()));
    await fs.writeFile(getPetConfigPath(), future);
    const { getLocalPetDefinition, saveLocalPetPersona, restoreLocalPetConfigBackup } = await import("./petConfigStore");
    await expect(getLocalPetDefinition("pet-a")).rejects.toMatchObject({ code: "CONFIG_VERSION_UNSUPPORTED" });
    await expect(saveLocalPetPersona({ petId: "pet-a", personaPrompt: "new", chatLanguage: "zh", replyLength: "short" }))
      .rejects.toMatchObject({ code: "CONFIG_VERSION_UNSUPPORTED" });
    expect(await restoreLocalPetConfigBackup("pet-a")).toMatchObject({ ok: false, message: expect.stringMatching(/更新版本/) });
    expect(await fs.readFile(getPetConfigPath(), "utf8")).toBe(future);
    await writePetFixture("pet-b");
    const scan = await (await import("./petConfigStore")).scanLocalPetsForRecovery();
    expect(scan.pets.map((pet) => pet.id)).toEqual(["pet-b"]);
    expect(scan.corruptions).toMatchObject([{ code: "CONFIG_VERSION_UNSUPPORTED", petId: "pet-a", backupAvailable: false }]);
  });

  it("persists the current local schema only on save", async () => {
    await writePetFixture();
    const { getLocalPetDefinition, saveLocalPetPersona } = await import("./petConfigStore");
    expect((await getLocalPetDefinition("pet-a"))?.schemaVersion).toBe(1);
    expect(JSON.parse(await fs.readFile(getPetConfigPath(), "utf8"))).not.toHaveProperty("schemaVersion");
    await saveLocalPetPersona({ petId: "pet-a", personaPrompt: "saved", chatLanguage: "zh", replyLength: "short" });
    expect(JSON.parse(await fs.readFile(getPetConfigPath(), "utf8")).schemaVersion).toBe(1);
  });
  it("keeps the previous config intact when the atomic target rename fails", async () => {
    await writePetFixture();
    const originalContent = await fs.readFile(getPetConfigPath(), "utf8");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(getPetConfigPath())) {
        throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
      }

      return originalRename(source, target);
    });
    const { saveLocalPetPersona } = await import("./petConfigStore");

    await expect(
      saveLocalPetPersona({
        petId: "pet-a",
        personaPrompt: "new persona",
        chatLanguage: "zh",
        replyLength: "medium"
      })
    ).rejects.toThrow("injected rename failure");

    expect(await fs.readFile(getPetConfigPath(), "utf8")).toBe(originalContent);
    expect(JSON.parse(await fs.readFile(getPetBackupPath(), "utf8"))).toMatchObject({
      personaPrompt: "old persona"
    });
    expect(renameSpy).toHaveBeenCalled();
  });

  it("serializes concurrent read-modify-write saves for the same pet", async () => {
    await writePetFixture();
    const { saveLocalPetPersona, saveLocalPetUiSettings } = await import("./petConfigStore");

    await Promise.all([
      saveLocalPetPersona({
        petId: "pet-a",
        personaPrompt: "serialized persona",
        chatLanguage: "zh",
        replyLength: "short"
      }),
      saveLocalPetUiSettings({
        petId: "pet-a",
        theme: "rock",
        clickThroughOpacity: 0.63,
        desktopScale: 1.25
      })
    ]);

    const stored = JSON.parse(await fs.readFile(getPetConfigPath(), "utf8"));
    expect(stored.personaPrompt).toBe("serialized persona");
    expect(stored.personaSettings).toMatchObject({ chatLanguage: "zh", replyLength: "short" });
    expect(stored.uiSettings).toMatchObject({
      theme: "rock",
      clickThroughOpacity: 0.63,
      desktopScale: 1.25
    });
  });

  it("reloads the saved desktop scale and companion quick actions after a process restart", async () => {
    await writePetFixture();
    const { saveLocalPetUiSettings } = await import("./petConfigStore");
    await saveLocalPetUiSettings({
      petId: "pet-a",
      theme: "soft",
      clickThroughOpacity: 0.55,
      cursorFollowEnabled: false,
      desktopScale: 1.5
    });

    vi.resetModules();
    const { getLocalPetDefinition } = await import("./petConfigStore");
    const reloadedPet = await getLocalPetDefinition("pet-a");

    expect(reloadedPet?.uiSettings).toMatchObject({
      clickThroughOpacity: 0.55,
      cursorFollowEnabled: false,
      desktopScale: 1.5
    });
  });

  it("stores an imported custom theme only inside the selected pet definition", async () => {
    await writePetFixture();
    const themePath = path.join(temporaryDirectory, "mint-plaid.json");
    await fs.writeFile(
      themePath,
      JSON.stringify({
        id: "mint-plaid",
        name: "薄荷格纹",
        description: "当前桌宠的主题",
        version: 1,
        tokens: {
          background: "#f3fbf8",
          surface: "rgba(255, 250, 240, 0.92)",
          headerSurface: "linear-gradient(135deg, #fff, #e4f4c8)",
          headerText: "#36552c",
          inputSurface: "#fbfff6",
          userSurface: "linear-gradient(145deg, #7fa84c, #5f8736)",
          text: "#273047",
          mutedText: "#6d7f89",
          accent: "#0f7281",
          decorationPrimary: "#73a136",
          decorationSecondary: "#8eae62",
          watermarkColor: "rgba(111, 152, 64, 0.10)",
          border: "rgba(102, 137, 135, 0.34)"
        },
        chatDecorations: {
          "header-left": "citrus",
          "header-right": "flower-2",
          "frame-top-right": "leaf",
          "body-watermark": "flower-2"
        },
        radialMenu: {
          radius: 15,
          surface: "#ffffff",
          text: "#36552c",
          border: "#668987",
          center: { surface: "#f3fbf8", text: "#36552c" },
          actions: {
            chat: { surface: "#eff8d7", text: "#577838" }
          }
        }
      }),
      "utf8"
    );
    testState.openDialogResult = { canceled: false, filePaths: [themePath] };
    const { importLocalUiTheme, saveLocalPetUiSettings } = await import("./petConfigStore");

    const imported = await importLocalUiTheme();
    expect(imported.ok).toBe(true);
    expect(imported.theme?.id).toBe("mint-plaid");
    await saveLocalPetUiSettings({
      petId: "pet-a",
      theme: "custom",
      customTheme: imported.theme
    });

    const stored = JSON.parse(await fs.readFile(getPetConfigPath(), "utf8"));
    expect(stored.uiSettings).toMatchObject({
      theme: "custom",
      customTheme: {
        id: "mint-plaid",
        name: "薄荷格纹",
        tokens: {
          accent: "#0f7281",
          headerSurface: "linear-gradient(135deg, #fff, #e4f4c8)",
          userSurface: "linear-gradient(145deg, #7fa84c, #5f8736)",
          watermarkColor: "rgba(111, 152, 64, 0.10)"
        },
        radialMenu: {
          radius: 15,
          actions: {
            chat: { surface: "#eff8d7", text: "#577838" }
          }
        },
        chatDecorations: {
          "header-left": "citrus",
          "header-right": "flower-2",
          "frame-top-right": "leaf",
          "body-watermark": "flower-2"
        }
      }
    });
    await expect(fs.access(path.join(temporaryDirectory, "themes"))).rejects.toThrow();
  });

  it("keeps the pet-local custom theme when a built-in theme is saved", async () => {
    await writePetFixture();
    const { saveLocalPetUiSettings } = await import("./petConfigStore");
    await saveLocalPetUiSettings({
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        id: "mint-plaid",
        name: "薄荷格纹",
        description: "当前桌宠的主题",
        version: 1,
        tokens: {
          background: "#f3fbf8",
          surface: "#ffffff",
          text: "#273047",
          mutedText: "#6d7f89",
          accent: "#0f7281",
          border: "#668987"
        }
      }
    });
    await saveLocalPetUiSettings({ petId: "pet-a", theme: "minimal" });

    const stored = JSON.parse(await fs.readFile(getPetConfigPath(), "utf8"));
    expect(stored.uiSettings.theme).toBe("minimal");
    expect(stored.uiSettings.customTheme).toMatchObject({ id: "mint-plaid", name: "薄荷格纹" });

    await saveLocalPetUiSettings({
      petId: "pet-a",
      theme: "minimal",
      removeCustomTheme: true
    });

    const afterDelete = JSON.parse(await fs.readFile(getPetConfigPath(), "utf8"));
    expect(afterDelete.uiSettings.theme).toBe("minimal");
    expect(afterDelete.uiSettings).not.toHaveProperty("customTheme");
  });

  it("durably reloads a partially off-screen desktop position and preserves it in later UI saves", async () => {
    await writePetFixture();
    const { saveLocalPetDesktopPosition, saveLocalPetUiSettings } = await import(
      "./petConfigStore"
    );
    await saveLocalPetDesktopPosition("pet-a", { x: -820, y: 1000 });
    await saveLocalPetUiSettings({
      petId: "pet-a",
      theme: "journal",
      clickThroughOpacity: 0.5,
      cursorFollowEnabled: true,
      desktopScale: 1.25
    });

    vi.resetModules();
    const { getLocalPetDefinition } = await import("./petConfigStore");
    const reloadedPet = await getLocalPetDefinition("pet-a");

    expect(reloadedPet?.uiSettings).toMatchObject({
      theme: "journal",
      desktopScale: 1.25,
      desktopPosition: { x: -820, y: 1000 }
    });
  });

  it("restores the most recent valid backup without replacing it with damaged content", async () => {
    await writePetFixture();
    const { listLocalPets, restoreLocalPetConfigBackup, saveLocalPetPersona } = await import(
      "./petConfigStore"
    );
    await saveLocalPetPersona({
      petId: "pet-a",
      personaPrompt: "new persona",
      chatLanguage: "zh",
      replyLength: "medium"
    });
    await fs.writeFile(getPetConfigPath(), "{ damaged", "utf8");

    await expect(listLocalPets()).rejects.toMatchObject({
      code: "PET_CONFIG_CORRUPTED",
      backupAvailable: true
    });

    const result = await restoreLocalPetConfigBackup("pet-a");
    const restored = JSON.parse(await fs.readFile(getPetConfigPath(), "utf8"));
    const backup = JSON.parse(await fs.readFile(getPetBackupPath(), "utf8"));

    expect(result.ok).toBe(true);
    expect(restored.personaPrompt).toBe("old persona");
    expect(backup.personaPrompt).toBe("old persona");
  });

  it("reports corruption and never rebuilds or overwrites it from a Live2D directory", async () => {
    await fs.mkdir(path.join(getPetDirectory(), "live2d"), { recursive: true });
    await fs.writeFile(getPetConfigPath(), "{ damaged config", "utf8");
    testState.validateLive2DFolder.mockResolvedValue({
      ok: true,
      message: "valid fixture model",
      entryFilePath: path.join(getPetDirectory(), "live2d", "model.model3.json"),
      entryFileName: "model.model3.json",
      textureCount: 1,
      motionCount: 0,
      expressionCount: 0
    });
    const { listLocalPets, PetConfigCorruptedError } = await import("./petConfigStore");

    await expect(listLocalPets()).rejects.toBeInstanceOf(PetConfigCorruptedError);
    expect(await fs.readFile(getPetConfigPath(), "utf8")).toBe("{ damaged config");
    expect(testState.validateLive2DFolder).not.toHaveBeenCalled();
  });

  it("keeps valid pets visible while separately reporting a damaged config", async () => {
    await writePetFixture("pet-valid", "valid persona");
    await fs.mkdir(getPetDirectory("pet-damaged"), { recursive: true });
    await fs.writeFile(getPetConfigPath("pet-damaged"), "{ damaged config", "utf8");
    const { scanLocalPetsForRecovery } = await import("./petConfigStore");

    const result = await scanLocalPetsForRecovery();

    expect(result.pets).toEqual([
      expect.objectContaining({ id: "pet-valid", personaPrompt: "valid persona" })
    ]);
    expect(result.corruptions).toEqual([
      expect.objectContaining({
        code: "PET_CONFIG_CORRUPTED",
        petId: "pet-damaged"
      })
    ]);
    expect(await fs.readFile(getPetConfigPath("pet-damaged"), "utf8")).toBe(
      "{ damaged config"
    );
  });

  it("rejects malicious, oversized, and avatar traversal pet IDs before writing", async () => {
    const avatarPath = path.join(temporaryDirectory, "source.png");
    await fs.writeFile(avatarPath, "fixture", "utf8");
    const { saveLocalPetAvatarCrop, saveLocalPetBasicInfo } = await import("./petConfigStore");

    await expect(
      saveLocalPetAvatarCrop({
        petId: "../../escaped",
        dataUrl: "data:image/png;base64,AA=="
      })
    ).rejects.toThrow("桌宠 ID 无效");
    await expect(
      saveLocalPetAvatarCrop({
        petId: "a".repeat(65),
        dataUrl: "data:image/png;base64,AA=="
      })
    ).rejects.toThrow("桌宠 ID 无效");
    await expect(
      saveLocalPetBasicInfo({
        id: "../outside",
        name: "Unsafe Pet",
        avatarImage: avatarPath,
        description: "",
        role: "",
        personality: "",
        scenes: []
      })
    ).rejects.toThrow("桌宠 ID 无效");

    await expect(fs.access(path.join(temporaryDirectory, "escaped"))).rejects.toThrow();
    await expect(fs.access(path.join(temporaryDirectory, "outside"))).rejects.toThrow();
  });
});
