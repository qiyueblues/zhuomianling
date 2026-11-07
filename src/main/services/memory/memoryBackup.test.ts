import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ZipFile } from "yazl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_BACKUP_KIND, type MemoryBackupData, type MemoryBackupManifest } from "../../../shared/types/memoryBackup";
import { MemoryLedger } from "./MemoryLedger";
import { readMemoryBackup, writeMemoryBackup } from "./memoryBackupArchive";
import { MemoryBackupSessions } from "./MemoryBackupSessions";

let directory = "";
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "zml-memory-backup-")); });
afterEach(async () => { vi.useRealTimers(); await fs.rm(directory, { recursive: true, force: true }); });

function fixture(): MemoryBackupData {
  const time = "2026-11-07T01:00:00.000Z";
  return {
    petId: "original-pet",
    records: ["first", "second"].map((id) => ({
      id, petId: "original-pet", chapter: "about_you", memoryType: "profile", content: `memory ${id}`,
      tags: ["fixture"], important: true, origin: "automatic", sourceTime: time, sourceAvailable: true,
      createdAt: time, updatedAt: time, revision: 2
    })),
    sources: [{ id: "turn-one", memoryIds: ["first", "second"], userText: "user source", assistantReply: "safe final reply", occurredAt: time, organizedAt: time }]
  };
}

function manifest(payload: Buffer, data = fixture()): MemoryBackupManifest {
  return { kind: MEMORY_BACKUP_KIND, formatVersion: 1, exportedAt: "2026-11-07T02:00:00.000Z", petName: "合成桌宠", recordCount: data.records.length,
    sourceCount: data.sources.length, dataBytes: payload.length, dataSha256: createHash("sha256").update(payload).digest("hex") };
}

async function rawArchive(entries: Array<[string, Buffer | string]>): Promise<string> {
  const zip = new ZipFile();
  const completion = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  })();
  for (const [name, content] of entries) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  const filePath = path.join(directory, "raw.zmlmem");
  await fs.writeFile(filePath, await completion);
  return filePath;
}

