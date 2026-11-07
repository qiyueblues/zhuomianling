import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_AUTO_CAPTURE_CONSENT,
  MEMORY_CHAPTERS,
  MEMORY_LIMITS,
  MEMORY_SOURCE_EXPORT_CONSENT,
  MEMORY_SOURCE_RETENTION_CONSENT,
  type MemoryChapter,
  type MemoryClearRequest,
  type MemoryConversationTurn,
  type MemoryCreateRequest,
  type MemoryExportRequest,
  type MemoryGetRequest,
  type MemoryListRequest,
  type MemoryRecord,
  type MemoryRecordInput,
  type MemoryMemorizeResponse,
  type MemoryPageRequest,
  type MemoryRetrieveResponse,
  type MemorySearchRequest,
  type MemoryRetrieveRequest,
  type MemoryRevisionRequest,
  type MemorySettingsSaveRequest,
  type MemorySettings,
  type MemorySourceConversationRequest,
  type MemoryUpdateRequest
} from "../types/memory";
import { assertValidPetId } from "./petId";

export class MemoryValidationError extends Error {
  readonly code = "invalid-request" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new MemoryValidationError(`${field} must be a boolean.`);
  }
}

function assertBoundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new MemoryValidationError(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

export function assertBoundedMemoryString(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false
): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new MemoryValidationError(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

export function normalizeMemorySettings(value: unknown): MemorySettings {
  if (value === undefined) {
    return { ...DEFAULT_MEMORY_SETTINGS };
  }
  if (!isRecord(value)) {
    throw new MemoryValidationError("memorySettings must be an object.");
  }

  const settings: MemorySettings = {
    onboardingCompleted: value.onboardingCompleted ?? true,
    recallEnabled: value.recallEnabled ?? DEFAULT_MEMORY_SETTINGS.recallEnabled,
    autoCaptureEnabled: value.autoCaptureEnabled ?? DEFAULT_MEMORY_SETTINGS.autoCaptureEnabled,
    recallLimit: value.recallLimit ?? DEFAULT_MEMORY_SETTINGS.recallLimit,
    contextBudgetChars: value.contextBudgetChars ?? DEFAULT_MEMORY_SETTINGS.contextBudgetChars,
    retainSources: value.retainSources ?? DEFAULT_MEMORY_SETTINGS.retainSources
  } as MemorySettings;

  assertBoolean(settings.onboardingCompleted, "memorySettings.onboardingCompleted");
  assertBoolean(settings.recallEnabled, "memorySettings.recallEnabled");
  assertBoolean(settings.autoCaptureEnabled, "memorySettings.autoCaptureEnabled");
  assertBoolean(settings.retainSources, "memorySettings.retainSources");
  settings.recallLimit = assertBoundedInteger(
    settings.recallLimit,
    "memorySettings.recallLimit",
    MEMORY_LIMITS.recallLimitMin,
    MEMORY_LIMITS.recallLimitMax
  );
  settings.contextBudgetChars = assertBoundedInteger(
    settings.contextBudgetChars,
    "memorySettings.contextBudgetChars",
    MEMORY_LIMITS.contextBudgetCharsMin,
    MEMORY_LIMITS.contextBudgetCharsMax
  );

  if (value.providerProfileId !== undefined) {
    settings.providerProfileId = assertBoundedMemoryString(
      value.providerProfileId,
      "memorySettings.providerProfileId",
      MEMORY_LIMITS.providerProfileIdChars
    );
  }
  return settings;
}

export function assertMemoryChapter(value: unknown): asserts value is MemoryChapter {
  if (!MEMORY_CHAPTERS.includes(value as MemoryChapter)) {
    throw new MemoryValidationError("Invalid memory chapter.");
  }
}

function assertIsoTime(value: unknown, field: string): asserts value is string {
  const text = assertBoundedMemoryString(value, field, 64);
  if (!Number.isFinite(Date.parse(text))) {
    throw new MemoryValidationError(`${field} must be an ISO-compatible timestamp.`);
  }
}

export function assertMemoryRecordInput(value: MemoryRecordInput | MemoryRecord): void {
  if (!isRecord(value)) {
    throw new MemoryValidationError("memory must be an object.");
  }
  assertBoundedMemoryString(value.id, "memory.id", MEMORY_LIMITS.idChars);
  assertValidPetId(value.petId);
  assertMemoryChapter(value.chapter);
  if (!["profile", "behavior", "event", "knowledge"].includes(value.memoryType)) {
    throw new MemoryValidationError("Invalid memory type.");
  }
  assertBoundedMemoryString(value.content, "memory.content", MEMORY_LIMITS.contentChars);
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > MEMORY_LIMITS.tags) {
      throw new MemoryValidationError(`memory.tags may contain at most ${MEMORY_LIMITS.tags} items.`);
    }
    value.tags.forEach((tag, index) =>
      assertBoundedMemoryString(tag, `memory.tags[${index}]`, MEMORY_LIMITS.tagChars)
    );
  }
  if (!["automatic", "manual", "imported"].includes(value.origin)) {
    throw new MemoryValidationError("Invalid memory origin.");
  }
  if (value.important !== undefined) assertBoolean(value.important, "memory.important");
  if (value.sourceAvailable !== undefined) {
    assertBoolean(value.sourceAvailable, "memory.sourceAvailable");
  }
  for (const [field, time] of [
    ["sourceTime", value.sourceTime],
    ["createdAt", value.createdAt],
    ["updatedAt", value.updatedAt],
    ["deletedAt", value.deletedAt]
  ] as const) {
    if (time !== undefined) assertIsoTime(time, `memory.${field}`);
  }
  if (value.revision !== undefined) {
    assertBoundedInteger(value.revision, "memory.revision", 0, Number.MAX_SAFE_INTEGER);
  }
}

