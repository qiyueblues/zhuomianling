import type {
  MemoryClearRequest,
  MemoryCreateRequest,
  MemoryExportRequest,
  MemoryGetRequest,
  MemoryIndexRebuildResult,
  MemoryListRequest,
  MemoryManagedClearResult,
  MemoryManagedForgetResult,
  MemoryManagedRecordMutation,
  MemoryManagementStatus,
  MemoryPage,
  MemoryProviderStatus,
  MemoryRecord,
  MemoryResult,
  MemoryRevisionRequest,
  MemorySearchRequest,
  MemorySettings,
  MemorySettingsSaveRequest,
  MemorySourceConversation,
  MemorySourceConversationRequest,
  MemorySummary,
  MemoryUpdateRequest
} from "../../../shared/types/memory";
import {
  assertMemoryClearRequest,
  assertMemoryCreateRequest,
  assertMemoryExportRequest,
  assertMemoryGetRequest,
  assertMemoryListRequest,
  assertMemoryObjectBudget,
  assertMemoryRevisionRequest,
  assertMemorySearchRequest,
  assertMemorySettingsSaveRequest,
  assertMemorySourceConversationRequest,
  assertMemoryUpdateRequest,
  normalizeMemorySettings
} from "../../../shared/validation/memory";
import { assertValidPetId } from "../../../shared/validation/petId";
import { getAiConnectionConfig } from "../ai/aiSettings";
import {
  getLocalPetDefinition,
  getLocalPetMemorySettings,
  saveLocalPetMemorySettings
} from "../config/petConfigStore";
import { MemoryBackendError } from "./MemoryBackend";
import type { MemoryBackupData, MemoryBackupRestoreResult } from "../../../shared/types/memoryBackup";
import { assertMemoryBackupData } from "../../../shared/validation/memoryBackup";
import { toMemoryErrorDto } from "./memoryErrors";
import { MemoryLedger } from "./MemoryLedger";
import { MemoryPendingStore } from "./MemoryPendingStore";
import { getExistingRuntimeComponents, getRuntimeComponents } from "./memoryRecall";
import { shutdownAllMemorySidecars } from "./memorySidecarRuntime";
import {
  refreshAutomaticMemoryCapturesForPet,
  suspendAutomaticMemoryCapturesForPet
} from "./memoryCapture";

type SyncLedger = Pick<MemoryLedger, "petId">;

export interface MemoryManagementDependencies {
  petExists(petId: string): Promise<boolean>;
  getSettings(petId: string): Promise<MemorySettings | undefined>;
  saveSettings(petId: string, settings: MemorySettings): Promise<MemorySettings>;
  openLedger(petId: string): Promise<MemoryLedger>;
  listPending(petId: string): Promise<Array<{ deadLetteredAt?: string }>>;
  synchronize(ledger: SyncLedger, signal: AbortSignal): Promise<void>;
  rebuild(ledger: SyncLedger, signal: AbortSignal): Promise<{ appliedCount: number }>;
  providerHealth(petId: string, signal: AbortSignal): Promise<MemoryProviderStatus>;
  testProvider(petId: string, settings: MemorySettings, signal: AbortSignal): Promise<MemoryProviderStatus>;
  closePetIndex(petId: string, signal: AbortSignal): Promise<void>;
  refreshCaptures(petId: string): Promise<void>;
  suspendCaptures(petId: string): Promise<() => void>;
}

function asUnavailable(error: unknown): MemoryBackendError {
  if (error instanceof MemoryBackendError) return error;
  return new MemoryBackendError("unavailable", "Memory runtime is unavailable.");
}

