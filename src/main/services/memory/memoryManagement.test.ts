import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_AUTO_CAPTURE_CONSENT,
  MEMORY_SOURCE_EXPORT_CONSENT,
  MEMORY_SOURCE_RETENTION_CONSENT
} from "../../../shared/types/memory";
import { MemoryBackendError } from "./MemoryBackend";
import { MemoryLedger } from "./MemoryLedger";
import { MemoryManagementService, type MemoryManagementDependencies } from "./memoryManagement";

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-memory-management-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function fixture(overrides: Partial<MemoryManagementDependencies> = {}) {
  const settings = new Map([
    ["pet-a", { ...DEFAULT_MEMORY_SETTINGS }],
    ["pet-b", { ...DEFAULT_MEMORY_SETTINGS }]
  ]);
  const synchronize = vi.fn(async () => undefined);
  const closePetIndex = vi.fn(async () => undefined);
  const releaseCapture = vi.fn();
  const dependencies: MemoryManagementDependencies = {
    petExists: vi.fn(async (petId) => petId === "pet-a" || petId === "pet-b"),
    getSettings: vi.fn(async (petId) => settings.get(petId)),
    saveSettings: vi.fn(async (petId, value) => {
      settings.set(petId, { ...value });
      return { ...value };
    }),
    openLedger: (petId) => MemoryLedger.open(petId, {
      memoryDirectoryPath: path.join(temporaryDirectory, petId)
    }),
    listPending: vi.fn(async () => []),
    synchronize,
    rebuild: vi.fn(async () => ({ appliedCount: 0 })),
    providerHealth: vi.fn(async () => ({ state: "ready" as const })),
    testProvider: vi.fn(async () => ({ state: "ready" as const })),
    closePetIndex,
    refreshCaptures: vi.fn(async () => undefined),
    suspendCaptures: vi.fn(async () => releaseCapture),
    ...overrides
  };
  return {
    service: new MemoryManagementService(dependencies),
    dependencies,
    settings,
    synchronize,
    closePetIndex,
    releaseCapture
  };
}

const createRequest = (petId: string, content: string) => ({
  petId,
  chapter: "about_you" as const,
  memoryType: "profile" as const,
  content
});

