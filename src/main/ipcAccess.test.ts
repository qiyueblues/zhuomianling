import type { WebContents } from "electron";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertIpcPetIdBound, assertIpcSenderAllowed } from "./ipcAccess";

const mainSender = {} as WebContents;
const petSender = {} as WebContents;
const unknownSender = {} as WebContents;

describe("assertIpcSenderAllowed", () => {
  it("keeps configuration and import IPC main-window only", () => {
    expect(() =>
      assertIpcSenderAllowed("pet-config:delete", "main", mainSender, mainSender, false)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("pet-config:delete", "main", petSender, mainSender, true)
    ).toThrow(/不允许/);
  });

  it("keeps all memory management IPC main-window only", () => {
    expect(() =>
      assertIpcSenderAllowed("memory:list", "main", mainSender, mainSender, false)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("memory:list", "main", petSender, mainSender, true)
    ).toThrow(/不允许/);
    expect(() =>
      assertIpcSenderAllowed("memory:clear", "main", unknownSender, mainSender, false)
    ).toThrow(/不允许/);
  });

  it("keeps AI, TTS, and drag IPC pet-window only", () => {
    expect(() =>
      assertIpcSenderAllowed("ai-chat:stream", "pet", petSender, mainSender, true)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("ai-chat:stream", "pet", mainSender, mainSender, false)
    ).toThrow(/不允许/);
  });

  it("allows shared close/state calls but rejects unknown senders", () => {
    expect(() =>
      assertIpcSenderAllowed("pet-window:close", "both", petSender, mainSender, true)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("pet-window:close", "both", mainSender, mainSender, false)
    ).not.toThrow();
    expect(() =>
      assertIpcSenderAllowed("pet-window:close", "both", unknownSender, mainSender, false)
    ).toThrow(/不允许/);
  });

  it("keeps the registered sensitive channel access map fail-closed", async () => {
    const ipcSource = await fs.readFile(new URL("./ipc.ts", import.meta.url), "utf8");
    const accessByChannel = new Map(
      Array.from(
        ipcSource.matchAll(/\b(?:handle|on)\("([^"]+)", "(main|pet|both)"/g),
        (match) => [match[1], match[2]] as const
      )
    );

    expect(accessByChannel.size).toBeGreaterThan(40);
    for (const channel of [
      "pet-config:delete",
      "app-update:get-state",
      "app-update:check",
      "app-update:download",
      "app-update:download-github",
      "app-update:cancel",
      "app-update:dismiss",
      "app-update:ignore-version",
      "app-update:install",
      "app-update:open-release",
      "app-update:startup-ready",
      "pet-config:save-basic-info",
      "live2d-import:import-model",
      "ai-settings:save",
      "memory:list",
      "memory:create",
      "memory:clear",
      "memory:export",
      "memory:save-settings",
      "memory:rebuild-index"
      ,"preset-voice:get-overview"
      ,"preset-voice:start"
      ,"preset-voice:cancel"
      ,"preset-voice:preview"
      ,"preset-voice:delete-one"
      ,"preset-voice:delete-all"
    ]) {
      expect(accessByChannel.get(channel)).toBe("main");
    }
    // TIMED DIAGNOSTICS TEST MODULE: screen capture IPC sender binding coverage.
    for (const channel of [
      "ai-chat:stream",
      "ai-chat:cancel",
      "text-to-speech:speak",
      "speech-stream:start",
      "pet-window:start-drag",
      // TIMED DIAGNOSTICS TEST MODULE: screen capture IPC access coverage.
      "screen-vision:start",
      "screen-vision:frame",
      "screen-vision:stop",
      "preset-voice:load-runtime"
    ]) {
      expect(accessByChannel.get(channel)).toBe("pet");
    }
    expect(accessByChannel.get("pet-window:close")).toBe("both");
    expect(accessByChannel.get("pet-window:get-state")).toBe("both");

    for (const channel of [
      "ai-chat:stream",
      "ai-chat:cancel",
      "speech-to-text:transcribe",
      "text-to-speech:speak",
      "text-to-speech:stop",
      "speech-stream:start",
      // TIMED DIAGNOSTICS TEST MODULE: screen capture IPC sender binding coverage.
      "screen-vision:start",
      "screen-vision:frame",
      "screen-vision:stop",
      "preset-voice:load-runtime"
    ]) {
      expect(ipcSource).toContain(`assertPetIdBound("${channel}", event, request.petId)`);
    }
  });
});

describe("assertIpcPetIdBound", () => {
  it("accepts only the pet ID bound by the main process", () => {
    expect(() => assertIpcPetIdBound("ai-chat:stream", "pet-a", "pet-a")).not.toThrow();
    expect(() => assertIpcPetIdBound("ai-chat:stream", "pet-b", "pet-a")).toThrow(/不匹配/);
    expect(() => assertIpcPetIdBound("ai-chat:stream", "pet-a", undefined)).toThrow(/不匹配/);
  });
});
