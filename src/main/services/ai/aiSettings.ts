import { app } from "electron";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  normalizeAiBaseUrl,
  type AiConnectionConfig,
  type AiConnectionDraft,
  type AiModelListResult,
  type AiConnectionSaveResult,
  type AiConnectionSummary,
  type AiConnectionTestResult,
  type AiOutputCapability,
  type AiOutputCapabilityTestResult,
  type AiModelOption
} from "../../../shared/types/ai";
export { normalizeAiBaseUrl } from "../../../shared/types/ai";
import {
  assertSecureStorageAvailable,
  deleteSecureString,
  encryptSecureString,
  getSecureString,
  SecureStorageCorruptedError,
  SecureStorageUnavailableError,
  setSecureString
} from "../config/secureConfigStore";
import { writeJsonFileAtomically } from "../config/durableJsonFile";
import { probeAiOutputCapability } from "./aiCapabilityProbe";
import { assertSupportedConfigVersion, UnsupportedConfigVersionError } from "../../../shared/validation/configVersion";
import { assertValidPetId } from "../../../shared/validation/petId";
import { withPetConfigWriteLock } from "../config/petConfigWriteQueue";
import { commitAiConnectionTransaction, recoverAiConnectionTransaction } from "./aiConnectionTransaction";

interface AiSettingsFile {
  version: 3;
  connections: Record<string, AiConnectionConfig>;
}

export interface VerifiedAiConnectionEvidence {
  models: AiModelOption[];
  outputCapability: AiOutputCapability;
  checkedAt: string;
}

interface ParsedAiSettingsFile {
  settings: AiSettingsFile;
  legacySecrets: Array<{
    petId: string;
    baseUrl: string;
    apiKey: string;
  }>;
  needsRewrite: boolean;
}

interface ResolvedAiConnectionConfig extends AiConnectionConfig {
  apiKey: string;
}

const settingsFileName = "ai-connections.json";
const aiApiKeyScope = "ai-api-key";
const fullProtocolDowngradeThreshold = 3;

let settingsMutationQueue: Promise<void> = Promise.resolve();
let migrationPromise: Promise<void> | undefined;
const fullProtocolDowngradeFailures = new Map<string, number>();

interface CachedAiModelsVerification {
  models: AiModelOption[];
  checkedAt: string;
}

// These caches only retain successful checks for the current process. The API
// key itself, or any reversible representation of it, never leaves the key
// resolver and is never persisted as part of the cache.
const aiModelsVerificationCache = new Map<string, CachedAiModelsVerification>();
const aiOutputVerificationCache = new Map<string, AiOutputCapability>();
const maxAiVerificationCacheEntries = 128;

interface CapabilityStabilityDecision {
  capability: AiOutputCapability;
  retainedFullProtocolFailureCount?: number;
}

function getApiKeyDigest(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

function getAiEndpointVerificationKey(draft: AiConnectionDraft, apiKey: string): string {
  return `${draft.petId}\0${draft.baseUrl}\0${getApiKeyDigest(apiKey)}`;
}

function getAiOutputVerificationKey(draft: AiConnectionDraft, apiKey: string): string {
  return `${getAiEndpointVerificationKey(draft, apiKey)}\0${draft.model}`;
}

function trimVerificationCache<T>(cache: Map<string, T>): void {
  while (cache.size > maxAiVerificationCacheEntries) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    cache.delete(oldestKey);
  }
}

function rememberAiModelsVerification(
  draft: AiConnectionDraft,
  apiKey: string,
  result: AiModelListResult
): void {
  if (!result.ok || !result.models.length) return;

  const key = getAiEndpointVerificationKey(draft, apiKey);
  aiModelsVerificationCache.delete(key);
  aiModelsVerificationCache.set(key, {
    models: result.models.map((model) => ({ ...model })),
    checkedAt: result.checkedAt
  });
  trimVerificationCache(aiModelsVerificationCache);
}

function getCachedAiModelsVerification(
  draft: AiConnectionDraft,
  apiKey: string
): CachedAiModelsVerification | undefined {
  return aiModelsVerificationCache.get(getAiEndpointVerificationKey(draft, apiKey));
}

function rememberAiOutputVerification(
  draft: AiConnectionDraft,
  apiKey: string,
  capability: AiOutputCapability
): void {
  if (capability.confidence !== "tested") return;

  const key = getAiOutputVerificationKey(draft, apiKey);
  aiOutputVerificationCache.delete(key);
  aiOutputVerificationCache.set(key, { ...capability });
  trimVerificationCache(aiOutputVerificationCache);
}

