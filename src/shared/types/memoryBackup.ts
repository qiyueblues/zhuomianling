import type { MemoryRecord } from "./memory";

export const MEMORY_BACKUP_KIND = "zhuomianling-memory";
export const MEMORY_BACKUP_VERSION = 1;
export const MEMORY_BACKUP_LIMITS = Object.freeze({ records: 10_000, bytes: 64 * 1024 * 1024, manifestBytes: 16 * 1024 });

export interface MemoryBackupSource {
  id: string;
  memoryIds: string[];
  userText: string;
  assistantReply: string;
  occurredAt: string;
  organizedAt: string;
}

// File data stays in the main process; IPC only exposes the inspection below.
export interface MemoryBackupData {
  petId: string;
  records: MemoryRecord[];
  sources: MemoryBackupSource[];
}

export interface MemoryBackupManifest {
  kind: typeof MEMORY_BACKUP_KIND;
  formatVersion: typeof MEMORY_BACKUP_VERSION;
  exportedAt: string;
  petName: string;
  recordCount: number;
  sourceCount: number;
  dataBytes: number;
  dataSha256: string;
}

export interface MemoryBackupInspection {
  token: string;
  fileName: string;
  petName: string;
  exportedAt: string;
  recordCount: number;
  sourceCount: number;
}

export interface MemoryBackupConfirmRequest {
  petId: string;
  token: string;
}

export interface MemoryBackupRestoreResult {
  importedCount: number;
  skippedCount: number;
  indexState: "synced" | "pending";
}
