import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataPath: ""
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath
  },
  net: {
    fetch: vi.fn()
  },
  protocol: {
    handle: vi.fn()
  }
}));

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-pet-resource-"));
  electronMock.userDataPath = temporaryDirectory;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("pet-resource local path boundary", () => {
  it("allows only assets and live2d descendants", async () => {
    const { resolvePetResourcePathForProtocol } = await import("./petResourceProtocol");

    const avatar = resolvePetResourcePathForProtocol(
      "pet-resource://local/pet-a/assets/avatar.png"
    );
    const model = resolvePetResourcePathForProtocol(
      "pet-resource://local/pet-a/live2d/model.model3.json"
    );

    expect(avatar.filePath).toBe(
      path.join(temporaryDirectory, "pets", "pet-a", "assets", "avatar.png")
    );
    expect(model.filePath).toBe(
      path.join(temporaryDirectory, "pets", "pet-a", "live2d", "model.model3.json")
    );
  });

  it("accepts canonical Unicode pet IDs", async () => {
    const { resolvePetResourcePathForProtocol } = await import("./petResourceProtocol");
    const petId = "桌宠_灵-01";
    const resource = resolvePetResourcePathForProtocol(
      `pet-resource://local/${encodeURIComponent(petId)}/live2d/model.model3.json`
    );

    expect(resource.filePath).toBe(
      path.join(temporaryDirectory, "pets", petId, "live2d", "model.model3.json")
    );
  });

  it("rejects non-canonical and overlong pet IDs", async () => {
    const { resolvePetResourcePathForProtocol } = await import("./petResourceProtocol");
    const invalidPetIds = [
      "-leading-hyphen",
      "contains space",
      "contains.dot",
      `a${"b".repeat(64)}`
    ];

    for (const petId of invalidPetIds) {
      expect(() =>
        resolvePetResourcePathForProtocol(
          `pet-resource://local/${encodeURIComponent(petId)}/live2d/model.model3.json`
        )
      ).toThrow();
    }
  });

  it("rejects pet config, voice files, and traversal segments", async () => {
    const { resolvePetResourcePathForProtocol } = await import("./petResourceProtocol");

    expect(() =>
      resolvePetResourcePathForProtocol("pet-resource://local/pet-a/pet.local.json")
    ).toThrow();
    expect(() => resolvePetResourcePathForProtocol("pet-resource://local/pet-a/ai-connection-transaction.json")).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol("pet-resource://local/pet-a/voice/config.yaml")
    ).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(
        "pet-resource://local/pet-a/live2d/%2e%2e/pet.local.json"
      )
    ).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(
        "pet-resource://local/pet-a/live2d/..%2fpet.local.json"
      )
    ).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(
        "pet-resource://local/pet-a/live2d/%2e%2e%5cpet.local.json"
      )
    ).toThrow();
  });

  it("rejects conversion of files outside the local pets root", async () => {
    const { toPetResourceUrl } = await import("./petResourceProtocol");

    expect(() =>
      toPetResourceUrl(path.join(temporaryDirectory, "outside", "model.model3.json"))
    ).toThrow("inside the local pets directory");
  });

  it("rejects a resource-root link that escapes the pet directory", async () => {
    const { resolvePetResourcePathForProtocol, resolveRealResourcePathForProtocol } = await import(
      "./petResourceProtocol"
    );
    const petDirectory = path.join(temporaryDirectory, "pets", "pet-a");
    const outsideDirectory = path.join(temporaryDirectory, "outside-live2d");
    await fs.mkdir(petDirectory, { recursive: true });
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(path.join(outsideDirectory, "model.model3.json"), "{}", "utf8");
    await fs.symlink(
      outsideDirectory,
      path.join(petDirectory, "live2d"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const resource = resolvePetResourcePathForProtocol(
      "pet-resource://local/pet-a/live2d/model.model3.json"
    );

    await expect(resolveRealResourcePathForProtocol(resource)).rejects.toThrow(
      "symbolic link escaped"
    );
  });

  it("rejects a local pets root link that escapes userData", async () => {
    const { resolvePetResourcePathForProtocol, resolveRealResourcePathForProtocol } = await import(
      "./petResourceProtocol"
    );
    const outsideDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "zhuomianling-outside-pets-")
    );

    try {
      const modelDirectory = path.join(outsideDirectory, "pet-a", "live2d");
      await fs.mkdir(modelDirectory, { recursive: true });
      await fs.writeFile(path.join(modelDirectory, "model.model3.json"), "{}", "utf8");
      await fs.symlink(
        outsideDirectory,
        path.join(temporaryDirectory, "pets"),
        process.platform === "win32" ? "junction" : "dir"
      );

      const resource = resolvePetResourcePathForProtocol(
        "pet-resource://local/pet-a/live2d/model.model3.json"
      );

      await expect(resolveRealResourcePathForProtocol(resource)).rejects.toThrow(
        "symbolic link escaped"
      );
    } finally {
      await fs.rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});

describe("pet-resource preview boundary", () => {
  it("allows Live2D file types and rejects local config or unrelated files", async () => {
    const { registerPetResourcePreviewRoot, resolvePetResourcePathForProtocol } = await import(
      "./petResourceProtocol"
    );
    const token = registerPetResourcePreviewRoot(temporaryDirectory);
    expect(() => resolvePetResourcePathForProtocol(`pet-resource://preview/${token}/ai-connection-transaction.json`)).toThrow();

    expect(() =>
      resolvePetResourcePathForProtocol(
        `pet-resource://preview/${token}/model/model.model3.json`
      )
    ).not.toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(
        `pet-resource://preview/${token}/model/speech.local.json`
      )
    ).toThrow();
    expect(() =>
      resolvePetResourcePathForProtocol(`pet-resource://preview/${token}/model/notes.txt`)
    ).toThrow();
  });

  it("rejects a preview file outside its registered containment root", async () => {
    const { registerPetResourcePreviewRoot, toPetPreviewResourceUrl } = await import(
      "./petResourceProtocol"
    );
    const previewRoot = path.join(temporaryDirectory, "preview-root");
    const token = registerPetResourcePreviewRoot(previewRoot);

    expect(() =>
      toPetPreviewResourceUrl(
        token,
        previewRoot,
        path.join(temporaryDirectory, "outside.model3.json")
      )
    ).toThrow("Invalid preview resource file path");
  });
});
