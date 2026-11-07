import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRebuildRequest, MemoryRebuildResponse } from "../../../shared/types/memory";
import { FakeMemoryBackend } from "./FakeMemoryBackend";
import { MemoryBackendError } from "./MemoryBackend";
import { MemoryIndexCoordinator } from "./MemoryIndexCoordinator";
import { MemoryLedger } from "./MemoryLedger";

let temporaryDirectory = "";

class DirectoryFakeBackend extends FakeMemoryBackend {
  failRebuild = false;

  constructor(private readonly indexDirectoryForPet: (petId: string) => string) {
    super();
  }

  override async rebuild(
    request: MemoryRebuildRequest,
    signal: AbortSignal
  ): Promise<MemoryRebuildResponse> {
    const target = path.join(this.indexDirectoryForPet(request.petId), request.targetId);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "validated.marker"), request.records.map(({ id }) => id).join("\n"));
    if (this.failRebuild) {
      throw new MemoryBackendError("index-dirty", "Injected rebuild failure.");
    }
    return super.rebuild(request, signal);
  }
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-index-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

async function incrementalFixture(count: number) {
  const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
  const ledgerOptions = { memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory") };
  const ledger = await MemoryLedger.open("pet-a", ledgerOptions);
  await fs.mkdir(path.join(indexDirectoryForPet("pet-a"), "current"), { recursive: true });
  await ledger.setIndexState("pet-a", false, "fixture-model-v1");
  for (let index = 0; index < count; index += 1) {
    await ledger.create({ petId: "pet-a", chapter: "about_you", memoryType: "profile", content: `authority ${index}` });
  }
  const backend = new DirectoryFakeBackend(indexDirectoryForPet);
  const coordinator = new MemoryIndexCoordinator({ backend, indexDirectoryForPet, modelFingerprint: "fixture-model-v1" });
  return { ledger, ledgerOptions, backend, coordinator };
}

describe("MemoryIndexCoordinator", () => {
  it("backs up once per completed page and leaves writes beyond the captured range for the next sync", async () => {
    const { ledger, backend, coordinator } = await incrementalFixture(45);
    try {
      const upperSequence = ledger.getLatestOutboxSequence();
      const upsert = backend.upsert.bind(backend);
      let appendedSequence = 0;
      vi.spyOn(backend, "upsert").mockImplementation(async (request, signal) => {
        await upsert(request, signal);
        if (!appendedSequence) {
          const appended = await ledger.create({ petId: "pet-a", chapter: "about_you", memoryType: "profile", content: "appended during sync" });
          appendedSequence = appended.outboxSequence;
        }
      });
      const rename = vi.spyOn(fs, "rename");
      const pages = vi.spyOn(ledger, "listOutbox");
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({ rebuilt: false, appliedCount: 45 });
      // One backup for the concurrent authority write, and three acknowledgments.
      expect(rename.mock.calls.filter(([, target]) => target === ledger.paths.ledgerBackup)).toHaveLength(4);
      expect(pages.mock.calls).toEqual([[0, 20, upperSequence], [20, 20, upperSequence], [40, 20, upperSequence]]);
      expect(backend.snapshot("pet-a")).toHaveLength(45);
      expect(ledger.getIndexMetadata().lastAppliedSequence).toBe(upperSequence);
      expect(ledger.getPendingOutboxCount()).toBe(1);
      expect(ledger.listOutbox().map(({ sequence }) => sequence)).toEqual([appendedSequence]);

      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({ rebuilt: false, appliedCount: 1 });
      expect(backend.snapshot("pet-a")).toHaveLength(46);
      expect(ledger.getIndexMetadata().lastAppliedSequence).toBe(appendedSequence);
      expect(ledger.getPendingOutboxCount()).toBe(0);
      expect(ledger.listOutbox()).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it.each(["failure", "cancel"] as const)("does not acknowledge an unfinished page after %s and rebuilds after reopening", async (mode) => {
    const fixture = await incrementalFixture(40);
    let ledger = fixture.ledger;
    const { backend, coordinator } = fixture;
    const controller = new AbortController();
    const upsert = backend.upsert.bind(backend);
    let calls = 0;
    vi.spyOn(backend, "upsert").mockImplementation(async (request, signal) => {
      calls += 1;
      if (mode === "failure" && calls === 23) throw new MemoryBackendError("unavailable", "injected page failure");
      await upsert(request, signal);
      // Cancellation after the last backend result must still leave the page pending.
      if (mode === "cancel" && calls === 40) controller.abort();
    });
    try {
      await expect(coordinator.synchronize(ledger, controller.signal)).rejects.toMatchObject({ code: mode === "failure" ? "unavailable" : "canceled" });
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: true, lastAppliedSequence: 20 });
      expect(ledger.getPendingOutboxCount()).toBe(20);
      expect(ledger.listOutbox().map(({ sequence }) => sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 21));
      ledger.close();
      ledger = await MemoryLedger.open("pet-a", fixture.ledgerOptions);
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: true, lastAppliedSequence: 20 });
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({ rebuilt: true, appliedCount: 40 });
      expect(backend.snapshot("pet-a")).toEqual(ledger.snapshot());
      expect(ledger.getPendingOutboxCount()).toBe(0);
      expect(ledger.listOutbox()).toEqual([]);
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: false, lastAppliedSequence: 40 });
    } finally {
      ledger.close();
    }
  });

  it("finds a clear beyond the first page before replaying any obsolete memory", async () => {
    const { ledger, backend, coordinator } = await incrementalFixture(25);
    try {
      await ledger.clear("pet-a");
      const upsert = vi.spyOn(backend, "upsert");
      const pages = vi.spyOn(ledger, "listOutbox");
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({ rebuilt: true, appliedCount: 0 });
      expect(upsert).not.toHaveBeenCalled();
      expect(pages).not.toHaveBeenCalled();
      expect(backend.snapshot("pet-a")).toEqual([]);
      expect(ledger.snapshot(true)).toEqual([]);
      expect(ledger.getPendingOutboxCount()).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("cleans legacy completed logs during an idle sync without replaying their payloads", async () => {
    const { ledger, backend, coordinator } = await incrementalFixture(1);
    try {
      const sequence = ledger.getLatestOutboxSequence();
      const connection = new DatabaseSync(ledger.paths.ledger);
      connection.prepare("UPDATE index_outbox SET processed_at = created_at, payload_json = 'obsolete-invalid-json'").run();
      connection.prepare("UPDATE index_metadata SET value = ? WHERE key = 'last_applied_sequence'").run(String(sequence));
      connection.close();
      const upsert = vi.spyOn(backend, "upsert");
      const rebuild = vi.spyOn(backend, "rebuild");
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({ rebuilt: false, appliedCount: 0 });
      expect(ledger.listOutbox()).toEqual([]);
      expect(ledger.snapshot()).toHaveLength(1);
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: false, lastAppliedSequence: sequence });
      expect(upsert).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      ledger.close();
    }
  });

  it("retries maintenance failures without invalidating confirmed synchronization", async () => {
    const { ledger, coordinator } = await incrementalFixture(1);
    try {
      const cleanup = vi.spyOn(ledger, "pruneProcessedOutbox").mockRejectedValueOnce(new Error("temporary cleanup failure"));
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({ rebuilt: false, appliedCount: 1 });
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: false, lastAppliedSequence: 1 });
      expect(ledger.listOutbox()).toEqual([]);
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({ rebuilt: false, appliedCount: 0 });
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      ledger.close();
    }
  });

  it("binds a rebuild to its authority snapshot without loading historical outbox payloads", async () => {
    const { ledger, backend, coordinator } = await incrementalFixture(2);
    try {
      const sequence = ledger.getLatestOutboxSequence();
      const rebuild = backend.rebuild.bind(backend);
      vi.spyOn(ledger, "listOutbox").mockImplementation(() => { throw new Error("history payloads must not be loaded"); });
      vi.spyOn(backend, "rebuild").mockImplementation(async (request, signal) => {
        await ledger.create({ petId: "pet-a", chapter: "about_you", memoryType: "profile", content: "created during rebuild" });
        return rebuild(request, signal);
      });
      await expect(coordinator.rebuild(ledger, new AbortController().signal)).resolves.toEqual({ rebuilt: true, appliedCount: 2 });
      expect(backend.snapshot("pet-a")).toHaveLength(2);
      expect(ledger.snapshot()).toHaveLength(3);
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: false, lastAppliedSequence: sequence });
      expect(ledger.getPendingOutboxCount()).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("rolls back failed staging work and advances outbox only after a validated swap", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    const created = await ledger.create({
      petId: "pet-a",
      chapter: "about_you",
      memoryType: "profile",
      content: "stable authority record"
    });
    const current = path.join(indexDirectoryForPet("pet-a"), "current");
    await fs.mkdir(current, { recursive: true });
    await fs.writeFile(path.join(current, "old.marker"), "old");
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({
      backend,
      indexDirectoryForPet,
      modelFingerprint: "fixture-model-v1"
    });
    const signal = new AbortController().signal;
    try {
      backend.failRebuild = true;
      await expect(coordinator.rebuild(ledger, signal)).rejects.toMatchObject({ code: "index-dirty" });
      expect(await fs.readFile(path.join(current, "old.marker"), "utf8")).toBe("old");
      expect((await fs.readdir(indexDirectoryForPet("pet-a"))).some((name) => name.startsWith("staging-"))).toBe(false);
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: true, lastAppliedSequence: 0 });

      backend.failRebuild = false;
      await expect(coordinator.rebuild(ledger, signal)).resolves.toEqual({ rebuilt: true, appliedCount: 1 });
      expect(await fs.readFile(path.join(current, "validated.marker"), "utf8")).toBe(created.memory.id);
      await expect(fs.access(path.join(indexDirectoryForPet("pet-a"), "backup"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(ledger.getIndexMetadata()).toMatchObject({
        dirty: false,
        lastAppliedSequence: created.outboxSequence,
        modelFingerprint: "fixture-model-v1"
      });

      const updated = await ledger.update({
        petId: "pet-a",
        memoryId: created.memory.id,
        expectedRevision: created.memory.revision,
        content: "updated authority record"
      });
      await expect(coordinator.synchronize(ledger, signal)).resolves.toEqual({ rebuilt: false, appliedCount: 1 });
      expect(backend.snapshot("pet-a")).toEqual([updated.memory]);
      expect(ledger.getIndexMetadata().lastAppliedSequence).toBe(updated.outboxSequence);
    } finally {
      ledger.close();
    }
  });

  it("rebuilds automatically on model fingerprint changes and removes stale staging work", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    const created = await ledger.create({
      petId: "pet-a",
      chapter: "preferences_habits",
      memoryType: "behavior",
      content: "model migration authority"
    });
    const root = indexDirectoryForPet("pet-a");
    await fs.mkdir(path.join(root, "current"), { recursive: true });
    await fs.writeFile(path.join(root, "current", "old.marker"), "old-model");
    await fs.mkdir(path.join(root, "staging-interrupted"), { recursive: true });
    await fs.writeFile(path.join(root, "staging-interrupted", "partial.marker"), "partial");
    await ledger.setIndexState("pet-a", false, "fixture-model-v1");
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({
      backend,
      indexDirectoryForPet,
      modelFingerprint: "fixture-model-v2"
    });
    try {
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({
        rebuilt: true,
        appliedCount: 1
      });
      expect(await fs.readFile(path.join(root, "current", "validated.marker"), "utf8")).toBe(created.memory.id);
      expect((await fs.readdir(root)).some((name) => name.startsWith("staging-"))).toBe(false);
      expect(ledger.getIndexMetadata()).toMatchObject({ dirty: false, modelFingerprint: "fixture-model-v2" });
    } finally {
      ledger.close();
    }
  });

  it("recovers backup when an interrupted Windows swap left current missing", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    const root = indexDirectoryForPet("pet-a");
    await fs.mkdir(path.join(root, "backup"), { recursive: true });
    await fs.writeFile(path.join(root, "backup", "recovery.marker"), "recovered");
    await ledger.setIndexState("pet-a", false, "fixture-model-v1");
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({ backend, indexDirectoryForPet, modelFingerprint: "fixture-model-v1" });
    try {
      await expect(coordinator.synchronize(ledger, new AbortController().signal)).resolves.toEqual({
        rebuilt: false,
        appliedCount: 0
      });
      expect(await fs.readFile(path.join(root, "current", "recovery.marker"), "utf8")).toBe("recovered");
      await expect(fs.access(path.join(root, "backup"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      ledger.close();
    }
  });

  it("rolls current back when authority metadata cannot commit after the directory swap", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    await ledger.create({
      petId: "pet-a",
      chapter: "about_you",
      memoryType: "profile",
      content: "new authority"
    });
    const root = indexDirectoryForPet("pet-a");
    await fs.mkdir(path.join(root, "current"), { recursive: true });
    await fs.writeFile(path.join(root, "current", "old.marker"), "old-current");
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({ backend, indexDirectoryForPet, modelFingerprint: "fixture-model-v2" });
    const originalSetIndexState = ledger.setIndexState.bind(ledger);
    ledger.setIndexState = async (petId, dirty, fingerprint) => {
      if (!dirty) throw new Error("injected metadata commit failure");
      return originalSetIndexState(petId, dirty, fingerprint);
    };
    try {
      await expect(coordinator.rebuild(ledger, new AbortController().signal)).rejects.toThrow("injected metadata commit failure");
      expect(await fs.readFile(path.join(root, "current", "old.marker"), "utf8")).toBe("old-current");
      expect((await fs.readdir(root)).some((name) => name.startsWith("staging-"))).toBe(false);
      expect(ledger.getIndexMetadata().dirty).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("physically purges a synchronized clear without retaining a derived backup", async () => {
    const indexDirectoryForPet = (petId: string) => path.join(temporaryDirectory, petId, "index");
    const ledger = await MemoryLedger.open("pet-a", {
      memoryDirectoryPath: path.join(temporaryDirectory, "pet-a", "memory")
    });
    await ledger.create({ petId: "pet-a", chapter: "about_you", memoryType: "profile", content: "clear-one" });
    await ledger.create({ petId: "pet-a", chapter: "important_events", memoryType: "event", content: "clear-two" });
    const backend = new DirectoryFakeBackend(indexDirectoryForPet);
    const coordinator = new MemoryIndexCoordinator({ backend, indexDirectoryForPet, modelFingerprint: "fixture-model-v1" });
    const signal = new AbortController().signal;
    try {
      await coordinator.synchronize(ledger, signal);
      await ledger.clear("pet-a");
      await expect(coordinator.synchronize(ledger, signal)).resolves.toEqual({ rebuilt: true, appliedCount: 0 });
      expect(ledger.snapshot(true)).toEqual([]);
      expect(ledger.listOutbox()).toEqual([]);
      expect(backend.snapshot("pet-a")).toEqual([]);
      await expect(fs.access(path.join(indexDirectoryForPet("pet-a"), "backup"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      ledger.close();
    }
  });
});