export function assertMemoryRecord(value: MemoryRecord): void {
  assertMemoryRecordInput(value);
  if (!Array.isArray(value.tags)) throw new MemoryValidationError("memory.tags is required.");
  assertBoolean(value.important, "memory.important");
  assertBoolean(value.sourceAvailable, "memory.sourceAvailable");
  assertIsoTime(value.createdAt, "memory.createdAt");
  assertIsoTime(value.updatedAt, "memory.updatedAt");
  assertBoundedInteger(value.revision, "memory.revision", 0, Number.MAX_SAFE_INTEGER);
}

export function assertMemoryRetrieveRequest(value: MemoryRetrieveRequest): void {
  assertValidPetId(value.petId);
  assertBoundedMemoryString(value.query, "query", MEMORY_LIMITS.queryChars);
  assertBoundedInteger(value.limit, "limit", MEMORY_LIMITS.recallLimitMin, MEMORY_LIMITS.recallLimitMax);
  assertBoundedInteger(
    value.contextBudgetChars,
    "contextBudgetChars",
    MEMORY_LIMITS.contextBudgetCharsMin,
    MEMORY_LIMITS.contextBudgetCharsMax
  );
}

export function normalizeMemoryPageRequest(value: MemoryPageRequest): Required<Pick<MemoryPageRequest, "pageSize">> & Pick<MemoryPageRequest, "cursor"> {
  const pageSize = value.pageSize ?? MEMORY_LIMITS.pageSizeDefault;
  assertBoundedInteger(pageSize, "pageSize", 1, MEMORY_LIMITS.pageSizeMax);
  if (value.cursor !== undefined) {
    assertBoundedMemoryString(value.cursor, "cursor", MEMORY_LIMITS.cursorChars);
  }
  return { pageSize, cursor: value.cursor };
}

