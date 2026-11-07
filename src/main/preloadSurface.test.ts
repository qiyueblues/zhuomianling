import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("preload capability separation", () => {
  it("keeps pet-only runtime capabilities out of the main-window preload", async () => {
    const source = await fs.readFile(new URL("../preload/index.ts", import.meta.url), "utf8");

    expect(source).toContain('ipcRenderer.invoke("pet-config:delete"');
    expect(source).toContain('ipcRenderer.invoke("live2d-import:import-model"');
    expect(source).toContain('ipcRenderer.invoke("memory:list"');
    expect(source).toContain('ipcRenderer.invoke("memory:get-source-conversation"');
    expect(source).toContain('ipcRenderer.invoke("memory:clear"');
    expect(source).toContain('ipcRenderer.invoke("ai-settings:test-output"');
    expect(source).toContain('ipcRenderer.invoke("pet-package:begin-import"');
    expect(source).toContain('ipcRenderer.invoke("pet-package:list-import-ai-models"');
    expect(source).toContain('ipcRenderer.invoke("pet-package:export"');
    for (const forbiddenChannel of [
      "ai-chat:stream",
      "ai-chat:cancel",
      "text-to-speech:speak",
      "speech-stream:start",
      "pet-window:start-drag"
    ]) {
      expect(source).not.toContain(forbiddenChannel);
    }
  });

  it("keeps configuration and import mutations out of the pet-window preload", async () => {
    const source = await fs.readFile(new URL("../preload/pet.ts", import.meta.url), "utf8");

    expect(source).toContain('ipcRenderer.invoke("ai-chat:stream"');
    expect(source).toContain('ipcRenderer.invoke("text-to-speech:speak"');
    for (const forbiddenChannel of [
      "pet-config:delete",
      "app-update:",
      "pet-config:save-basic-info",
      "live2d-import:",
      "ai-settings:",
      "memory:",
      "pet-package:",
      "pet-window:show"
    ]) {
      expect(source).not.toContain(forbiddenChannel);
    }
  });
});