export class MemoryManagementService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly deletingPets = new Set<string>();

  constructor(private readonly dependencies: MemoryManagementDependencies) {}

  private enqueue<T>(petId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(petId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(petId, current);
    void current.finally(() => {
      if (this.queues.get(petId) === current) this.queues.delete(petId);
    }).catch(() => undefined);
    return current;
  }

  private async execute<T>(
    petIdValue: string,
    operation: (petId: string) => Promise<T>,
    enforceResultBudget = true
  ): Promise<MemoryResult<T>> {
    try {
      const petId = assertValidPetId(petIdValue);
      if (this.deletingPets.has(petId)) {
        throw new MemoryBackendError("unavailable", "Pet memory is being deleted.", false);
      }
      return await this.enqueue(petId, async () => {
        if (!await this.dependencies.petExists(petId)) {
          return { ok: false, error: { code: "not-found", message: "The local pet does not exist.", retryable: false } };
        }
        const value = await operation(petId);
        if (enforceResultBudget) assertMemoryObjectBudget(value);
        return { ok: true, value };
      });
    } catch (error) {
      return { ok: false, error: toMemoryErrorDto(error) };
    }
  }

  private async withLedger<T>(petId: string, operation: (ledger: MemoryLedger) => Promise<T> | T): Promise<T> {
    const ledger = await this.dependencies.openLedger(petId);
    try {
      return await operation(ledger);
    } finally {
      ledger.close();
    }
  }

  private async synchronizeMutation<T extends object>(
    ledger: MemoryLedger,
    mutation: T
  ): Promise<T & { indexState: "synced" | "pending" }> {
    try {
      await this.dependencies.synchronize(ledger, new AbortController().signal);
      return { ...mutation, indexState: "synced" };
    } catch {
      return { ...mutation, indexState: "pending" };
    }
  }

  getSummary(petId: string): Promise<MemoryResult<MemorySummary>> {
    return this.execute(petId, (validPetId) => this.withLedger(validPetId, (ledger) => ({
      petId: validPetId,
      ...ledger.getSummary()
    })));
  }

  list(request: MemoryListRequest): Promise<MemoryResult<MemoryPage<MemoryRecord>>> {
    try {
      assertMemoryListRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(petId, (ledger) => ledger.list(request)));
  }

  search(request: MemorySearchRequest): Promise<MemoryResult<MemoryPage<MemoryRecord>>> {
    try {
      assertMemorySearchRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(petId, (ledger) => ledger.search(request)));
  }

  get(request: MemoryGetRequest): Promise<MemoryResult<MemoryRecord | undefined>> {
    try {
      assertMemoryGetRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(
      petId,
      (ledger) => ledger.get(request.memoryId, request.includeDeleted)
    ));
  }

  getSourceConversation(
    request: MemorySourceConversationRequest
  ): Promise<MemoryResult<MemorySourceConversation | undefined>> {
    try {
      assertMemorySourceConversationRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(
      petId,
      (ledger) => ledger.getSourceConversation(request.memoryId)
    ));
  }

  create(request: MemoryCreateRequest): Promise<MemoryResult<MemoryManagedRecordMutation>> {
    try {
      assertMemoryCreateRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(petId, async (ledger) => {
      const { memory } = await ledger.create({ ...request, origin: "manual" });
      return this.synchronizeMutation(ledger, { memory });
    }));
  }

  update(request: MemoryUpdateRequest): Promise<MemoryResult<MemoryManagedRecordMutation>> {
    try {
      assertMemoryUpdateRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(petId, async (ledger) => {
      const { memory } = await ledger.update(request);
      return this.synchronizeMutation(ledger, { memory });
    }));
  }

  forget(request: MemoryRevisionRequest): Promise<MemoryResult<MemoryManagedForgetResult>> {
    try {
      assertMemoryRevisionRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(petId, async (ledger) => {
      const { memoryId, revision, deletedAt } = await ledger.forget(
        petId,
        request.memoryId,
        request.expectedRevision
      );
      return this.synchronizeMutation(ledger, { memoryId, revision, deletedAt });
    }));
  }

  undoForget(request: MemoryRevisionRequest): Promise<MemoryResult<MemoryManagedRecordMutation>> {
    try {
      assertMemoryRevisionRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(petId, async (ledger) => {
      const { memory } = await ledger.undoForget(petId, request.memoryId, request.expectedRevision);
      return this.synchronizeMutation(ledger, { memory });
    }));
  }

  clear(request: MemoryClearRequest): Promise<MemoryResult<MemoryManagedClearResult>> {
    try {
      assertMemoryClearRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(petId, async (ledger) => {
      const { clearedCount } = await ledger.clear(petId);
      const result = await this.synchronizeMutation(ledger, { clearedCount });
      if (result.indexState === "synced") {
        await ledger.purgeDeleted(petId, "9999-12-31T23:59:59.999Z");
      }
      return result;
    }));
  }

  exportSnapshot(request: MemoryExportRequest): Promise<MemoryResult<MemoryBackupData>> {
    try {
      assertMemoryExportRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, (petId) => this.withLedger(petId, (ledger) =>
      ledger.backupSnapshot(request.options.includeSources === true)
    ), false);
  }

  restoreSnapshot(petId: string, data: MemoryBackupData): Promise<MemoryResult<MemoryBackupRestoreResult>> {
    return this.execute(petId, async (validPetId) => {
      assertMemoryBackupData(data);
      const release = await this.dependencies.suspendCaptures(validPetId);
      try {
        return await this.withLedger(validPetId, async (ledger) => {
          const mutation = await ledger.restoreSnapshot(data);
          if (!mutation.importedCount) {
            return { ...mutation, indexState: ledger.getIndexMetadata().dirty || ledger.getPendingOutboxCount() > 0 ? "pending" as const : "synced" as const };
          }
          return this.synchronizeMutation(ledger, mutation);
        });
      } finally {
        release();
      }
    });
  }

  rebuildIndex(petId: string): Promise<MemoryResult<MemoryIndexRebuildResult>> {
    return this.execute(petId, (validPetId) => this.withLedger(validPetId, async (ledger) => {
      const result = await this.dependencies.rebuild(ledger, new AbortController().signal);
      return { indexedCount: result.appliedCount, indexState: "synced" };
    }));
  }

  getSettings(petId: string): Promise<MemoryResult<MemorySettings>> {
    return this.execute(petId, async (validPetId) =>
      normalizeMemorySettings(await this.dependencies.getSettings(validPetId))
    );
  }

  saveSettings(request: MemorySettingsSaveRequest): Promise<MemoryResult<MemorySettings>> {
    let settings: MemorySettings;
    try {
      settings = assertMemorySettingsSaveRequest(request);
    } catch (error) {
      return Promise.resolve({ ok: false, error: toMemoryErrorDto(error) });
    }
    return this.execute(request.petId, async (petId) => {
      const saved = await this.dependencies.saveSettings(petId, settings);
      await this.dependencies.refreshCaptures(petId).catch(() => undefined);
      return saved;
    });
  }

  private async providerStatusValue(petId: string): Promise<MemoryProviderStatus> {
    const settings = normalizeMemorySettings(await this.dependencies.getSettings(petId));
    if (!settings.recallEnabled && !settings.autoCaptureEnabled) return { state: "disabled" };
    try {
      return await this.dependencies.providerHealth(petId, new AbortController().signal);
    } catch (error) {
      const mapped = toMemoryErrorDto(error);
      return {
        state: mapped.code === "invalid-config" ? "invalid-config" : mapped.code === "index-dirty" ? "index-dirty" : "unavailable",
        message: mapped.message
      };
    }
  }

  getProviderStatus(petId: string): Promise<MemoryResult<MemoryProviderStatus>> {
    return this.execute(petId, (validPetId) => this.providerStatusValue(validPetId));
  }

  testProvider(petId: string): Promise<MemoryResult<MemoryProviderStatus>> {
    return this.execute(petId, async (validPetId) => {
      const settings = normalizeMemorySettings(await this.dependencies.getSettings(validPetId));
      return this.dependencies.testProvider(validPetId, settings, new AbortController().signal);
    });
  }

  getStatus(petId: string): Promise<MemoryResult<MemoryManagementStatus>> {
    return this.execute(petId, async (validPetId) => {
      const settings = normalizeMemorySettings(await this.dependencies.getSettings(validPetId));
      const [provider, pending] = await Promise.all([
        this.providerStatusValue(validPetId),
        this.dependencies.listPending(validPetId)
      ]);
      return this.withLedger(validPetId, (ledger) => {
        const metadata = ledger.getIndexMetadata();
        return {
          petId: validPetId,
          settings,
          provider,
          indexState: metadata.dirty || ledger.getPendingOutboxCount() > 0 ? "pending" : "synced",
          pendingCaptures: pending.filter((item) => !item.deadLetteredAt).length,
          deadLetters: pending.filter((item) => Boolean(item.deadLetteredAt)).length
        };
      });
    });
  }

  async runPetDeletion<T extends { ok: boolean }>(petIdValue: string, operation: () => Promise<T>): Promise<T> {
    const petId = assertValidPetId(petIdValue);
    this.deletingPets.add(petId);
    return this.enqueue(petId, async () => {
      let releaseCaptures: () => void = () => undefined;
      try {
        releaseCaptures = await this.dependencies.suspendCaptures(petId);
        await this.dependencies.closePetIndex(petId, new AbortController().signal);
        return await operation();
      } finally {
        this.deletingPets.delete(petId);
        releaseCaptures();
      }
    });
  }
}

