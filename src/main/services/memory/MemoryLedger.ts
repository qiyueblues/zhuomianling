import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import type {
  MemoryChapter,
  MemoryClearResult,
  MemoryConversationTurn,
  MemoryCreateRequest,
  MemoryForgetResult,
  MemoryIndexMetadata,
  MemoryMutationResult,
  MemoryOutboxEntry,
  MemoryOutboxOperation,
  MemoryPage,
  MemoryRecord,
  MemoryRecordInput,
  MemorySearchRequest,
  MemorySourceConversation,
  MemorySourceTurn,
  MemoryUpdateRequest
} from "../../../shared/types/memory";
import { MEMORY_CHAPTERS, MEMORY_LIMITS } from "../../../shared/types/memory";
import { MEMORY_BACKUP_LIMITS, type MemoryBackupData, type MemoryBackupSource } from "../../../shared/types/memoryBackup";
import { assertMemoryBackupData } from "../../../shared/validation/memoryBackup";
import {
  assertBoundedMemoryString,
  assertMemoryChapter,
  assertMemoryConversationTurn,
  assertMemoryObjectBudget,
  assertMemoryRecord,
  assertMemoryRecordInput,
  assertMemorySearchRequest,
  MemoryValidationError,
  normalizeMemoryPageRequest
} from "../../../shared/validation/memory";
import { assertValidPetId } from "../../../shared/validation/petId";
import { withPetConfigWriteLock } from "../config/petConfigWriteQueue";
import {
  assertSafeExistingMemoryEntry,
  ensureMemoryPathsAtDirectory,
  ensureSafeMemoryPaths,
  type MemoryPaths
} from "./memoryPaths";

const MEMORY_LEDGER_SCHEMA_VERSION = 1;
const OUTBOX_COMPACTION_MIN_FREE_BYTES = 1024 * 1024;

export type MemoryLedgerErrorCode =
  | "LEDGER_CORRUPTED"
  | "LEDGER_VERSION_UNSUPPORTED"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_REVISION_CONFLICT"
  | "MEMORY_STORAGE_UNAVAILABLE";

export class MemoryLedgerError extends Error {
  constructor(readonly code: MemoryLedgerErrorCode, message: string, readonly originalError?: unknown) {
    super(message);
    this.name = "MemoryLedgerError";
  }
}

export interface MemoryLedgerOptions {
  memoryDirectoryPath?: string;
  now?: () => string;
  idFactory?: () => string;
}

export interface CommitAutomaticTurnResult {
  memories: MemoryRecord[];
  duplicate: boolean;
  outboxSequences: number[];
}

interface MemoryRow {
  id: string;
  pet_id: string;
  chapter: MemoryChapter;
  memory_type: MemoryRecord["memoryType"];
  content: string;
  tags_json: string;
  important: number;
  origin: MemoryRecord["origin"];
  source_time: string | null;
  source_available: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  revision: number;
}

interface OutboxRow {
  sequence: number;
  operation: MemoryOutboxOperation;
  memory_id: string | null;
  payload_json: string;
  created_at: string;
  processed_at: string | null;
}

function sqliteError(error: unknown, fallback: MemoryLedgerErrorCode): MemoryLedgerError {
  if (error instanceof MemoryLedgerError) return error;
  const message = error instanceof Error ? error.message : "";
  const storageUnavailable = /(?:database or disk is full|readonly|read-only|unable to open|disk i\/o|database is locked|database is busy|access|permission)/i.test(message);
  return new MemoryLedgerError(
    storageUnavailable ? "MEMORY_STORAGE_UNAVAILABLE" : fallback,
    storageUnavailable
      ? "The memory ledger storage is temporarily unavailable."
      : "The memory ledger could not be read safely.",
    error
  );
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) throw new Error();
    return parsed;
  } catch {
    throw new MemoryLedgerError("LEDGER_CORRUPTED", "The memory ledger contains invalid tags.");
  }
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  const record: MemoryRecord = {
    id: row.id,
    petId: row.pet_id,
    chapter: row.chapter,
    memoryType: row.memory_type,
    content: row.content,
    tags: parseTags(row.tags_json),
    important: row.important === 1,
    origin: row.origin,
    sourceTime: row.source_time ?? undefined,
    sourceAvailable: row.source_available === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    revision: row.revision
  };
  assertMemoryRecord(record);
  return record;
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") throw new Error();
    const record = value as Record<string, unknown>;
    return {
      updatedAt: assertBoundedMemoryString(record.updatedAt, "cursor.updatedAt", 64),
      id: assertBoundedMemoryString(record.id, "cursor.id", MEMORY_LIMITS.idChars)
    };
  } catch (error) {
    if (error instanceof MemoryValidationError) throw error;
    throw new MemoryValidationError("Invalid memory cursor.");
  }
}

function memorySearchTerms(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .slice(0, 32);
}

function ftsQuery(terms: readonly string[]): string {
  return terms
    .map((term) => `"${term}"`)
    .join(" AND ");
}

