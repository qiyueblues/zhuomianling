import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { app, BrowserWindow, dialog, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AiChatStreamCancelRequest,
  AiChatStreamRequest,
  AiConnectionDraft
} from "../shared/types/ai";
import type {
  LocalPetAvatarCropSaveRequest,
  LocalPetBasicInfoDraft,
  LocalPetEventSettingsDraft,
  LocalPetExpressionMappingDraft,
  LocalPetPersonaDraft,
  LocalPetUiSettingsDraft,
  LocalPetVoiceInputDraft,
  LocalPetVoiceModelDraft,
  LocalPetVoiceResourceKind
} from "../shared/types/pet";
import type {
  SpeechStreamAudioChunk,
  SpeechStreamStartRequest,
  SpeechStreamStopRequest,
  SpeechToTextRequest,
  TextToSpeechRequest,
  TextToSpeechStopRequest
} from "../shared/types/speech";
import type {
  DesktopPetPayload,
  PetWindowDragPoint,
  PetWindowSourcePreviewRequest
} from "../shared/types/window";
import type { PetWindowCloseOptions } from "../shared/types/window";
import type { Live2DModelImportRequest } from "../shared/types/live2dImport";
import type {
  MemoryClearRequest,
  MemoryCreateRequest,
  MemoryExportRequest,
  MemoryGetRequest,
  MemoryListRequest,
  MemoryRevisionRequest,
  MemorySearchRequest,
  MemorySettingsSaveRequest,
  MemorySourceConversationRequest,
  MemoryUpdateRequest
} from "../shared/types/memory";
import type { StartupRendererStage } from "../shared/types/startup";
import {
  TIMED_DIAGNOSTICS_TEST_MODULE,
  type TimedDiagnosticEvent,
  type TimedDiagnosticSnapshot
} from "../shared/types/timedDiagnostics";
import type { PetPackageImportAiModelsRequest, PetPackageImportAiRequest, PetPackageImportCancelRequest, PetPackageImportCommitRequest, PetPackageImportVoiceRequest } from "../shared/types/petPackage";
import { sanitizePetPackageFileName } from "../shared/validation/petPackage";
import type { LocalPetMoodSettingsDraft, PetMoodEnterPreviewRequest, PetMoodMeterPosition, PetMoodVoiceImportRequest, PetMoodVoiceRemoveRequest } from "../shared/types/mood";
import type { SystemMoodEvent } from "../shared/mood";
import type {
  PresetVoiceDeleteOneRequest,
  PresetVoiceGenerationRequest,
  PresetVoicePreviewRequest,
  PresetVoiceTaskCancelRequest
} from "../shared/types/presetVoice";
import type {
  ScreenCaptureSessionRequest,
  ScreenFrameRequest,
  ScreenMonitorReplyStatusRequest,
  ScreenVisionConnectionDraft,
  ScreenVisionTimingRequest
} from "../shared/types/screen";
import { cancelAiChatStreams, startAiChatStream } from "./services/ai/aiChat";
import {
  getAiConnectionSummary,
  deleteAiConnection,
  listAiModels,
  listAiConnectionSummaries,
  saveAiConnection,
  testAiOutputCapability
} from "./services/ai/aiSettings";
import {
  getPetWindowState,
  getBoundPetWindowPayload,
  getCurrentPetWindowPayload,
  clearCurrentPetWindowPayload,
  closePetWindow,
  endPetWindowDrag,
  movePetWindowDrag,
  onPetWindowStateChanged,
  setPetWindowClickThroughControlInteractive,
  setPetWindowClickThrough,
  showPetWindow,
  startPetWindowDrag,
  togglePetWindowClickThrough,
  updateCurrentPetWindowPayload,
  isPetWindowWebContents,
  previewPetWindowSource,
  consumePendingPetWindowSourcePreview,
  completePetWindowSourcePreview
} from "./petWindow";
import {
  sendSpeechStreamAudio,
  startSpeechStream,
  stopSpeechStream,
  transcribeSpeech
} from "./services/speech/speechToText";
import { speakText, stopSpeechPlayback } from "./services/speech/textToSpeech";
import {
  importLocalPetAvatar,
  deleteLocalPet,
  getLocalPetDefinition,
  importLocalUiTheme,
  listLocalPets,
  scanLocalPetsForRecovery,
  saveLocalPetAvatarCrop,
  saveLocalPetBasicInfo,
  saveLocalPetEventSettings,
  saveLocalPetExpressionMappings,
  saveLocalPetPersona,
  saveLocalPetUiSettings,
  saveLocalPetVoiceInput,
  saveLocalPetVoiceModel,
  pickLocalPetVoiceModelFile,
  resetLocalPetVoiceRuntimeState,
  restoreLocalPetConfigBackup,
  stopManagedGptSoVitsApi,
  testLocalPetVoiceModelConnection,
  toPublicPetDefinition
  ,toPetRuntimeDefinition,
  saveLocalPetMoodSettings
  ,importLocalPetMoodVoice,
  removeLocalPetMoodVoice
} from "./services/config/petConfigStore";
import { moodService } from "./services/mood/MoodService";
import { writeTextFileAtomically } from "./services/config/durableJsonFile";
import { memoryManagementService } from "./services/memory/memoryManagement";
import { createMemoryExportFileName } from "./services/memory/memoryExport";
import {
  createLive2DPreviewModel,
  generateLive2DEntry,
  importLive2DModel,
  scanImportedLive2DSources,
  scanLive2DPreviewSources,
  selectLive2DFolder,
  validateLive2DFolder
} from "./services/config/live2dImportService";
import { revealMainWindowStartupSurface } from "./window";
import { validateIpcArguments } from "./ipcValidation";
import { assertIpcPetIdBound, assertIpcSenderAllowed, type IpcAccess } from "./ipcAccess";
import { startupProfiler } from "./startupProfiler";
import {
  getAppUpdateState, checkAppUpdates, scheduleStartupUpdateCheck,
  downloadAppUpdate, cancelAppUpdate, dismissAppUpdate, ignoreAppUpdateVersion,
  installAppUpdate, openAppUpdateReleasePage
} from "./appUpdates";
import { presetVoiceGenerationService } from "./services/presetVoice/PresetVoiceGenerationService";
import { exportPetPackage, inspectPetPackageExport } from "./services/petPackage/petPackageExportService";
import { beginPetPackageImport, cancelPetPackageImport, commitPetPackageImport, listPetPackageImportAiModels, testPetPackageImportAi, testPetPackageImportVoice } from "./services/petPackage/petPackageImportService";
import { cancelPetPackageOperation, onPetPackageProgress } from "./services/petPackage/petPackageOperation";
import { screenVisionService } from "./services/screen/ScreenVisionService";
import { screenCaptureService } from "./services/screen/ScreenCaptureService";
import { screenVisionTiming } from "./services/screen/ScreenVisionTiming";
import { startLocalHelpServer } from "./services/help/localHelpServer";