function getCachedAiOutputVerification(
  draft: AiConnectionDraft,
  apiKey: string
): AiOutputCapability | undefined {
  return aiOutputVerificationCache.get(getAiOutputVerificationKey(draft, apiKey));
}

function clearAiOutputVerificationForConfig(
  petId: string,
  baseUrl: string,
  model: string
): void {
  const prefix = `${petId}\0${baseUrl}\0`;
  const suffix = `\0${model}`;
  for (const key of aiOutputVerificationCache.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      aiOutputVerificationCache.delete(key);
    }
  }
}

function clearAiVerificationCache(petId: string): void {
  const prefix = `${petId}\0`;
  for (const key of aiModelsVerificationCache.keys()) {
    if (key.startsWith(prefix)) aiModelsVerificationCache.delete(key);
  }
  for (const key of aiOutputVerificationCache.keys()) {
    if (key.startsWith(prefix)) aiOutputVerificationCache.delete(key);
  }
}

function hasMatchingTestedOutputCapability(
  config: AiConnectionConfig | undefined,
  draft: AiConnectionDraft
): config is AiConnectionConfig & { outputCapability: AiOutputCapability } {
  const capability = config?.outputCapability;
  return Boolean(
    !draft.apiKey &&
    config?.baseUrl === draft.baseUrl &&
    config.model === draft.model &&
    capability?.confidence === "tested" &&
    capability.baseUrl === draft.baseUrl &&
    capability.model === draft.model
  );
}

function getCapabilityStabilityKey(petId: string, baseUrl: string, model: string): string {
  return `${petId}\0${normalizeAiBaseUrl(baseUrl)}\0${model.trim()}`;
}

function stabilizeOutputCapability(
  petId: string,
  existing: AiOutputCapability | undefined,
  candidate: AiOutputCapability
): CapabilityStabilityDecision {
  const key = getCapabilityStabilityKey(petId, candidate.baseUrl, candidate.model);
  if (candidate.protocolTier === "full") {
    fullProtocolDowngradeFailures.delete(key);
    return { capability: candidate };
  }

  const matchingFullCapability = existing?.protocolTier === "full" &&
    normalizeAiBaseUrl(existing.baseUrl) === normalizeAiBaseUrl(candidate.baseUrl) &&
    existing.model === candidate.model;
  if (!matchingFullCapability) {
    fullProtocolDowngradeFailures.delete(key);
    return { capability: candidate };
  }

  const failureCount = (fullProtocolDowngradeFailures.get(key) ?? 0) + 1;
  if (failureCount < fullProtocolDowngradeThreshold) {
    fullProtocolDowngradeFailures.set(key, failureCount);
    return {
      capability: existing,
      retainedFullProtocolFailureCount: failureCount
    };
  }

  fullProtocolDowngradeFailures.delete(key);
  return { capability: candidate };
}

function getCapabilityStabilityMessage(decision: CapabilityStabilityDecision): string {
  if (decision.retainedFullProtocolFailureCount !== undefined) {
    return `完整协议探测本次未通过（${decision.retainedFullProtocolFailureCount}/${fullProtocolDowngradeThreshold}），暂时保留已保存的完整协议。`;
  }
  return getCapabilityMessage(decision.capability);
}

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), settingsFileName);
}

function normalizeModelOptions(models: unknown): AiModelOption[] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models.flatMap((model) => {
    if (!model || typeof model !== "object") {
      return [];
    }

    const candidate = model as { id?: unknown; name?: unknown };

    if (typeof candidate.id !== "string" || !candidate.id.trim()) {
      return [];
    }

    const id = candidate.id.trim();
    return [
      {
        id,
        name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : id
      }
    ];
  });
}

