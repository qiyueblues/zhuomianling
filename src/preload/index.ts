import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AiConnectionDraft,
  AiModelListResult,
  AiConnectionSaveResult,
  AiConnectionSummary,
  AiOutputCapabilityTestResult
} from "../shared/types/ai";
import type {
  DesktopPetPayload,
  PetWindowCloseOptions,
  PetWindowSourcePreviewRequest,
  PetWindowSourcePreviewFinishedEvent,
  PetWindowSourcePreviewResult,
  PetWindowState
} from "../shared/types/window";
import type {
  LocalPetAvatarImportResult,
  LocalPetAvatarCropSaveRequest,
  LocalPetBasicInfoDraft,
  LocalPetDeleteResult,
  LocalPetListResult,
  LocalPetEventSettingsDraft,
  LocalPetExpressionMappingDraft,
  LocalPetPersonaDraft,
  LocalPetUiSettingsDraft,
  LocalPetVoiceInputDraft,
  LocalPetVoiceModelConnectionResult,
  LocalPetVoiceModelDraft,
  LocalPetVoiceModelFilePickResult,
  LocalPetVoiceResourceKind,
  LocalPetSaveResult,
  PetCustomThemeImportResult,
  PetDefinition
} from "../shared/types/pet";
import type {
  Live2DFolderScanResult,
  Live2DFolderSelectResult,
  Live2DGeneratedEntryResult,
  Live2DImportedSourceScanResult,
  Live2DModelImportRequest,
  Live2DModelImportResult,
  Live2DPreviewModelResult
} from "../shared/types/live2dImport";
import type {
  MemoryClearRequest,
  MemoryCreateRequest,
  MemoryExportRequest,
  MemoryExportSaveResult,
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
} from "../shared/types/memory";
import type { StartupRendererStage } from "../shared/types/startup";
import type { AppUpdateState, AppUpdateActionResult } from "../shared/types/appUpdate";
import type { LocalPetMoodSettingsDraft, PetMoodEditorState, PetMoodEnterPreviewRequest, PetMoodVoiceImportRequest, PetMoodVoiceImportResult, PetMoodVoiceRemoveRequest } from "../shared/types/mood";
import type {
  PresetVoiceDeleteOneRequest,
  PresetVoiceGenerationRequest,
  PresetVoiceDeleteResult,
  PresetVoiceOverview,
  PresetVoicePreviewRequest,
  PresetVoicePreviewResult,
  PresetVoiceTaskCancelRequest,
  PresetVoiceTaskCancelResult,
  PresetVoiceTaskSnapshot,
  PresetVoiceTaskStartResult
} from "../shared/types/presetVoice";
import type {
  PetPackageDirectoryPickResult,
  PetPackageExportInspection,
  PetPackageExportResult,
  PetPackageImportAiModelsRequest,
  PetPackageImportAiModelsResult,
  PetPackageImportAiRequest,
  PetPackageImportBeginResult,
  PetPackageImportCancelRequest,
  PetPackageImportCommitRequest,
  PetPackageImportCommitResult,
  PetPackageImportStepResult,
  PetPackageImportVoiceRequest,
  PetPackageProgress
} from "../shared/types/petPackage";
import type {
  ScreenAwarenessAvailability,
  ScreenVisionConnectionDraft,
  ScreenVisionConnectionSummary,
  ScreenVisionModelListResult,
  ScreenVisionProbeResult,
  ScreenAwarenessMode
} from "../shared/types/screen";
import type {
  TimedDiagnosticEvent,
  TimedDiagnosticSnapshot
} from "../shared/types/timedDiagnostics";

const startupTimingEnabled = process.env.ZHUOMIANLING_STARTUP_TIMING === "1";