describe("MemoryManagementService", () => {
  it("keeps management reads and records isolated by pet with bounded pagination", async () => {
    const { service } = fixture();
    await service.create(createRequest("pet-a", "only pet a"));
    await service.create(createRequest("pet-b", "only pet b"));

    const petA = await service.list({ petId: "pet-a", pageSize: 1 });
    const petBSearch = await service.search({ petId: "pet-b", query: "only", pageSize: 1 });
    expect(petA.ok && petA.value.items.map(({ content }) => content)).toEqual(["only pet a"]);
    expect(petBSearch.ok && petBSearch.value.items.map(({ content }) => content)).toEqual(["only pet b"]);
    const missing = await service.get({
      petId: "pet-b",
      memoryId: petA.ok ? petA.value.items[0]!.id : "missing"
    });
    expect(missing).toEqual({ ok: true, value: undefined });
    await expect(service.getSourceConversation({
      petId: "pet-b",
      memoryId: petA.ok ? petA.value.items[0]!.id : "missing"
    })).resolves.toEqual({ ok: true, value: undefined });
  });

  it("returns only the retained source turn associated with the requested memory", async () => {
    const { service, dependencies } = fixture();
    const ledger = await dependencies.openLedger("pet-a");
    await ledger.commitAutomaticTurn({
      petId: "pet-a",
      requestId: "source-request",
      userText: "用户来源内容",
      assistantReply: "桌宠最终回复",
      occurredAt: "2026-07-14T10:00:00.000Z",
      retainSource: true
    }, "c".repeat(64), [{
      id: "source-memory",
      petId: "pet-a",
      chapter: "important_events",
      memoryType: "event",
      content: "我记得这一轮对话",
      origin: "automatic"
    }]);
    ledger.close();

    const result = await service.getSourceConversation({ petId: "pet-a", memoryId: "source-memory" });
    expect(result).toMatchObject({
      ok: true,
      value: {
        userText: "用户来源内容",
        assistantReply: "桌宠最终回复",
        occurredAt: "2026-07-14T10:00:00.000Z",
        organizedAt: expect.any(String)
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/requestId|ledger|sqlite|indexPath|[A-Z]:\\/i);
  });

  it("serializes duplicate mutations so stale revisions fail without duplicating outbox writes", async () => {
    const { service } = fixture();
    const created = await service.create(createRequest("pet-a", "original"));
    if (!created.ok) throw new Error("fixture create failed");
    const memory = created.value.memory;
    const updates = await Promise.all([
      service.update({ petId: "pet-a", memoryId: memory.id, expectedRevision: 1, content: "first" }),
      service.update({ petId: "pet-a", memoryId: memory.id, expectedRevision: 1, content: "second" })
    ]);

    expect(updates.filter((result) => result.ok)).toHaveLength(1);
    expect(updates.filter((result) => !result.ok)[0]).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false }
    });
    const ledger = await MemoryLedger.open("pet-a", { memoryDirectoryPath: path.join(temporaryDirectory, "pet-a") });
    expect(ledger.listOutbox()).toHaveLength(2);
    ledger.close();
  });

  it("keeps a successful authority mutation when sidecar synchronization is unavailable", async () => {
    const { service } = fixture({
      synchronize: vi.fn(async () => {
        throw new MemoryBackendError("unavailable", "sidecar unavailable");
      })
    });
    const created = await service.create(createRequest("pet-a", "durable authority"));
    expect(created).toMatchObject({ ok: true, value: { indexState: "pending" } });
    expect(JSON.stringify(created)).not.toContain("outboxSequence");
    const listed = await service.list({ petId: "pet-a", pageSize: 5 });
    expect(listed.ok && listed.value.items[0]?.content).toBe("durable authority");
  });

  it("returns a structured error when an explicit rebuild cannot reach the sidecar", async () => {
    const { service } = fixture({
      rebuild: vi.fn(async () => {
        throw new MemoryBackendError("unavailable", "sidecar unavailable");
      })
    });
    await expect(service.rebuildIndex("pet-a")).resolves.toEqual({
      ok: false,
      error: { code: "unavailable", message: "sidecar unavailable", retryable: true }
    });
  });

  it("requires explicit confirmations for capture, source retention, source export, and clear", async () => {
    const { service } = fixture();
    const settings = {
      ...DEFAULT_MEMORY_SETTINGS,
      autoCaptureEnabled: true,
      retainSources: true
    };
    await expect(service.saveSettings({ petId: "pet-a", settings })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid-request" }
    });
    await expect(service.saveSettings({
      petId: "pet-a",
      settings,
      autoCaptureConsent: MEMORY_AUTO_CAPTURE_CONSENT,
      sourceRetentionConsent: MEMORY_SOURCE_RETENTION_CONSENT
    })).resolves.toMatchObject({ ok: true });
    await expect(service.exportSnapshot({
      petId: "pet-a",
      options: { includeSources: true }
    })).resolves.toMatchObject({ ok: false, error: { code: "invalid-request" } });
    await expect(service.exportSnapshot({
      petId: "pet-a",
      options: { includeSources: true },
      sourceExportConsent: MEMORY_SOURCE_EXPORT_CONSENT
    })).resolves.toMatchObject({ ok: true });
    await expect(service.clear({ petId: "pet-a", confirmPetId: "pet-b" })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid-request" }
    });
  });

  it("closes the derived index and suspends capture before pet deletion, then releases on completion", async () => {
    const { service, closePetIndex, releaseCapture } = fixture();
    const events: string[] = [];
    closePetIndex.mockImplementation(async () => { events.push("close-index"); });
    const result = await service.runPetDeletion("pet-a", async () => {
      events.push("delete-files");
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });
    expect(events).toEqual(["close-index", "delete-files"]);
    expect(releaseCapture).toHaveBeenCalledOnce();
  });

  it("restores a backup with capture suspended and keeps authority when the index is unavailable", async () => {
    const { service, dependencies, releaseCapture } = fixture({
      synchronize: vi.fn(async () => { throw new MemoryBackendError("unavailable", "sidecar unavailable"); })
    });
    const source = await dependencies.openLedger("pet-a");
    const created = await source.create(createRequest("pet-a", "backup authority"));
    const data = source.backupSnapshot(false);
    source.close();
    const restored = await service.restoreSnapshot("pet-b", data);
    expect(restored).toEqual({ ok: true, value: { importedCount: 1, skippedCount: 0, indexState: "pending" } });
    expect(dependencies.suspendCaptures).toHaveBeenCalledWith("pet-b");
    expect(releaseCapture).toHaveBeenCalledOnce();
    const listed = await service.list({ petId: "pet-b", pageSize: 5 });
    expect(listed.ok && listed.value.items[0]?.content).toBe("backup authority");
    expect(JSON.stringify(restored)).not.toContain("outbox");
    expect(await service.get({ petId: "pet-a", memoryId: created.memory.id })).toMatchObject({ ok: true, value: { content: "backup authority" } });
    const again = await service.restoreSnapshot("pet-b", data);
    expect(again).toEqual({ ok: true, value: { importedCount: 0, skippedCount: 1, indexState: "pending" } });
    expect(dependencies.synchronize).toHaveBeenCalledOnce();
  });

  it("reports only public status fields and does not create data for an unknown pet", async () => {
    const { service } = fixture({
      listPending: vi.fn(async () => [{}, { deadLetteredAt: "2026-07-13T00:00:00.000Z" }])
    });
    const status = await service.getStatus("pet-a");
    expect(status).toMatchObject({
      ok: true,
      value: {
        petId: "pet-a",
        provider: { state: "disabled" },
        pendingCaptures: 1,
        deadLetters: 1
      }
    });
    expect(JSON.stringify(status)).not.toMatch(/apiKey|ledger|sqlite|indexPath|[A-Z]:\\/i);
    await expect(service.getSummary("pet-c")).resolves.toMatchObject({
      ok: false,
      error: { code: "not-found" }
    });
    await expect(fs.access(path.join(temporaryDirectory, "pet-c"))).rejects.toThrow();
  });
});