function normalizeOutputCapability(
  value: unknown,
  baseUrl: string,
  model: string
): AiOutputCapability | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const capabilityBaseUrl =
    typeof candidate.baseUrl === "string" ? normalizeAiBaseUrl(candidate.baseUrl) : "";
  const capabilityModel = typeof candidate.model === "string" ? candidate.model.trim() : "";
  if (capabilityBaseUrl !== baseUrl || capabilityModel !== model) return undefined;
  if (
    candidate.mode !== "json-schema" &&
    candidate.mode !== "json-object" &&
    candidate.mode !== "prompt-json" &&
    candidate.mode !== "plain-text"
  ) {
    return undefined;
  }
  if (typeof candidate.streaming !== "boolean") return undefined;
  if (candidate.confidence !== "tested" && candidate.confidence !== "fallback") return undefined;
  if (typeof candidate.checkedAt !== "string" || !candidate.checkedAt) return undefined;
  const hasExplicitTier = candidate.protocolTier === "full" || candidate.protocolTier === "text";
  if (
    hasExplicitTier &&
    ((candidate.mode === "plain-text") !== (candidate.protocolTier === "text"))
  ) {
    return undefined;
  }
  const needsPromptJsonRecheck = !hasExplicitTier ||
    (candidate.probeVersion !== 2 && candidate.protocolTier === "text");
  const protocolTier = needsPromptJsonRecheck
    ? "full"
    : candidate.protocolTier as "full" | "text";
  const mode = needsPromptJsonRecheck ? "prompt-json" : candidate.mode;

  return {
    baseUrl: capabilityBaseUrl,
    model: capabilityModel,
    mode,
    protocolTier,
    streaming: candidate.streaming,
    confidence: needsPromptJsonRecheck ? "fallback" : candidate.confidence,
    checkedAt: candidate.checkedAt,
    probeVersion: 2
  };
}

function normalizeStoredConfig(petId: string, value: unknown): AiConnectionConfig {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const baseUrl = typeof candidate.baseUrl === "string" ? normalizeAiBaseUrl(candidate.baseUrl) : "";
  const model = typeof candidate.model === "string" ? candidate.model.trim() : "";

  return {
    petId: typeof candidate.petId === "string" && candidate.petId.trim() ? candidate.petId.trim() : petId,
    providerName:
      typeof candidate.providerName === "string" && candidate.providerName.trim()
        ? candidate.providerName.trim()
        : "OpenAI Compatible",
    baseUrl,
    model,
    models: normalizeModelOptions(candidate.models),
    outputCapability: normalizeOutputCapability(candidate.outputCapability, baseUrl, model),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt
        ? candidate.updatedAt
        : new Date(0).toISOString()
  };
}

function parseSettingsFile(value: unknown): ParsedAiSettingsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI settings file is invalid.");
  }

  const candidate = value as { version?: unknown; connections?: unknown };
  assertSupportedConfigVersion(candidate.version, 3, [1, 2]);

  if (!candidate.connections || typeof candidate.connections !== "object" || Array.isArray(candidate.connections)) {
    throw new Error("AI settings connections are invalid.");
  }

  const rawConnections = (candidate.connections ?? {}) as Record<string, unknown>;
  const connections: Record<string, AiConnectionConfig> = {};
  const legacySecrets: ParsedAiSettingsFile["legacySecrets"] = [];
  let needsRewrite = candidate.version !== 3;

  for (const [connectionId, rawConnection] of Object.entries(rawConnections)) {
    assertValidPetId(connectionId);
    if (!rawConnection || typeof rawConnection !== "object" || Array.isArray(rawConnection)) {
      throw new Error("AI settings connection is invalid.");
    }
    const legacyConnection = rawConnection as Record<string, unknown>;
    if (typeof legacyConnection.baseUrl !== "string" || !legacyConnection.baseUrl.trim() ||
      typeof legacyConnection.model !== "string") {
      throw new Error("AI settings connection structure is unrecognized.");
    }
    const normalizedConnection = normalizeStoredConfig(connectionId, rawConnection);
    if (normalizedConnection.petId !== connectionId) throw new Error("AI settings pet binding is invalid.");
    connections[connectionId] = normalizedConnection;

    if (legacyConnection.outputCapability && typeof legacyConnection.outputCapability === "object" && (
      !("protocolTier" in (legacyConnection.outputCapability as Record<string, unknown>)) ||
      (legacyConnection.outputCapability as Record<string, unknown>).probeVersion !== 2
    )) {
      needsRewrite = true;
    }

    if (Object.prototype.hasOwnProperty.call(legacyConnection, "apiKey")) {
      needsRewrite = true;

      if (typeof legacyConnection.apiKey === "string" && legacyConnection.apiKey.trim()) {
        legacySecrets.push({
          petId: normalizedConnection.petId,
          baseUrl: normalizedConnection.baseUrl,
          apiKey: legacyConnection.apiKey.trim()
        });
      }
    }
  }

  return {
    settings: {
      version: 3,
      connections
    },
    legacySecrets,
    needsRewrite
  };
}

