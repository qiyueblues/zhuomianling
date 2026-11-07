import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataPath: ""
}));

const moodVoiceMock = vi.hoisted(() => ({
  resolveMoodVoiceOverride: vi.fn()
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath
  }
}));

vi.mock("../mood/moodVoice", () => ({
  resolveMoodVoiceOverride: moodVoiceMock.resolveMoodVoiceOverride
}));

class FakeWebContents extends EventEmitter {
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroyOwner(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }

  crashOwner(): void {
    this.emit("render-process-gone");
  }
}

function asWebContents(owner: FakeWebContents): WebContents {
  return owner as unknown as WebContents;
}

function createAbortablePendingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    })
  );
}

let temporaryDirectory = "";
let referenceAudioPath = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-tts-"));
  electronMock.userDataPath = temporaryDirectory;
  referenceAudioPath = path.join(temporaryDirectory, "reference.wav");
  await fs.writeFile(referenceAudioPath, "fixture-audio", "utf8");
  await Promise.all(
    ["pet-a", "pet-b"].map(async (petId) => {
      const petDirectory = path.join(temporaryDirectory, "pets", petId);
      await fs.mkdir(petDirectory, { recursive: true });
      await fs.writeFile(
        path.join(petDirectory, "pet.local.json"),
        JSON.stringify({
          voiceModelSettings: {
            enabled: true,
            connected: true,
            referenceAudioPath,
            referenceText: "参考文本",
            referenceLanguage: "zh",
            language: "zh"
          }
        }),
        "utf8"
      );
    })
  );
  moodVoiceMock.resolveMoodVoiceOverride.mockReset();
  moodVoiceMock.resolveMoodVoiceOverride.mockResolvedValue(undefined);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("text-to-speech request lifecycle", () => {
  it.each(["v5dev", "v5turbo"])("uses the compatible /tts contract and server sampling defaults for %s", async (modelVersion) => {
    const petConfigPath = path.join(temporaryDirectory, "pets", "pet-a", "pet.local.json");
    const pet = JSON.parse(await fs.readFile(petConfigPath, "utf8"));
    pet.voiceModelSettings.modelVersion = modelVersion;
    await fs.writeFile(petConfigPath, JSON.stringify(pet));
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/wav" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");

    const result = await speakText(asWebContents(new FakeWebContents()), {
      petId: "pet-a", requestId: "v5-reply", text: "测试语音。"
    });

    expect(result).toMatchObject({ ok: true, mimeType: "audio/wav" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9880/tts");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      text: "测试语音。", text_lang: "zh", ref_audio_path: referenceAudioPath,
      prompt_text: "参考文本", prompt_lang: "zh", media_type: "wav", streaming_mode: false
    });
    expect(body).not.toHaveProperty("sample_steps");
    expect(body).not.toHaveProperty("cfg_rate");
  });

  it("performs a real synthesis for connection checks using the supplied draft config", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { testTextToSpeechConnection } = await import("./textToSpeech");
    const controller = new AbortController();

    const result = await testTextToSpeechConnection(
      {
        petId: "pet-a",
        requestId: "connection-test",
        text: "嗯。"
      },
      {
        baseUrl: "http://127.0.0.1:9880",
        apiMode: "v2",
        refAudioPath: referenceAudioPath,
        promptText: "参考文本",
        promptLang: "zh",
        textLang: "zh",
        textSplitMethod: "cut5",
        mediaType: "wav"
      },
      controller.signal
    );

    expect(result).toMatchObject({ ok: true, audioBase64: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9880/tts",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("uses the mood-selected reference audio for an external screen reply session", async () => {
    const darkenedReferenceAudioPath = path.join(temporaryDirectory, "darkened-reference.wav");
    await fs.writeFile(darkenedReferenceAudioPath, "fixture-darkened-audio", "utf8");
    moodVoiceMock.resolveMoodVoiceOverride.mockResolvedValue({
      refAudioPath: darkenedReferenceAudioPath,
      promptText: "黑化参考文本",
      resolvedMoodRange: "darkened"
    });

    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { registerMoodTextToSpeechSnapshot, speakText } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const target = asWebContents(owner);

    registerMoodTextToSpeechSnapshot(target, "pet-a", "screen-reply-1", "darkened");
    await speakText(target, {
      petId: "pet-a",
      requestId: "screen-segment-1",
      sessionId: "screen-reply-1",
      text: "这是一条自动检测回复。"
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      ref_audio_path: string;
      prompt_text: string;
    };
    expect(requestBody).toMatchObject({
      ref_audio_path: darkenedReferenceAudioPath,
      prompt_text: "黑化参考文本"
    });
    expect(moodVoiceMock.resolveMoodVoiceOverride).toHaveBeenCalledWith("pet-a", "darkened");
  });

  it("locks one voice configuration snapshot for every segment in a reply session", async () => {
    const secondReferenceAudioPath = path.join(temporaryDirectory, "reference-2.wav");
    await fs.writeFile(secondReferenceAudioPath, "fixture-audio-2", "utf8");
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { speakText, stopSpeechPlayback } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const target = asWebContents(owner);

    await speakText(target, {
      petId: "pet-a",
      requestId: "snapshot-segment-1",
      sessionId: "voice-session-1",
      text: "第一句"
    });

    const petConfigPath = path.join(temporaryDirectory, "pets", "pet-a", "pet.local.json");
    await fs.writeFile(
      petConfigPath,
      JSON.stringify({
        voiceModelSettings: {
          enabled: true,
          connected: true,
          referenceAudioPath: secondReferenceAudioPath,
          referenceText: "新的参考文本",
          referenceLanguage: "zh",
          language: "zh"
        }
      }),
      "utf8"
    );

    await speakText(target, {
      petId: "pet-a",
      requestId: "snapshot-segment-2",
      sessionId: "voice-session-1",
      text: "第二句"
    });
    stopSpeechPlayback(target, { petId: "pet-a", sessionId: "voice-session-1" });
    await speakText(target, {
      petId: "pet-a",
      requestId: "snapshot-next-reply",
      sessionId: "voice-session-2",
      text: "下一轮"
    });

    const requestBodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as { ref_audio_path: string; prompt_text: string }
    );
    expect(requestBodies[0]).toMatchObject({
      ref_audio_path: referenceAudioPath,
      prompt_text: "参考文本"
    });
    expect(requestBodies[1]).toMatchObject({
      ref_audio_path: referenceAudioPath,
      prompt_text: "参考文本"
    });
    expect(requestBodies[2]).toMatchObject({
      ref_audio_path: secondReferenceAudioPath,
      prompt_text: "新的参考文本"
    });
    stopSpeechPlayback(target, { petId: "pet-a" });
  });

  it("a delayed stop for an old session does not cancel the next reply session", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText, stopSpeechPlayback } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const target = asWebContents(owner);
    const nextReply = speakText(target, {
      petId: "pet-a",
      requestId: "new-segment",
      sessionId: "voice-session-new",
      text: "新回复"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      stopSpeechPlayback(target, {
        petId: "pet-a",
        sessionId: "voice-session-old"
      }).canceled
    ).toBe(0);
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(false);

    expect(
      stopSpeechPlayback(target, {
        petId: "pet-a",
        sessionId: "voice-session-new"
      }).canceled
    ).toBe(1);
    await expect(nextReply).resolves.toMatchObject({ code: "CANCELED" });
  });

  it("旧配置缺少参考文本时返回可操作提示而不是抛出 TypeError", async () => {
    const petDirectory = path.join(temporaryDirectory, "pets", "pet-a");
    await fs.writeFile(
      path.join(petDirectory, "pet.local.json"),
      JSON.stringify({
        voiceModelSettings: {
          enabled: true,
          connected: true,
          referenceAudioPath,
          language: "zh"
        }
      }),
      "utf8"
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");

    await expect(
      speakText(asWebContents(new FakeWebContents()), {
        petId: "pet-a",
        requestId: "legacy-missing-text",
        text: "你好"
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "INVALID_CONFIG",
      message: expect.stringContaining("参考文本")
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing reference audio before calling GPT-SoVITS", async () => {
    const petDirectory = path.join(temporaryDirectory, "pets", "pet-a");
    await fs.writeFile(
      path.join(petDirectory, "pet.local.json"),
      JSON.stringify({
        voiceModelSettings: {
          enabled: true,
          connected: true,
          referenceAudioPath: path.join(temporaryDirectory, "moved-reference.wav"),
          referenceText: "参考文本",
          referenceLanguage: "zh",
          language: "zh"
        }
      }),
      "utf8"
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");

    await expect(
      speakText(asWebContents(new FakeWebContents()), {
        petId: "pet-a",
        requestId: "missing-reference",
        text: "你好"
      })
    ).resolves.toMatchObject({
      ok: false,
      code: "INVALID_CONFIG",
      message: expect.stringContaining("找不到参考音频")
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps GPT-SoVITS ENOENT responses to a bounded Chinese action message", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        detail: `ENOENT: no such file or directory, access 'old-reference.wav'\r${"0/1500 [00:00<?, ?it/s] 推理中".repeat(800)}`
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");

    const result = await speakText(asWebContents(new FakeWebContents()), {
      petId: "pet-a",
      requestId: "service-missing-reference",
      text: "你好"
    });

    expect(result).toMatchObject({
      ok: false,
      message: "GPT-SoVITS 找不到参考音频或模型文件，请回到声音模型页重新选择文件并重新连接。"
    });
    expect(result.message.length).toBeLessThan(120);
    expect(result.message).not.toContain("ENOENT");
    expect(result.message).not.toContain("1500");
  });

  it("stop aborts every active synthesis request for the selected pet", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText, stopSpeechPlayback } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const firstSpeakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "speech-cancel-1",
      text: "你好"
    });
    const secondSpeakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "speech-cancel-2",
      text: "世界"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(stopSpeechPlayback(asWebContents(owner), { petId: "pet-a" }).canceled).toBe(2);
    await expect(firstSpeakPromise).resolves.toMatchObject({
      ok: false,
      requestId: "speech-cancel-1",
      code: "CANCELED"
    });
    await expect(secondSpeakPromise).resolves.toMatchObject({
      ok: false,
      requestId: "speech-cancel-2",
      code: "CANCELED"
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect((fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("aborts synthesis when its timeout expires", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");
    const owner = new FakeWebContents();

    await expect(
      speakText(
        asWebContents(owner),
        {
          petId: "pet-a",
          requestId: "speech-timeout",
          text: "你好"
        },
        10
      )
    ).resolves.toMatchObject({
      ok: false,
      requestId: "speech-timeout",
      code: "TIMEOUT"
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("aborts synthesis when the owning renderer is destroyed", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const speakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "speech-owner",
      text: "你好"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    owner.destroyOwner();
    await expect(speakPromise).resolves.toMatchObject({
      ok: false,
      requestId: "speech-owner",
      code: "CANCELED"
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("aborts synthesis when the owning renderer process exits", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const speakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "speech-crash",
      text: "你好"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    owner.crashOwner();
    await expect(speakPromise).resolves.toMatchObject({
      ok: false,
      requestId: "speech-crash",
      code: "CANCELED"
    });
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("keeps the same request ID isolated across different pets", async () => {
    const fetchMock = createAbortablePendingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { speakText, stopSpeechPlayback } = await import("./textToSpeech");
    const owner = new FakeWebContents();
    const firstSpeakPromise = speakText(asWebContents(owner), {
      petId: "pet-a",
      requestId: "shared-request",
      text: "宠物 A"
    });
    const secondSpeakPromise = speakText(asWebContents(owner), {
      petId: "pet-b",
      requestId: "shared-request",
      text: "宠物 B"
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      stopSpeechPlayback(asWebContents(owner), {
        petId: "pet-a",
        requestId: "shared-request"
      }).canceled
    ).toBe(1);
    await expect(firstSpeakPromise).resolves.toMatchObject({ code: "CANCELED" });

    const callsByText = new Map(
      fetchMock.mock.calls.map(([, init]) => [
        (JSON.parse(String(init?.body)) as { text: string }).text,
        init?.signal as AbortSignal
      ])
    );
    expect(callsByText.get("宠物 A")?.aborted).toBe(true);
    expect(callsByText.get("宠物 B")?.aborted).toBe(false);

    expect(
      stopSpeechPlayback(asWebContents(owner), {
        petId: "pet-b",
        requestId: "shared-request"
      }).canceled
    ).toBe(1);
    await expect(secondSpeakPromise).resolves.toMatchObject({ code: "CANCELED" });
  });
});
