import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CircleHelp, FolderOpen, MousePointer2, PackageOpen, Plus, Sparkles, Trash2 } from "lucide-react";
import type { LocalPetConfigCorruption, PetDefinition } from "../../shared/types/pet";
import type { PetWindowState } from "../../shared/types/window";
import type { MemoryBookRouteState } from "../components/MemoryBook/memoryBookState";
import type { ActiveEditorPanel } from "../components/PetEditor/editorNavigation";
import { PetSelector } from "../components/PetSelector/PetSelector";
import { StartupSplash } from "../components/StartupSplash/StartupSplash";
import { hasUsableLive2DModel, loadAvailablePets } from "../pets/petSources";
import { DeferredViewBoundary } from "./DeferredViewBoundary";
import { PetPackageImportDialog } from "../components/PetPackage/PetPackageImportDialog";
import { TIMED_DIAGNOSTICS_TEST_ENABLED } from "../components/TimedDiagnosticsTest/timedDiagnosticsTest";

const PetEditor = lazy(async () => {
  const module = await import("../components/PetEditor/PetEditor");
  return { default: module.PetEditor };
});
const MemoryBook = lazy(async () => {
  const module = await import("../components/MemoryBook/MemoryBook");
  return { default: module.MemoryBook };
});
const PetStage = lazy(async () => {
  const module = await import("../components/PetStage/PetStage");
  return { default: module.PetStage };
});
const TimedDiagnosticsTestPage = lazy(async () => {
  const module = await import("../components/TimedDiagnosticsTest/TimedDiagnosticsTestPage");
  return { default: module.TimedDiagnosticsTestPage };
});
const HelpCenter = lazy(async () => {
  await import("../styles/surfaces/85-help-center.css");
  const module = await import("../components/HelpCenter/HelpCenter");
  return { default: module.HelpCenter };
});
const AppUpdateControl = lazy(async () => {
  await import("../styles/surfaces/84-app-update.css");
  const module = await import("../components/AppUpdate/AppUpdateControl");
  return { default: module.AppUpdateControl };
});

type AppView = "selector" | "editor" | "memoryBook" | "timedDiagnosticsTest";

const MIN_STARTUP_SPLASH_MS = 2000;
const STARTUP_SPLASH_EXIT_MS = 360;
const HOME_ICON_SRC = "./icons/home-icon.jpg";

function getRemainingStartupSplashMs(): number {
  const startupSurfaceShownAt = window.__desktopPetStartupSurfaceShownAt;

  if (typeof startupSurfaceShownAt !== "number" || !Number.isFinite(startupSurfaceShownAt)) {
    // A renderer that reached React through the main-process fallback may not
    // have the static FCP timestamp. Keep the previous safe minimum in that case.
    return MIN_STARTUP_SPLASH_MS;
  }

  return Math.max(0, MIN_STARTUP_SPLASH_MS - (performance.now() - startupSurfaceShownAt));
}

interface EditorPageOptions {
  mode?: "create" | "edit";
  petId?: string;
  initialPanel?: ActiveEditorPanel;
}

function DeferredViewFallback({ label }: { label: string }): JSX.Element {
  return (
    <section className="stagePane selectorGuideStage deferredViewFallback" role="status" aria-live="polite">
      <div className="selectorGuideVisual" aria-hidden="true">
        <span className="selectorGuideScreen"><Sparkles size={24} /></span>
      </div>
      <div className="selectorGuideCopy">
        <h2>{label}</h2>
        <p>正在加载，请稍候…</p>
      </div>
    </section>
  );
}

function HelpCenterLoadingFallback(): JSX.Element {
  return (
    <div className="unsavedOverlay" role="status" aria-live="polite">
      <div className="unsavedDialog">
        <span className="unsavedIcon" aria-hidden="true">
          <CircleHelp size={22} />
        </span>
        <div className="unsavedText">
          <h2>正在打开帮助中心</h2>
          <p>正在载入帮助界面，请稍候…</p>
        </div>
      </div>
    </div>
  );
}