describe("memory backup archive", () => {
  it("round-trips a compressed authority backup with source links and safe metadata", async () => {
    const data = fixture();
    const filePath = path.join(directory, "backup.zmlmem");
    await writeMemoryBackup(filePath, data, "合成桌宠");
    expect((await fs.readFile(filePath)).subarray(0, 2).toString()).toBe("PK");
    const restored = await readMemoryBackup(filePath);
    expect(restored.data).toEqual(data);
    expect(restored.manifest).toMatchObject({ petName: "合成桌宠", formatVersion: 1, recordCount: 2, sourceCount: 1 });
    expect(JSON.stringify(restored)).not.toMatch(/embedding|sqlite|apiKey|contentHash|indexPath/);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["future-version", "hash", "count", "source-link", "duplicate-record", "invalid-json", "extra-field"])("rejects %s before restoration", async (mode) => {
    const data = fixture();
    if (mode === "source-link") data.sources[0].memoryIds = ["not-in-backup"];
    if (mode === "duplicate-record") data.records[1].id = data.records[0].id;
    if (mode === "extra-field") Object.assign(data.records[0], { indexPath: "untrusted" });
    const payload = Buffer.from(mode === "invalid-json" ? "{broken" : JSON.stringify(data));
    const meta = { ...manifest(payload), ...(mode === "future-version" ? { formatVersion: 99 } : {}),
      ...(mode === "hash" ? { dataSha256: "0".repeat(64) } : {}), ...(mode === "count" ? { recordCount: 100 } : {}) };
    const filePath = await rawArchive([["manifest.json", JSON.stringify(meta)], ["memories.json", payload]]);
    await expect(readMemoryBackup(filePath)).rejects.toMatchObject({ code: "invalid-request" });
  });

  it.each(["unexpected-entry", "duplicate-entry", "oversized-manifest", "missing-entry"])("rejects an archive with %s", async (mode) => {
    const payload = Buffer.from(JSON.stringify(fixture()));
    let entries: Array<[string, Buffer | string]> = [["manifest.json", JSON.stringify(manifest(payload))], ["memories.json", payload]];
    if (mode === "unexpected-entry") entries[1][0] = "nested/memories.json";
    if (mode === "duplicate-entry") entries[1][0] = "manifest.json";
    if (mode === "oversized-manifest") entries[0][1] = " ".repeat(20_000);
    if (mode === "missing-entry") entries = entries.slice(0, 1);
    await expect(readMemoryBackup(await rawArchive(entries))).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("rejects truncated archives and leaves an existing export intact on failed validation", async () => {
    const filePath = path.join(directory, "backup.zmlmem");
    await writeMemoryBackup(filePath, fixture(), "fixture");
    const before = await fs.readFile(filePath);
    const invalid = fixture();
    invalid.records[0].revision = 0;
    await expect(writeMemoryBackup(filePath, invalid, "fixture")).rejects.toThrow();
    expect(await fs.readFile(filePath)).toEqual(before);
    await fs.writeFile(filePath, before.subarray(0, 50));
    await expect(readMemoryBackup(filePath)).rejects.toMatchObject({ code: "invalid-request" });
  });
});

describe("memory backup restoration", () => {
  it("merges into the current pet, preserves sources across restart, and skips duplicates and local edits", async () => {
    const options = { memoryDirectoryPath: path.join(directory, "target") };
    let ledger = await MemoryLedger.open("target-pet", options);
    try {
      const existing = await ledger.create({ petId: "target-pet", chapter: "about_you", memoryType: "profile", content: "existing local memory" });
      expect(await ledger.restoreSnapshot(fixture())).toEqual({ importedCount: 2, skippedCount: 0 });
      const imported = ledger.snapshot().find((memory) => memory.content === "memory first")!;
      expect(imported).toMatchObject({ petId: "target-pet", important: true, revision: 2, sourceAvailable: true });
      expect(ledger.getSourceConversation(imported.id)).toEqual({ userText: "user source", assistantReply: "safe final reply", occurredAt: fixture().sources[0].occurredAt, organizedAt: fixture().sources[0].organizedAt });
      expect(ledger.get(existing.memory.id)?.content).toBe("existing local memory");
      await ledger.update({ petId: "target-pet", memoryId: imported.id, expectedRevision: 2, content: "locally edited" });
      ledger.close();
      ledger = await MemoryLedger.open("target-pet", options);
      expect(await ledger.restoreSnapshot(fixture())).toEqual({ importedCount: 0, skippedCount: 2 });
      expect(ledger.get(imported.id)?.content).toBe("locally edited");
      expect(ledger.snapshot()).toHaveLength(3);
      expect(ledger.getIndexMetadata().dirty).toBe(true);
      const exported = ledger.backupSnapshot(true);
      expect(exported.sources).toHaveLength(1);
      expect(exported.sources[0].memoryIds).toContain(imported.id);
      expect(ledger.backupSnapshot(false).records.every((memory) => !memory.sourceAvailable)).toBe(true);
      expect(ledger.backupSnapshot(false).sources).toEqual([]);
    } finally { ledger.close(); }
  });

  it("rolls back every record, source, FTS entry, and outbox row on a mid-transaction failure", async () => {
    const ledger = await MemoryLedger.open("target-pet", { memoryDirectoryPath: directory });
    const connection = new DatabaseSync(ledger.paths.ledger);
    try {
      connection.exec("CREATE TRIGGER reject_second BEFORE INSERT ON memories WHEN new.content = 'memory second' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
      await expect(ledger.restoreSnapshot(fixture())).rejects.toThrow();
      expect(ledger.snapshot()).toEqual([]);
      expect(ledger.getSourceTurns()).toEqual([]);
      expect(ledger.listOutbox()).toEqual([]);
      expect(ledger.search({ petId: "target-pet", query: "first" }).items).toEqual([]);
      expect(ledger.getIndexMetadata().dirty).toBe(false);
    } finally { connection.close(); ledger.close(); }
  });

  it("fails before mutation when the verified backup cannot be replaced", async () => {
    const ledger = await MemoryLedger.open("target-pet", { memoryDirectoryPath: directory });
    try {
      await fs.mkdir(ledger.paths.ledgerBackup);
      await expect(ledger.restoreSnapshot(fixture())).rejects.toMatchObject({ code: "MEMORY_STORAGE_UNAVAILABLE" });
      expect(ledger.snapshot()).toEqual([]);
      expect(ledger.listOutbox()).toEqual([]);
    } finally { ledger.close(); }
  });

  it("keeps same-pet IDs and explicitly restores forgotten and cleared records before index cleanup", async () => {
    const ledger = await MemoryLedger.open("original-pet", { memoryDirectoryPath: directory });
    try {
      await ledger.restoreSnapshot(fixture());
      await ledger.forget("original-pet", "first", 2);
      expect(await ledger.restoreSnapshot(fixture())).toEqual({ importedCount: 1, skippedCount: 1 });
      expect(ledger.get("first")).toMatchObject({ content: "memory first", revision: 4 });
      expect(ledger.listOutbox().at(-1)?.payload).toMatchObject({ id: "first", revision: 4 });
      await ledger.clear("original-pet");
      expect(ledger.snapshot()).toEqual([]);
      expect(await ledger.restoreSnapshot(fixture())).toEqual({ importedCount: 2, skippedCount: 0 });
      const data = ledger.backupSnapshot(true);
      expect(data.records.map(({ id }) => id)).toEqual(["first", "second"]);
      expect(data.sources[0].memoryIds).toEqual(["first", "second"]);
    } finally { ledger.close(); }
  });
});

describe("memory backup confirmation sessions", () => {
  it("binds a one-time confirmation to its window and target pet and exposes no content or path", () => {
    const sessions = new MemoryBackupSessions();
    const data = fixture();
    const inspection = sessions.prepare(1, "target", "C:/private/backup.zmlmem", { data, manifest: manifest(Buffer.from(JSON.stringify(data))) });
    expect(JSON.stringify(inspection)).not.toMatch(/private|user source|memory first/);
    expect(() => sessions.take(2, "target", inspection.token)).toThrow();
    expect(() => sessions.take(1, "other", inspection.token)).toThrow();
    expect(sessions.take(1, "target", inspection.token)).toEqual(data);
    expect(() => sessions.take(1, "target", inspection.token)).toThrow();
  });

  it("discards canceled, superseded, and expired confirmations", () => {
    vi.useFakeTimers();
    const sessions = new MemoryBackupSessions();
    const data = fixture();
    const backup = { data, manifest: manifest(Buffer.from(JSON.stringify(data))) };
    const first = sessions.prepare(1, "target", "a.zmlmem", backup);
    const second = sessions.prepare(1, "target", "b.zmlmem", backup);
    expect(() => sessions.take(1, "target", first.token)).toThrow();
    sessions.discardOwner(1);
    expect(() => sessions.take(1, "target", second.token)).toThrow();
    const third = sessions.prepare(1, "target", "c.zmlmem", backup);
    vi.advanceTimersByTime(10 * 60_000);
    expect(() => sessions.take(1, "target", third.token)).toThrow();
  });
});