const localHelpPageFileName = "help.html";

function getLocalHelpPageRoot(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "dist",
      "renderer"
    );
  }

  return path.join(__dirname, "../renderer");
}

async function openLocalHelpPage(): Promise<{ ok: true } | { ok: false; message: string }> {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL?.replace(/\/$/, "");

  if (devServerUrl) {
    try {
      await shell.openExternal(`${devServerUrl}/${localHelpPageFileName}`);
      return { ok: true };
    } catch {
      return { ok: false, message: "本地教程网页打开失败。" };
    }
  }

  const localHelpPageRoot = getLocalHelpPageRoot();
  const localHelpPagePath = path.join(localHelpPageRoot, localHelpPageFileName);

  if (!existsSync(localHelpPagePath)) {
    return {
      ok: false,
      message: "本地教程网页尚未接入。"
    };
  }

  try {
    const localHelpServerUrl = await startLocalHelpServer(localHelpPageRoot);
    await shell.openExternal(`${localHelpServerUrl}/${localHelpPageFileName}`);
    return { ok: true };
  } catch {
    return { ok: false, message: "本地教程网页打开失败。" };
  }
}

export function registerIpc(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null): void {
  let moodRangeEventId = 0;
  const moodWindowSubscriptions = new Map<number, () => void>();
  const assertSenderAllowed = (
    channel: string,
    event: IpcMainEvent | IpcMainInvokeEvent,
    access: IpcAccess
  ): void => {
    assertIpcSenderAllowed(
      channel,
      access,
      event.sender,
      getMainWindow()?.webContents,
      isPetWindowWebContents(event.sender)
    );
  };

  const assertPetIdBound = (
    channel: string,
    event: IpcMainEvent | IpcMainInvokeEvent,
    requestedPetId: string
  ): void => {
    assertIpcPetIdBound(
      channel,
      requestedPetId,
      getBoundPetWindowPayload(event.sender)?.id
    );
  };

  // TIMED DIAGNOSTICS TEST MODULE: forward bounded timing events to the main
  // window. The renderer can only expose the page when the explicit timed
  // development launcher has enabled the matching Vite flag.
  const forwardTimedDiagnosticEvent = (event: TimedDiagnosticEvent): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("timed-diagnostics-test:event", event);
  };
  startupProfiler.subscribe(forwardTimedDiagnosticEvent);
  screenVisionTiming.subscribe(forwardTimedDiagnosticEvent);

  const handle = <Args extends unknown[], Result>(
    channel: string,
    access: IpcAccess,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertSenderAllowed(channel, event, access);
      validateIpcArguments(channel, args);
      return listener(event, ...(args as unknown as Args));
    });
  };

  const on = <Args extends unknown[]>(
    channel: string,
    access: IpcAccess,
    listener: (event: IpcMainEvent, ...args: Args) => void
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      try {
        assertSenderAllowed(channel, event, access);
        validateIpcArguments(channel, args);
        listener(event, ...(args as unknown as Args));
      } catch (error: unknown) {
        console.warn(
          `Rejected one-way IPC ${channel}.`,
          error instanceof Error ? error.message : "Unknown IPC validation error."
        );
      }
    });
  };

  const emitPetConfigChanged = (pet?: DesktopPetPayload["definition"]): void => {
    const publicPet = pet ? toPublicPetDefinition(pet) : undefined;
    const runtimePet = pet ? toPetRuntimeDefinition(pet) : undefined;

    if (publicPet) {
      updateCurrentPetWindowPayload({
        id: publicPet.id,
        name: publicPet.name,
        modelPath: publicPet.modelPath,
        avatar: publicPet.avatar,
        definition: runtimePet
      });
    }

    for (const targetWindow of BrowserWindow.getAllWindows()) {
      targetWindow.webContents.send(
        "pet-config:changed",
        isPetWindowWebContents(targetWindow.webContents) ? runtimePet : publicPet
      );
    }
  };

  onPetWindowStateChanged((state) => {
    for (const targetWindow of BrowserWindow.getAllWindows()) {
      targetWindow.webContents.send("pet-window:state-changed", state);
    }
  });

  onPetPackageProgress((progress) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("pet-package:progress", progress);
    if (progress.status === "running") {
      mainWindow.setProgressBar(progress.percent ?? 2, { mode: progress.percent === undefined ? "indeterminate" : "normal" });
    } else if (progress.status === "failed") {
      mainWindow.setProgressBar(1, { mode: "error" });
      setTimeout(() => { if (!mainWindow.isDestroyed()) mainWindow.setProgressBar(-1); }, 1200);
    } else {
      mainWindow.setProgressBar(-1);
    }
  });

  handle("app:get-version", "main", () => app.getVersion());

  handle("app-update:get-state", "main", getAppUpdateState);
  handle("app-update:check", "main", checkAppUpdates);
  handle("app-update:download", "main", () => downloadAppUpdate());
  handle("app-update:download-github", "main", () => downloadAppUpdate("github"));
  handle("app-update:cancel", "main", cancelAppUpdate);
  handle("app-update:dismiss", "main", dismissAppUpdate);
  handle("app-update:ignore-version", "main", ignoreAppUpdateVersion);
  handle("app-update:install", "main", installAppUpdate);
  handle("app-update:open-release", "main", openAppUpdateReleasePage);
  on("app-update:startup-ready", "main", scheduleStartupUpdateCheck);

  handle("app:open-local-help", "main", openLocalHelpPage);

  handle("timed-diagnostics-test:get-snapshot", "main", (): TimedDiagnosticSnapshot => ({
    module: TIMED_DIAGNOSTICS_TEST_MODULE,
    enabled: startupProfiler.enabled || screenVisionTiming.enabled,
    events: [
      ...startupProfiler.getEvents(),
      ...screenVisionTiming.getEvents()
    ]
  }));

  handle("app-window:is-shown", "main", () => getMainWindow()?.isVisible() ?? false);

  on("app-window:startup-surface-ready", "main", (event, reason?: string) => {
    const safeReason = typeof reason === "string" ? reason.slice(0, 120) : "renderer";

    startupProfiler.markOnce("startup-surface-ready-ipc", "主进程收到启动首帧 ready");
    revealMainWindowStartupSurface(safeReason);
  });

  on("app-window:startup-timing", "main", (_event, stage: StartupRendererStage) => {
    startupProfiler.reportRendererStage(stage);
    if (
      stage === "splash-hidden" &&
      process.env.ZHUOMIANLING_STARTUP_EXIT_AFTER_SPLASH === "1"
    ) {
      setImmediate(() => app.quit());
    }
  });

  handle("pet-config:list-local", "main", async () => {
    const result = await startupProfiler.measureOnce(
      "initial-pet-config-scan",
      "主进程扫描本地桌宠配置",
      () => scanLocalPetsForRecovery()
    );
    const corruption = result.corruptions[0];

    return {
      ok: !corruption,
      pets: result.pets,
      corruption: corruption
        ? {
            code: corruption.code,
            petId: corruption.petId,
            backupAvailable: corruption.backupAvailable,
            message: corruption.message
          }
        : undefined
    };
  });

  handle("pet-config:restore-backup", "main", async (_event, petId: string) => {
    const result = await restoreLocalPetConfigBackup(petId);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:import-ui-theme", "main", () => importLocalUiTheme());

  handle("mood:get-editor-state", "main", async (_event, petId: string) => {
    const pet = await getLocalPetDefinition(petId);
    return { display: await moodService.getDisplayState(petId), settings: pet?.moodSettings };
  });

  const presetVoiceSucceededByPet = new Map<string, number>();
  presetVoiceGenerationService.onProgress((snapshot) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("preset-voice:progress", snapshot);
    }
    const previousSucceeded = presetVoiceSucceededByPet.get(snapshot.petId) ?? 0;
    if (snapshot.succeeded > previousSucceeded) {
      presetVoiceSucceededByPet.set(snapshot.petId, snapshot.succeeded);
      void getLocalPetDefinition(snapshot.petId)
        .then((pet) => emitPetConfigChanged(pet))
        .catch(() => undefined);
    }
    if (snapshot.status !== "running") presetVoiceSucceededByPet.delete(snapshot.petId);
  });

  moodService.subscribeMutations((petId, result) => {
    if (!result.enteredRangeId) return;
    void getLocalPetDefinition(petId).then((pet) => {
      const settings = pet?.moodSettings?.ranges?.[result.enteredRangeId!];
      const source = settings?.enterSource;
      const line = settings?.enterLine;
      if (!source && !line) return;
      for (const targetWindow of BrowserWindow.getAllWindows()) {
        if (getBoundPetWindowPayload(targetWindow.webContents)?.id === petId) {
          targetWindow.webContents.send("mood:range-entered", {
            id: ++moodRangeEventId,
            rangeId: result.enteredRangeId,
            ...(source ? { source } : {}),
            ...(line ? { line } : {})
          });
        }
      }
    }).catch(() => undefined);
  });

  handle("mood:save-settings", "main", async (_event, draft: LocalPetMoodSettingsDraft) => {
    const result = await saveLocalPetMoodSettings(draft);
    if (result.ok) emitPetConfigChanged(result.pet);
    return result;
  });

  handle("mood:import-range-voice", "main", async (_event, request: PetMoodVoiceImportRequest) => {
    const result = await importLocalPetMoodVoice(request);
    if (result.ok && result.pet) emitPetConfigChanged(result.pet);
    const { pet: _pet, ...publicResult } = result;
    return publicResult;
  });

  handle("mood:remove-range-voice", "main", async (_event, request: PetMoodVoiceRemoveRequest) => {
    const result = await removeLocalPetMoodVoice(request);
    if (result.ok) emitPetConfigChanged(result.pet);
    return result;
  });

  handle("mood:preview-enter-source", "main", async (_event, request: PetMoodEnterPreviewRequest) => {
    const pet = await getLocalPetDefinition(request.petId);
    const source = request.source;
    if (!pet?.modelPath || !source) return { ok: false, message: "当前心情区间没有可预览的进入表现。", state: getPetWindowState() };
    const available = pet.expressionSources?.some((candidate) => candidate.sourceKind === source.sourceKind && candidate.sourceFileName === source.sourceFileName && String(candidate.runtimeName ?? "") === String(source.runtimeName ?? ""));
    if (!available) return { ok: false, message: "所选进入表现源已失效，请重新选择。", state: getPetWindowState() };
    return previewPetWindowSource({ id: pet.id, name: pet.name, modelPath: pet.modelPath, avatar: pet.avatar, definition: toPetRuntimeDefinition(pet) }, source);
  });

  handle("preset-voice:get-overview", "main", (_event, petId: string) =>
    presetVoiceGenerationService.getOverview(petId)
  );

  handle("preset-voice:get-task", "main", (_event, petId: string) =>
    presetVoiceGenerationService.getTask(petId)
  );

  handle("preset-voice:start", "main", (_event, request: PresetVoiceGenerationRequest) =>
    presetVoiceGenerationService.start(request)
  );

  handle("preset-voice:cancel", "main", (_event, request: PresetVoiceTaskCancelRequest) => ({
    ...(() => {
      const ok = presetVoiceGenerationService.cancel(request.petId, request.taskId);
      return { ok, message: ok ? "已请求取消预设语音生成任务。" : "没有找到可取消的生成任务。" };
    })()
  }));

  handle("preset-voice:preview", "main", (_event, request: PresetVoicePreviewRequest) =>
    presetVoiceGenerationService.preview(request.petId, request.targetId)
  );

  handle("preset-voice:delete-all", "main", async (_event, petId: string) => {
    const result = await presetVoiceGenerationService.deleteAll(petId);
    if (result.pet) emitPetConfigChanged(result.pet);
    const { pet: _pet, ...publicResult } = result;
    return publicResult;
  });

  handle("preset-voice:delete-one", "main", async (_event, request: PresetVoiceDeleteOneRequest) => {
    const result = await presetVoiceGenerationService.deleteOne(request.petId, request.targetId);
    if (result.pet) emitPetConfigChanged(result.pet);
    const { pet: _pet, ...publicResult } = result;
    return publicResult;
  });

  handle("preset-voice:load-runtime", "pet", (event, request: PresetVoicePreviewRequest) => {
    assertPetIdBound("preset-voice:load-runtime", event, request.petId);
    return presetVoiceGenerationService.preview(request.petId, request.targetId);
  });

  handle("mood:get-display-state", "pet", async (event) => {
    const petId = getBoundPetWindowPayload(event.sender)?.id;
    if (!petId) throw new Error("心情请求未绑定桌宠。");
    if (!moodWindowSubscriptions.has(event.sender.id)) {
      const unsubscribe = moodService.subscribe(petId, (state) => {
        if (!event.sender.isDestroyed()) event.sender.send("mood:display-state-changed", state);
      });
      moodWindowSubscriptions.set(event.sender.id, unsubscribe);
      event.sender.once("destroyed", () => {
        moodWindowSubscriptions.get(event.sender.id)?.();
        moodWindowSubscriptions.delete(event.sender.id);
        moodService.disposeOwner(event.sender.id);
      });
    }
    return moodService.getDisplayState(petId);
  });

  handle("mood:report-system-event", "pet", async (event, systemEvent: SystemMoodEvent) => {
    const petId = getBoundPetWindowPayload(event.sender)?.id;
    if (!petId) throw new Error("心情事件未绑定桌宠。");
    const result = await moodService.applySystemEvent(petId, systemEvent);
    return result;
  });

  handle("mood:save-meter-position", "pet", async (event, position: PetMoodMeterPosition) => {
    const petId = getBoundPetWindowPayload(event.sender)?.id;
    if (!petId) throw new Error("心情位置未绑定桌宠。");
    await moodService.saveMeterPosition(petId, position);
  });

  handle("pet-config:save-basic-info", "main", async (_event, draft: LocalPetBasicInfoDraft) => {
    const result = await saveLocalPetBasicInfo(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-persona", "main", async (_event, draft: LocalPetPersonaDraft) => {
    const result = await saveLocalPetPersona(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-expression-mappings", "main", async (_event, draft: LocalPetExpressionMappingDraft) => {
    const result = await saveLocalPetExpressionMappings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-event-settings", "main", async (_event, draft: LocalPetEventSettingsDraft) => {
    const result = await saveLocalPetEventSettings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-ui-settings", "main", async (_event, draft: LocalPetUiSettingsDraft) => {
    const result = await saveLocalPetUiSettings(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:save-voice-input", "main", async (_event, draft: LocalPetVoiceInputDraft) => {
    const result = await saveLocalPetVoiceInput(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:pick-voice-model-file", "main", (_event, kind: LocalPetVoiceResourceKind) =>
    pickLocalPetVoiceModelFile(kind)
  );

  handle("pet-config:test-voice-model-connection", "main", (_event, draft: LocalPetVoiceModelDraft) =>
    testLocalPetVoiceModelConnection(draft)
  );

  handle("pet-config:disconnect-voice-model", "main", async () => {
    stopManagedGptSoVitsApi();
    await resetLocalPetVoiceRuntimeState();

    emitPetConfigChanged();

    return {
      ok: true,
      message: "已断开连接。"
    };
  });

  handle("pet-config:save-voice-model", "main", async (_event, draft: LocalPetVoiceModelDraft) => {
    const result = await saveLocalPetVoiceModel(draft);

    if (result.ok) {
      emitPetConfigChanged(result.pet);
    }

    return result;
  });

  handle("pet-config:import-avatar", "main", (_event, petId?: string) =>
    importLocalPetAvatar(petId)
  );

  handle("pet-config:save-avatar-crop", "main", (_event, request: LocalPetAvatarCropSaveRequest) =>
    saveLocalPetAvatarCrop(request)
  );

  handle("pet-config:delete", "main", async (_event, petId: string) => {
    const currentPayload = getCurrentPetWindowPayload();

    if (currentPayload?.id === petId) {
      const closeState = await closePetWindow({ playEffect: false });

      if (closeState.visible && closeState.petId === petId) {
        return {
          ok: false,
          message: "桌宠窗口尚未关闭，未执行删除。请重试。",
          petId
        };
      }
    }

    await presetVoiceGenerationService.disposePet(petId);
    await screenCaptureService.stopForPet(petId);
    const result = await memoryManagementService.runPetDeletion(
      petId,
      () => deleteLocalPet(petId, {
        finalizeDeletion: async (deletingPetId) => {
          await deleteAiConnection(deletingPetId);
          await screenVisionService.deleteForPetWhilePetConfigLocked(deletingPetId);
        }
      })
    );

    if (result.ok) {
      clearCurrentPetWindowPayload(result.petId);
      emitPetConfigChanged();
    }

    return result;
  });

  handle("live2d-import:select-folder", "main", () => selectLive2DFolder());

  handle("live2d-import:validate-folder", "main", (_event, folderPath: string) =>
    validateLive2DFolder(folderPath)
  );

  handle("live2d-import:generate-entry", "main", (_event, folderPath: string) =>
    generateLive2DEntry(folderPath)
  );

  handle("live2d-import:create-preview-model", "main", (_event, folderPath: string) =>
    createLive2DPreviewModel(folderPath)
  );

  handle("live2d-import:import-model", "main", async (_event, request: Live2DModelImportRequest) => {
    const result = await importLive2DModel(request);
    const publicResult = result.pet
      ? {
          ...result,
          pet: toPublicPetDefinition(result.pet)
        }
      : result;

    if (publicResult.ok) {
      emitPetConfigChanged(publicResult.pet);
    }

    return publicResult;
  });

  handle("live2d-import:scan-imported-sources", "main", (_event, petId: string) =>
    scanImportedLive2DSources(petId)
  );

  handle("live2d-import:scan-preview-sources", "main", (_event, folderPath: string) =>
    scanLive2DPreviewSources(folderPath)
  );

  handle("ai-settings:list", "main", () => listAiConnectionSummaries());

  handle("ai-settings:get", "main", (_event, petId: string) => getAiConnectionSummary(petId));

  handle("pet-package:inspect-export", "main", (_event, petId: string) => inspectPetPackageExport(petId));

  handle("pet-package:export", "main", async (_event, petId: string) => {
    const pet = await getLocalPetDefinition(petId);
    if (!pet) return { ok: false, message: "桌宠不存在。" };
    const options = {
      title: "导出桌宠",
      defaultPath: path.join(app.getPath("documents"), sanitizePetPackageFileName(pet.name)),
      filters: [{ name: "桌面灵桌宠包", extensions: ["zmling"] }]
    };
    const mainWindow = getMainWindow();
    const selection = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) return { ok: false, canceled: true, message: "已取消导出。" };
    const destination = selection.filePath.toLowerCase().endsWith(".zmling") ? selection.filePath : `${selection.filePath}.zmling`;
    return exportPetPackage(petId, destination);
  });

  handle("pet-package:begin-import", "main", async (event) => {
    const options: OpenDialogOptions = { title: "导入桌宠", properties: ["openFile"], filters: [{ name: "桌面灵桌宠包", extensions: ["zmling"] }] };
    const mainWindow = getMainWindow();
    const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return { ok: false, canceled: true, message: "已取消选择。" };
    return beginPetPackageImport(selection.filePaths[0], event.sender.id);
  });

  handle("pet-package:test-import-ai", "main", (event, request: PetPackageImportAiRequest) => testPetPackageImportAi(request, event.sender.id));
  handle("pet-package:list-import-ai-models", "main", (event, request: PetPackageImportAiModelsRequest) => listPetPackageImportAiModels(request, event.sender.id));

  handle("pet-package:pick-gpt-sovits-root", "main", async () => {
    const options: OpenDialogOptions = { title: "选择 GPT-SoVITS 完整文件夹", properties: ["openDirectory"] };
    const mainWindow = getMainWindow();
    const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return selection.canceled || !selection.filePaths[0]
      ? { ok: false, canceled: true, message: "已取消选择。" }
      : { ok: true, message: "已选择 GPT-SoVITS 目录。", directoryPath: selection.filePaths[0] };
  });

  handle("pet-package:test-import-voice", "main", (event, request: PetPackageImportVoiceRequest) => testPetPackageImportVoice(request.sessionId, request.gptSoVitsRootPath, event.sender.id));
  handle("pet-package:commit-import", "main", async (event, request: PetPackageImportCommitRequest) => {
    const result = await commitPetPackageImport(request.sessionId, event.sender.id);
    if (result.ok && result.pet) emitPetConfigChanged(result.pet);
    return { ...result, pet: result.pet ? toPublicPetDefinition(result.pet) : undefined };
  });
  handle("pet-package:cancel-import", "main", (event, request: PetPackageImportCancelRequest) => cancelPetPackageImport(request.sessionId, event.sender.id));
  handle("pet-package:cancel-operation", "main", (_event, operationId: string) => ({ ok: cancelPetPackageOperation(operationId) }));

  handle("ai-settings:list-models", "main", (_event, draft: AiConnectionDraft) =>
    listAiModels(draft)
  );

  handle("ai-settings:test-output", "main", (_event, draft: AiConnectionDraft) =>
    testAiOutputCapability(draft)
  );

  handle("ai-settings:save", "main", async (_event, draft: AiConnectionDraft) => {
    const result = await saveAiConnection(draft);
    if (result.test.ok) {
      await screenVisionService.invalidateAwarenessAfterAiConfigChange(draft.petId);
      emitPetConfigChanged(await getLocalPetDefinition(draft.petId));
    }
    return result;
  });

  handle("screen-vision:get-availability", "main", (_event, petId: string) =>
    screenVisionService.getAvailability(petId)
  );

  handle("screen-vision:test-current", "main", (_event, petId: string) =>
    screenVisionService.testCurrentChatVision(petId)
  );

  handle("screen-vision:list-models", "main", (_event, draft: ScreenVisionConnectionDraft) =>
    screenVisionService.listIndependentVisionModels(draft)
  );

  handle("screen-vision:test-independent", "main", (_event, draft: ScreenVisionConnectionDraft) =>
    screenVisionService.testIndependentVision(draft)
  );

  handle("screen-vision:save-independent", "main", (_event, draft: ScreenVisionConnectionDraft) =>
    screenVisionService.saveIndependentVision(draft).then(async (summary) => {
      emitPetConfigChanged(await getLocalPetDefinition(draft.petId));
      return summary;
    })
  );

  handle("screen-vision:save-settings", "main", async (_event, draft: { petId: string; enabled: boolean; mode?: "quiet" | "companion"; persistentCaptureEnabled?: boolean }) => {
    const result = await screenVisionService.saveAwarenessSettings(draft);
    if (result.ok) emitPetConfigChanged(result.pet);
    if (!draft.enabled) await screenCaptureService.stopForPet(draft.petId);
    else if (draft.persistentCaptureEnabled === false) await screenCaptureService.stopPersistentForPet(draft.petId);
    return result;
  });

  handle("screen-vision:pet-availability", "pet", async (event) => {
    const petId = getBoundPetWindowPayload(event.sender)?.id;
    if (!petId) throw new Error("视觉请求未绑定桌宠。");
    return screenVisionService.getAvailability(petId);
  });

  handle("screen-vision:list-sources", "pet", async (event) => {
    const petId = getBoundPetWindowPayload(event.sender)?.id;
    if (!petId) throw new Error("视觉请求未绑定桌宠。");
    const availability = await screenVisionService.getAvailability(petId);
    if (!availability.canUseVision) return [];
    return screenCaptureService.listSources(event.sender);
  });

  handle("screen-vision:start", "pet", async (event, request: ScreenCaptureSessionRequest) => {
    assertPetIdBound("screen-vision:start", event, request.petId);
    const availability = await screenVisionService.getAvailability(request.petId);
    return screenCaptureService.startSession(event.sender, request, availability.canUseVision);
  });

  handle("screen-vision:frame", "pet", (event, request: ScreenFrameRequest) => {
    assertPetIdBound("screen-vision:frame", event, request.petId);
    return screenCaptureService.processFrame(event.sender, request);
  });

  on("screen-vision:timing", "pet", (event, request: ScreenVisionTimingRequest) => {
    assertPetIdBound("screen-vision:timing", event, request.petId);
    screenVisionTiming.mark(
      request.requestId,
      request.phase,
      request.stage,
      request.ok ?? true,
      request.kind ?? "vision"
    );
  });

  handle("screen-vision:stop", "pet", async (event, request: { petId: string; sessionId?: string }) => {
    assertPetIdBound("screen-vision:stop", event, request.petId);
    return {
      ok: await screenCaptureService.stop(event.sender, request.sessionId),
      message: "视觉观察已停止。"
    };
  });

  on("screen-vision:reply-status", "pet", (event, request: ScreenMonitorReplyStatusRequest) => {
    assertPetIdBound("screen-vision:reply-status", event, request.petId);
    screenCaptureService.reportReplyDelivery(event.sender, request);
  });

  handle("screen-vision:get-state", "pet", (event) => {
    const state = screenCaptureService.getState(event.sender);
    return state ?? {
      sessionId: "",
      purpose: "manual-monitor" as const,
      mode: "quiet" as const,
      state: "inactive" as const
    };
  });

  handle("memory:get-summary", "main", (_event, petId: string) =>
    memoryManagementService.getSummary(petId)
  );

  handle("memory:list", "main", (_event, request: MemoryListRequest) =>
    memoryManagementService.list(request)
  );

  handle("memory:get", "main", (_event, request: MemoryGetRequest) =>
    memoryManagementService.get(request)
  );

  handle("memory:get-source-conversation", "main", (_event, request: MemorySourceConversationRequest) =>
    memoryManagementService.getSourceConversation(request)
  );

  handle("memory:search", "main", (_event, request: MemorySearchRequest) =>
    memoryManagementService.search(request)
  );

  handle("memory:create", "main", (_event, request: MemoryCreateRequest) =>
    memoryManagementService.create(request)
  );

  handle("memory:update", "main", (_event, request: MemoryUpdateRequest) =>
    memoryManagementService.update(request)
  );

  handle("memory:forget", "main", (_event, request: MemoryRevisionRequest) =>
    memoryManagementService.forget(request)
  );

  handle("memory:undo-forget", "main", (_event, request: MemoryRevisionRequest) =>
    memoryManagementService.undoForget(request)
  );

  handle("memory:clear", "main", (_event, request: MemoryClearRequest) =>
    memoryManagementService.clear(request)
  );

  handle("memory:export", "main", async (_event, request: MemoryExportRequest) => {
    const prepared = await memoryManagementService.exportSnapshot(request);
    if (!prepared.ok) return prepared;
    const extension = request.options.format === "json" ? "json" : "md";
    const pet = await getLocalPetDefinition(request.petId);
    const options = {
      title: "导出桌宠记忆",
      defaultPath: createMemoryExportFileName(pet?.name, request.petId, extension),
      filters: [{
        name: request.options.format === "json" ? "JSON" : "Markdown",
        extensions: [extension]
      }]
    };
    const mainWindow = getMainWindow();
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) {
      return {
        ok: true as const,
        value: {
          canceled: true,
          format: prepared.value.format,
          recordCount: prepared.value.recordCount,
          message: "已取消导出。"
        }
      };
    }
    try {
      await writeTextFileAtomically(selection.filePath, prepared.value.content);
      return {
        ok: true as const,
        value: {
          canceled: false,
          format: prepared.value.format,
          recordCount: prepared.value.recordCount,
          fileName: path.basename(selection.filePath),
          message: "记忆已导出。"
        }
      };
    } catch {
      return {
        ok: false as const,
        error: {
          code: "storage-unavailable" as const,
          message: "无法写入所选导出文件。",
          retryable: true
        }
      };
    }
  });

  handle("memory:rebuild-index", "main", (_event, petId: string) =>
    memoryManagementService.rebuildIndex(petId)
  );

  handle("memory:get-settings", "main", (_event, petId: string) =>
    memoryManagementService.getSettings(petId)
  );

  handle("memory:save-settings", "main", async (_event, request: MemorySettingsSaveRequest) => {
    const result = await memoryManagementService.saveSettings(request);
    if (result.ok) {
      emitPetConfigChanged(await getLocalPetDefinition(request.petId));
    }
    return result;
  });

  handle("memory:get-provider-status", "main", (_event, petId: string) =>
    memoryManagementService.getProviderStatus(petId)
  );

  handle("memory:test-provider", "main", (_event, petId: string) =>
    memoryManagementService.testProvider(petId)
  );

  handle("memory:get-status", "main", (_event, petId: string) =>
    memoryManagementService.getStatus(petId)
  );

  handle("ai-chat:stream", "pet", (event, request: AiChatStreamRequest) => {
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId)
    ) {
      return {
        ok: false,
        message: "AI 请求标识无效。"
      };
    }

    assertPetIdBound("ai-chat:stream", event, request.petId);

    const streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    void startAiChatStream(event.sender, request, streamId);

    return {
      ok: true,
      message: "ok",
      requestId: request.requestId,
      streamId
    };
  });

  handle("ai-chat:cancel", "pet", (event, request?: AiChatStreamCancelRequest) => {
    if (request?.petId) {
      assertPetIdBound("ai-chat:cancel", event, request.petId);
    }

    return cancelAiChatStreams(event.sender, request);
  });

  handle("speech-to-text:transcribe", "pet", (event, request: SpeechToTextRequest) => {
    if (request.petId) {
      assertPetIdBound("speech-to-text:transcribe", event, request.petId);
    }

    return transcribeSpeech(request);
  });

  handle("text-to-speech:speak", "pet", (event, request: TextToSpeechRequest) => {
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId)
    ) {
      return {
        ok: false,
        message: "语音请求标识无效。"
      };
    }

    assertPetIdBound("text-to-speech:speak", event, request.petId);

    return speakText(event.sender, request);
  });

  handle("text-to-speech:stop", "pet", (event, request?: TextToSpeechStopRequest) => {
    if (request?.petId) {
      assertPetIdBound("text-to-speech:stop", event, request.petId);
    }

    return stopSpeechPlayback(event.sender, request);
  });

  handle("speech-stream:start", "pet", (event, request: SpeechStreamStartRequest) => {
    assertPetIdBound("speech-stream:start", event, request.petId);
    return startSpeechStream(event.sender, request);
  });

  on("speech-stream:audio", "pet", (_event, chunk: SpeechStreamAudioChunk) => {
    sendSpeechStreamAudio(chunk);
  });

  on("speech-stream:stop", "pet", (_event, request: SpeechStreamStopRequest) => {
    stopSpeechStream(request);
  });

  on("window:minimize", "main", () => {
    getMainWindow()?.minimize();
  });

  on("window:close", "main", () => {
    getMainWindow()?.close();
  });

  handle("pet-window:show", "main", (_event, payload: DesktopPetPayload) =>
    showPetWindow({
      ...payload,
      definition: payload.definition ? toPublicPetDefinition(payload.definition) : undefined
    })
  );

  handle("pet-window:close", "both", async (event, options?: PetWindowCloseOptions) => {
    if (isPetWindowWebContents(event.sender)) {
      await screenCaptureService.stopForOwner(event.sender);
    } else {
      const currentPetId = getCurrentPetWindowPayload()?.id;
      if (currentPetId) await screenCaptureService.stopForPet(currentPetId);
    }
    return closePetWindow(options);
  });

  handle("pet-window:toggle-click-through", "pet", async (event) => {
    const nextState = await togglePetWindowClickThrough();
    if (nextState.clickThrough) screenCaptureService.stopDirectQuestionForOwner(event.sender);
    return nextState;
  });

  handle("pet-window:set-click-through", "pet", (event, value: boolean) => {
    if (value) screenCaptureService.stopDirectQuestionForOwner(event.sender);
    return setPetWindowClickThrough(value);
  });

  handle("pet-window:set-click-through-control-interactive", "pet", (_event, value: boolean) =>
    setPetWindowClickThroughControlInteractive(value)
  );

  handle("pet-window:start-drag", "pet", (_event, point: PetWindowDragPoint) =>
    startPetWindowDrag(point)
  );

  handle("pet-window:move-drag", "pet", (_event, point: PetWindowDragPoint) =>
    movePetWindowDrag(point)
  );

  handle("pet-window:end-drag", "pet", () => endPetWindowDrag());

  handle("pet-window:get-state", "both", () => getPetWindowState());

  handle("pet-window:get-payload", "pet", () => getCurrentPetWindowPayload());

  handle("pet-window:consume-pending-source-preview", "pet", () =>
    consumePendingPetWindowSourcePreview()
  );

  handle("pet-window:complete-source-preview", "pet", (event, previewId: number) =>
    completePetWindowSourcePreview(event.sender, previewId)
  );

  handle("pet-window:preview-source", "main", async (_event, request: PetWindowSourcePreviewRequest) => {
    const pet = (await listLocalPets()).find((candidate) => candidate.id === request.petId);

    if (!pet?.modelPath) {
      return {
        ok: false,
        message: "当前桌宠还没有可预览的 Live2D 模型。",
        state: getPetWindowState()
      };
    }

    return previewPetWindowSource(
      {
        id: pet.id,
        name: pet.name,
        modelPath: pet.modelPath,
        avatar: pet.avatar,
        definition: toPublicPetDefinition(pet)
      },
      {
        sourceKind: request.source.sourceKind,
        sourceFileName: request.source.sourceFileName,
        runtimeName: request.source.runtimeName
      }
    );
  });
}