async function syncFileAndParent(filePath: string): Promise<void> {
  const file = await fs.open(filePath, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  let directory: fs.FileHandle | undefined;
  try {
    directory = await fs.open(path.dirname(filePath), "r");
    await directory.sync();
  } catch (error) {
    if (!["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function replaceFileAtomically(sourcePath: string, targetPath: string): Promise<void> {
  const delays = [0, 10, 25, 50];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
  }
  throw lastError;
}

export class MemoryLedger {
  readonly petId: string;
  readonly paths: MemoryPaths;
  private readonly database: DatabaseSync;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private closed = false;

  private constructor(petId: string, paths: MemoryPaths, database: DatabaseSync, options: MemoryLedgerOptions) {
    this.petId = petId;
    this.paths = paths;
    this.database = database;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  static async open(petId: string, options: MemoryLedgerOptions = {}): Promise<MemoryLedger> {
    const validPetId = assertValidPetId(petId);
    const paths = options.memoryDirectoryPath
      ? await ensureMemoryPathsAtDirectory(options.memoryDirectoryPath)
      : await ensureSafeMemoryPaths(validPetId);
    const existed = await fs.access(paths.ledger).then(() => true, () => false);
    let database: DatabaseSync | undefined;

    try {
      database = new DatabaseSync(paths.ledger, { timeout: 5_000 });
      await fs.chmod(paths.ledger, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EPERM") throw error;
      });
      database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
      database.exec("PRAGMA secure_delete = ON;");
      const quickCheck = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (quickCheck.quick_check !== "ok") {
        throw new MemoryLedgerError("LEDGER_CORRUPTED", "The memory ledger failed its integrity check.");
      }
      const ledger = new MemoryLedger(validPetId, paths, database, options);
      await ledger.migrate(existed);
      database.prepare("PRAGMA journal_mode = WAL").get();
      return ledger;
    } catch (error) {
      database?.close();
      throw sqliteError(error, "LEDGER_CORRUPTED");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryLedgerError("MEMORY_STORAGE_UNAVAILABLE", "Memory ledger is closed.");
  }

  private tableExists(name: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
        .get(name)
    );
  }

  private async migrate(existed: boolean): Promise<void> {
    let version = 0;
    if (this.tableExists("memory_meta")) {
      const row = this.database.prepare("SELECT value FROM memory_meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      version = row ? Number.parseInt(row.value, 10) : 0;
      if (!Number.isInteger(version) || version < 0) {
        throw new MemoryLedgerError("LEDGER_CORRUPTED", "The memory ledger schema version is invalid.");
      }
    }
    if (version > MEMORY_LEDGER_SCHEMA_VERSION) {
      throw new MemoryLedgerError(
        "LEDGER_VERSION_UNSUPPORTED",
        "The memory ledger was created by a newer application version."
      );
    }
    if (version === MEMORY_LEDGER_SCHEMA_VERSION) {
      this.assertPetBinding();
      return;
    }
    if (existed) {
      await this.createBackup();
    }

    try {
      this.database.exec("BEGIN IMMEDIATE");
      if (version === 0) this.migrateToVersion1();
      this.database.exec("COMMIT");
      this.assertPetBinding();
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw sqliteError(error, "LEDGER_CORRUPTED");
    }
  }

  private migrateToVersion1(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        pet_id TEXT NOT NULL,
        chapter TEXT NOT NULL CHECK (chapter IN ('about_you','preferences_habits','important_events','relationships_goals')),
        memory_type TEXT NOT NULL CHECK (memory_type IN ('profile','behavior','event','knowledge')),
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        important INTEGER NOT NULL CHECK (important IN (0,1)),
        origin TEXT NOT NULL CHECK (origin IN ('automatic','manual','imported')),
        source_time TEXT,
        source_available INTEGER NOT NULL CHECK (source_available IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;
      CREATE INDEX memories_active_order ON memories(deleted_at, updated_at DESC, id ASC);
      CREATE INDEX memories_chapter_order ON memories(chapter, deleted_at, updated_at DESC, id ASC);
      CREATE TABLE source_turns (
        request_id TEXT PRIMARY KEY,
        pet_id TEXT NOT NULL,
        user_text TEXT NOT NULL,
        assistant_reply TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE idempotency (
        request_id TEXT PRIMARY KEY,
        pet_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        memory_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE index_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL CHECK (operation IN ('upsert','forget','clear')),
        memory_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_at TEXT
      ) STRICT;
      CREATE INDEX index_outbox_pending ON index_outbox(processed_at, sequence);
      CREATE TABLE index_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, tags);
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id, content, tags) VALUES (new.id, new.content, new.tags_json);
      END;
      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE id = old.id;
      END;
      CREATE TRIGGER memories_fts_update AFTER UPDATE OF content, tags_json ON memories BEGIN
        DELETE FROM memories_fts WHERE id = old.id;
        INSERT INTO memories_fts(id, content, tags) VALUES (new.id, new.content, new.tags_json);
      END;
      INSERT INTO memory_meta(key, value) VALUES ('schema_version', '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      INSERT INTO index_metadata(key, value) VALUES ('dirty', '0') ON CONFLICT(key) DO NOTHING;
      INSERT INTO index_metadata(key, value) VALUES ('last_applied_sequence', '0') ON CONFLICT(key) DO NOTHING;
    `);
    this.database
      .prepare("INSERT INTO memory_meta(key, value) VALUES ('pet_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(this.petId);
  }

  private assertPetBinding(): void {
    const row = this.database.prepare("SELECT value FROM memory_meta WHERE key = 'pet_id'").get() as
      | { value: string }
      | undefined;
    if (row?.value !== this.petId) {
      throw new MemoryLedgerError("LEDGER_CORRUPTED", "The memory ledger belongs to another pet.");
    }
  }

  private async createBackup(): Promise<void> {
    const temporaryPath = path.join(
      this.paths.directory,
      `.ledger-backup-${process.pid}-${crypto.randomUUID()}.tmp`
    );
    let verificationDatabase: DatabaseSync | undefined;
    try {
      await assertSafeExistingMemoryEntry(this.paths.directory, this.paths.ledgerBackup);
      await backup(this.database, temporaryPath);
      verificationDatabase = new DatabaseSync(temporaryPath, { readOnly: true });
      const check = verificationDatabase.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (check.quick_check !== "ok") {
        throw new MemoryLedgerError("LEDGER_CORRUPTED", "The new memory backup failed verification.");
      }
      verificationDatabase.close();
      verificationDatabase = undefined;
      await syncFileAndParent(temporaryPath);
      await replaceFileAtomically(temporaryPath, this.paths.ledgerBackup);
      await syncFileAndParent(this.paths.ledgerBackup);
    } finally {
      verificationDatabase?.close();
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async backupBeforeMutation(): Promise<void> {
    this.assertOpen();
    try {
      await this.createBackup();
    } catch (error) {
      throw sqliteError(error, "MEMORY_STORAGE_UNAVAILABLE");
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      if (error instanceof MemoryValidationError) throw error;
      throw sqliteError(error, "MEMORY_STORAGE_UNAVAILABLE");
    }
  }

  private insertOutbox(operation: MemoryOutboxOperation, memoryId: string | undefined, payload: unknown): number {
    assertMemoryObjectBudget(payload);
    const result = this.database
      .prepare(
        "INSERT INTO index_outbox(operation, memory_id, payload_json, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(operation, memoryId ?? null, JSON.stringify(payload), this.now());
    return Number(result.lastInsertRowid);
  }

  private getRequired(memoryId: string): MemoryRecord {
    const row = this.database.prepare("SELECT * FROM memories WHERE id = ? AND pet_id = ?").get(
      memoryId,
      this.petId
    ) as MemoryRow | undefined;
    if (!row) throw new MemoryLedgerError("MEMORY_NOT_FOUND", "Memory record was not found.");
    return rowToRecord(row);
  }

  get(memoryId: string, includeDeleted = false): MemoryRecord | undefined {
    this.assertOpen();
    assertBoundedMemoryString(memoryId, "memoryId", MEMORY_LIMITS.idChars);
    const row = this.database
      .prepare(`SELECT * FROM memories WHERE id = ? AND pet_id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`)
      .get(memoryId, this.petId) as MemoryRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getSourceConversation(memoryId: string): MemorySourceConversation | undefined {
    this.assertOpen();
    assertBoundedMemoryString(memoryId, "memoryId", MEMORY_LIMITS.idChars);
    const memory = this.get(memoryId);
    if (!memory?.sourceAvailable) return undefined;
    let row: MemorySourceConversation | undefined;
    try {
      row = this.database.prepare(`
        SELECT
          source_turns.user_text userText,
          source_turns.assistant_reply assistantReply,
          source_turns.occurred_at occurredAt,
          source_turns.created_at organizedAt
        FROM idempotency
        JOIN source_turns
          ON source_turns.request_id = idempotency.request_id
         AND source_turns.pet_id = idempotency.pet_id
        JOIN json_each(idempotency.memory_ids_json) memory_ids
          ON memory_ids.value = ?
        WHERE idempotency.pet_id = ?
        LIMIT 1
      `).get(memoryId, this.petId) as MemorySourceConversation | undefined;
    } catch (error) {
      throw sqliteError(error, "LEDGER_CORRUPTED");
    }
    if (!row) return undefined;
    try {
      assertMemoryObjectBudget(row);
    } catch (error) {
      throw new MemoryLedgerError("LEDGER_CORRUPTED", "Stored memory source exceeds its public data boundary.", error);
    }
    return row;
  }

  async create(request: MemoryCreateRequest): Promise<MemoryMutationResult> {
    if (assertValidPetId(request.petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    const now = this.now();
    const record: MemoryRecord = {
      id: this.idFactory(),
      petId: this.petId,
      chapter: request.chapter,
      memoryType: request.memoryType,
      content: request.content,
      tags: [...(request.tags ?? [])],
      important: request.important ?? false,
      origin: request.origin ?? "manual",
      sourceTime: request.sourceTime,
      sourceAvailable: false,
      createdAt: now,
      updatedAt: now,
      revision: 1
    };
    assertMemoryRecord(record);
    return withPetConfigWriteLock(this.petId, async () => {
      await this.backupBeforeMutation();
      return this.transaction(() => {
        this.database
          .prepare(`INSERT INTO memories(
            id, pet_id, chapter, memory_type, content, tags_json, important, origin,
            source_time, source_available, created_at, updated_at, deleted_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            record.id, record.petId, record.chapter, record.memoryType, record.content,
            JSON.stringify(record.tags), Number(record.important), record.origin,
            record.sourceTime ?? null, Number(record.sourceAvailable), record.createdAt,
            record.updatedAt, null, record.revision
          );
        const outboxSequence = this.insertOutbox("upsert", record.id, record);
        return { memory: record, outboxSequence };
      });
    });
  }

  async commitAutomaticTurn(
    turn: MemoryConversationTurn,
    contentHash: string,
    entries: MemoryRecordInput[]
  ): Promise<CommitAutomaticTurnResult> {
    assertMemoryConversationTurn(turn);
    if (turn.petId !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new MemoryValidationError("Invalid memory content hash.");
    if (entries.length > MEMORY_LIMITS.backendItemsMax) throw new MemoryValidationError("Too many memory entries.");
    entries.forEach((entry) => {
      assertMemoryRecordInput(entry);
      if (entry.petId !== this.petId || entry.origin !== "automatic") {
        throw new MemoryValidationError("Automatic memory entry crossed its contract boundary.");
      }
    });
    assertMemoryObjectBudget({ turn, contentHash, entries });

    return withPetConfigWriteLock(this.petId, async () => {
      await this.backupBeforeMutation();
      return this.transaction(() => {
        const existing = this.database
          .prepare("SELECT content_hash, memory_ids_json FROM idempotency WHERE request_id = ? AND pet_id = ?")
          .get(turn.requestId, this.petId) as { content_hash: string; memory_ids_json: string } | undefined;
        if (existing) {
          if (existing.content_hash !== contentHash) {
            throw new MemoryLedgerError(
              "MEMORY_REVISION_CONFLICT",
              "The request ID was already committed with different content."
            );
          }
          let ids: string[];
          try {
            ids = JSON.parse(existing.memory_ids_json) as string[];
            if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error();
          } catch (error) {
            throw new MemoryLedgerError("LEDGER_CORRUPTED", "Idempotency data is corrupted.", error);
          }
          return { memories: ids.map((id) => this.getRequired(id)), duplicate: true, outboxSequences: [] };
        }

        const now = this.now();
        const memories = entries.map((entry) => {
          const memory: MemoryRecord = {
            id: entry.id,
            petId: entry.petId,
            chapter: entry.chapter,
            memoryType: entry.memoryType,
            content: entry.content,
            tags: [...(entry.tags ?? [])],
            important: entry.important ?? false,
            origin: "automatic",
            sourceTime: entry.sourceTime ?? turn.occurredAt,
            sourceAvailable: turn.retainSource,
            createdAt: entry.createdAt ?? now,
            updatedAt: entry.updatedAt ?? now,
            revision: entry.revision ?? 1
          };
          assertMemoryRecord(memory);
          this.database
            .prepare(`INSERT INTO memories(
              id, pet_id, chapter, memory_type, content, tags_json, important, origin,
              source_time, source_available, created_at, updated_at, deleted_at, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
            .run(
              memory.id, memory.petId, memory.chapter, memory.memoryType, memory.content,
              JSON.stringify(memory.tags), Number(memory.important), memory.origin,
              memory.sourceTime ?? null, Number(memory.sourceAvailable), memory.createdAt,
              memory.updatedAt, memory.revision
            );
          return memory;
        });
        if (turn.retainSource) {
          this.database
            .prepare(`INSERT INTO source_turns(
              request_id, pet_id, user_text, assistant_reply, occurred_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
              turn.requestId, this.petId, turn.userText, turn.assistantReply, turn.occurredAt, now
            );
        }
        const outboxSequences = memories.map((memory) =>
          this.insertOutbox("upsert", memory.id, memory)
        );
        this.database
          .prepare(`INSERT INTO idempotency(
            request_id, pet_id, content_hash, memory_ids_json, created_at
          ) VALUES (?, ?, ?, ?, ?)`)
          .run(
            turn.requestId,
            this.petId,
            contentHash,
            JSON.stringify(memories.map(({ id }) => id)),
            now
          );
        return { memories, duplicate: false, outboxSequences };
      });
    });
  }

  isAutomaticTurnCommitted(requestId: string, contentHash: string): boolean {
    this.assertOpen();
    assertBoundedMemoryString(requestId, "requestId", MEMORY_LIMITS.idChars);
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new MemoryValidationError("Invalid memory content hash.");
    const row = this.database
      .prepare("SELECT content_hash FROM idempotency WHERE request_id = ? AND pet_id = ?")
      .get(requestId, this.petId) as { content_hash: string } | undefined;
    if (!row) return false;
    if (row.content_hash !== contentHash) {
      throw new MemoryLedgerError(
        "MEMORY_REVISION_CONFLICT",
        "The request ID was already committed with different content."
      );
    }
    return true;
  }

  async update(request: MemoryUpdateRequest): Promise<MemoryMutationResult> {
    if (assertValidPetId(request.petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    assertBoundedMemoryString(request.memoryId, "memoryId", MEMORY_LIMITS.idChars);
    if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 1) {
      throw new MemoryValidationError("Invalid expected revision.");
    }
    return withPetConfigWriteLock(this.petId, async () => {
      await this.backupBeforeMutation();
      return this.transaction(() => {
        const current = this.getRequired(request.memoryId);
        if (current.deletedAt) throw new MemoryLedgerError("MEMORY_NOT_FOUND", "Memory record was forgotten.");
        if (current.revision !== request.expectedRevision) {
          throw new MemoryLedgerError("MEMORY_REVISION_CONFLICT", "Memory revision no longer matches.");
        }
        const next: MemoryRecord = {
          ...current,
          chapter: request.chapter ?? current.chapter,
          content: request.content ?? current.content,
          tags: request.tags ? [...request.tags] : current.tags,
          important: request.important ?? current.important,
          updatedAt: this.now(),
          revision: current.revision + 1
        };
        assertMemoryRecord(next);
        const result = this.database
          .prepare(`UPDATE memories SET chapter = ?, content = ?, tags_json = ?, important = ?,
            updated_at = ?, revision = ? WHERE id = ? AND pet_id = ? AND revision = ? AND deleted_at IS NULL`)
          .run(
            next.chapter, next.content, JSON.stringify(next.tags), Number(next.important),
            next.updatedAt, next.revision, next.id, this.petId, current.revision
          );
        if (result.changes !== 1) {
          throw new MemoryLedgerError("MEMORY_REVISION_CONFLICT", "Memory changed concurrently.");
        }
        const outboxSequence = this.insertOutbox("upsert", next.id, next);
        return { memory: next, outboxSequence };
      });
    });
  }

  async forget(petId: string, memoryId: string, expectedRevision: number): Promise<MemoryForgetResult> {
    if (assertValidPetId(petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    assertBoundedMemoryString(memoryId, "memoryId", MEMORY_LIMITS.idChars);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new MemoryValidationError("Invalid expected revision.");
    }
    return withPetConfigWriteLock(this.petId, async () => {
      await this.backupBeforeMutation();
      return this.transaction(() => {
        const current = this.getRequired(memoryId);
        if (current.revision !== expectedRevision) {
          throw new MemoryLedgerError("MEMORY_REVISION_CONFLICT", "Memory revision no longer matches.");
        }
        if (current.deletedAt) throw new MemoryLedgerError("MEMORY_NOT_FOUND", "Memory was already forgotten.");
        const deletedAt = this.now();
        const revision = current.revision + 1;
        this.database
          .prepare("UPDATE memories SET deleted_at = ?, updated_at = ?, revision = ? WHERE id = ? AND pet_id = ?")
          .run(deletedAt, deletedAt, revision, memoryId, this.petId);
        const outboxSequence = this.insertOutbox("forget", memoryId, { memoryId, revision });
        return { memoryId, revision, deletedAt, outboxSequence };
      });
    });
  }

  async undoForget(petId: string, memoryId: string, expectedRevision: number): Promise<MemoryMutationResult> {
    if (assertValidPetId(petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    assertBoundedMemoryString(memoryId, "memoryId", MEMORY_LIMITS.idChars);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new MemoryValidationError("Invalid expected revision.");
    }
    return withPetConfigWriteLock(this.petId, async () => {
      await this.backupBeforeMutation();
      return this.transaction(() => {
        const current = this.getRequired(memoryId);
        if (!current.deletedAt) throw new MemoryLedgerError("MEMORY_NOT_FOUND", "Memory is not forgotten.");
        if (current.revision !== expectedRevision) {
          throw new MemoryLedgerError("MEMORY_REVISION_CONFLICT", "Memory revision no longer matches.");
        }
        const now = this.now();
        this.database
          .prepare("UPDATE memories SET deleted_at = NULL, updated_at = ?, revision = ? WHERE id = ? AND pet_id = ?")
          .run(now, current.revision + 1, memoryId, this.petId);
        const memory = this.getRequired(memoryId);
        const outboxSequence = this.insertOutbox("upsert", memoryId, memory);
        return { memory, outboxSequence };
      });
    });
  }

  async clear(petId: string): Promise<MemoryClearResult> {
    if (assertValidPetId(petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    return withPetConfigWriteLock(this.petId, async () => {
      await this.backupBeforeMutation();
      return this.transaction(() => {
        const now = this.now();
        const result = this.database
          .prepare("UPDATE memories SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE pet_id = ? AND deleted_at IS NULL")
          .run(now, now, this.petId);
        const clearedCount = Number(result.changes);
        this.database.prepare("DELETE FROM source_turns WHERE pet_id = ?").run(this.petId);
        this.database.prepare("DELETE FROM idempotency WHERE pet_id = ?").run(this.petId);
        const outboxSequence = clearedCount > 0
          ? this.insertOutbox("clear", undefined, { petId: this.petId, clearedCount })
          : undefined;
        return { clearedCount, outboxSequence };
      });
    });
  }

  async purgeDeleted(
    petId: string,
    deletedBefore: string
  ): Promise<{ purgedCount: number; sourceTurnsPurged: number }> {
    if (assertValidPetId(petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    if (!Number.isFinite(Date.parse(deletedBefore))) {
      throw new MemoryValidationError("Invalid forgotten-memory cleanup cutoff.");
    }
    return withPetConfigWriteLock(this.petId, async () => {
      this.assertOpen();
      const candidates = this.database
        .prepare("SELECT id FROM memories WHERE pet_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY id")
        .all(this.petId, deletedBefore) as unknown as Array<{ id: string }>;
      if (!candidates.length) return { purgedCount: 0, sourceTurnsPurged: 0 };
      const candidateIds = new Set(candidates.map(({ id }) => id));
      const activeIds = new Set(
        (this.database
          .prepare("SELECT id FROM memories WHERE pet_id = ? AND deleted_at IS NULL")
          .all(this.petId) as unknown as Array<{ id: string }>).map(({ id }) => id)
      );
      const sourceRequestIds: string[] = [];
      const idempotencyRows = this.database
        .prepare("SELECT request_id, memory_ids_json FROM idempotency WHERE pet_id = ?")
        .all(this.petId) as unknown as Array<{ request_id: string; memory_ids_json: string }>;
      for (const row of idempotencyRows) {
        let memoryIds: string[];
        try {
          memoryIds = JSON.parse(row.memory_ids_json) as string[];
          if (!Array.isArray(memoryIds) || memoryIds.some((id) => typeof id !== "string")) throw new Error();
        } catch (error) {
          throw new MemoryLedgerError("LEDGER_CORRUPTED", "Idempotency data is corrupted.", error);
        }
        if (memoryIds.length > 0 && memoryIds.every((id) => candidateIds.has(id) || !activeIds.has(id))) {
          sourceRequestIds.push(row.request_id);
        }
      }

      await this.backupBeforeMutation();
      let authorityPurged = false;
      try {
        const result = this.transaction(() => {
          let sourceTurnsPurged = 0;
          for (const requestId of sourceRequestIds) {
            sourceTurnsPurged += Number(
              this.database
                .prepare("DELETE FROM source_turns WHERE request_id = ? AND pet_id = ?")
                .run(requestId, this.petId).changes
            );
          }
          const placeholders = candidates.map(() => "?").join(",");
          this.database
            .prepare(`DELETE FROM index_outbox WHERE processed_at IS NOT NULL AND (operation = 'clear' OR memory_id IN (${placeholders}))`)
            .run(...candidates.map(({ id }) => id));
          const purgedCount = Number(
            this.database
              .prepare(`DELETE FROM memories WHERE pet_id = ? AND id IN (${placeholders})`)
              .run(this.petId, ...candidates.map(({ id }) => id)).changes
          );
          return { purgedCount, sourceTurnsPurged };
        });
        authorityPurged = true;
        this.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        this.database.exec("VACUUM");
        await this.createBackup();
        return result;
      } catch (error) {
        // Once authority content has been physically removed, retaining a stale
        // pre-cleanup backup would violate the user's forget/clear request.
        if (authorityPurged) {
          await fs.rm(this.paths.ledgerBackup, { force: true }).catch(() => undefined);
        }
        throw sqliteError(error, "MEMORY_STORAGE_UNAVAILABLE");
      }
    });
  }

  list(request: Omit<MemorySearchRequest, "query"> & { query?: string }): MemoryPage<MemoryRecord> {
    return this.search({ ...request, query: request.query ?? "" });
  }

  search(request: MemorySearchRequest): MemoryPage<MemoryRecord> {
    this.assertOpen();
    assertMemorySearchRequest(request);
    if (request.petId !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    const { pageSize, cursor } = normalizeMemoryPageRequest(request);
    const parameters: Array<string | number> = [this.petId];
    const conditions = ["m.pet_id = ?", "m.deleted_at IS NULL"];
    const terms = memorySearchTerms(request.query);
    const search = ftsQuery(terms);
    const from = "memories m";
    if (terms.length) {
      const substringConditions = terms
        .map(() => "(instr(lower(m.content), lower(?)) > 0 OR instr(lower(m.tags_json), lower(?)) > 0)")
        .join(" AND ");
      conditions.push(
        `(m.id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?) OR (${substringConditions}))`
      );
      parameters.push(search);
      for (const term of terms) parameters.push(term, term);
    }
    if (request.chapters?.length) {
      conditions.push(`m.chapter IN (${request.chapters.map(() => "?").join(",")})`);
      parameters.push(...request.chapters);
    }
    if (request.importantOnly) conditions.push("m.important = 1");
    if (request.fromTime) {
      conditions.push("m.updated_at >= ?");
      parameters.push(request.fromTime);
    }
    if (request.toTime) {
      conditions.push("m.updated_at <= ?");
      parameters.push(request.toTime);
    }
    const sort = request.sort ?? "newest";
    if (cursor) {
      const decoded = decodeCursor(cursor);
      conditions.push(
        sort === "newest"
          ? "(m.updated_at < ? OR (m.updated_at = ? AND m.id > ?))"
          : "(m.updated_at > ? OR (m.updated_at = ? AND m.id > ?))"
      );
      parameters.push(decoded.updatedAt, decoded.updatedAt, decoded.id);
    }
    parameters.push(pageSize + 1);
    const rows = this.database
      .prepare(`SELECT m.* FROM ${from} WHERE ${conditions.join(" AND ")}
        ORDER BY m.updated_at ${sort === "newest" ? "DESC" : "ASC"}, m.id ASC LIMIT ?`)
      .all(...parameters) as unknown as MemoryRow[];
    const hasMore = rows.length > pageSize;
    const items = rows.slice(0, pageSize).map(rowToRecord);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.updatedAt, last.id) : undefined
    };
  }

  getSummary(): { total: number; important: number; byChapter: Record<MemoryChapter, number>; lastUpdatedAt?: string } {
    this.assertOpen();
    const rows = this.database
      .prepare(`SELECT chapter, count(*) count, sum(important) important, max(updated_at) last_updated
        FROM memories WHERE pet_id = ? AND deleted_at IS NULL GROUP BY chapter`)
      .all(this.petId) as unknown as Array<{ chapter: MemoryChapter; count: number; important: number; last_updated: string }>;
    const byChapter = Object.fromEntries(MEMORY_CHAPTERS.map((chapter) => [chapter, 0])) as Record<MemoryChapter, number>;
    let total = 0;
    let important = 0;
    let lastUpdatedAt: string | undefined;
    for (const row of rows) {
      assertMemoryChapter(row.chapter);
      byChapter[row.chapter] = Number(row.count);
      total += Number(row.count);
      important += Number(row.important ?? 0);
      if (!lastUpdatedAt || row.last_updated > lastUpdatedAt) lastUpdatedAt = row.last_updated;
    }
    return { total, important, byChapter, lastUpdatedAt };
  }

  snapshot(includeDeleted = false): MemoryRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare(`SELECT * FROM memories WHERE pet_id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"} ORDER BY updated_at ASC, id ASC`)
      .all(this.petId) as unknown as MemoryRow[];
    return rows.map(rowToRecord);
  }

  getLatestOutboxSequence(): number {
    this.assertOpen();
    return Number(
      (this.database.prepare("SELECT coalesce(max(sequence), 0) maximum FROM index_outbox").get() as { maximum: number }).maximum
    );
  }

  hasOutboxClear(afterSequence: number, throughSequence: number): boolean {
    this.assertOpen();
    if (
      !Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
      !Number.isSafeInteger(throughSequence) || throughSequence < 0
    ) {
      throw new MemoryValidationError("Invalid outbox range.");
    }
    return this.database
      .prepare("SELECT 1 FROM index_outbox WHERE sequence > ? AND sequence <= ? AND operation = 'clear' LIMIT 1")
      .get(afterSequence, throughSequence) !== undefined;
  }

  listOutbox(
    afterSequence = 0,
    limit = MEMORY_LIMITS.pageSizeDefault,
    throughSequence = Number.MAX_SAFE_INTEGER
  ): MemoryOutboxEntry[] {
    this.assertOpen();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new MemoryValidationError("Invalid outbox cursor.");
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) throw new MemoryValidationError("Invalid outbox upper bound.");
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_LIMITS.pageSizeMax) throw new MemoryValidationError("Invalid outbox limit.");
    const rows = this.database
      .prepare("SELECT * FROM index_outbox WHERE sequence > ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?")
      .all(afterSequence, throughSequence, limit) as unknown as OutboxRow[];
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      operation: row.operation,
      memoryId: row.memory_id ?? undefined,
      payload: (() => {
        try {
          return JSON.parse(row.payload_json) as unknown;
        } catch (error) {
          throw new MemoryLedgerError("LEDGER_CORRUPTED", "Memory outbox payload is corrupted.", error);
        }
      })(),
      createdAt: row.created_at,
      processedAt: row.processed_at ?? undefined
    }));
  }

  getIndexMetadata(): MemoryIndexMetadata {
    this.assertOpen();
    const rows = this.database.prepare("SELECT key, value FROM index_metadata").all() as unknown as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const dirty = values.get("dirty") ?? "0";
    const lastAppliedSequence = Number.parseInt(values.get("last_applied_sequence") ?? "0", 10);
    const modelFingerprint = values.get("model_fingerprint");
    if (
      !["0", "1"].includes(dirty) ||
      !Number.isSafeInteger(lastAppliedSequence) ||
      lastAppliedSequence < 0 ||
      (modelFingerprint !== undefined && (!modelFingerprint || modelFingerprint.length > 256))
    ) {
      throw new MemoryLedgerError("LEDGER_CORRUPTED", "Memory index metadata is corrupted.");
    }
    return { dirty: dirty === "1", lastAppliedSequence, modelFingerprint };
  }

  getPendingOutboxCount(): number {
    this.assertOpen();
    const row = this.database
      .prepare("SELECT count(*) count FROM index_outbox WHERE processed_at IS NULL")
      .get() as { count: number };
    return Number(row.count);
  }

  private shouldCompactOutbox(): boolean {
    const { freelist_count: freePages } = this.database.prepare("PRAGMA freelist_count").get() as { freelist_count: number };
    const { page_count: totalPages } = this.database.prepare("PRAGMA page_count").get() as { page_count: number };
    const { page_size: pageSize } = this.database.prepare("PRAGMA page_size").get() as { page_size: number };
    return freePages * pageSize >= OUTBOX_COMPACTION_MIN_FREE_BYTES && freePages * 4 >= totalPages;
  }

  async pruneProcessedOutbox(petId: string): Promise<{ prunedCount: number; compacted: boolean }> {
    if (assertValidPetId(petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    return withPetConfigWriteLock(this.petId, async () => {
      this.assertOpen();
      try {
        const { lastAppliedSequence } = this.getIndexMetadata();
        // Old versions retained acknowledged payloads. Never infer completion
        // from the cursor alone: pending rows must remain available for repair.
        const completed = this.database
          .prepare("SELECT 1 FROM index_outbox WHERE processed_at IS NOT NULL AND sequence <= ? LIMIT 1")
          .get(lastAppliedSequence);
        if (!completed && !this.shouldCompactOutbox()) return { prunedCount: 0, compacted: false };

        await this.backupBeforeMutation();
        const prunedCount = completed
          ? this.transaction(() => Number(this.database
            .prepare("DELETE FROM index_outbox WHERE processed_at IS NOT NULL AND sequence <= ?")
            .run(lastAppliedSequence).changes))
          : 0;
        // Small deletions reuse free pages. Reclaim disk space only after at
        // least 1 MiB and a quarter of the database have become unused.
        const compacted = this.shouldCompactOutbox();
        if (compacted) this.database.exec("VACUUM");
        this.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        // The authority did not change; keep a verified recovery copy without
        // the obsolete payloads or the old database's unused pages.
        await this.createBackup();
        return { prunedCount, compacted };
      } catch (error) {
        throw sqliteError(error, "MEMORY_STORAGE_UNAVAILABLE");
      }
    });
  }

  async markOutboxProcessed(petId: string, throughSequence: number): Promise<void> {
    if (assertValidPetId(petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new MemoryValidationError("Invalid outbox sequence.");
    }
    await withPetConfigWriteLock(this.petId, async () => {
      this.assertOpen();
      const metadata = this.getIndexMetadata();
      // Acknowledged rows are removed, but the saved cursor and SQLite's
      // AUTOINCREMENT high-water mark must survive cleanup and reopening.
      const maximum = Math.max(this.getLatestOutboxSequence(), metadata.lastAppliedSequence);
      if (throughSequence > maximum) throw new MemoryValidationError("Outbox sequence exceeds the ledger.");
      const entries = this.database
        .prepare("SELECT 1 FROM index_outbox WHERE sequence <= ? LIMIT 1")
        .get(throughSequence);
      if (throughSequence <= metadata.lastAppliedSequence && !entries) return;
      await this.backupBeforeMutation();
      this.transaction(() => {
        // The sidecar has confirmed this entire range. Drop its payloads in
        // the same transaction as the cursor, keeping later work untouched.
        this.database
          .prepare("DELETE FROM index_outbox WHERE sequence <= ?")
          .run(throughSequence);
        this.database
          .prepare(`INSERT INTO index_metadata(key, value) VALUES ('last_applied_sequence', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(String(Math.max(throughSequence, metadata.lastAppliedSequence)));
      });
    });
  }

  async setIndexState(
    petId: string,
    dirty: boolean,
    modelFingerprint?: string
  ): Promise<void> {
    if (assertValidPetId(petId) !== this.petId) throw new MemoryValidationError("Memory pet ID mismatch.");
    if (modelFingerprint !== undefined) {
      assertBoundedMemoryString(modelFingerprint, "modelFingerprint", 256);
    }
    await withPetConfigWriteLock(this.petId, async () => {
      const metadata = this.getIndexMetadata();
      if (
        metadata.dirty === dirty &&
        (modelFingerprint === undefined || metadata.modelFingerprint === modelFingerprint)
      ) return;
      await this.backupBeforeMutation();
      this.transaction(() => {
        this.database
          .prepare(`INSERT INTO index_metadata(key, value) VALUES ('dirty', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(dirty ? "1" : "0");
        if (modelFingerprint !== undefined) {
          this.database
            .prepare(`INSERT INTO index_metadata(key, value) VALUES ('model_fingerprint', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
            .run(modelFingerprint);
        }
      });
    });
  }

  backupSnapshot(includeSources: boolean): MemoryBackupData {
    this.assertOpen();
    if (this.getSummary().total > MEMORY_BACKUP_LIMITS.records) {
      throw new MemoryValidationError("记忆数量超过单次备份的 10000 条限制。");
    }
    const records = this.snapshot();
    const sources = new Map<string, MemoryBackupSource>();
    const linkedIds = new Set<string>();
    if (includeSources) {
      const rows = this.database.prepare(`
        SELECT s.request_id id, s.user_text userText, s.assistant_reply assistantReply,
          s.occurred_at occurredAt, s.created_at organizedAt, m.id memoryId
        FROM source_turns s JOIN idempotency i ON i.request_id = s.request_id AND i.pet_id = s.pet_id
        JOIN json_each(i.memory_ids_json) ids
        JOIN memories m ON m.id = ids.value AND m.pet_id = s.pet_id
        WHERE s.pet_id = ? AND m.deleted_at IS NULL AND m.source_available = 1
        ORDER BY s.request_id, m.id
      `).all(this.petId) as unknown as Array<Omit<MemoryBackupSource, "memoryIds"> & { memoryId: string }>;
      for (const { memoryId, ...source } of rows) {
        const entry = sources.get(source.id) ?? { ...source, memoryIds: [] };
        entry.memoryIds.push(memoryId);
        sources.set(source.id, entry);
        linkedIds.add(memoryId);
      }
    }
    const data = {
      petId: this.petId,
      records: records.map((record) => {
        const active = { ...record, sourceAvailable: linkedIds.has(record.id) };
        delete active.deletedAt;
        return active;
      }),
      sources: [...sources.values()]
    };
    assertMemoryBackupData(data);
    return data;
  }

  async restoreSnapshot(data: MemoryBackupData): Promise<{ importedCount: number; skippedCount: number }> {
    assertMemoryBackupData(data);
    const digest = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    return withPetConfigWriteLock(this.petId, async () => {
      this.assertOpen();
      const ids = new Map<string, string>();
      for (const record of data.records) {
        const id = data.petId === this.petId ? record.id : `backup-${digest([data.petId, record.id])}`;
        // Active local records win. Explicitly confirmed restoration can recover
        // forgotten/cleared records even before physical index cleanup completes.
        const existing = this.get(id, true);
        if (!existing || existing.deletedAt) ids.set(record.id, id);
      }
      const result = { importedCount: ids.size, skippedCount: data.records.length - ids.size };
      if (!ids.size) return result;
      await this.backupBeforeMutation();
      return this.transaction(() => {
        const insert = this.database.prepare(`INSERT INTO memories(
          id, pet_id, chapter, memory_type, content, tags_json, important, origin,
          source_time, source_available, created_at, updated_at, deleted_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT(id) DO UPDATE SET chapter = excluded.chapter, memory_type = excluded.memory_type,
            content = excluded.content, tags_json = excluded.tags_json, important = excluded.important,
            origin = excluded.origin, source_time = excluded.source_time, source_available = excluded.source_available,
            created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = NULL,
            revision = max(memories.revision + 1, excluded.revision)
          WHERE memories.deleted_at IS NOT NULL`);
        for (const record of data.records) {
          const id = ids.get(record.id);
          if (!id) continue;
          const existing = this.get(id, true);
          const memory: MemoryRecord = {
            ...record, id, petId: this.petId,
            revision: existing ? Math.max(existing.revision + 1, record.revision) : record.revision
          };
          insert.run(id, this.petId, memory.chapter, memory.memoryType, memory.content, JSON.stringify(memory.tags),
            Number(memory.important), memory.origin, memory.sourceTime ?? null, Number(memory.sourceAvailable),
            memory.createdAt, memory.updatedAt, memory.revision);
          this.insertOutbox("upsert", id, memory);
        }
        for (const source of data.sources) {
          const memoryIds = source.memoryIds.flatMap((id) => ids.has(id) ? [ids.get(id)!] : []);
          if (!memoryIds.length) continue;
          const contentHash = digest([source.userText, source.assistantReply, source.occurredAt, source.organizedAt]);
          const requestId = `backup-${digest([data.petId, source.id, contentHash])}`;
          const previous = this.database.prepare("SELECT content_hash, memory_ids_json FROM idempotency WHERE request_id = ?").get(requestId) as { content_hash: string; memory_ids_json: string } | undefined;
          let previousIds: unknown;
          try { previousIds = previous ? JSON.parse(previous.memory_ids_json) : []; }
          catch { throw new MemoryLedgerError("LEDGER_CORRUPTED", "Stored backup source association is corrupted."); }
          if (!Array.isArray(previousIds) || previousIds.some((id) => typeof id !== "string") || (previous && previous.content_hash !== contentHash)) {
            throw new MemoryLedgerError("LEDGER_CORRUPTED", "Stored backup source association is inconsistent.");
          }
          const combined = [...new Set([...previousIds as string[], ...memoryIds])];
          if (combined.length > MEMORY_LIMITS.backendItemsMax) throw new MemoryValidationError("单轮来源关联的记忆超过数量限制。");
          this.database.prepare(`INSERT INTO source_turns(request_id, pet_id, user_text, assistant_reply, occurred_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING`)
            .run(requestId, this.petId, source.userText, source.assistantReply, source.occurredAt, source.organizedAt);
          this.database.prepare(`INSERT INTO idempotency(request_id, pet_id, content_hash, memory_ids_json, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET memory_ids_json = excluded.memory_ids_json`)
            .run(requestId, this.petId, contentHash, JSON.stringify(combined), source.organizedAt);
        }
        this.database.prepare("INSERT INTO index_metadata(key, value) VALUES ('dirty', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
        return result;
      });
    });
  }

  getSourceTurns(): MemorySourceTurn[] {
    this.assertOpen();
    return this.database
      .prepare("SELECT request_id requestId, pet_id petId, user_text userText, assistant_reply assistantReply, occurred_at occurredAt, created_at createdAt FROM source_turns WHERE pet_id = ? ORDER BY occurred_at ASC")
      .all(this.petId) as unknown as MemorySourceTurn[];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } catch {}
    this.database.close();
  }

  static async restoreBackup(petId: string, memoryDirectoryPath?: string): Promise<void> {
    assertValidPetId(petId);
    const paths = memoryDirectoryPath
      ? await ensureMemoryPathsAtDirectory(memoryDirectoryPath)
      : await ensureSafeMemoryPaths(petId);
    let backupDatabase: DatabaseSync | undefined;
    const temporaryPath = path.join(paths.directory, `.ledger-restore-${crypto.randomUUID()}.tmp`);
    const corruptPath = path.join(paths.directory, `ledger.sqlite3.corrupt-${Date.now()}`);
    try {
      backupDatabase = new DatabaseSync(paths.ledgerBackup, { readOnly: true });
      const check = backupDatabase.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (check.quick_check !== "ok") throw new Error("Backup failed integrity check.");
      backupDatabase.close();
      backupDatabase = undefined;
      await fs.copyFile(paths.ledgerBackup, temporaryPath);
      const handle = await fs.open(temporaryPath, "r+");
      await handle.sync();
      await handle.close();
      await fs.rename(paths.ledger, corruptPath);
      try {
        await Promise.all([
          fs.rm(`${paths.ledger}-wal`, { force: true }),
          fs.rm(`${paths.ledger}-shm`, { force: true })
        ]);
        await fs.rename(temporaryPath, paths.ledger);
      } catch (error) {
        await fs.rename(corruptPath, paths.ledger);
        throw error;
      }
      await syncFileAndParent(paths.ledger);
    } catch (error) {
      throw sqliteError(error, "LEDGER_CORRUPTED");
    } finally {
      backupDatabase?.close();
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
