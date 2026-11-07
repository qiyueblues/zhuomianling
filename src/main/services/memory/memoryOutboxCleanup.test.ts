import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLedger } from "./MemoryLedger";

let directory = "";
let ledger: MemoryLedger;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-outbox-test-"));
  ledger = await MemoryLedger.open("pet-a", { memoryDirectoryPath: directory });
});

afterEach(async () => {
  vi.restoreAllMocks();
  ledger.close();
  await fs.rm(directory, { recursive: true, force: true });
});

function create(content: string) {
  return ledger.create({ petId: "pet-a", chapter: "about_you", memoryType: "profile", content });
}

function markLegacyProcessed(throughSequence: number): void {
  const connection = new DatabaseSync(ledger.paths.ledger);
  try {
    connection.prepare("UPDATE index_outbox SET processed_at = created_at WHERE sequence <= ?").run(throughSequence);
    connection.prepare("UPDATE index_metadata SET value = ? WHERE key = 'last_applied_sequence'").run(String(throughSequence));
  } finally {
    connection.close();
  }
}

describe("memory outbox cleanup", () => {
  it("drops confirmed revisions while preserving later work, authority, sources, and monotonically increasing sequences", async () => {
    const committed = await ledger.commitAutomaticTurn({
      petId: "pet-a", requestId: "source-fixture", userText: "original source", assistantReply: "final reply",
      occurredAt: "2026-11-08T00:00:00.000Z", retainSource: true
    }, "a".repeat(64), [{
      id: "source-memory", petId: "pet-a", chapter: "about_you", memoryType: "profile", content: "first revision", origin: "automatic"
    }]);
    const updated = await ledger.update({
      petId: "pet-a", memoryId: committed.memories[0].id, expectedRevision: 1, content: "current revision"
    });
    const later = await create("unsynchronized work");
    const records = ledger.snapshot();
    const sources = ledger.getSourceTurns();

    await ledger.markOutboxProcessed("pet-a", updated.outboxSequence);
    expect(ledger.listOutbox().map(({ sequence }) => sequence)).toEqual([later.outboxSequence]);
    expect(ledger.getPendingOutboxCount()).toBe(1);
    expect(ledger.snapshot()).toEqual(records);
    expect(ledger.getSourceTurns()).toEqual(sources);
    expect(ledger.getSourceConversation("source-memory")).toMatchObject({ userText: "original source", assistantReply: "final reply" });

    await ledger.markOutboxProcessed("pet-a", later.outboxSequence);
    expect(ledger.listOutbox()).toEqual([]);
    ledger.close();
    ledger = await MemoryLedger.open("pet-a", { memoryDirectoryPath: directory });
    expect(ledger.getIndexMetadata().lastAppliedSequence).toBe(later.outboxSequence);
    const next = await create("after reopening");
    expect(next.outboxSequence).toBeGreaterThan(later.outboxSequence);
    expect(ledger.listOutbox().map(({ sequence }) => sequence)).toEqual([next.outboxSequence]);
  });

  it("prunes legacy completed payloads using both the saved cursor and completion flag", async () => {
    const first = await create("completed");
    const pending = await create("pending below cursor");
    const ahead = await create("flagged ahead of cursor");
    markLegacyProcessed(pending.outboxSequence);
    const connection = new DatabaseSync(ledger.paths.ledger);
    connection.prepare("UPDATE index_outbox SET processed_at = NULL WHERE sequence = ?").run(pending.outboxSequence);
    connection.prepare("UPDATE index_outbox SET processed_at = created_at WHERE sequence = ?").run(ahead.outboxSequence);
    connection.prepare("UPDATE index_outbox SET payload_json = 'obsolete-invalid-json' WHERE sequence = ?").run(first.outboxSequence);
    connection.close();
    const records = ledger.snapshot();

    await expect(ledger.pruneProcessedOutbox("pet-a")).resolves.toEqual({ prunedCount: 1, compacted: false });
    expect(ledger.listOutbox().map(({ sequence }) => sequence)).toEqual([pending.outboxSequence, ahead.outboxSequence]);
    expect(ledger.getPendingOutboxCount()).toBe(1);
    expect(ledger.snapshot()).toEqual(records);
    const backup = new DatabaseSync(ledger.paths.ledgerBackup, { readOnly: true });
    try {
      expect(backup.prepare("SELECT sequence FROM index_outbox ORDER BY sequence").all()).toEqual([
        { sequence: pending.outboxSequence }, { sequence: ahead.outboxSequence }
      ]);
    } finally {
      backup.close();
    }
  });

  it("skips backups and compaction when there is nothing to clean", async () => {
    const created = await create("active authority");
    await ledger.markOutboxProcessed("pet-a", created.outboxSequence);
    const rename = vi.spyOn(fs, "rename");
    await expect(ledger.pruneProcessedOutbox("pet-a")).resolves.toEqual({ prunedCount: 0, compacted: false });
    await ledger.markOutboxProcessed("pet-a", created.outboxSequence);
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(["backup", "transaction"] as const)("keeps legacy logs and progress intact after a %s failure", async (failure) => {
    const created = await create("authority survives cleanup failure");
    markLegacyProcessed(created.outboxSequence);
    if (failure === "backup") {
      await fs.rm(ledger.paths.ledgerBackup);
      await fs.mkdir(ledger.paths.ledgerBackup);
    } else {
      const connection = new DatabaseSync(ledger.paths.ledger);
      connection.exec(`CREATE TRIGGER fail_outbox_cleanup BEFORE DELETE ON index_outbox BEGIN
        SELECT RAISE(ABORT, 'database or disk is full'); END;`);
      connection.close();
    }
    await expect(ledger.pruneProcessedOutbox("pet-a")).rejects.toMatchObject({ code: "MEMORY_STORAGE_UNAVAILABLE" });
    expect(ledger.listOutbox()).toHaveLength(1);
    expect(ledger.getIndexMetadata().lastAppliedSequence).toBe(created.outboxSequence);
    expect(ledger.get(created.memory.id)).toEqual(created.memory);
  });

  it("rolls back both log deletion and cursor advancement if acknowledgment fails", async () => {
    const first = await create("first pending");
    const second = await create("second pending");
    const connection = new DatabaseSync(ledger.paths.ledger);
    connection.exec(`CREATE TRIGGER fail_cursor_commit BEFORE UPDATE ON index_metadata
      WHEN new.key = 'last_applied_sequence' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;`);
    connection.close();

    await expect(ledger.markOutboxProcessed("pet-a", second.outboxSequence)).rejects.toMatchObject({ code: "MEMORY_STORAGE_UNAVAILABLE" });
    expect(ledger.getIndexMetadata().lastAppliedSequence).toBe(0);
    expect(ledger.listOutbox().map(({ sequence }) => sequence)).toEqual([first.outboxSequence, second.outboxSequence]);
    expect(ledger.getPendingOutboxCount()).toBe(2);
  });

  it.each(["legacy", "acknowledged"] as const)("reclaims %s log space in the ledger and recovery backup without resetting sequences", async (mode) => {
    const created = await create("current authority must remain");
    const connection = new DatabaseSync(ledger.paths.ledger);
    let highWaterMark = created.outboxSequence;
    try {
      const insert = connection.prepare(`INSERT INTO index_outbox(operation, memory_id, payload_json, created_at, processed_at)
        VALUES ('upsert', ?, ?, ?, ?)`);
      const payload = JSON.stringify({ ...created.memory, content: "retired revision ".repeat(500) });
      connection.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 384; index += 1) {
        highWaterMark = Number(insert.run(created.memory.id, payload, created.memory.createdAt, created.memory.createdAt).lastInsertRowid);
      }
      connection.prepare("UPDATE index_outbox SET processed_at = created_at").run();
      connection.prepare("UPDATE index_metadata SET value = ? WHERE key = 'last_applied_sequence'").run(String(highWaterMark));
      connection.exec("COMMIT");
      connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      connection.close();
    }
    const before = (await fs.stat(ledger.paths.ledger)).size;
    expect(before).toBeGreaterThan(2 * 1024 * 1024);
    if (mode === "acknowledged") await ledger.markOutboxProcessed("pet-a", highWaterMark);

    await expect(ledger.pruneProcessedOutbox("pet-a")).resolves.toEqual({ prunedCount: mode === "legacy" ? 385 : 0, compacted: true });
    expect((await fs.stat(ledger.paths.ledger)).size).toBeLessThan(before / 2);
    expect((await fs.stat(ledger.paths.ledgerBackup)).size).toBeLessThan(before / 2);
    expect(ledger.listOutbox()).toEqual([]);
    expect(ledger.get(created.memory.id)).toEqual(created.memory);
    expect((await fs.stat(`${ledger.paths.ledger}-wal`)).size).toBe(0);
    const check = new DatabaseSync(ledger.paths.ledgerBackup, { readOnly: true });
    try {
      expect(check.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(check.prepare("SELECT count(*) count FROM index_outbox").get()).toEqual({ count: 0 });
    } finally {
      check.close();
    }
    ledger.close();
    ledger = await MemoryLedger.open("pet-a", { memoryDirectoryPath: directory });
    expect((await create("new work after compaction")).outboxSequence).toBeGreaterThan(highWaterMark);
  });
});