async function readSettingsFile(): Promise<ParsedAiSettingsFile> {
  try {
    const content = await fs.readFile(getSettingsPath(), "utf8");
    return parseSettingsFile(JSON.parse(content) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        settings: {
          version: 3,
          connections: {}
        },
        legacySecrets: [],
        needsRewrite: false
      };
    }

    throw error;
  }
}

async function writeSettingsFile(settings: AiSettingsFile): Promise<void> {
  await writeJsonFileAtomically(getSettingsPath(), settings);
}

function runSettingsMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const operation = async (): Promise<T> => {
    await recoverAiConnectionTransaction(async (petId) => (await readSettingsFile()).settings.connections[petId]);
    return mutation();
  };
  const result = settingsMutationQueue.then(operation, operation);
  settingsMutationQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

function runPetMutation<T>(petId: string, mutation: () => Promise<T>): Promise<T> {
  return withPetConfigWriteLock(petId, mutation);
}

export async function migrateLegacyAiConnections(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runSettingsMutation(async () => {
      const parsed = await readSettingsFile();

      if (!parsed.needsRewrite) {
        return;
      }

      for (const legacySecret of parsed.legacySecrets) {
        await setSecureString(
          aiApiKeyScope,
          legacySecret.petId,
          legacySecret.apiKey,
          legacySecret.baseUrl
        );

        const migratedValue = await getSecureString(
          aiApiKeyScope,
          legacySecret.petId,
          legacySecret.baseUrl
        );

        if (migratedValue !== legacySecret.apiKey) {
          throw new SecureStorageCorruptedError();
        }
      }

      // The plaintext file is only replaced after every migrated secret can be
      // decrypted again. A failed migration therefore leaves the legacy file intact.
      await writeSettingsFile(parsed.settings);
    }).catch((error: unknown) => {
      migrationPromise = undefined;
      throw error;
    });
  }

  await migrationPromise;
}

async function readSettings(): Promise<AiSettingsFile> {
  await migrateLegacyAiConnections();
  return runSettingsMutation(async () => (await readSettingsFile()).settings);
}

async function readResolvedSettings<T>(reader: (settings: AiSettingsFile) => Promise<T>): Promise<T> {
  await migrateLegacyAiConnections();
  return runSettingsMutation(async () => reader((await readSettingsFile()).settings));
}

function normalizeDraft(draft: AiConnectionDraft): AiConnectionDraft {
  return {
    petId: draft.petId.trim(),
    providerName: draft.providerName.trim() || "OpenAI Compatible",
    baseUrl: normalizeAiBaseUrl(draft.baseUrl),
    model: draft.model.trim(),
    apiKey: draft.apiKey.trim(),
    models: normalizeModelOptions(draft.models)
  };
}

async function toSummary(config: AiConnectionConfig): Promise<AiConnectionSummary> {
  const apiKey = await getSecureString(aiApiKeyScope, config.petId, config.baseUrl);

  return {
    petId: config.petId,
    providerName: config.providerName,
    baseUrl: config.baseUrl,
    model: config.model,
    models: config.models ?? [],
    outputCapability: config.outputCapability,
    hasApiKey: Boolean(apiKey),
    updatedAt: config.updatedAt
  };
}

function toUnsavedSummary(draft: AiConnectionDraft): AiConnectionSummary {
  return {
    petId: draft.petId,
    providerName: draft.providerName,
    baseUrl: draft.baseUrl,
    model: draft.model,
    models: draft.models ?? [],
    hasApiKey: false
  };
}

function getSettingsFailure(
  error: unknown,
  checkedAt: string
): Pick<AiConnectionTestResult, "ok" | "message" | "checkedAt" | "code"> {
  if (error instanceof UnsupportedConfigVersionError) {
    return { ok: false, message: error.message, checkedAt, code: error.code };
  }
  if (error instanceof SecureStorageUnavailableError) {
    return {
      ok: false,
      message: error.message,
      checkedAt,
      code: "SECURE_STORAGE_UNAVAILABLE"
    };
  }

  if (error instanceof SecureStorageCorruptedError) {
    return {
      ok: false,
      message: error.message,
      checkedAt,
      code: "SECURE_STORAGE_CORRUPTED"
    };
  }

  return {
    ok: false,
    message: "无法读取或保存本机 AI 设置，请检查配置文件权限。",
    checkedAt,
    code: "INVALID_AI_SETTINGS"
  };
}