export function assertMemorySearchRequest(value: MemorySearchRequest): void {
  assertValidPetId(value.petId);
  assertBoundedMemoryString(value.query, "query", MEMORY_LIMITS.queryChars, true);
  normalizeMemoryPageRequest(value);
  if (value.importantOnly !== undefined && typeof value.importantOnly !== "boolean") {
    throw new MemoryValidationError("importantOnly must be a boolean.");
  }
  if (value.sort !== undefined && value.sort !== "newest" && value.sort !== "oldest") {
    throw new MemoryValidationError("Invalid memory sort order.");
  }
  if (value.chapters !== undefined) {
    if (!Array.isArray(value.chapters) || value.chapters.length > MEMORY_CHAPTERS.length) {
      throw new MemoryValidationError("Invalid memory chapter filter.");
    }
    value.chapters.forEach(assertMemoryChapter);
  }
  if (value.fromTime !== undefined) assertIsoTime(value.fromTime, "fromTime");
  if (value.toTime !== undefined) assertIsoTime(value.toTime, "toTime");
}

export function assertMemoryListRequest(value: MemoryListRequest): void {
  assertMemorySearchRequest({ ...value, query: "" });
}

export function assertMemoryGetRequest(value: MemoryGetRequest): void {
  assertValidPetId(value.petId);
  assertBoundedMemoryString(value.memoryId, "memoryId", MEMORY_LIMITS.idChars);
  if (value.includeDeleted !== undefined) assertBoolean(value.includeDeleted, "includeDeleted");
  assertMemoryObjectBudget(value);
}

export function assertMemorySourceConversationRequest(value: MemorySourceConversationRequest): void {
  assertValidPetId(value.petId);
  assertBoundedMemoryString(value.memoryId, "memoryId", MEMORY_LIMITS.idChars);
  assertMemoryObjectBudget(value);
}

export function assertMemoryCreateRequest(value: MemoryCreateRequest): void {
  assertValidPetId(value.petId);
  assertMemoryChapter(value.chapter);
  if (!["profile", "behavior", "event", "knowledge"].includes(value.memoryType)) {
    throw new MemoryValidationError("Invalid memory type.");
  }
  assertBoundedMemoryString(value.content, "content", MEMORY_LIMITS.contentChars);
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > MEMORY_LIMITS.tags) {
      throw new MemoryValidationError(`tags may contain at most ${MEMORY_LIMITS.tags} items.`);
    }
    value.tags.forEach((tag, index) =>
      assertBoundedMemoryString(tag, `tags[${index}]`, MEMORY_LIMITS.tagChars)
    );
  }
  if (value.important !== undefined) assertBoolean(value.important, "important");
  if (value.origin !== undefined && value.origin !== "manual") {
    throw new MemoryValidationError("Management create origin must be manual.");
  }
  if (value.sourceTime !== undefined) assertIsoTime(value.sourceTime, "sourceTime");
  assertMemoryObjectBudget(value);
}

export function assertMemoryUpdateRequest(value: MemoryUpdateRequest): void {
  assertValidPetId(value.petId);
  assertBoundedMemoryString(value.memoryId, "memoryId", MEMORY_LIMITS.idChars);
  assertBoundedInteger(value.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
  if (
    value.chapter === undefined &&
    value.content === undefined &&
    value.tags === undefined &&
    value.important === undefined
  ) {
    throw new MemoryValidationError("Memory update has no changes.");
  }
  if (value.chapter !== undefined) assertMemoryChapter(value.chapter);
  if (value.content !== undefined) {
    assertBoundedMemoryString(value.content, "content", MEMORY_LIMITS.contentChars);
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > MEMORY_LIMITS.tags) {
      throw new MemoryValidationError(`tags may contain at most ${MEMORY_LIMITS.tags} items.`);
    }
    value.tags.forEach((tag, index) =>
      assertBoundedMemoryString(tag, `tags[${index}]`, MEMORY_LIMITS.tagChars)
    );
  }
  if (value.important !== undefined) assertBoolean(value.important, "important");
  assertMemoryObjectBudget(value);
}

