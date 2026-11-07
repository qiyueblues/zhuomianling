import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MEMORY_LIMITS, type MemoryRecord } from "../../../shared/types/memory";
import { assertMemoryRecord } from "../../../shared/validation/memory";
import { assertValidPetId } from "../../../shared/validation/petId";
import { MemoryBackendError, type MemoryBackend } from "./MemoryBackend";
import type { MemoryLedger } from "./MemoryLedger";

type IndexDirectoryResolver = (petId: string) => string | Promise<string>;

export interface MemoryIndexCoordinatorOptions {
  backend: MemoryBackend;
  indexDirectoryForPet: IndexDirectoryResolver;
  modelFingerprint: string;
  forgottenRetentionMs?: number;
  now?: () => number;
}

export interface MemoryIndexSyncResult {
  rebuilt: boolean;
  appliedCount: number;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MemoryBackendError("canceled", "Memory index operation was canceled.");
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class MemoryIndexCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: MemoryIndexCoordinatorOptions) {
    if (!options.modelFingerprint || options.modelFingerprint.length > 256) {
      throw new MemoryBackendError("internal", "Invalid memory model fingerprint.", false);
    }
  }

  private enqueue<T>(petId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(petId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(petId, current);
    void current.finally(() => {
      if (this.queues.get(petId) === current) this.queues.delete(petId);
    }).catch(() => undefined);
    return current;
  }

  private async indexRoot(petId: string): Promise<string> {
    assertValidPetId(petId);
    const configured = path.resolve(await this.options.indexDirectoryForPet(petId));
    if (path.basename(configured) !== "index") {
      throw new MemoryBackendError("internal", "Memory index resolver returned an unsafe directory.", false);
    }
    await fs.mkdir(configured, { recursive: true });
    const stat = await fs.lstat(configured);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new MemoryBackendError("unavailable", "Memory index root is unsafe.", false);
    }
    return fs.realpath(configured);
  }

  private child(root: string, name: "current" | "backup" | `staging-${string}`): string {
    if (!/^(?:current|backup|staging-[A-Za-z0-9_-]{1,96})$/.test(name)) {
      throw new MemoryBackendError("internal", "Invalid memory index child.", false);
    }
    const child = path.join(root, name);
    if (path.dirname(child) !== root) {
      throw new MemoryBackendError("internal", "Memory index child escaped its root.", false);
    }
    return child;
  }

  private async removeChild(root: string, child: string): Promise<void> {
    if (path.dirname(child) !== root) {
      throw new MemoryBackendError("internal", "Refusing to remove an uncontained index path.", false);
    }
    if (!await exists(child)) return;
    await this.assertSafeTree(root, child);
    await fs.rm(child, { recursive: true, force: false });
  }

  private async assertSafeTree(root: string, entry: string): Promise<void> {
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink()) {
      throw new MemoryBackendError("unavailable", "Memory index contains a symbolic link or junction.", false);
    }
    const realEntry = await fs.realpath(entry);
    const relative = path.relative(root, realEntry);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new MemoryBackendError("unavailable", "Memory index entry escaped its root.", false);
    }
    if (!stat.isDirectory()) return;
    for (const name of await fs.readdir(entry)) {
      await this.assertSafeTree(root, path.join(entry, name));
    }
  }

  private async recoverInterruptedSwap(root: string): Promise<void> {
    const current = this.child(root, "current");
    const backup = this.child(root, "backup");
    for (const name of await fs.readdir(root)) {
      if (!name.startsWith("staging-")) continue;
      if (!/^staging-[A-Za-z0-9_-]{1,96}$/.test(name)) {
        throw new MemoryBackendError("unavailable", "Memory index contains an unsafe staging entry.", false);
      }
      await this.removeChild(root, this.child(root, name as `staging-${string}`));
    }
    if (!await exists(current) && await exists(backup)) {
      await this.assertSafeTree(root, backup);
      await fs.rename(backup, current);
    }
  }

  private async removeObsoleteBackup(root: string): Promise<void> {
    const backup = this.child(root, "backup");
    await this.removeChild(root, backup);
  }

  private async cleanupSynchronizedLedger(ledger: MemoryLedger): Promise<void> {
    const retention = this.options.forgottenRetentionMs ?? 7_000;
    const cutoff = new Date((this.options.now?.() ?? Date.now()) - retention).toISOString();
    await ledger.purgeDeleted(ledger.petId, cutoff).catch(() => undefined);
    // Maintenance can retry on the next sync without invalidating an already
    // confirmed index or rolling back committed authority records.
    await ledger.pruneProcessedOutbox(ledger.petId).catch(() => undefined);
  }

  async synchronize(ledger: MemoryLedger, signal: AbortSignal): Promise<MemoryIndexSyncResult> {
    const petId = ledger.petId;
    return this.enqueue(petId, () => this.synchronizePet(ledger, signal));
  }

  private async synchronizePet(ledger: MemoryLedger, signal: AbortSignal): Promise<MemoryIndexSyncResult> {
    throwIfAborted(signal);
    const metadata = ledger.getIndexMetadata();
    const root = await this.indexRoot(ledger.petId);
    await this.recoverInterruptedSwap(root);
    const current = this.child(root, "current");
    if (
      metadata.dirty ||
      metadata.modelFingerprint !== this.options.modelFingerprint ||
      !await exists(current)
    ) {
      const appliedCount = await this.rebuildPet(ledger, signal, root);
      return { rebuilt: true, appliedCount };
    }

    // Capture a finite range before any sidecar work. Later writes remain pending
    // for the next synchronization, and a clear anywhere in this range wins.
    const throughSequence = ledger.getLatestOutboxSequence();
    if (throughSequence <= metadata.lastAppliedSequence) {
      await this.removeObsoleteBackup(root);
      await this.cleanupSynchronizedLedger(ledger);
      return { rebuilt: false, appliedCount: 0 };
    }
    if (ledger.hasOutboxClear(metadata.lastAppliedSequence, throughSequence)) {
      const appliedCount = await this.rebuildPet(ledger, signal, root, true);
      return { rebuilt: true, appliedCount };
    }

    let appliedCount = 0;
    let cursor = metadata.lastAppliedSequence;
    try {
      while (cursor < throughSequence) {
        throwIfAborted(signal);
        const entries = ledger.listOutbox(cursor, MEMORY_LIMITS.pageSizeDefault, throughSequence);
        if (!entries.length) break;
        for (const entry of entries) {
          throwIfAborted(signal);
          if (entry.operation === "upsert") {
            assertMemoryRecord(entry.payload as MemoryRecord);
            const memory = entry.payload as MemoryRecord;
            if (memory.petId !== ledger.petId || memory.deletedAt) {
              throw new MemoryBackendError("index-dirty", "Memory outbox upsert is inconsistent.", false);
            }
            await this.options.backend.upsert({ petId: ledger.petId, memory }, signal);
          } else if (entry.operation === "forget" && entry.memoryId) {
            await this.options.backend.forget({ petId: ledger.petId, memoryId: entry.memoryId }, signal);
          } else {
            throw new MemoryBackendError("index-dirty", "Memory outbox operation is invalid.", false);
          }
        }
        throwIfAborted(signal);
        // Only a completely applied page can advance the durable cursor. A failed
        // page is replayable; real mutations still take a verified ledger backup.
        cursor = entries[entries.length - 1].sequence;
        await ledger.markOutboxProcessed(ledger.petId, cursor);
        appliedCount += entries.length;
      }
      await this.removeObsoleteBackup(root);
      await this.cleanupSynchronizedLedger(ledger);
      return { rebuilt: false, appliedCount };
    } catch (error) {
      await ledger.setIndexState(ledger.petId, true, this.options.modelFingerprint).catch(() => undefined);
      throw error;
    }
  }

  async rebuild(ledger: MemoryLedger, signal: AbortSignal): Promise<MemoryIndexSyncResult> {
    return this.enqueue(ledger.petId, async () => {
      const root = await this.indexRoot(ledger.petId);
      await this.recoverInterruptedSwap(root);
      const appliedCount = await this.rebuildPet(ledger, signal, root);
      return { rebuilt: true, appliedCount };
    });
  }

  private async rebuildPet(
    ledger: MemoryLedger,
    signal: AbortSignal,
    root: string,
    purgeAllDeleted = false
  ): Promise<number> {
    const petId = ledger.petId;
    throwIfAborted(signal);
    const targetId = `staging-${randomUUID()}` as const;
    const staging = this.child(root, targetId);
    const current = this.child(root, "current");
    const backup = this.child(root, "backup");
    await ledger.setIndexState(petId, true, this.options.modelFingerprint);

    // These synchronous ledger reads run in one JavaScript turn, so the sequence
    // cursor describes exactly the authority snapshot sent to the sidecar.
    const records = ledger.snapshot(false);
    const throughSequence = ledger.getLatestOutboxSequence();
    await this.removeChild(root, staging);
    await fs.mkdir(staging);

    let movedCurrent = false;
    let swappedCurrent = false;
    try {
      const response = await this.options.backend.rebuild({ petId, records, targetId }, signal);
      if (response.indexedCount !== records.length) {
        throw new MemoryBackendError("index-dirty", "Memory rebuild count is inconsistent.");
      }
      throwIfAborted(signal);
      await this.assertSafeTree(root, staging);

      // Windows cannot rename an open SQLite database. closePet is deliberately
      // called with a cleanup signal after the rebuild has completed.
      await this.options.backend.closePet(petId, new AbortController().signal);
      // A previous validated swap may have left a recovery copy. The current
      // directory is authoritative now, so make room for this operation's backup.
      await this.removeChild(root, backup);
      if (await exists(current)) {
        await this.assertSafeTree(root, current);
        await fs.rename(current, backup);
        movedCurrent = true;
      }
      try {
        await fs.rename(staging, current);
        swappedCurrent = true;
      } catch (error) {
        if (movedCurrent && !await exists(current) && await exists(backup)) {
          await fs.rename(backup, current).catch(() => undefined);
        }
        throw error;
      }
      if (throughSequence > 0) await ledger.markOutboxProcessed(petId, throughSequence);
      await ledger.setIndexState(petId, false, this.options.modelFingerprint);
      await this.removeObsoleteBackup(root);
      if (purgeAllDeleted) {
        await ledger.purgeDeleted(petId, "9999-12-31T23:59:59.999Z");
        await ledger.pruneProcessedOutbox(petId).catch(() => undefined);
      } else {
        await this.cleanupSynchronizedLedger(ledger);
      }
      return records.length;
    } catch (error) {
      await this.options.backend.closePet(petId, new AbortController().signal).catch(() => undefined);
      if (swappedCurrent) {
        await this.removeChild(root, current).catch(() => undefined);
        if (movedCurrent && await exists(backup)) {
          await fs.rename(backup, current).catch(() => undefined);
        }
      }
      await this.removeChild(root, staging).catch(() => undefined);
      await ledger.setIndexState(petId, true, this.options.modelFingerprint).catch(() => undefined);
      throw error;
    }
  }
}