function getMissingApiKeyResult(
  checkedAt: string,
  endpointChanged: boolean
): AiModelListResult {
  return {
    ok: false,
    message: endpointChanged
      ? "Base URL 已更改，请重新输入 API Key；旧密钥不会用于新的服务地址。"
      : "请填写桌宠、Base URL 和 API Key。",
    checkedAt,
    code: "API_KEY_REQUIRED",
    models: []
  };
}

async function resolveApiKey(
  draft: AiConnectionDraft,
  existingConfig: AiConnectionConfig | undefined
): Promise<{ apiKey?: string; endpointChanged: boolean }> {
  if (draft.apiKey) {
    return {
      apiKey: draft.apiKey,
      endpointChanged: false
    };
  }

  const endpointChanged = Boolean(
    existingConfig && existingConfig.baseUrl !== normalizeAiBaseUrl(draft.baseUrl)
  );

  if (!existingConfig || endpointChanged) {
    return {
      endpointChanged
    };
  }

  return {
    apiKey: await runSettingsMutation(() => getSecureString(aiApiKeyScope, draft.petId, existingConfig.baseUrl)),
    endpointChanged: false
  };
}

function buildModelsUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/`);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (normalizedPath && normalizedPath !== "") {
    url.pathname = `${normalizedPath}/models`;
    return url.toString();
  }

  url.pathname = `${normalizedPath}/v1/models`;
  return url.toString();
}

function getModelName(model: unknown): string {
  if (typeof model === "string") {
    return model;
  }

  if (model && typeof model === "object" && "id" in model && typeof model.id === "string") {
    return model.id;
  }

  return "";
}

async function fetchAiModels(
  draft: AiConnectionDraft,
  apiKey: string,
  checkedAt: string,
  externalSignal?: AbortSignal
): Promise<AiModelListResult> {
  let response: Response;

  try {
    const timeoutSignal = AbortSignal.timeout(15_000);
    response = await fetch(buildModelsUrl(draft.baseUrl), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      },
      signal: externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal
    });
  } catch {
    return {
      ok: false,
      message: "无法连接到 Base URL，请检查地址或本地服务是否启动。",
      checkedAt,
      models: []
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `连接失败，服务返回 ${response.status}。`,
      checkedAt,
      models: []
    };
  }

  let body: { data?: unknown[] };

  try {
    body = (await response.json()) as { data?: unknown[] };
  } catch {
    return {
      ok: false,
      message: "连接成功，但服务返回的模型列表格式无效。",
      checkedAt,
      models: []
    };
  }

  const models =
    body.data
      ?.map((model) => {
        const id = getModelName(model);

        return id
          ? {
              id,
              name: id
            }
          : undefined;
      })
      .filter((model): model is { id: string; name: string } => Boolean(model)) ?? [];

  if (!models.length) {
    return {
      ok: false,
      message: "连接成功，但没有获取到可选择的模型列表。",
      checkedAt,
      models: []
    };
  }

  return {
    ok: true,
    message: "连接成功，请选择要使用的模型。",
    checkedAt,
    models
  };
}

export async function listAiConnectionSummaries(): Promise<AiConnectionSummary[]> {
  return readResolvedSettings((settings) => Promise.all(Object.values(settings.connections).map(toSummary)));
}

export async function getAiConnectionSummary(
  petId: string
): Promise<AiConnectionSummary | undefined> {
  const normalizedPetId = petId.trim();
  return readResolvedSettings(async (settings) => {
    const config = settings.connections[normalizedPetId];
    return config ? toSummary(config) : undefined;
  });
}

export async function getAiConnectionConfig(
  petId: string
): Promise<ResolvedAiConnectionConfig | undefined> {
  const normalizedPetId = petId.trim();
  return readResolvedSettings(async (settings) => {
    const config = settings.connections[normalizedPetId];
    if (!config) return undefined;
    const apiKey = await getSecureString(aiApiKeyScope, config.petId, config.baseUrl);
    return { ...config, apiKey: apiKey ?? "" };
  });
}

export async function listAiModels(draft: AiConnectionDraft, signal?: AbortSignal): Promise<AiModelListResult> {
  const normalized = normalizeDraft(draft);
  const checkedAt = new Date().toISOString();

  if (!normalized.petId || !normalized.baseUrl) {
    return getMissingApiKeyResult(checkedAt, false);
  }

  let settings: AiSettingsFile;
  let resolution: Awaited<ReturnType<typeof resolveApiKey>>;

  try {
    settings = await readSettings();
    resolution = await resolveApiKey(normalized, settings.connections[normalized.petId]);
  } catch (error: unknown) {
    return {
      ...getSettingsFailure(error, checkedAt),
      models: []
    };
  }

  if (!resolution.apiKey) {
    return getMissingApiKeyResult(checkedAt, resolution.endpointChanged);
  }

  const result = await fetchAiModels(normalized, resolution.apiKey, checkedAt, signal);
  rememberAiModelsVerification(normalized, resolution.apiKey, result);
  return result;
}

export async function testAiConnection(draft: AiConnectionDraft): Promise<AiConnectionTestResult> {
  const modelsResult = await listAiModels(draft);

  return {
    ok: modelsResult.ok,
    message: modelsResult.ok ? "连接成功，设置已保存。" : modelsResult.message,
    checkedAt: modelsResult.checkedAt,
    code: modelsResult.code
  };
}

function getCapabilityMessage(capability: AiOutputCapability): string {
  if (capability.confidence === "fallback") {
    return capability.protocolTier === "full"
      ? "将通过 Prompt JSON 兼容方式保持完整桌宠协议。"
      : "完整协议测试未完成，将使用仅文字兼容模式。";
  }
  const tierLabel = capability.protocolTier === "full" ? "完整桌宠协议" : "仅文字兼容";
  return `${tierLabel} · ${capability.streaming ? "支持流式" : "完整回复"}`;
}

function getCapabilityProbeFailureMessage(
  failureKind: "authentication" | "rate-limit" | "server" | "network" | "invalid-response" | undefined,
  status?: number
): string {
  const statusSuffix = status ? `（HTTP ${status}）` : "";
  if (failureKind === "authentication") return `输出能力测试认证失败${statusSuffix}，不会更改已保存的能力等级。`;
  if (failureKind === "rate-limit") return `输出能力测试触发限流${statusSuffix}，不会更改已保存的能力等级。`;
  if (failureKind === "server") return `输出能力测试遇到服务端错误${statusSuffix}，不会更改已保存的能力等级。`;
  if (failureKind === "network") return "输出能力测试未能连接或已超时，不会更改已保存的能力等级。";
  return "模型没有完成固定输出能力测试，不会把本次失败记录为格式降级。";
}

export async function testAiOutputCapability(
  draft: AiConnectionDraft,
  signal?: AbortSignal
): Promise<AiOutputCapabilityTestResult> {
  const normalized = normalizeDraft(draft);
  const checkedAt = new Date().toISOString();

  if (!normalized.petId || !normalized.baseUrl || !normalized.model) {
    return {
      ok: false,
      message: "请先填写 Base URL 并选择模型。",
      checkedAt,
      code: "INVALID_AI_SETTINGS"
    };
  }

  return runPetMutation(normalized.petId, async () => {
    let settings: AiSettingsFile;
    let resolution: Awaited<ReturnType<typeof resolveApiKey>>;
    try {
      settings = await readSettings();
      resolution = await resolveApiKey(normalized, settings.connections[normalized.petId]);
    } catch (error: unknown) {
      return getSettingsFailure(error, checkedAt);
    }

    if (!resolution.apiKey) {
      return getMissingApiKeyResult(checkedAt, resolution.endpointChanged);
    }

    const probe = await probeAiOutputCapability({
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      apiKey: resolution.apiKey,
      checkedAt,
      signal
    });

    const existing = settings.connections[normalized.petId];
    let stabilityDecision: CapabilityStabilityDecision | undefined;
    if (probe.tested && existing?.baseUrl === normalized.baseUrl && existing.model === normalized.model) {
      await runSettingsMutation(async () => {
        const latest = (await readSettingsFile()).settings;
        const current = latest.connections[normalized.petId];
        if (current?.baseUrl === normalized.baseUrl && current.model === normalized.model) {
          stabilityDecision = stabilizeOutputCapability(
            normalized.petId,
            current.outputCapability,
            probe.capability
          );
          current.outputCapability = stabilityDecision.capability;
          await writeSettingsFile(latest);
        }
      });
    }

    const effectiveCapability = stabilityDecision?.capability ?? probe.capability;
    if (probe.tested) {
      rememberAiOutputVerification(normalized, resolution.apiKey, effectiveCapability);
    }

    return {
      ok: probe.tested,
      message: probe.tested
        ? stabilityDecision
          ? getCapabilityStabilityMessage(stabilityDecision)
          : getCapabilityMessage(probe.capability)
        : getCapabilityProbeFailureMessage(probe.failureKind, probe.status),
      checkedAt,
      ...(probe.tested ? { capability: effectiveCapability } : {})
    };
  });
}

export async function recordAiOutputCapability(
  petId: string,
  expectedBaseUrl: string,
  expectedModel: string,
  capability: AiOutputCapability
): Promise<void> {
  await runPetMutation(petId, async () => {
    await runSettingsMutation(async () => {
      const settings = (await readSettingsFile()).settings;
      const current = settings.connections[petId];
      if (
        !current ||
        current.baseUrl !== normalizeAiBaseUrl(expectedBaseUrl) ||
        current.model !== expectedModel.trim()
      ) {
        return;
      }
      clearAiOutputVerificationForConfig(petId, current.baseUrl, current.model);
      current.outputCapability = capability;
      await writeSettingsFile(settings);
    });
  });
}

export async function saveAiConnection(
  draft: AiConnectionDraft,
  verifiedEvidence?: VerifiedAiConnectionEvidence
): Promise<AiConnectionSaveResult> {
  if (!draft.petId.trim()) return saveAiConnectionWhilePetConfigLocked(draft, verifiedEvidence);
  return runPetMutation(draft.petId.trim(), () => saveAiConnectionWhilePetConfigLocked(draft, verifiedEvidence));
}

/** Used by imports that already hold the shared per-pet lock. */
export async function saveAiConnectionWhilePetConfigLocked(
  draft: AiConnectionDraft,
  verifiedEvidence?: VerifiedAiConnectionEvidence
): Promise<AiConnectionSaveResult> {
  const normalized = normalizeDraft(draft);

  if (!normalized.petId) {
    const checkedAt = new Date().toISOString();
    return {
      config: toUnsavedSummary(normalized),
      test: {
        ok: false,
        message: "请先选择要配置的桌宠。",
        checkedAt,
        code: "INVALID_AI_SETTINGS"
      }
    };
  }

  return (async () => {
    const checkedAt = new Date().toISOString();
    const verifiedModels = verifiedEvidence ? normalizeModelOptions(verifiedEvidence.models) : undefined;
    const verifiedCapability = verifiedEvidence
      ? normalizeOutputCapability(verifiedEvidence.outputCapability, normalized.baseUrl, normalized.model)
      : undefined;
    if (verifiedEvidence && (
      !verifiedCapability ||
      verifiedCapability.confidence !== "tested" ||
      !verifiedModels?.some((model) => model.id === normalized.model)
    )) {
      return {
        config: toUnsavedSummary(normalized),
        test: {
          ok: false,
          message: "导入会话中的 AI 检测结果无效，请重新检测。",
          checkedAt,
          code: "INVALID_AI_SETTINGS"
        }
      };
    }
    let settings: AiSettingsFile;
    let resolution: Awaited<ReturnType<typeof resolveApiKey>>;

    try {
      settings = await readSettings();
      resolution = await resolveApiKey(normalized, settings.connections[normalized.petId]);
    } catch (error: unknown) {
      return {
        config: toUnsavedSummary(normalized),
        test: getSettingsFailure(error, checkedAt)
      };
    }

    if (!normalized.baseUrl || !resolution.apiKey) {
      return {
        config: toUnsavedSummary(normalized),
        test: getMissingApiKeyResult(checkedAt, resolution.endpointChanged)
      };
    }

    const existingConfig = settings.connections[normalized.petId];

    let ciphertext: string;
    try {
      assertSecureStorageAvailable();
      // Check encryption before networking, while keeping the saved key intact.
      ciphertext = encryptSecureString(resolution.apiKey, normalized.baseUrl);
    } catch (error: unknown) {
      return {
        config: toUnsavedSummary(normalized),
        test: getSettingsFailure(error, checkedAt)
      };
    }

    const cachedModelsVerification = verifiedEvidence
      ? undefined
      : getCachedAiModelsVerification(normalized, resolution.apiKey);
    const persistedModels = !normalized.apiKey && existingConfig?.baseUrl === normalized.baseUrl
      ? existingConfig.models
      : undefined;
    const reusableModels = verifiedModels?.length
      ? verifiedModels
      : cachedModelsVerification?.models ?? persistedModels;
    const modelsResult = verifiedEvidence ? {
      ok: true,
      message: "已复用导入向导中的 AI 检测结果。",
      checkedAt: verifiedEvidence.checkedAt,
      models: verifiedModels!
    } satisfies AiModelListResult : reusableModels?.length ? {
      ok: true,
      message: "已复用已完成的模型列表检测。",
      checkedAt: cachedModelsVerification?.checkedAt ?? existingConfig?.updatedAt ?? checkedAt,
      models: reusableModels
    } satisfies AiModelListResult : await fetchAiModels(normalized, resolution.apiKey, checkedAt);
    const cachedOutputVerification = verifiedEvidence
      ? undefined
      : getCachedAiOutputVerification(normalized, resolution.apiKey);
    const persistedOutputVerification = hasMatchingTestedOutputCapability(existingConfig, normalized)
      ? existingConfig.outputCapability
      : undefined;
    const reusableOutputVerification = verifiedCapability
      ?? cachedOutputVerification
      ?? persistedOutputVerification;
    const capabilityProbe = !verifiedEvidence && !reusableOutputVerification && modelsResult.ok && normalized.model
      ? await probeAiOutputCapability({
          baseUrl: normalized.baseUrl,
          model: normalized.model,
          apiKey: resolution.apiKey,
          checkedAt
        })
      : undefined;
    const outputCapability = reusableOutputVerification ?? (capabilityProbe?.tested
      ? capabilityProbe.capability
      : existingConfig?.baseUrl === normalized.baseUrl && existingConfig.model === normalized.model
        ? existingConfig.outputCapability
        : undefined);
    const config: AiConnectionConfig = {
      petId: normalized.petId,
      providerName: normalized.providerName,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      models: verifiedModels?.length
        ? verifiedModels
        : modelsResult.ok
          ? modelsResult.models
          : normalized.models?.length
            ? normalized.models
            : existingConfig?.models ?? [],
      outputCapability,
      updatedAt: new Date(Math.max(Date.now(), (Date.parse(existingConfig?.updatedAt ?? "") || 0) + 1)).toISOString()
    };
    const test: AiConnectionTestResult = {
      ok: modelsResult.ok,
      message: modelsResult.ok
        ? verifiedEvidence
          ? "AI 设置已使用导入向导的检测结果保存。"
          : `连接成功，设置已保存。${capabilityProbe
            ? ` ${capabilityProbe.tested
              ? getCapabilityMessage(capabilityProbe.capability)
              : getCapabilityProbeFailureMessage(capabilityProbe.failureKind, capabilityProbe.status)}`
            : reusableOutputVerification
              ? " 已复用已完成的输出能力测试。"
              : ""}`
        : modelsResult.message,
      checkedAt: modelsResult.checkedAt,
      code: modelsResult.code
    };

    try {
      await runSettingsMutation(async () => {
        const latestSettings = (await readSettingsFile()).settings;

        latestSettings.connections[normalized.petId] = config;
        await commitAiConnectionTransaction(
          config, ciphertext,
          () => writeSettingsFile(latestSettings),
          async (petId) => (await readSettingsFile()).settings.connections[petId]
        );
      });
    } catch (error: unknown) {
      return {
        config: toUnsavedSummary(normalized),
        test: getSettingsFailure(error, checkedAt)
      };
    }

    rememberAiModelsVerification(normalized, resolution.apiKey, modelsResult);
    if (outputCapability) {
      rememberAiOutputVerification(normalized, resolution.apiKey, outputCapability);
    }

    return {
      config: {
        petId: config.petId,
        providerName: config.providerName,
        baseUrl: config.baseUrl,
        model: config.model,
        models: config.models ?? [],
        outputCapability: config.outputCapability,
        hasApiKey: true,
        updatedAt: config.updatedAt
      },
      test
    };
  })();
}

export async function deleteAiConnection(petId: string): Promise<void> {
  const normalizedPetId = petId.trim();

  if (!normalizedPetId) {
    return;
  }

  await runPetMutation(normalizedPetId, () => deleteAiConnectionWhilePetConfigLocked(normalizedPetId));
}

/** Caller must hold the shared pet configuration lock. */
export async function deleteAiConnectionWhilePetConfigLocked(normalizedPetId: string): Promise<void> {
  assertValidPetId(normalizedPetId);
  clearAiVerificationCache(normalizedPetId);
  await migrateLegacyAiConnections();
  await runSettingsMutation(async () => {
    const settings = (await readSettingsFile()).settings;
    if (normalizedPetId in settings.connections) {
      delete settings.connections[normalizedPetId];
      await writeSettingsFile(settings);
    }
    await deleteSecureString(aiApiKeyScope, normalizedPetId);
  });
}
