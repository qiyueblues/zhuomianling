export const MEMORY_SCHEMA_VERSION = 1 as const;

export const MEMORY_LIMITS = Object.freeze({
  idChars: 128,
  contentChars: 8_192,
  queryChars: 2_048,
  tagChars: 64,
  tags: 16,
  cursorChars: 256,
  providerProfileIdChars: 128,
  messageChars: 512,
  pageSizeDefault: 20,
  pageSizeMax: 100,
  recallLimitDefault: 5,
  recallLimitMin: 1,
  recallLimitMax: 10,
  contextBudgetCharsDefault: 2_048,
  contextBudgetCharsMin: 512,
  contextBudgetCharsMax: 4_096,
  managementPageSizeMax: 5,
  backendItemsMax: 100,
  objectBudgetBytes: 64 * 1024
} as const);

export type MemoryChapter =
  | "about_you"
  | "preferences_habits"
  | "important_events"
  | "relationships_goals";

export const MEMORY_CHAPTERS: readonly MemoryChapter[] = Object.freeze([
  "about_you",
  "preferences_habits",
  "important_events",
  "relationships_goals"
]);

export type MemoryType = "profile" | "behavior" | "event" | "knowledge";
export type MemoryOrigin = "automatic" | "manual" | "imported";

export interface MemorySettings {
  onboardingCompleted: boolean;
  recallEnabled: boolean;
  autoCaptureEnabled: boolean;
  recallLimit: number;
  contextBudgetChars: number;
  retainSources: boolean;
  providerProfileId?: string;
}

export const DEFAULT_MEMORY_SETTINGS: Readonly<MemorySettings> = Object.freeze({
  onboardingCompleted: false,
  recallEnabled: false,
  autoCaptureEnabled: false,
  recallLimit: MEMORY_LIMITS.recallLimitDefault,
  contextBudgetChars: MEMORY_LIMITS.contextBudgetCharsDefault,
  retainSources: false
});

export const MEMORY_AUTO_CAPTURE_CONSENT_NOTICE =
  "开启后，仅在 AI 完整成功回复时，本机会保存当前用户消息和用户可见回复，并调用已配置的整理服务生成长期记忆；失败或取消的回复不会保存。你可以随时关闭并在记忆管理中删除记录。";
export const MEMORY_AUTO_CAPTURE_CONSENT = "memory-auto-capture-v1" as const;
export const MEMORY_SOURCE_RETENTION_CONSENT = "memory-source-retention-v1" as const;
export const MEMORY_SOURCE_EXPORT_CONSENT = "memory-source-export-v1" as const;

export interface MemoryRecord {
  id: string;
  petId: string;
  chapter: MemoryChapter;
  memoryType: MemoryType;
  content: string;
  tags: string[];
  important: boolean;
  origin: MemoryOrigin;
  sourceTime?: string;
  sourceAvailable: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  revision: number;
}

export interface MemoryRecordInput {
  id: string;
  petId: string;
  chapter: MemoryChapter;
  memoryType: MemoryType;
  content: string;
  tags?: string[];
  important?: boolean;
  origin: MemoryOrigin;
  sourceTime?: string;
  sourceAvailable?: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
  revision?: number;
}

export interface MemoryPageRequest {
  cursor?: string;
  pageSize?: number;
}

export interface MemoryPage<T> {
  items: T[];
  nextCursor?: string;
}

export type MemorySort = "newest" | "oldest";

export interface MemorySearchRequest extends MemoryPageRequest {
  petId: string;
  query: string;
  chapters?: MemoryChapter[];
  importantOnly?: boolean;
  sort?: MemorySort;
  fromTime?: string;
  toTime?: string;
}

export interface MemoryListRequest extends MemoryPageRequest {
  petId: string;
  chapters?: MemoryChapter[];
  importantOnly?: boolean;
  sort?: MemorySort;
  fromTime?: string;
  toTime?: string;
}

export interface MemoryGetRequest {
  petId: string;
  memoryId: string;
  includeDeleted?: boolean;
}

export interface MemorySourceConversationRequest {
  petId: string;
  memoryId: string;
}

export interface MemorySourceConversation {
  userText: string;
  assistantReply: string;
  occurredAt: string;
  organizedAt: string;
}

export interface MemorySummary {
  petId: string;
  total: number;
  important: number;
  byChapter: Record<MemoryChapter, number>;
  lastUpdatedAt?: string;
}

export type MemoryProviderState =
  | "disabled"
  | "ready"
  | "unavailable"
  | "invalid-config"
  | "index-dirty";

export interface MemoryProviderStatus {
  state: MemoryProviderState;
  message?: string;
}

export type MemoryErrorCode =
  | "canceled"
  | "timeout"
  | "unavailable"
  | "invalid-config"
  | "index-dirty"
  | "invalid-request"
  | "not-found"
  | "conflict"
  | "ledger-corrupted"
  | "storage-unavailable"
  | "internal";

