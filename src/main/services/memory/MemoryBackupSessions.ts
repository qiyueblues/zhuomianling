import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MemoryBackupData, MemoryBackupInspection, MemoryBackupManifest } from "../../../shared/types/memoryBackup";
import { MemoryValidationError } from "../../../shared/validation/memory";

interface Session {
  token: string;
  petId: string;
  data: MemoryBackupData;
  timer: ReturnType<typeof setTimeout>;
}

export class MemoryBackupSessions {
  private readonly sessions = new Map<number, Session>();

  prepare(owner: number, petId: string, filePath: string, backup: { data: MemoryBackupData; manifest: MemoryBackupManifest }): MemoryBackupInspection {
    this.discardOwner(owner);
    const token = randomUUID();
    const timer = setTimeout(() => this.discardOwner(owner), 10 * 60_000);
    timer.unref();
    this.sessions.set(owner, { token, petId, data: backup.data, timer });
    return {
      token, fileName: path.basename(filePath), petName: backup.manifest.petName,
      exportedAt: backup.manifest.exportedAt, recordCount: backup.data.records.length, sourceCount: backup.data.sources.length
    };
  }

  take(owner: number, petId: string, token: string): MemoryBackupData {
    const session = this.sessions.get(owner);
    if (!session || session.petId !== petId || session.token !== token) {
      throw new MemoryValidationError("记忆恢复确认已失效，请重新选择文件。");
    }
    this.discardOwner(owner);
    return session.data;
  }

  discardOwner(owner: number): void {
    const session = this.sessions.get(owner);
    if (session) clearTimeout(session.timer);
    this.sessions.delete(owner);
  }
}
