import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateIpcArguments, validatedIpcChannels } from "./ipcValidation";

describe("validateIpcArguments", () => {
  it("accepts updater commands only without renderer-supplied URLs, paths or versions", () => {
    for (const channel of [
      "app-update:get-state", "app-update:acknowledge-completion", "app-update:check", "app-update:download", "app-update:download-github", "app-update:cancel",
      "app-update:dismiss", "app-update:ignore-version", "app-update:install", "app-update:open-release", "app-update:startup-ready"
    ]) {
      expect(() => validateIpcArguments(channel, [])).not.toThrow();
      expect(() => validateIpcArguments(channel, [{ url: "https://untrusted.test/update.exe" }])).toThrow();
      expect(() => validateIpcArguments(channel, ["1.9.0"])).toThrow();
    }
  });
  it("validates bounded main-window pet package requests", () => {
    expect(() => validateIpcArguments("pet-package:begin-import", [])).not.toThrow();
    expect(() => validateIpcArguments("pet-package:export", ["pet-a"])).not.toThrow();
    expect(() => validateIpcArguments("pet-package:export", ["../pet"])).toThrow(/桌宠 ID/);
    expect(() => validateIpcArguments("pet-package:test-import-ai", [{
      sessionId: "session-1",
      draft: { baseUrl: "https://example.test/v1", model: "m", apiKey: "k" }
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-package:list-import-ai-models", [{
      sessionId: "session-1", baseUrl: "https://example.test/v1", apiKey: "k"
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-package:test-import-ai", [{
      sessionId: "session-1",
      draft: { baseUrl: "https://example.test/v1", model: "m", apiKey: "x".repeat(16_385) }
    }])).toThrow(/apiKey/);
    expect(() => validateIpcArguments("pet-package:commit-import", [{ sessionId: "x".repeat(65) }])).toThrow(/sessionId/);
  });
  // TIMED DIAGNOSTICS TEST MODULE: screenshot and timing IPC validation coverage.
  it("accepts a bounded AI stream request", () => {
    expect(() =>
      validateIpcArguments("ai-chat:stream", [
        {
          petId: "pet-a",
          requestId: "request-0001",
          messages: [{ role: "user", content: "你好" }]
        }
      ])
    ).not.toThrow();
    expect(() => validateIpcArguments("ai-chat:stream", [{
      petId: "pet-a",
      requestId: "request-0001",
      messages: [{
        role: "user",
        content: "看看这张图",
        image: { data: new Uint8Array(64), mimeType: "image/jpeg" }
      }]
    }])).not.toThrow();
    expect(() => validateIpcArguments("ai-chat:stream", [{
      petId: "pet-a",
      requestId: "request-0001",
      messages: [{
        role: "user",
        content: "看看这张图",
        image: { data: new Uint8Array(64), mimeType: "text/plain" }
      }]
    }])).toThrow(/MIME/);
  });

  it("validates bounded screen vision frames and rejects oversized binary payloads", () => {
    const frame = {
      petId: "pet-a",
      sessionId: "screen-session-0001",
      frameId: "frame-1",
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array(64),
        mimeType: "image/jpeg",
        width: 1280,
        height: 720,
        capturedAt: Date.now()
      }
    };
    expect(() => validateIpcArguments("screen-vision:frame", [frame])).not.toThrow();
    expect(() => validateIpcArguments("screen-vision:frame", [{
      ...frame,
      frame: { ...frame.frame, mimeType: "text/plain" }
    }])).toThrow(/MIME/);
    expect(() => validateIpcArguments("screen-vision:frame", [{
      ...frame,
      frame: { ...frame.frame, data: new Uint8Array(512 * 1024 + 1) }
    }])).toThrow(/截图大小|二进制/);
  });

  it("accepts bounded visual timing events and rejects unknown stages", () => {
    expect(() => validateIpcArguments("screen-vision:timing", [{
      petId: "pet-a",
      requestId: "screen-request-0001",
      kind: "chat",
      phase: "renderer",
      stage: "frame-encoded",
      ok: true
    }])).not.toThrow();
    expect(() => validateIpcArguments("screen-vision:timing", [{
      petId: "pet-a",
      requestId: "screen-request-0001",
      phase: "renderer",
      stage: "unknown-stage"
    }])).toThrow(/stage/);
  });

  it("validates monitor reply delivery status IPC", () => {
    const request = {
      petId: "pet-a",
      sessionId: "screen-session-0001",
      replyId: "screen-reply-00000001",
      status: "accepted"
    };
    expect(() => validateIpcArguments("screen-vision:reply-status", [request])).not.toThrow();
    expect(() => validateIpcArguments("screen-vision:reply-status", [{ ...request, status: "played" }])).not.toThrow();
    expect(() => validateIpcArguments("screen-vision:reply-status", [{ ...request, status: "unknown" }])).toThrow(/状态/);
  });

  it("rejects traversal and unbounded pet IDs", () => {
    expect(() => validateIpcArguments("pet-config:delete", ["../outside"])).toThrow(/桌宠 ID/);
    expect(() => validateIpcArguments("pet-config:delete", [`p${"x".repeat(64)}`])).toThrow(
      /桌宠 ID/
    );
  });

  it("rejects oversized speech chunks", () => {
    expect(() =>
      validateIpcArguments("speech-stream:audio", [
        {
          sessionId: "desktop-pet-session-0001",
          audio: new ArrayBuffer(262_145)
        }
      ])
    ).toThrow(/262144/);
  });

  it("rejects an unsupported one-shot speech format", () => {
    expect(() =>
      validateIpcArguments("speech-to-text:transcribe", [
        {
          petId: "pet-a",
          format: "exe",
          audioBase64: "AA=="
        }
      ])
    ).toThrow(/format/);
  });

  it("rejects dangerous object keys", () => {
    const payload = JSON.parse(
      '{"petId":"pet-a","requestId":"request-0001","messages":[{"role":"user","content":"ok"}],"__proto__":{"polluted":true}}'
    ) as unknown;

    expect(() => validateIpcArguments("ai-chat:stream", [payload])).toThrow(/__proto__/);
  });

  it("allows selecting a mood reference audio before entering its transcript", () => {
    expect(() => validateIpcArguments("mood:import-range-voice", [{
      petId: "pet-a",
      rangeId: "calm",
      referenceText: ""
    }])).not.toThrow();
    expect(() => validateIpcArguments("mood:import-range-voice", [{
      petId: "pet-a",
      rangeId: "calm",
      referenceText: "x".repeat(501)
    }])).toThrow(/500/);
  });

  it("accepts only bounded TTS reply session identifiers", () => {
    expect(() =>
      validateIpcArguments("text-to-speech:speak", [
        {
          petId: "pet-a",
          requestId: "voice-1-1",
          sessionId: "voice-session-1",
          text: "第一句"
        }
      ])
    ).not.toThrow();
    expect(() =>
      validateIpcArguments("text-to-speech:speak", [
        {
          petId: "pet-a",
          requestId: "voice-1-1",
          sessionId: "../other-session",
          text: "第一句"
        }
      ])
    ).toThrow(/sessionId/);
    expect(() =>
      validateIpcArguments("text-to-speech:stop", [
        { petId: "pet-a", sessionId: "x".repeat(129) }
      ])
    ).toThrow(/sessionId/);
  });

  it("validates preset voice generation requests", () => {
    expect(() => validateIpcArguments("preset-voice:start", [{
      petId: "pet-a",
      scope: "missing",
      translation: "translate",
      targetLanguage: "ja",
      targetId: "line-ready"
    }])).not.toThrow();
    expect(() => validateIpcArguments("preset-voice:start", [{
      petId: "pet-a",
      scope: "missing",
      translation: "translate"
    }])).toThrow(/targetLanguage/);
    expect(() => validateIpcArguments("preset-voice:cancel", [{
      petId: "pet-a",
      taskId: "../other-task"
    }])).toThrow(/taskId/);
    expect(() => validateIpcArguments("preset-voice:delete-one", [{
      petId: "pet-a",
      targetId: "line-ready"
    }])).not.toThrow();
    expect(() => validateIpcArguments("preset-voice:delete-one", [{
      petId: "pet-a",
      targetId: "../voice.wav"
    }])).toThrow(/targetId/);
  });

  it("accepts only bounded finite desktop scale settings", () => {
    const validDraft = {
      petId: "pet-a",
      theme: "soft",
      desktopScale: 1.25
    };
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [validDraft]))
      .not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: 0.7
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: 1.5
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: 0.69
    }])).toThrow(/desktopScale/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: 1.51
    }])).toThrow(/desktopScale/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      ...validDraft,
      desktopScale: Number.NaN
    }])).toThrow(/desktopScale/);
  });

  it("accepts only a bounded pet-local custom theme and explicit deletion", () => {
    const customTheme = {
      id: "mint-plaid",
      name: "薄荷格纹",
      description: "当前桌宠的主题",
      version: 1,
      tokens: {
        background: "#f3fbf8",
        surface: "#ffffff",
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
        border: "#668987"
      },
      chatDecorations: {
        "header-left": "citrus",
        "header-right": "flower-2"
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
      },
      moodMeter: {
        upColor: "#e88cab",
        downColor: "#6676b8",
        calmColor: "#8b9387",
        surface: "rgba(19, 23, 38, 0.82)",
        emptyColor: "rgba(255, 255, 255, 0.12)",
        textColor: "#ffffff",
        boundaryColor: "#f4f7ff",
        particleColor: "#ffffff",
        shadow: "0 8px 24px rgba(0, 0, 0, 0.24)",
        insetShadow: "inset 0 0 8px rgba(255, 255, 255, 0.08)",
        frame: "soft-pill",
        particleStyle: "float",
        effectStyle: "halo",
        ranges: {
          excited: {
            frameOpacity: .9,
            glowOpacity: .72,
            glowRadius: 22,
            liquidOpacity: .94,
            boundaryWidth: 2,
            waveAmplitude: 4,
            particleOpacity: .9,
            auraOpacity: .92,
            accentOpacity: 1,
            animationSeconds: 1.2
          }
        }
      }
    };
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom"
    }])).toThrow(/customTheme/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "soft",
      customTheme
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "soft",
      removeCustomTheme: true
    }])).not.toThrow();
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "soft",
      customTheme,
      removeCustomTheme: true
    }])).toThrow(/同时提交|同时/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "soft",
      removeCustomTheme: "yes"
    }])).toThrow(/removeCustomTheme/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        tokens: { ...customTheme.tokens, background: "x".repeat(181) }
      }
    }])).toThrow(/180/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        chatDecorations: { "header-left": "remote-image" }
      }
    }])).toThrow(/图标无效/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        chatDecorations: { "footer-left": "leaf" }
      }
    }])).toThrow(/不允许字段/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        radialMenu: { ...customTheme.radialMenu, unknown: "#fff" }
      }
    }])).toThrow(/不允许字段/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        moodMeter: { ...customTheme.moodMeter, upColor: undefined }
      }
    }])).toThrow(/upColor/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        moodMeter: { ...customTheme.moodMeter, particleStyle: "spark" }
      }
    }])).toThrow(/particleStyle/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        moodMeter: { ...customTheme.moodMeter, effectStyle: "css" }
      }
    }])).toThrow(/effectStyle/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        moodMeter: {
          ...customTheme.moodMeter,
          ranges: { excited: { glowRadius: 33 } }
        }
      }
    }])).toThrow(/glowRadius/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        moodMeter: {
          ...customTheme.moodMeter,
          ranges: { euphoric: { glowRadius: 12 } }
        }
      }
    }])).toThrow(/euphoric/);
    expect(() => validateIpcArguments("pet-config:save-ui-settings", [{
      petId: "pet-a",
      theme: "custom",
      customTheme: {
        ...customTheme,
        moodMeter: { ...customTheme.moodMeter, surface: "url(https://example.test/a.png)" }
      }
    }])).toThrow(/不安全/);
  });

  it("accepts only supported GPT-SoVITS model versions", () => {
    for (const channel of ["pet-config:save-voice-model", "pet-config:test-voice-model-connection"]) {
      for (const modelVersion of ["v4", "v2ProPlus", "v5dev", "v5turbo"]) {
        expect(() => validateIpcArguments(channel, [{ petId: "pet-a", modelVersion }])).not.toThrow();
      }
      for (const modelVersion of ["v5", "v5pro", "future"]) {
        expect(() => validateIpcArguments(channel, [{ petId: "pet-a", modelVersion }])).toThrow(/modelVersion/);
      }
    }
  });

  it("accepts a bounded AI output probe and rejects oversized connection fields", () => {
    expect(() =>
      validateIpcArguments("ai-settings:test-output", [
        {
          petId: "pet-a",
          providerName: "Custom",
          baseUrl: "https://api.example.com/v1",
          model: "model-a",
          apiKey: "secret"
        }
      ])
    ).not.toThrow();
    expect(() =>
      validateIpcArguments("ai-settings:test-output", [
        {
          petId: "pet-a",
          providerName: "Custom",
          baseUrl: `https://example.com/${"x".repeat(4096)}`,
          model: "model-a",
          apiKey: "secret"
        }
      ])
    ).toThrow(/4096/);
  });

  it("enforces persona and expression-description prompt budgets at IPC", () => {
    expect(() => validateIpcArguments("pet-config:save-persona", [{
      petId: "pet-a",
      personaPrompt: "人".repeat(16_001),
      chatLanguage: "zh"
    }])).toThrow(/16000/);
    expect(() => validateIpcArguments("pet-config:save-expression-mappings", [{
      petId: "pet-a",
      mappings: [{ description: "表".repeat(501) }]
    }])).toThrow(/500/);
    expect(() => validateIpcArguments("pet-config:save-expression-mappings", [{
      petId: "pet-a",
      mappings: Array.from({ length: 17 }, () => ({ description: "表".repeat(500) }))
    }])).toThrow(/总长度/);
  });

  it("accepts bounded memory management requests and explicit destructive confirmations", () => {
    expect(() => validateIpcArguments("memory:list", [{ petId: "pet-a", pageSize: 5 }])).not.toThrow();
    expect(() => validateIpcArguments("memory:get-source-conversation", [{
      petId: "pet-a",
      memoryId: "memory-1"
    }])).not.toThrow();
    expect(() => validateIpcArguments("memory:create", [{
      petId: "pet-a",
      chapter: "about_you",
      memoryType: "profile",
      content: "A bounded manual memory",
      tags: ["manual"]
    }])).not.toThrow();
    expect(() => validateIpcArguments("memory:clear", [{
      petId: "pet-a",
      confirmPetId: "pet-a"
    }])).not.toThrow();
  });

  it("rejects oversized, unknown-field, and mismatched memory management payloads", () => {
    expect(() => validateIpcArguments("memory:list", [{ petId: "pet-a", pageSize: 6 }])).toThrow(/1-5/);
    expect(() => validateIpcArguments("memory:create", [{
      petId: "pet-a",
      chapter: "about_you",
      memoryType: "profile",
      content: "x".repeat(8_193)
    }])).toThrow(/8192/);
    expect(() => validateIpcArguments("memory:get", [{
      petId: "pet-a",
      memoryId: "memory-1",
      databasePath: "C:\\private\\ledger.sqlite3"
    }])).toThrow(/databasePath/);
    expect(() => validateIpcArguments("memory:get-source-conversation", [{
      petId: "pet-a",
      memoryId: "memory-1",
      requestId: "private-source-request"
    }])).toThrow(/requestId/);
    expect(() => validateIpcArguments("memory:clear", [{
      petId: "pet-a",
      confirmPetId: "pet-b"
    }])).toThrow(/confirmation|确认|match/i);
  });

  it("accepts a shared expression source across event settings", () => {
    const source = {
      sourceKind: "expression",
      sourceFileName: "smile.exp3.json",
      runtimeName: "smile"
    };

    expect(() =>
      validateIpcArguments("pet-config:save-event-settings", [
        {
          petId: "pet-a",
          events: [
            { event: "idle", source, lines: [] },
            { event: "close", source, lines: [] }
          ]
        }
      ])
    ).not.toThrow();
  });

  it("accepts a boolean event subtitle switch and rejects other types", () => {
    expect(() => validateIpcArguments("pet-config:save-event-settings", [{
      petId: "pet-a",
      events: [{ event: "click", lines: ["你好"], showSubtitle: false }]
    }])).not.toThrow();

    expect(() => validateIpcArguments("pet-config:save-event-settings", [{
      petId: "pet-a",
      events: [{ event: "click", lines: ["你好"], showSubtitle: "false" }]
    }])).toThrow(/showSubtitle/);
  });

  it("accepts a bounded mood range entry line and rejects an oversized one", () => {
    const request = {
      petId: "pet-a",
      settings: { ranges: { calm: { enterLine: "我会慢慢平静下来的。" } } }
    };

    expect(() => validateIpcArguments("mood:save-settings", [request])).not.toThrow();
    expect(() => validateIpcArguments("mood:save-settings", [{
      ...request,
      settings: { ranges: { calm: { enterLine: "x".repeat(301) } } }
    }])).toThrow(/enterLine/);
  });

  it("accepts a mood entry line object with generated preset audio metadata", () => {
    expect(() => validateIpcArguments("mood:save-settings", [{
      petId: "pet-a",
      settings: {
        ranges: {
          calm: {
            enterLine: {
              id: "mood_calm_line",
              text: "我会慢慢平静下来的。",
              presetAudio: {
                schemaVersion: 1,
                resourceId: "preset_mood_calm_01",
                sourceTextHash: "a".repeat(64),
                spokenText: "我会慢慢平静下来的。",
                language: "zh",
                mimeType: "audio/wav",
                durationMs: 1_800,
                voiceFingerprint: "b".repeat(64),
                personaFingerprint: "c".repeat(64),
                requestedMoodRange: "calm",
                resolvedMoodRange: "calm",
                generatedAt: 1_700_000_000_000
              }
            }
          }
        }
      }
    }])).not.toThrow();
  });

  it("still rejects a real circular payload", () => {
    const payload: Record<string, unknown> = {
      petId: "pet-a",
      requestId: "request-0001",
      messages: [{ role: "user", content: "ok" }]
    };
    payload.self = payload;

    expect(() => validateIpcArguments("ai-chat:stream", [payload])).toThrow(/循环引用/);
  });

  it("validates a bounded desktop source preview request", () => {
    expect(() =>
      validateIpcArguments("pet-window:preview-source", [
        {
          petId: "pet-a",
          source: {
            sourceKind: "motion",
            sourceFileName: "angry01.mtn",
            runtimeName: "Tap"
          }
        }
      ])
    ).not.toThrow();
    expect(() =>
      validateIpcArguments("pet-window:preview-source", [
        {
          petId: "pet-a",
          source: { sourceKind: "motion", sourceFileName: "angry01.mtn" }
        }
      ])
    ).toThrow(/runtimeName/);
  });

  it("fails closed for an unregistered IPC channel", () => {
    expect(() => validateIpcArguments("unknown:channel", [])).toThrow(/没有注册运行时 schema/);
  });

  it("only accepts fixed renderer startup timing stages", () => {
    expect(() =>
      validateIpcArguments("app-window:startup-timing", ["splash-hidden"])
    ).not.toThrow();
    expect(() =>
      validateIpcArguments("app-window:startup-timing", ["C:\\private\\config.json"])
    ).toThrow(/startup stage/);
    expect(() =>
      validateIpcArguments("app-window:startup-timing", ["splash-hidden", "extra"])
    ).toThrow(/参数数量/);
  });

  // TIMED DIAGNOSTICS TEST MODULE: main-window snapshot access coverage.
  it("accepts the TIMED DIAGNOSTICS TEST MODULE snapshot without payload", () => {
    expect(() => validateIpcArguments("timed-diagnostics-test:get-snapshot", [])).not.toThrow();
    expect(() => validateIpcArguments("timed-diagnostics-test:get-snapshot", ["extra"])).toThrow(/参数数量/);
  });

  it("keeps every IPC registration covered by a validation schema", async () => {
    const ipcSource = await fs.readFile(new URL("./ipc.ts", import.meta.url), "utf8");
    const registeredChannels = Array.from(
      ipcSource.matchAll(/\b(?:handle|on)\("([^"]+)"/g),
      (match) => match[1]
    );

    expect(registeredChannels.length).toBeGreaterThan(40);
    expect(registeredChannels.filter((channel) => !validatedIpcChannels.has(channel))).toEqual([]);
    expect(new Set(registeredChannels)).toEqual(validatedIpcChannels);
  });
});
