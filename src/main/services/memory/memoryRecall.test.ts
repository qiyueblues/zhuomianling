import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_SETTINGS, type MemoryRecord } from "../../../shared/types/memory";
import { MemoryLedger } from "./MemoryLedger";
import { AiMemoryRecallService, type MemoryRecallDiagnostic } from "./memoryRecall";

const enabledSettings = {
  ...DEFAULT_MEMORY_SETTINGS,
  recallEnabled: true,
  recallLimit: 5,
  contextBudgetChars: 1_024
};

function memory(content: string): MemoryRecord {
  return {
    id: "memory-1",
    petId: "pet-a",
    chapter: "about_you",
    memoryType: "profile",
    content,
    tags: [],
    important: false,
    origin: "manual",
    sourceAvailable: false,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    revision: 1
  };
}

function abortablePending(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

describe("AiMemoryRecallService", () => {
  it("does not touch storage or backend when recall is disabled", async () => {
    const synchronize = vi.fn();
    const retrieve = vi.fn();
    const openLedger = vi.fn();
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => undefined),
      synchronize,
      retrieve,
      openLedger
    });
    await expect(service.recall("pet-a", [{ role: "user", content: "hello" }], new AbortController().signal))
      .resolves.toEqual({ recalledCount: 0 });
    expect(synchronize).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(openLedger).not.toHaveBeenCalled();
  });

  it("returns only a bounded untrusted context and emits content-free diagnostics", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const retrieve = vi.fn(async (_petId, query: string) => {
      expect(query).toContain("current-question");
      expect(query).not.toContain("persona-secret");
      return {
        ok: true as const,
        value: {
          items: [{ memory: memory("private-memory-content"), score: 0.9 }],
          answerPolicy: "reference" as const
        }
      };
    });
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn(async () => undefined),
      retrieve,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const result = await service.recall("pet-a", [
      { role: "system", content: "persona-secret" },
      { role: "user", content: "current-question" }
    ], new AbortController().signal);
    expect(result.recalledCount).toBe(1);
    expect(result.context).toContain("private-memory-content");
    expect(result.context!.length).toBeLessThanOrEqual(enabledSettings.contextBudgetChars);
    expect(diagnostics).toEqual([
      expect.objectContaining({ petId: "pet-a", stage: "context", code: "ok", recalledCount: 1 })
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("private-memory-content");
    expect(JSON.stringify(diagnostics)).not.toContain("current-question");
  });

  it("turns its own 1200ms-class deadline into a no-memory fallback", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn((_petId, signal) => abortablePending(signal)),
      retrieve: vi.fn(),
      deadlineMs: 10,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(service.recall("pet-a", [{ role: "user", content: "hello" }], new AbortController().signal))
      .resolves.toEqual({ recalledCount: 0 });
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "index", code: "timeout" })]);
  });

  it("degrades a missing application-owned runtime before retrieval", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn(async () => { throw new Error("runtime missing"); }),
      retrieve: vi.fn(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(service.recall("pet-a", [{ role: "user", content: "hello" }], new AbortController().signal))
      .resolves.toEqual({ recalledCount: 0 });
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "index", code: "unavailable" })]);
  });

  it("propagates the parent cancellation to index work without throwing", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const controller = new AbortController();
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn((_petId, signal) => abortablePending(signal)),
      retrieve: vi.fn(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const pending = service.recall("pet-a", [{ role: "user", content: "hello" }], controller.signal);
    controller.abort("renderer");
    await expect(pending).resolves.toEqual({ recalledCount: 0 });
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "index", code: "canceled" })]);
  });

  it("degrades structured backend failures without leaking their query", async () => {
    const diagnostics: MemoryRecallDiagnostic[] = [];
    const service = new AiMemoryRecallService({
      getSettings: vi.fn(async () => enabledSettings),
      synchronize: vi.fn(async () => undefined),
      retrieve: vi.fn(async () => ({
        ok: false as const,
        error: { code: "unavailable" as const, message: "hidden", retryable: true }
      })),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    await expect(service.recall("pet-a", [{ role: "user", content: "sensitive-query" }], new AbortController().signal))
      .resolves.toEqual({ recalledCount: 0 });
    expect(diagnostics).toEqual([expect.objectContaining({ stage: "retrieve", code: "unavailable" })]);
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive-query");
  });

  it("injects a no-guessing constraint when a memory check has no high-confidence match", async () => {
    const service = new AiMemoryRecallService({
      getSettings: async () => ({ ...DEFAULT_MEMORY_SETTINGS, recallEnabled: true }),
      synchronize: async () => undefined,
      retrieve: async () => ({
        ok: true,
        value: { items: [], answerPolicy: "unknown" }
      })
    });
    const result = await service.recall(
      "pet-a",
      [{ role: "user", content: "你记得我喜欢什么颜色吗？" }],
      new AbortController().signal
    );
    expect(result.recalledCount).toBe(0);
    expect(result.context).toContain("必须明确承认不知道或记不清");
  });

  it("loads current summaries and deduplicated original turns from the real per-pet ledger for ordinary chat", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-recall-source-test-"));
    let ledger: MemoryLedger | undefined;
    try {
      ledger = await MemoryLedger.open("pet-a", { memoryDirectoryPath: directory });
      const turn = {
        petId: "pet-a",
        requestId: "source-request",
        userText: "我想喝无糖咖啡，不是甜咖啡。",
        assistantReply: "好，我记住你不加糖啦。",
        occurredAt: "2026-07-13T00:00:00.000Z",
        retainSource: true
      };
      const entries = ["旧的未修正摘要", "我们聊过咖啡", "已经忘记的摘要"].map((content, index) => ({
        ...memory(content), id: `memory-${index + 1}`, origin: "automatic" as const
      }));
      const committed = await ledger.commitAutomaticTurn(turn, "a".repeat(64), entries);
      await ledger.update({
        petId: "pet-a", memoryId: "memory-1", expectedRevision: 1, content: "你喜欢无糖咖啡，记忆已修正。"
      });
      await ledger.forget("pet-a", "memory-3", 1);
      ledger.close();
      ledger = undefined;

      const diagnostics: MemoryRecallDiagnostic[] = [];
      const service = new AiMemoryRecallService({
        getSettings: async () => ({ ...enabledSettings, contextBudgetChars: 4_096, retainSources: false }),
        synchronize: async () => undefined,
        retrieve: async () => ({
          ok: true,
          value: {
            items: [
              ...committed.memories.map((item) => ({ memory: item, score: 0.9 })),
              { memory: { ...memory("other-pet-private"), petId: "pet-b" }, score: 0.99 }
            ],
            answerPolicy: "reference"
          }
        }),
        openLedger: (petId) => MemoryLedger.open(petId, { memoryDirectoryPath: directory }),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
      });
      const result = await service.recall("pet-a", [{ role: "user", content: "今天喝点什么？" }], new AbortController().signal);
      expect(result.recalledCount).toBe(2);
      expect(result.context).toContain("你喜欢无糖咖啡，记忆已修正。");
      expect(result.context).toContain('"edited":true');
      expect(result.context).not.toContain("旧的未修正摘要");
      expect(result.context).not.toContain("已经忘记的摘要");
      expect(result.context).not.toContain("other-pet-private");
      expect(result.context!.split(turn.userText)).toHaveLength(2);
      expect(result.context).toContain(turn.assistantReply);
      expect(result.context).toContain(turn.occurredAt);
      expect(JSON.stringify(diagnostics)).not.toContain(turn.userText);
    } finally {
      ledger?.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the summary when its retained source is missing and skips source reads for unsaved sources", async () => {
    const saved = { ...memory("有摘要但缺少原文"), sourceAvailable: true };
    const unsaved = { ...memory("从未保存原文"), id: "memory-2" };
    const getSourceConversation = vi.fn(() => undefined);
    const close = vi.fn();
    const service = new AiMemoryRecallService({
      getSettings: async () => enabledSettings,
      synchronize: async () => undefined,
      retrieve: async () => ({ ok: true, value: {
        items: [saved, unsaved].map((item) => ({ memory: item, score: 0.9 })), answerPolicy: "reference"
      } }),
      openLedger: async () => ({
        get: (id) => id === saved.id ? saved : unsaved,
        getSourceConversation,
        close
      })
    });
    const result = await service.recall("pet-a", [{ role: "user", content: "随便聊聊" }], new AbortController().signal);
    expect(result.context).toContain(saved.content);
    expect(result.context).toContain(unsaved.content);
    expect(result.context).not.toContain("sourceConversations");
    expect(getSourceConversation).toHaveBeenCalledExactlyOnceWith(saved.id);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a late source ledger after cancellation without reading or injecting its contents", async () => {
    const controller = new AbortController();
    const get = vi.fn();
    const getSourceConversation = vi.fn();
    const close = vi.fn();
    let finishOpen!: (value: { get: typeof get; getSourceConversation: typeof getSourceConversation; close: typeof close }) => void;
    const openLedger = vi.fn(() => new Promise<{ get: typeof get; getSourceConversation: typeof getSourceConversation; close: typeof close }>((resolve) => {
      finishOpen = resolve;
    }));
    const service = new AiMemoryRecallService({
      getSettings: async () => enabledSettings,
      synchronize: async () => undefined,
      retrieve: async () => ({ ok: true, value: {
        items: [{ memory: memory("hidden"), score: 0.9 }], answerPolicy: "reference"
      } }),
      openLedger
    });
    const pending = service.recall("pet-a", [{ role: "user", content: "hello" }], controller.signal);
    await vi.waitFor(() => expect(openLedger).toHaveBeenCalledOnce());
    controller.abort("canceled");
    finishOpen({ get, getSourceConversation, close });
    await expect(pending).resolves.toEqual({ recalledCount: 0 });
    expect(get).not.toHaveBeenCalled();
    expect(getSourceConversation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds ledger reads to selected relevant candidates and does not load sources for unknown checks", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      memory: { ...memory(`记忆${index}`), id: `memory-${index}`, sourceAvailable: true }, score: 0.9
    }));
    const get = vi.fn((id: string) => items.find((item) => item.memory.id === id)?.memory);
    const getSourceConversation = vi.fn(() => undefined);
    const openLedger = vi.fn(async () => ({ get, getSourceConversation, close: vi.fn() }));
    let answerPolicy = "reference" as "reference" | "unknown";
    const service = new AiMemoryRecallService({
      getSettings: async () => ({ ...enabledSettings, recallLimit: 10 }),
      synchronize: async () => undefined,
      retrieve: async () => ({ ok: true, value: { items, answerPolicy } }),
      openLedger
    });
    await service.recall("pet-a", [{ role: "user", content: "hello" }], new AbortController().signal);
    expect(get).toHaveBeenCalledTimes(6);
    expect(getSourceConversation).toHaveBeenCalledTimes(6);
    answerPolicy = "unknown";
    await service.recall("pet-a", [{ role: "user", content: "你记得吗？" }], new AbortController().signal);
    expect(openLedger).toHaveBeenCalledOnce();
  });
});