export interface MemoryErrorDto {
  code: MemoryErrorCode;
  message: string;
  retryable: boolean;
}

export type MemoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryErrorDto };

export interface MemoryRecallItem {
  memory: MemoryRecord;
  score: number;
}

export type MemoryRecallAnswerPolicy = "reference" | "verified" | "unknown";

export interface MemoryRetrieveRequest {
  petId: string;
  query: string;
  limit: number;
  contextBudgetChars: number;
}

export interface MemoryRetrieveResponse {
  items: MemoryRecallItem[];
  answerPolicy: MemoryRecallAnswerPolicy;
}

export interface MemoryConversationTurn {
  petId: string;
  requestId: string;
  userText: string;
  assistantReply: string;
  occurredAt: string;
  retainSource: boolean;
}

export interface MemoryMemorizeResponse {
  entries: MemoryRecordInput[];
}

export interface MemoryUpsertRequest {
  petId: string;
  memory: MemoryRecordInput;
}

export interface MemoryForgetRequest {
  petId: string;
  memoryId: string;
}

export interface MemoryRebuildRequest {
  petId: string;
  records: MemoryRecord[];
  targetId: string;
}

export interface MemoryRebuildResponse {
  indexedCount: number;
}

export interface MemoryCreateRequest {
  petId: string;
  chapter: MemoryChapter;
  memoryType: MemoryType;
  content: string;
  tags?: string[];
  important?: boolean;
  origin?: MemoryOrigin;
  sourceTime?: string;
}

export interface MemoryUpdateRequest {
  petId: string;
  memoryId: string;
  expectedRevision: number;
  chapter?: MemoryChapter;
  content?: string;
  tags?: string[];
  important?: boolean;
}

export interface MemoryRevisionRequest {
  petId: string;
  memoryId: string;
  expectedRevision: number;
}

export interface MemoryClearRequest {
  petId: string;
  confirmPetId: string;
}

export interface MemorySettingsSaveRequest {
  petId: string;
  settings: MemorySettings;
  autoCaptureConsent?: typeof MEMORY_AUTO_CAPTURE_CONSENT;
  sourceRetentionConsent?: typeof MEMORY_SOURCE_RETENTION_CONSENT;
}

export interface MemoryExportRequest {
  petId: string;
  options: MemoryExportOptions;
  sourceExportConsent?: typeof MEMORY_SOURCE_EXPORT_CONSENT;
}

export interface MemoryExportSaveResult {
  canceled: boolean;
  recordCount: number;
  fileName?: string;
  message: string;
}

export type MemoryIndexSyncState = "synced" | "pending";

export interface MemoryManagedRecordMutation {
  memory: MemoryRecord;
  indexState: MemoryIndexSyncState;
}

export interface MemoryManagedForgetResult {
  memoryId: string;
  revision: number;
  deletedAt?: string;
  indexState: MemoryIndexSyncState;
}

export interface MemoryManagedClearResult {
  clearedCount: number;
  indexState: MemoryIndexSyncState;
}

export interface MemoryIndexRebuildResult {
  indexedCount: number;
  indexState: "synced";
}

export interface MemoryManagementStatus {
  petId: string;
  settings: MemorySettings;
  provider: MemoryProviderStatus;
  indexState: MemoryIndexSyncState;
  pendingCaptures: number;
  deadLetters: number;
}

export interface MemoryMutationResult {
  memory: MemoryRecord;
  outboxSequence: number;
}

export interface MemoryForgetResult {
  memoryId: string;
  revision: number;
  deletedAt?: string;
  outboxSequence: number;
}

export interface MemoryClearResult {
  clearedCount: number;
  outboxSequence?: number;
}

export interface MemorySourceTurn {
  requestId: string;
  petId: string;
  userText: string;
  assistantReply: string;
  occurredAt: string;
  createdAt: string;
}

export type MemoryOutboxOperation = "upsert" | "forget" | "clear";

export interface MemoryOutboxEntry {
  sequence: number;
  operation: MemoryOutboxOperation;
  memoryId?: string;
  payload: unknown;
  createdAt: string;
  processedAt?: string;
}

export interface MemoryIndexMetadata {
  dirty: boolean;
  lastAppliedSequence: number;
  modelFingerprint?: string;
}

export interface MemoryExportOptions {
  includeSources?: boolean;
}

export interface MemoryPendingTurn {
  schemaVersion: 1;
  petId: string;
  requestId: string;
  contentHash: string;
  userText: string;
  assistantReply: string;
  occurredAt: string;
  retainSource: boolean;
  attempt: number;
  createdAt: string;
  nextAttemptAt?: string;
  deadLetteredAt?: string;
  lastErrorCode?: string;
}
