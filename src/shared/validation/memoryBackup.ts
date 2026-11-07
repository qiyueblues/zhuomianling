import { MEMORY_LIMITS, type MemoryRecord } from "../types/memory";
import { MEMORY_BACKUP_LIMITS, type MemoryBackupData, type MemoryBackupConfirmRequest } from "../types/memoryBackup";
import { assertBoundedMemoryString, assertMemoryObjectBudget, assertMemoryRecord, MemoryValidationError } from "./memory";
import { assertValidPetId } from "./petId";

function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new MemoryValidationError("记忆备份的数据结构不正确。");
  }
}

function time(value: unknown): void {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new MemoryValidationError("记忆备份中的时间不正确。");
  }
}

export function assertMemoryBackupData(value: unknown): asserts value is MemoryBackupData {
  object(value, ["petId", "records", "sources"]);
  assertValidPetId(value.petId);
  if (!Array.isArray(value.records) || value.records.length > MEMORY_BACKUP_LIMITS.records ||
      !Array.isArray(value.sources) || value.sources.length > MEMORY_BACKUP_LIMITS.records) {
    throw new MemoryValidationError("记忆备份超过单次恢复的数量限制。");
  }
  const records = new Map<string, MemoryRecord>();
  for (const record of value.records) {
    object(record, ["id", "petId", "chapter", "memoryType", "content", "tags", "important", "origin", "sourceTime", "sourceAvailable", "createdAt", "updatedAt", "revision"]);
    assertMemoryRecord(record as unknown as MemoryRecord);
    assertMemoryObjectBudget(record);
    const memory = record as unknown as MemoryRecord;
    if (memory.petId !== value.petId || records.has(memory.id) || memory.revision < 1) {
      throw new MemoryValidationError("记忆备份中存在重复或不一致的记录。");
    }
    records.set(memory.id, memory);
  }
  const sourceIds = new Set<string>();
  const linkedIds = new Set<string>();
  for (const source of value.sources) {
    object(source, ["id", "memoryIds", "userText", "assistantReply", "occurredAt", "organizedAt"]);
    const id = assertBoundedMemoryString(source.id, "source.id", MEMORY_LIMITS.idChars);
    assertBoundedMemoryString(source.userText, "source.userText", MEMORY_LIMITS.contentChars);
    assertBoundedMemoryString(source.assistantReply, "source.assistantReply", MEMORY_LIMITS.contentChars);
    time(source.occurredAt);
    time(source.organizedAt);
    if (sourceIds.has(id) || !Array.isArray(source.memoryIds) || !source.memoryIds.length || source.memoryIds.length > MEMORY_LIMITS.backendItemsMax) {
      throw new MemoryValidationError("记忆来源关联不正确。");
    }
    sourceIds.add(id);
    for (const memoryId of source.memoryIds) {
      if (typeof memoryId !== "string" || !records.get(memoryId)?.sourceAvailable || linkedIds.has(memoryId)) {
        throw new MemoryValidationError("记忆来源关联不正确。");
      }
      linkedIds.add(memoryId);
    }
    assertMemoryObjectBudget(source);
  }
  for (const memory of records.values()) {
    if (memory.sourceAvailable !== linkedIds.has(memory.id)) throw new MemoryValidationError("记忆来源关联缺失。");
  }
}

export function assertMemoryBackupConfirmRequest(value: MemoryBackupConfirmRequest): void {
  object(value, ["petId", "token"]);
  assertValidPetId(value.petId);
  if (typeof value.token !== "string" || !/^[a-f0-9-]{36}$/.test(value.token)) {
    throw new MemoryValidationError("记忆恢复确认已失效，请重新选择文件。");
  }
}