async function runtimeHealth(signal: AbortSignal): Promise<MemoryProviderStatus> {
  try {
    const runtime = await getRuntimeComponents();
    const result = await runtime.service.health(signal);
    if (!result.ok) {
      throw new MemoryBackendError(
        result.error.code === "invalid-config" ? "invalid-config" : result.error.code === "index-dirty" ? "index-dirty" : result.error.code === "timeout" ? "timeout" : "unavailable",
        result.error.message,
        result.error.retryable
      );
    }
    return result.value;
  } catch (error) {
    throw asUnavailable(error);
  }
}

export const memoryManagementService = new MemoryManagementService({
  async petExists(petId) {
    return Boolean(await getLocalPetDefinition(petId));
  },
  getSettings: getLocalPetMemorySettings,
  async saveSettings(petId, settings) {
    return (await saveLocalPetMemorySettings(petId, settings)).settings;
  },
  openLedger: (petId) => MemoryLedger.open(petId),
  listPending: (petId) => new MemoryPendingStore(petId).list(),
  async synchronize(ledger, signal) {
    const runtime = await getRuntimeComponents();
    await runtime.coordinator.synchronize(ledger as MemoryLedger, signal);
  },
  async rebuild(ledger, signal) {
    try {
      const runtime = await getRuntimeComponents();
      return await runtime.coordinator.rebuild(ledger as MemoryLedger, signal);
    } catch (error) {
      throw asUnavailable(error);
    }
  },
  async providerHealth(petId, signal) {
    const settings = normalizeMemorySettings(await getLocalPetMemorySettings(petId));
    if (settings.autoCaptureEnabled) {
      const profileId = settings.providerProfileId ?? petId;
      const provider = await getAiConnectionConfig(profileId);
      if (!provider?.baseUrl || !provider.model || !provider.apiKey) {
        return { state: "invalid-config", message: "Memory provider is not configured." };
      }
    }
    return runtimeHealth(signal);
  },
  async testProvider(petId, settings, signal) {
    try {
      const profileId = settings.providerProfileId ?? petId;
      const provider = await getAiConnectionConfig(profileId);
      if (!provider?.baseUrl || !provider.model || !provider.apiKey) {
        throw new MemoryBackendError("invalid-config", "Memory provider is not configured.", false);
      }
      const runtime = await getRuntimeComponents();
      await runtime.backend.configureNormalizationProvider({
        petId,
        profileId,
        baseUrl: provider.baseUrl,
        chatModel: provider.model,
        apiKey: provider.apiKey
      }, signal);
      await runtime.backend.testNormalizationProvider(petId, signal);
      return { state: "ready" };
    } catch (error) {
      throw asUnavailable(error);
    }
  },
  async closePetIndex(petId, signal) {
    const existing = getExistingRuntimeComponents();
    if (!existing) return;
    try {
      const runtime = await existing;
      const result = await runtime.service.closePet(petId, signal);
      if (!result.ok) await shutdownAllMemorySidecars();
    } catch {
      await shutdownAllMemorySidecars();
    }
  },
  refreshCaptures: refreshAutomaticMemoryCapturesForPet,
  suspendCaptures: suspendAutomaticMemoryCapturesForPet
});