export function assertMemoryRevisionRequest(value: MemoryRevisionRequest): void {
  assertMemoryGetRequest(value);
  assertBoundedInteger(value.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
}

export function assertMemoryClearRequest(value: MemoryClearRequest): void {
  const petId = assertValidPetId(value.petId);
  if (value.confirmPetId !== petId) {
    throw new MemoryValidationError("Memory clear confirmation does not match the pet ID.");
  }
}

export function assertMemorySettingsSaveRequest(value: MemorySettingsSaveRequest): MemorySettings {
  assertValidPetId(value.petId);
  const settings = normalizeMemorySettings(value.settings);
  if (settings.autoCaptureEnabled && value.autoCaptureConsent !== MEMORY_AUTO_CAPTURE_CONSENT) {
    throw new MemoryValidationError("Automatic memory capture requires explicit consent.");
  }
  if (settings.retainSources && value.sourceRetentionConsent !== MEMORY_SOURCE_RETENTION_CONSENT) {
    throw new MemoryValidationError("Memory source retention requires explicit consent.");
  }
  assertMemoryObjectBudget(value);
  return settings;
}

export function assertMemoryExportRequest(value: MemoryExportRequest): void {
  assertValidPetId(value.petId);
  if (!isRecord(value.options) || Object.keys(value.options).some((key) => key !== "includeSources")) {
    throw new MemoryValidationError("Invalid memory backup options.");
  }
  if (value.options.includeSources !== undefined && typeof value.options.includeSources !== "boolean") {
    throw new MemoryValidationError("includeSources must be a boolean.");
  }
  if (value.options.includeSources && value.sourceExportConsent !== MEMORY_SOURCE_EXPORT_CONSENT) {
    throw new MemoryValidationError("Exporting source conversations requires explicit consent.");
  }
  assertMemoryObjectBudget(value);
}

export function assertMemoryRetrieveResponse(value: MemoryRetrieveResponse, petId?: string): void {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["items", "answerPolicy"].includes(key)) ||
    !Array.isArray(value.items) ||
    value.items.length > MEMORY_LIMITS.backendItemsMax ||
    !["reference", "verified", "unknown"].includes(String(value.answerPolicy)) ||
    (value.answerPolicy === "unknown" && value.items.length !== 0) ||
    (value.answerPolicy === "verified" && value.items.length === 0)
  ) {
    throw new MemoryValidationError("Invalid memory retrieve response.");
  }
  value.items.forEach((item) => {
    if (!isRecord(item) || typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) {
      throw new MemoryValidationError("Invalid memory recall score.");
    }
    assertMemoryRecord(item.memory);
    if (petId !== undefined && item.memory.petId !== petId) {
      throw new MemoryValidationError("Memory backend returned a record for another pet.");
    }
  });
  assertMemoryObjectBudget(value);
}

export function assertMemoryMemorizeResponse(value: MemoryMemorizeResponse, petId?: string): void {
  if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length > MEMORY_LIMITS.backendItemsMax) {
    throw new MemoryValidationError("Invalid memory memorize response.");
  }
  value.entries.forEach((entry) => {
    assertMemoryRecordInput(entry);
    if (petId !== undefined && entry.petId !== petId) {
      throw new MemoryValidationError("Memory backend returned an entry for another pet.");
    }
  });
  assertMemoryObjectBudget(value);
}

export function assertMemoryConversationTurn(value: MemoryConversationTurn): void {
  assertValidPetId(value.petId);
  assertBoundedMemoryString(value.requestId, "requestId", MEMORY_LIMITS.idChars);
  assertBoundedMemoryString(value.userText, "userText", MEMORY_LIMITS.contentChars);
  assertBoundedMemoryString(value.assistantReply, "assistantReply", MEMORY_LIMITS.contentChars);
  assertIsoTime(value.occurredAt, "occurredAt");
  assertBoolean(value.retainSource, "retainSource");
}

export function estimateMemoryObjectBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
}

export function assertMemoryObjectBudget(value: unknown): void {
  if (estimateMemoryObjectBytes(value) > MEMORY_LIMITS.objectBudgetBytes) {
    throw new MemoryValidationError("Memory payload exceeds the shared object budget.");
  }
}