function DeletePetDialog({
  pet,
  step,
  deleting,
  onCancel,
  onContinue,
  onConfirm
}: {
  pet: PetDefinition;
  step: 1 | 2;
  deleting: boolean;
  onCancel: () => void;
  onContinue: () => void;
  onConfirm: () => void | Promise<void>;
}): JSX.Element {
  const finalStep = step === 2;

  return (
    <div className="unsavedOverlay" role="dialog" aria-modal="true" aria-label={`删除 ${pet.name}`}>
      <div className="unsavedDialog deletePetDialog">
        <span className="unsavedIcon deletePetIcon" aria-hidden="true">
          {finalStep ? <AlertTriangle size={22} /> : <Trash2 size={21} />}
        </span>
        <div className="unsavedText deletePetText">
          <h2>{finalStep ? "最后确认删除" : "删除这只桌宠？"}</h2>
          <p>
            {finalStep
              ? "删除后会清理它的本地配置、头像和已导入资源，无法从软件内恢复。"
              : "这会移除这只本地桌宠和它关联的本机配置。"}
          </p>
          <strong className="deletePetName">{pet.name}</strong>
        </div>
        <div className="unsavedActions">
          <button className="secondaryAction" type="button" disabled={deleting} onClick={onCancel}>
            取消
          </button>
          <button
            className={finalStep ? "primaryAction danger" : "secondaryAction danger"}
            type="button"
            disabled={deleting}
            onClick={() => {
              if (finalStep) {
                void onConfirm();
                return;
              }

              onContinue();
            }}
          >
            {deleting ? "删除中" : finalStep ? "确认删除" : "继续"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfigRecoveryDialog({
  corruption,
  restoring,
  onDismiss,
  onRestore
}: {
  corruption: LocalPetConfigCorruption;
  restoring: boolean;
  onDismiss: () => void;
  onRestore: () => void | Promise<void>;
}): JSX.Element {
  return (
    <div className="unsavedOverlay" role="dialog" aria-modal="true" aria-label="桌宠配置损坏">
      <div className="unsavedDialog deletePetDialog">
        <span className="unsavedIcon deletePetIcon" aria-hidden="true">
          <AlertTriangle size={22} />
        </span>
        <div className="unsavedText deletePetText">
          <h2>桌宠配置需要恢复</h2>
          <p>{corruption.message}</p>
          <strong className="deletePetName">{corruption.petId}</strong>
          <p>
            {corruption.backupAvailable
              ? "程序没有覆盖损坏文件。你可以明确选择恢复最近一次有效备份。"
              : "程序没有覆盖损坏文件。当前没有可用备份，请从外部备份恢复后再重试。"}
          </p>
        </div>
        <div className="unsavedActions">
          <button className="secondaryAction" type="button" disabled={restoring} onClick={onDismiss}>
            稍后处理
          </button>
          {corruption.backupAvailable ? (
            <button
              className="primaryAction"
              type="button"
              disabled={restoring}
              onClick={() => void onRestore()}
            >
              {restoring ? "恢复中" : "恢复最近备份"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SelectorGuideStage({
  hasPets,
  onCreatePet
}: {
  hasPets: boolean;
  onCreatePet: () => void;
}): JSX.Element {
  return (
    <section className="stagePane selectorGuideStage" aria-label={hasPets ? "桌宠详情占位" : "创建桌宠"}>
      <div className="selectorGuideVisual" aria-hidden="true">
        <span className="selectorGuideScreen">
          <Sparkles size={24} />
        </span>
        <span className="selectorGuidePet">
          {hasPets ? <MousePointer2 size={24} /> : <Plus size={26} />}
        </span>
      </div>

      <div className="selectorGuideCopy">
        <h2>{hasPets ? "选择一只桌宠" : "还没有桌宠"}</h2>
        <p>
          {hasPets
            ? "点选左侧列表后，这里会显示预览、启用状态和编辑入口。"
            : "创建后可以导入 Live2D 模型，并为它配置对话、表现和声音。"}
        </p>
      </div>

      <div className="selectorGuideActions">
        {hasPets ? (
          <span className="selectorGuideHint">
            <FolderOpen size={16} />
            等待选择
          </span>
        ) : null}
        <button className="primaryAction" type="button" onClick={onCreatePet}>
          <Plus size={17} />
          {hasPets ? "创建新桌宠" : "创建第一只桌宠"}
        </button>
      </div>
    </section>
  );
}

const createBlankPetDraft = (): PetDefinition => ({
  id: "new-pet",
  name: "",
  description: "",
  modelPath: "",
  avatar: "",
  personaPrompt: "",
  capabilities: {
    chat: false,
    voiceOutput: false,
    subtitles: true
  },
  details: {
    role: "",
    personality: "",
    scenes: [],
    features: []
  },
  expressions: {},
  expressionDescriptions: {},
  uiSettings: {
    theme: "soft",
    clickThroughOpacity: 0.45,
    cursorFollowEnabled: true,
    desktopScale: 1
  },
  lines: {},
  subtitleStyle: {
    tone: "soft"
  }
});

export function App(): JSX.Element {
  const [availablePets, setAvailablePets] = useState<PetDefinition[]>([]);
  const [selectedPetId, setSelectedPetId] = useState<string | undefined>();
  const [activePetId, setActivePetId] = useState<string | undefined>();
  const [currentView, setCurrentView] = useState<AppView>("selector");
  const [editorOptions, setEditorOptions] = useState<EditorPageOptions>({});
  const [isStartupSplashVisible, setIsStartupSplashVisible] = useState(true);
  const [isStartupSplashLeaving, setIsStartupSplashLeaving] = useState(false);
  const [hasMinimumStartupSplashElapsed, setHasMinimumStartupSplashElapsed] = useState(false);
  const [hasInitialPetsLoaded, setHasInitialPetsLoaded] = useState(false);
  const [hasMainWindowBeenShown, setHasMainWindowBeenShown] = useState(() => !window.desktopPet?.appWindow);
  const [hasStartupSurfaceReady, setHasStartupSurfaceReady] = useState(
    () => !window.desktopPet?.appWindow || window.__desktopPetStartupSurfaceReady === true
  );
  const [toastText, setToastText] = useState<string | undefined>();
  const [deleteTargetPet, setDeleteTargetPet] = useState<PetDefinition | undefined>();
  const [deleteConfirmStep, setDeleteConfirmStep] = useState<1 | 2>(1);
  const [deletingPet, setDeletingPet] = useState(false);
  const [configCorruption, setConfigCorruption] = useState<LocalPetConfigCorruption | undefined>();
  const [restoringConfig, setRestoringConfig] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const [helpCenterOpen, setHelpCenterOpen] = useState(false);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const [petWindowState, setPetWindowState] = useState<PetWindowState>({
    visible: false,
    clickThrough: false
  });
  const currentViewRef = useRef<AppView>(currentView);
  const activePetIdRef = useRef<string | undefined>();
  const petOperationSequenceRef = useRef(0);
  const petRefreshSequenceRef = useRef(0);
  const memoryBookStateRef = useRef<Record<string, MemoryBookRouteState>>({});
  const selectorScrollPositionRef = useRef(0);
  const hasReportedMinimumStartupSplashRef = useRef(false);

  useEffect(() => {
    window.desktopPet?.appWindow.reportStartupTiming("react-mounted");
  }, []);

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    activePetIdRef.current = activePetId;
  }, [activePetId]);

  const selectedPet = useMemo<PetDefinition | undefined>(() => {
    return availablePets.find((pet) => pet.id === selectedPetId);
  }, [availablePets, selectedPetId]);

  const refreshPets = useCallback(async (): Promise<void> => {
    const refreshSequence = ++petRefreshSequenceRef.current;
    const result = await loadAvailablePets();

    if (refreshSequence !== petRefreshSequenceRef.current) {
      return;
    }

    setAvailablePets(result.pets);
    setConfigCorruption(result.corruption);
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadInitialPets = async (): Promise<void> => {
      try {
        await refreshPets();
      } catch (error) {
        console.error("Failed to load desktop pets on startup.", error);
      } finally {
        if (isMounted) {
          window.desktopPet?.appWindow.reportStartupTiming("initial-pets-loaded");
          setHasInitialPetsLoaded(true);
        }
      }
    };

    void loadInitialPets();

    const handleFocus = (): void => {
      if (currentViewRef.current === "editor") {
        return;
      }

      void refreshPets();
    };
    const unsubscribePetConfig = window.desktopPet?.petConfig.onChanged(() => {
      if (currentViewRef.current === "editor") {
        return;
      }

      void refreshPets();
    });

    window.addEventListener("focus", handleFocus);

    return () => {
      isMounted = false;
      window.removeEventListener("focus", handleFocus);
      unsubscribePetConfig?.();
    };
  }, [refreshPets]);

  useEffect(() => {
    const markWindowShown = (): void => {
      window.desktopPet?.appWindow.reportStartupTiming("main-window-shown");
      setHasMainWindowBeenShown(true);
    };

    if (!window.desktopPet?.appWindow) {
      markWindowShown();
      return;
    }

    const unsubscribeShown = window.desktopPet.appWindow.onShown(markWindowShown);

    void window.desktopPet.appWindow
      .isShown()
      .then((isShown) => {
        if (isShown) {
          markWindowShown();
        }
      })
      .catch((error) => {
        console.error("Failed to read main window visibility.", error);
        markWindowShown();
      });

    return () => {
      unsubscribeShown();
    };
  }, []);

  useEffect(() => {
    if (hasStartupSurfaceReady) {
      return;
    }

    const setStartupSurfaceReadyState = (): void => {
      window.desktopPet?.appWindow.reportStartupTiming("startup-surface-ready");
      setHasStartupSurfaceReady(true);
    };

    if (window.__desktopPetStartupSurfaceReady === true) {
      setStartupSurfaceReadyState();
      return;
    }

    const fallbackTimer = window.setTimeout(() => {
      setStartupSurfaceReadyState();
    }, 3000);

    window.addEventListener("desktop-pet-startup-surface-ready", setStartupSurfaceReadyState, {
      once: true
    });

    return () => {
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("desktop-pet-startup-surface-ready", setStartupSurfaceReadyState);
    };
  }, [hasStartupSurfaceReady]);

  useEffect(() => {
    if (!hasMainWindowBeenShown) {
      return;
    }

    const markMinimumSplashElapsed = (): void => {
      if (hasReportedMinimumStartupSplashRef.current) {
        return;
      }

      hasReportedMinimumStartupSplashRef.current = true;
      window.desktopPet?.appWindow.reportStartupTiming("minimum-splash-elapsed");
      setHasMinimumStartupSplashElapsed(true);
    };
    const remainingMs = getRemainingStartupSplashMs();

    if (remainingMs === 0) {
      markMinimumSplashElapsed();
      return;
    }

    const splashTimer = window.setTimeout(() => {
      markMinimumSplashElapsed();
    }, remainingMs);

    return () => {
      window.clearTimeout(splashTimer);
    };
  }, [hasMainWindowBeenShown]);

  useEffect(() => {
    if (
      !isStartupSplashVisible ||
      isStartupSplashLeaving ||
      !hasMinimumStartupSplashElapsed ||
      !hasInitialPetsLoaded ||
      !hasMainWindowBeenShown ||
      !hasStartupSurfaceReady
    ) {
      return;
    }

    window.desktopPet?.appWindow.reportStartupTiming("splash-exit-started");
    setIsStartupSplashLeaving(true);
  }, [
    hasMinimumStartupSplashElapsed,
    hasInitialPetsLoaded,
    hasMainWindowBeenShown,
    hasStartupSurfaceReady,
    isStartupSplashLeaving,
    isStartupSplashVisible
  ]);

  useEffect(() => {
    if (!isStartupSplashLeaving) {
      return;
    }

    const splashExitTimer = window.setTimeout(() => {
      window.desktopPet?.appWindow.reportStartupTiming("splash-hidden");
      setIsStartupSplashVisible(false);
    }, STARTUP_SPLASH_EXIT_MS);

    return () => {
      window.clearTimeout(splashExitTimer);
    };
  }, [isStartupSplashLeaving]);

  useEffect(() => {
    const applyPetWindowState = (nextState: PetWindowState): void => {
      setPetWindowState(nextState);
      const nextActivePetId = nextState.visible ? nextState.petId : undefined;
      activePetIdRef.current = nextActivePetId;
      setActivePetId(nextActivePetId);
    };
    const petWindowApi = window.desktopPet?.petWindow;

    if (!petWindowApi) {
      return;
    }

    void petWindowApi.getState().then(applyPetWindowState).catch((error) => {
      console.error("Failed to read desktop pet window state.", error);
    });

    return petWindowApi.onStateChanged(applyPetWindowState);
  }, []);

  useEffect(() => {
    if (!toastText) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToastText(undefined);
    }, 1800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [toastText]);

  const blankPetDraft = useMemo(createBlankPetDraft, []);
  const isCreateMode = currentView === "editor" && editorOptions.mode === "create";
  const editorPets = useMemo(() => {
    return isCreateMode ? [blankPetDraft, ...availablePets] : availablePets;
  }, [availablePets, blankPetDraft, isCreateMode]);
  const editorSelectedPetId = useMemo(() => {
    if (isCreateMode) {
      return blankPetDraft.id;
    }

    if (editorOptions.petId && availablePets.some((pet) => pet.id === editorOptions.petId)) {
      return editorOptions.petId;
    }

    return availablePets[0]?.id ?? "";
  }, [availablePets, blankPetDraft.id, editorOptions.petId, isCreateMode]);

  const openEditorPage = (options: EditorPageOptions): void => {
    setEditorOptions(options);
    setCurrentView("editor");
  };

  const closeEditorPage = (): void => {
    setCurrentView("selector");
    setEditorOptions({});
    void refreshPets();
  };

  const openMemoryBook = (petId: string): void => {
    selectorScrollPositionRef.current = window.scrollY;
    delete memoryBookStateRef.current[petId];
    setSelectedPetId(petId);
    setCurrentView("memoryBook");
  };

  const closeMemoryBook = (): void => {
    setCurrentView("selector");
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: selectorScrollPositionRef.current, behavior: "auto" });
    });
  };

  const handleEditorSavedPet = (pet: PetDefinition): void => {
    setAvailablePets((currentPets) => {
      const withoutSaved = currentPets.filter((currentPet) => currentPet.id !== pet.id);

      return [pet, ...withoutSaved];
    });
    setSelectedPetId(pet.id);
    setEditorOptions({ mode: "edit", petId: pet.id });
  };

  const closeHelpCenter = useCallback((): void => {
    setHelpCenterOpen(false);
    window.requestAnimationFrame(() => helpButtonRef.current?.focus());
  }, []);

  const handlePackageImported = (pet: PetDefinition): void => {
    setAvailablePets((current) => [pet, ...current.filter((item) => item.id !== pet.id)]);
    setSelectedPetId(pet.id);
    setToastText(`${pet.name} 已导入`);
  };

  const activatePet = async (petId: string): Promise<void> => {
    const operationSequence = ++petOperationSequenceRef.current;
    const targetPet = availablePets.find((pet) => pet.id === petId);

    if (!targetPet) {
      return;
    }

    setSelectedPetId(petId);

    if (!hasUsableLive2DModel(targetPet)) {
      setToastText("请先导入 Live2D 模型。");
      return;
    }

    try {
      const nextState = await window.desktopPet?.petWindow.show({
        id: targetPet.id,
        name: targetPet.name,
        modelPath: targetPet.modelPath,
        avatar: targetPet.avatar,
        definition: targetPet
      });

      if (operationSequence !== petOperationSequenceRef.current) {
        return;
      }

      if (!nextState?.visible || nextState.petId !== targetPet.id) {
        throw new Error("桌宠窗口没有成功显示。");
      }

      setPetWindowState(nextState);
      activePetIdRef.current = targetPet.id;
      setActivePetId(targetPet.id);
      setToastText(`${targetPet.name} 已上线`);
    } catch (error: unknown) {
      if (operationSequence !== petOperationSequenceRef.current) {
        return;
      }

      setToastText(error instanceof Error ? error.message : "启用桌宠失败，请重试。");
    }
  };

  const deactivatePet = async (): Promise<boolean> => {
    const operationSequence = ++petOperationSequenceRef.current;

    try {
      const nextState = await window.desktopPet?.petWindow.close();

      if (operationSequence !== petOperationSequenceRef.current) {
        return false;
      }

      if (!nextState || nextState.visible) {
        throw new Error("桌宠窗口尚未关闭，请重试。");
      }

      setPetWindowState(nextState);
      activePetIdRef.current = undefined;
      setActivePetId(undefined);
      return true;
    } catch (error: unknown) {
      if (operationSequence === petOperationSequenceRef.current) {
        setToastText(error instanceof Error ? error.message : "关闭桌宠失败，请重试。");
      }

      return false;
    }
  };

  const togglePet = async (petId: string): Promise<void> => {
    if (activePetIdRef.current === petId) {
      await deactivatePet();
      return;
    }

    await activatePet(petId);
  };

  const deletePet = async (pet: PetDefinition): Promise<void> => {
    if (!pet.isLocal) {
      setToastText("只能删除本地桌宠");
      return;
    }

    setDeleteTargetPet(pet);
    setDeleteConfirmStep(1);
  };

  const confirmDeletePet = async (): Promise<void> => {
    const pet = deleteTargetPet;

    if (!pet || deletingPet) {
      return;
    }

    setDeletingPet(true);
    try {
      if (activePetIdRef.current === pet.id && !(await deactivatePet())) {
        return;
      }

      const result = await window.desktopPet?.petConfig.delete(pet.id);

      if (!result) {
        throw new Error("删除请求没有返回结果，请重试。");
      }

      setToastText(result.message);

      if (!result.ok) {
        return;
      }

      setDeleteTargetPet(undefined);
      setDeleteConfirmStep(1);
      setSelectedPetId(undefined);
      await refreshPets();
    } catch (error: unknown) {
      setToastText(error instanceof Error ? error.message : "删除桌宠失败，请重试。");
    } finally {
      setDeletingPet(false);
    }
  };

  const restoreCorruptedConfig = async (): Promise<void> => {
    const corruption = configCorruption;

    if (!corruption || restoringConfig) {
      return;
    }

    setRestoringConfig(true);

    try {
      const result = await window.desktopPet?.petConfig.restoreBackup(corruption.petId);

      if (!result) {
        throw new Error("配置恢复请求没有返回结果，请重试。");
      }

      setToastText(result.message);

      if (!result.ok) {
        return;
      }

      setConfigCorruption(undefined);
      await refreshPets();
    } catch (error: unknown) {
      setToastText(error instanceof Error ? error.message : "配置备份恢复失败，请重试。");
    } finally {
      setRestoringConfig(false);
    }
  };

  const updateControl = !isStartupSplashVisible ? (
    <Suspense fallback={null}><AppUpdateControl showButton={currentView === "selector"} /></Suspense>
  ) : null;

  if (currentView === "timedDiagnosticsTest") {
    return (
      <main className="appShell timedDiagnosticsTestShell">
        {updateControl}
        <DeferredViewBoundary
          resetKey="timed-diagnostics-test"
          title="开发者监测页面加载失败"
          onBack={() => setCurrentView("selector")}
        >
          <Suspense fallback={<DeferredViewFallback label="正在打开开发者监测" />}>
            <TimedDiagnosticsTestPage onBack={() => setCurrentView("selector")} />
          </Suspense>
        </DeferredViewBoundary>
        {isStartupSplashVisible ? <StartupSplash leaving={isStartupSplashLeaving} /> : null}
      </main>
    );
  }

  if (currentView === "editor") {
    return (
      <main className="appShell editorViewShell">
        {updateControl}
        <DeferredViewBoundary
          resetKey={`editor:${editorSelectedPetId}`}
          title="桌宠编辑器加载失败"
          onBack={closeEditorPage}
        >
          <Suspense fallback={<DeferredViewFallback label="正在打开编辑器" />}>
            <PetEditor
              pets={editorPets}
              selectedPetId={editorSelectedPetId}
              initialPanel={editorOptions.initialPanel}
              onSavedPet={handleEditorSavedPet}
              onBack={closeEditorPage}
            />
          </Suspense>
        </DeferredViewBoundary>
        {toastText ? <div className="launchToast">{toastText}</div> : null}
        {configCorruption ? (
          <ConfigRecoveryDialog
            corruption={configCorruption}
            restoring={restoringConfig}
            onDismiss={() => setConfigCorruption(undefined)}
            onRestore={restoreCorruptedConfig}
          />
        ) : null}
        {isStartupSplashVisible ? <StartupSplash leaving={isStartupSplashLeaving} /> : null}
      </main>
    );
  }

  if (currentView === "memoryBook" && selectedPet) {
    return (
      <main className="appShell memoryBookViewShell">
        {updateControl}
        <DeferredViewBoundary
          resetKey={`memory:${selectedPet.id}`}
          title="记忆书加载失败"
          onBack={closeMemoryBook}
        >
          <Suspense fallback={<DeferredViewFallback label="正在翻开记忆书" />}>
            <MemoryBook
              pet={selectedPet}
              initialState={memoryBookStateRef.current[selectedPet.id]}
              onStateChange={(state) => {
                memoryBookStateRef.current[selectedPet.id] = state;
              }}
              onBack={closeMemoryBook}
            />
          </Suspense>
        </DeferredViewBoundary>
        {isStartupSplashVisible ? <StartupSplash leaving={isStartupSplashLeaving} /> : null}
      </main>
    );
  }

  return (
    <main className="appShell">
      <header className="appTopbar">
        <div className="brandBlock">
          <span className="brandMark" aria-hidden="true">
            <img src={HOME_ICON_SRC} alt="" />
          </span>
          <span>主页</span>
        </div>
        <div className="topbarActionGroup">
          {updateControl}
          {TIMED_DIAGNOSTICS_TEST_ENABLED ? (
            <button
              className="topbarImportButton timedDiagnosticsTopbarButton"
              type="button"
              onClick={() => setCurrentView("timedDiagnosticsTest")}
            >
              <Activity size={17} />
              监测
            </button>
          ) : null}
          <button
            ref={helpButtonRef}
            className="topbarImportButton helpTopbarButton"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={helpCenterOpen}
            onClick={() => setHelpCenterOpen(true)}
          >
            <CircleHelp size={17} />
            帮助中心
          </button>
          <button ref={importButtonRef} className="topbarImportButton" type="button" onClick={() => setImportDialogOpen(true)}>
            <PackageOpen size={17} />
            导入桌宠
          </button>
          <div className="statusBlock">
            <span className={activePetId ? "statusDot online" : "statusDot"} />
            <span>{activePetId ? "桌宠运行中" : "未启用"}</span>
          </div>
        </div>
      </header>

      <div className="workspace detailsOpen">
        <PetSelector
          pets={availablePets}
          selectedPetId={selectedPet?.id}
          activePetId={activePetId}
          onSelectPet={setSelectedPetId}
          onTogglePet={togglePet}
          onCreatePet={() => {
            openEditorPage({ mode: "create" });
          }}
        />

        <div className="rightColumn">
          {selectedPet ? (
            <DeferredViewBoundary
              resetKey={`details:${selectedPet.id}`}
              title="桌宠详情加载失败"
              onBack={() => setSelectedPetId(undefined)}
            >
              <Suspense fallback={<DeferredViewFallback label="正在载入桌宠详情" />}>
                <PetStage
                  pet={selectedPet}
                  isActive={selectedPet.id === activePetId}
                  petWindowState={petWindowState}
                  onActivate={() => activatePet(selectedPet.id)}
                  onDeactivate={async () => {
                    await deactivatePet();
                  }}
                  onEditPet={(initialPanel) => openEditorPage({
                    mode: "edit",
                    petId: selectedPet.id,
                    initialPanel
                  })}
                  onOpenMemoryBook={() => openMemoryBook(selectedPet.id)}
                  onDeletePet={() => deletePet(selectedPet)}
                  onCloseDetails={() => setSelectedPetId(undefined)}
                  onVoiceConnected={refreshPets}
                />
              </Suspense>
            </DeferredViewBoundary>
          ) : (
            <SelectorGuideStage
              hasPets={Boolean(availablePets.length)}
              onCreatePet={() => {
                openEditorPage({ mode: "create" });
              }}
            />
          )}
        </div>
      </div>

      {toastText ? <div className="launchToast">{toastText}</div> : null}
      {deleteTargetPet ? (
        <DeletePetDialog
          pet={deleteTargetPet}
          step={deleteConfirmStep}
          deleting={deletingPet}
          onCancel={() => {
            if (deletingPet) {
              return;
            }

            setDeleteTargetPet(undefined);
            setDeleteConfirmStep(1);
          }}
          onContinue={() => setDeleteConfirmStep(2)}
          onConfirm={confirmDeletePet}
        />
      ) : null}
      {configCorruption ? (
        <ConfigRecoveryDialog
          corruption={configCorruption}
          restoring={restoringConfig}
          onDismiss={() => setConfigCorruption(undefined)}
          onRestore={restoreCorruptedConfig}
        />
      ) : null}
      {importDialogOpen ? <PetPackageImportDialog onImported={handlePackageImported} onClose={() => {
        setImportDialogOpen(false);
        window.requestAnimationFrame(() => importButtonRef.current?.focus());
      }} /> : null}
      {helpCenterOpen ? (
        <Suspense fallback={<HelpCenterLoadingFallback />}>
          <HelpCenter onClose={closeHelpCenter} />
        </Suspense>
      ) : null}
      {isStartupSplashVisible ? <StartupSplash leaving={isStartupSplashLeaving} /> : null}
    </main>
  );
}