const desktopPetApi = {
  getAppVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
  appUpdate: {
    getState: () => ipcRenderer.invoke("app-update:get-state") as Promise<AppUpdateState>,
    check: () => ipcRenderer.invoke("app-update:check") as Promise<AppUpdateState>,
    download: () => ipcRenderer.invoke("app-update:download") as Promise<AppUpdateState>,
    downloadGithub: () => ipcRenderer.invoke("app-update:download-github") as Promise<AppUpdateState>,
    cancel: () => ipcRenderer.invoke("app-update:cancel") as Promise<AppUpdateState>,
    dismiss: () => ipcRenderer.invoke("app-update:dismiss") as Promise<AppUpdateState>,
    ignoreVersion: () => ipcRenderer.invoke("app-update:ignore-version") as Promise<AppUpdateActionResult>,
    install: () => ipcRenderer.invoke("app-update:install") as Promise<AppUpdateActionResult>,
    openReleasePage: () => ipcRenderer.invoke("app-update:open-release") as Promise<AppUpdateActionResult>,
    startupReady: () => ipcRenderer.send("app-update:startup-ready"),
    onChanged: (callback: (state: AppUpdateState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState): void => callback(state);
      ipcRenderer.on("app-update:changed", listener);
      return () => { ipcRenderer.off("app-update:changed", listener); };
    }
  },
  // TIMED DIAGNOSTICS TEST MODULE: main-window-only development diagnostics.
  timedDiagnosticsTest: {
    getSnapshot: () =>
      ipcRenderer.invoke("timed-diagnostics-test:get-snapshot") as Promise<TimedDiagnosticSnapshot>,
    onEvent: (callback: (event: TimedDiagnosticEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, result: TimedDiagnosticEvent): void => {
        callback(result);
      };

      ipcRenderer.on("timed-diagnostics-test:event", listener);
      return () => {
        ipcRenderer.off("timed-diagnostics-test:event", listener);
      };
    }
  },
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),
  appWindow: {
    openLocalHelp: () => ipcRenderer.invoke("app:open-local-help") as Promise<{ ok: boolean; message?: string }>,
    isShown: () => ipcRenderer.invoke("app-window:is-shown") as Promise<boolean>,
    revealStartupSurface: (reason?: string) =>
      ipcRenderer.send("app-window:startup-surface-ready", reason),
    reportStartupTiming: (stage: StartupRendererStage) => {
      if (startupTimingEnabled) {
        ipcRenderer.send("app-window:startup-timing", stage);
      }
    },
    onShown: (callback: () => void) => {
      const listener = (): void => {
        callback();
      };

      ipcRenderer.on("app-window:shown", listener);

      return () => {
        ipcRenderer.off("app-window:shown", listener);
      };
    }
  },
  petConfig: {
    listLocal: () => ipcRenderer.invoke("pet-config:list-local") as Promise<LocalPetListResult>,
    restoreBackup: (petId: string) =>
      ipcRenderer.invoke("pet-config:restore-backup", petId) as Promise<LocalPetSaveResult>,
    importUiTheme: () =>
      ipcRenderer.invoke("pet-config:import-ui-theme") as Promise<PetCustomThemeImportResult>,
    saveBasicInfo: (draft: LocalPetBasicInfoDraft) =>
      ipcRenderer.invoke("pet-config:save-basic-info", draft) as Promise<LocalPetSaveResult>,
    savePersona: (draft: LocalPetPersonaDraft) =>
      ipcRenderer.invoke("pet-config:save-persona", draft) as Promise<LocalPetSaveResult>,
    saveExpressionMappings: (draft: LocalPetExpressionMappingDraft) =>
      ipcRenderer.invoke("pet-config:save-expression-mappings", draft) as Promise<LocalPetSaveResult>,
    saveEventSettings: (draft: LocalPetEventSettingsDraft) =>
      ipcRenderer.invoke("pet-config:save-event-settings", draft) as Promise<LocalPetSaveResult>,
    saveUiSettings: (draft: LocalPetUiSettingsDraft) =>
      ipcRenderer.invoke("pet-config:save-ui-settings", draft) as Promise<LocalPetSaveResult>,
    saveVoiceInput: (draft: LocalPetVoiceInputDraft) =>
      ipcRenderer.invoke("pet-config:save-voice-input", draft) as Promise<LocalPetSaveResult>,
    pickVoiceModelFile: (kind: LocalPetVoiceResourceKind) =>
      ipcRenderer.invoke("pet-config:pick-voice-model-file", kind) as Promise<LocalPetVoiceModelFilePickResult>,
    testVoiceModelConnection: (draft: LocalPetVoiceModelDraft) =>
      ipcRenderer.invoke("pet-config:test-voice-model-connection", draft) as Promise<LocalPetVoiceModelConnectionResult>,
    disconnectVoiceModel: () =>
      ipcRenderer.invoke("pet-config:disconnect-voice-model") as Promise<LocalPetVoiceModelConnectionResult>,
    saveVoiceModel: (draft: LocalPetVoiceModelDraft) =>
      ipcRenderer.invoke("pet-config:save-voice-model", draft) as Promise<LocalPetSaveResult>,
    importAvatar: (petId?: string) =>
      ipcRenderer.invoke("pet-config:import-avatar", petId) as Promise<LocalPetAvatarImportResult>,
    saveAvatarCrop: (request: LocalPetAvatarCropSaveRequest) =>
      ipcRenderer.invoke("pet-config:save-avatar-crop", request) as Promise<LocalPetAvatarImportResult>,
    delete: (petId: string) =>
      ipcRenderer.invoke("pet-config:delete", petId) as Promise<LocalPetDeleteResult>,
    onChanged: (callback: (pet?: PetDefinition) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, pet?: PetDefinition): void => {
        callback(pet);
      };

      ipcRenderer.on("pet-config:changed", listener);

      return () => {
        ipcRenderer.off("pet-config:changed", listener);
      };
    }
  },
  mood: {
    getEditorState: (petId: string) => ipcRenderer.invoke("mood:get-editor-state", petId) as Promise<PetMoodEditorState>,
    saveSettings: (draft: LocalPetMoodSettingsDraft) => ipcRenderer.invoke("mood:save-settings", draft) as Promise<LocalPetSaveResult>,
    importRangeVoice: (request: PetMoodVoiceImportRequest) => ipcRenderer.invoke("mood:import-range-voice", request) as Promise<PetMoodVoiceImportResult>,
    removeRangeVoice: (request: PetMoodVoiceRemoveRequest) => ipcRenderer.invoke("mood:remove-range-voice", request) as Promise<LocalPetSaveResult>,
    previewEnterSource: (request: PetMoodEnterPreviewRequest) => ipcRenderer.invoke("mood:preview-enter-source", request) as Promise<PetWindowSourcePreviewResult>
  },
  presetVoice: {
    getOverview: (petId: string) =>
      ipcRenderer.invoke("preset-voice:get-overview", petId) as Promise<PresetVoiceOverview>,
    getTask: (petId: string) =>
      ipcRenderer.invoke("preset-voice:get-task", petId) as Promise<PresetVoiceTaskSnapshot | undefined>,
    start: (request: PresetVoiceGenerationRequest) =>
      ipcRenderer.invoke("preset-voice:start", request) as Promise<PresetVoiceTaskStartResult>,
    cancel: (request: PresetVoiceTaskCancelRequest) =>
      ipcRenderer.invoke("preset-voice:cancel", request) as Promise<PresetVoiceTaskCancelResult>,
    preview: (request: PresetVoicePreviewRequest) =>
      ipcRenderer.invoke("preset-voice:preview", request) as Promise<PresetVoicePreviewResult>,
    deleteOne: (request: PresetVoiceDeleteOneRequest) =>
      ipcRenderer.invoke("preset-voice:delete-one", request) as Promise<PresetVoiceDeleteResult>,
    deleteAll: (petId: string) =>
      ipcRenderer.invoke("preset-voice:delete-all", petId) as Promise<PresetVoiceDeleteResult>,
    onProgress: (callback: (snapshot: PresetVoiceTaskSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: PresetVoiceTaskSnapshot): void => {
        callback(snapshot);
      };
      ipcRenderer.on("preset-voice:progress", listener);
      return () => {
        ipcRenderer.off("preset-voice:progress", listener);
      };
    }
  },
  live2dImport: {
    selectFolder: () =>
      ipcRenderer.invoke("live2d-import:select-folder") as Promise<Live2DFolderSelectResult>,
    validateFolder: (folderPath: string) =>
      ipcRenderer.invoke("live2d-import:validate-folder", folderPath) as Promise<Live2DFolderScanResult>,
    generateEntry: (folderPath: string) =>
      ipcRenderer.invoke("live2d-import:generate-entry", folderPath) as Promise<Live2DGeneratedEntryResult>,
    createPreviewModel: (folderPath: string) =>
      ipcRenderer.invoke("live2d-import:create-preview-model", folderPath) as Promise<Live2DPreviewModelResult>,
    importModel: (request: Live2DModelImportRequest) =>
      ipcRenderer.invoke("live2d-import:import-model", request) as Promise<Live2DModelImportResult>,
    scanImportedSources: (petId: string) =>
      ipcRenderer.invoke("live2d-import:scan-imported-sources", petId) as Promise<Live2DImportedSourceScanResult>,
    scanPreviewSources: (folderPath: string) =>
      ipcRenderer.invoke("live2d-import:scan-preview-sources", folderPath) as Promise<Live2DImportedSourceScanResult>,
    getDroppedFolderPath: (file: File) => webUtils.getPathForFile(file)
  },
  aiSettings: {
    list: () => ipcRenderer.invoke("ai-settings:list") as Promise<AiConnectionSummary[]>,
    get: (petId: string) =>
      ipcRenderer.invoke("ai-settings:get", petId) as Promise<AiConnectionSummary | undefined>,
    listModels: (draft: AiConnectionDraft) =>
      ipcRenderer.invoke("ai-settings:list-models", draft) as Promise<AiModelListResult>,
    testOutput: (draft: AiConnectionDraft) =>
      ipcRenderer.invoke("ai-settings:test-output", draft) as Promise<AiOutputCapabilityTestResult>,
    save: (draft: AiConnectionDraft) =>
      ipcRenderer.invoke("ai-settings:save", draft) as Promise<AiConnectionSaveResult>
  },
  screenVision: {
    getAvailability: (petId: string) =>
      ipcRenderer.invoke("screen-vision:get-availability", petId) as Promise<ScreenAwarenessAvailability>,
    testCurrent: (petId: string) =>
      ipcRenderer.invoke("screen-vision:test-current", petId) as Promise<ScreenVisionProbeResult>,
    listModels: (draft: ScreenVisionConnectionDraft) =>
      ipcRenderer.invoke("screen-vision:list-models", draft) as Promise<ScreenVisionModelListResult>,
    testIndependent: (draft: ScreenVisionConnectionDraft) =>
      ipcRenderer.invoke("screen-vision:test-independent", draft) as Promise<ScreenVisionProbeResult>,
    saveIndependent: (draft: ScreenVisionConnectionDraft) =>
      ipcRenderer.invoke("screen-vision:save-independent", draft) as Promise<ScreenVisionConnectionSummary>,
    saveSettings: (request: { petId: string; enabled: boolean; mode?: ScreenAwarenessMode; persistentCaptureEnabled?: boolean }) =>
      ipcRenderer.invoke("screen-vision:save-settings", request) as Promise<LocalPetSaveResult>
  },
  petPackage: {
    inspectExport: (petId: string) => ipcRenderer.invoke("pet-package:inspect-export", petId) as Promise<PetPackageExportInspection>,
    export: (petId: string) => ipcRenderer.invoke("pet-package:export", petId) as Promise<PetPackageExportResult>,
    beginImport: () => ipcRenderer.invoke("pet-package:begin-import") as Promise<PetPackageImportBeginResult>,
    listImportAiModels: (request: PetPackageImportAiModelsRequest) => ipcRenderer.invoke("pet-package:list-import-ai-models", request) as Promise<PetPackageImportAiModelsResult>,
    testImportAi: (request: PetPackageImportAiRequest) => ipcRenderer.invoke("pet-package:test-import-ai", request) as Promise<PetPackageImportStepResult>,
    pickGptSoVitsRoot: () => ipcRenderer.invoke("pet-package:pick-gpt-sovits-root") as Promise<PetPackageDirectoryPickResult>,
    testImportVoice: (request: PetPackageImportVoiceRequest) => ipcRenderer.invoke("pet-package:test-import-voice", request) as Promise<PetPackageImportStepResult>,
    commitImport: (request: PetPackageImportCommitRequest) => ipcRenderer.invoke("pet-package:commit-import", request) as Promise<PetPackageImportCommitResult>,
    cancelImport: (request: PetPackageImportCancelRequest) => ipcRenderer.invoke("pet-package:cancel-import", request) as Promise<PetPackageImportStepResult>,
    cancelOperation: (operationId: string) => ipcRenderer.invoke("pet-package:cancel-operation", operationId) as Promise<{ ok: boolean }>,
    onProgress: (callback: (progress: PetPackageProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: PetPackageProgress): void => callback(progress);
      ipcRenderer.on("pet-package:progress", listener);
      return () => { ipcRenderer.off("pet-package:progress", listener); };
    }
  },
  memory: {
    getSummary: (petId: string) =>
      ipcRenderer.invoke("memory:get-summary", petId) as Promise<MemoryResult<MemorySummary>>,
    list: (request: MemoryListRequest) =>
      ipcRenderer.invoke("memory:list", request) as Promise<MemoryResult<MemoryPage<MemoryRecord>>>,
    get: (request: MemoryGetRequest) =>
      ipcRenderer.invoke("memory:get", request) as Promise<MemoryResult<MemoryRecord | undefined>>,
    getSourceConversation: (request: MemorySourceConversationRequest) =>
      ipcRenderer.invoke("memory:get-source-conversation", request) as Promise<
        MemoryResult<MemorySourceConversation | undefined>
      >,
    search: (request: MemorySearchRequest) =>
      ipcRenderer.invoke("memory:search", request) as Promise<MemoryResult<MemoryPage<MemoryRecord>>>,
    create: (request: MemoryCreateRequest) =>
      ipcRenderer.invoke("memory:create", request) as Promise<
        MemoryResult<MemoryManagedRecordMutation>
      >,
    update: (request: MemoryUpdateRequest) =>
      ipcRenderer.invoke("memory:update", request) as Promise<
        MemoryResult<MemoryManagedRecordMutation>
      >,
    forget: (request: MemoryRevisionRequest) =>
      ipcRenderer.invoke("memory:forget", request) as Promise<
        MemoryResult<MemoryManagedForgetResult>
      >,
    undoForget: (request: MemoryRevisionRequest) =>
      ipcRenderer.invoke("memory:undo-forget", request) as Promise<
        MemoryResult<MemoryManagedRecordMutation>
      >,
    clear: (request: MemoryClearRequest) =>
      ipcRenderer.invoke("memory:clear", request) as Promise<
        MemoryResult<MemoryManagedClearResult>
      >,
    export: (request: MemoryExportRequest) =>
      ipcRenderer.invoke("memory:export", request) as Promise<MemoryResult<MemoryExportSaveResult>>,
    rebuildIndex: (petId: string) =>
      ipcRenderer.invoke("memory:rebuild-index", petId) as Promise<MemoryResult<MemoryIndexRebuildResult>>,
    getSettings: (petId: string) =>
      ipcRenderer.invoke("memory:get-settings", petId) as Promise<MemoryResult<MemorySettings>>,
    saveSettings: (request: MemorySettingsSaveRequest) =>
      ipcRenderer.invoke("memory:save-settings", request) as Promise<MemoryResult<MemorySettings>>,
    getProviderStatus: (petId: string) =>
      ipcRenderer.invoke("memory:get-provider-status", petId) as Promise<MemoryResult<MemoryProviderStatus>>,
    testProvider: (petId: string) =>
      ipcRenderer.invoke("memory:test-provider", petId) as Promise<MemoryResult<MemoryProviderStatus>>,
    getStatus: (petId: string) =>
      ipcRenderer.invoke("memory:get-status", petId) as Promise<MemoryResult<MemoryManagementStatus>>
  },
  petWindow: {
    show: (payload: DesktopPetPayload) =>
      ipcRenderer.invoke("pet-window:show", payload) as Promise<PetWindowState>,
    close: (options?: PetWindowCloseOptions) =>
      ipcRenderer.invoke("pet-window:close", options) as Promise<PetWindowState>,
    getState: () => ipcRenderer.invoke("pet-window:get-state") as Promise<PetWindowState>,
    previewSource: (request: PetWindowSourcePreviewRequest) =>
      ipcRenderer.invoke("pet-window:preview-source", request) as Promise<PetWindowSourcePreviewResult>,
    onStateChanged: (callback: (state: PetWindowState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: PetWindowState): void => {
        callback(state);
      };

      ipcRenderer.on("pet-window:state-changed", listener);

      return () => {
        ipcRenderer.off("pet-window:state-changed", listener);
      };
    },
    onSourcePreviewFinished: (callback: (event: PetWindowSourcePreviewFinishedEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, preview: PetWindowSourcePreviewFinishedEvent): void => {
        callback(preview);
      };

      ipcRenderer.on("pet-window:source-preview-finished", listener);
      return () => {
        ipcRenderer.off("pet-window:source-preview-finished", listener);
      };
    }
  }
};

contextBridge.exposeInMainWorld("desktopPet", desktopPetApi);

export type MainDesktopPetApi = typeof desktopPetApi;
