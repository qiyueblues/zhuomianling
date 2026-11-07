import {
  Bot,
  CheckCircle2,
  FileAudio,
  FileCode2,
  FileJson,
  ArrowLeft,
  FolderOpen,
  ChevronRight,
  LoaderCircle,
  Plus,
  PlugZap,
  RotateCcw,
  Smile,
  MessagesSquare,
  KeyRound,
  Lock,
  Palette,
  Archive,
  Volume2,
  XCircle
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import { createPortal } from "react-dom";
import type {
  LocalPetSaveResult,
  PetDefinition,
  PetVoiceInferenceDevice,
  PetVoiceLanguage,
  PetVoiceModelVersion,
  LocalPetVoiceModelDraft,
  LocalPetVoiceResourceKind
} from "../../../shared/types/pet";
import { defaultPetVoiceModelVersion } from "../../../shared/types/pet";
import type {
  Live2DFolderScanResult,
  Live2DImportedSource,
  Live2DResourceCheck
} from "../../../shared/types/live2dImport";
import { Live2DCanvas, type Live2DPreviewAction } from "../../live2d/Live2DCanvas";
import { AiPanel } from "./AiPanel";
import { AppleSelect, PanelSaveActions, UnsavedChangesDialog, VoiceFileRow } from "./EditorShared";
import { EventLinesPanel } from "./EventLinesPanel";
import { ExpressionPanel } from "./ExpressionPanel";
import {
  aiSubTabs,
  dialogueSubTabs,
  editorTabs,
  interactionSubTabs,
  moodEditorTab,
  type ActiveEditorPanel
} from "./editorNavigation";
import {
  getFileName
} from "./petEditorDrafts";
import { BasicPanel } from "./BasicPanel";
import { PersonaPanel } from "./PersonaPanel";
import { ThemePanel } from "./ThemePanel";
import { QuickActionsPanel } from "./QuickActionsPanel";
import { VoiceInputPanel } from "./VoiceInputPanel";
import { MoodPanel } from "./MoodPanel";
import { PresetVoicePanel } from "./PresetVoicePanel";
import { PetPackageExportDialog } from "../PetPackage/PetPackageExportDialog";
import { VisionPanel } from "./VisionPanel";

interface PetEditorProps {
  pets: PetDefinition[];
  selectedPetId: string;
  initialPanel?: ActiveEditorPanel;
  onSavedPet?: (pet: PetDefinition) => void;
  onBack?: () => void;
}

type VoiceConnectionState = "connected" | "failed";
type PendingNavigation = ActiveEditorPanel | "back";

const voiceLanguageOptions = [
  { value: "zh", label: "中文" },
  { value: "ja", label: "日语" },
  { value: "en", label: "英语" }
];

const voiceModelVersionOptions = [
  { value: "v1", label: "V1" },
  { value: "v2", label: "V2" },
  { value: "v3", label: "V3" },
  { value: "v4", label: "V4" },
  { value: "v2Pro", label: "V2 Pro" },
  { value: "v2ProPlus", label: "V2 Pro Plus" },
  { value: "v5dev", label: "V5 Dev" },
  { value: "v5turbo", label: "V5 Turbo" }
];

export function PetEditor({
  pets,
  selectedPetId,
  initialPanel = "basic",
  onSavedPet,
  onBack
}: PetEditorProps): JSX.Element | null {
  const MoodIcon = moodEditorTab.icon;
  const [activePanel, setActivePanel] = useState<ActiveEditorPanel>(
    initialPanel === "vision" ? "aiConfig" : initialPanel
  );
  const [aiExpanded, setAiExpanded] = useState(true);
  const [dialogueExpanded, setDialogueExpanded] = useState(true);
  const [interactionExpanded, setInteractionExpanded] = useState(true);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [pendingPanel, setPendingPanel] = useState<PendingNavigation | undefined>();
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [llmReady, setLlmReady] = useState(false);
  const initialVisionPanelRef = useRef(initialPanel === "vision");
  const selectedPet = useMemo(() => {
    return pets.find((pet) => pet.id === selectedPetId) ?? pets[0];
  }, [pets, selectedPetId]);
  const activePanelLabel = useMemo(() => {
    return (
      editorTabs.find((tab) => tab.id === activePanel)?.label ??
      aiSubTabs.find((tab) => tab.id === activePanel)?.label ??
      dialogueSubTabs.find((tab) => tab.id === activePanel)?.label ??
      interactionSubTabs.find((tab) => tab.id === activePanel)?.label ??
      (activePanel === "mood" ? moodEditorTab.label : undefined) ??
      "基础信息"
    );
  }, [activePanel]);

  useEffect(() => {
    setHasUnsavedChanges(false);
    setPendingPanel(undefined);
  }, [selectedPetId]);

  useEffect(() => {
    let disposed = false;
    const refreshLlmState = async (): Promise<void> => {
      try {
        const summary = await window.desktopPet?.aiSettings.get(selectedPetId);
        if (!disposed) {
          setLlmReady(Boolean(summary?.hasApiKey && summary.baseUrl.trim() && summary.model.trim()));
        }
      } catch {
        if (!disposed) setLlmReady(false);
      }
    };
    void refreshLlmState();
    const unsubscribe = window.desktopPet?.petConfig.onChanged(() => { void refreshLlmState(); });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [selectedPetId]);

  useEffect(() => {
    if (activePanel === "vision" && !llmReady) {
      setActivePanel("aiConfig");
      return;
    }
    if (llmReady && initialVisionPanelRef.current && activePanel === "aiConfig") {
      initialVisionPanelRef.current = false;
      setActivePanel("vision");
    }
  }, [activePanel, llmReady]);

  const changePanel = (nextPanel: ActiveEditorPanel): void => {
    if (nextPanel === "vision" && !llmReady) {
      setActivePanel("aiConfig");
      return;
    }
    if (nextPanel === activePanel) {
      return;
    }

    if (hasUnsavedChanges) {
      setPendingPanel(nextPanel);
      return;
    }

    setActivePanel(nextPanel);
  };

  const changeGroupedPanel = (
    nextPanel: ActiveEditorPanel,
    setExpanded: Dispatch<SetStateAction<boolean>>
  ): void => {
    if (nextPanel !== activePanel && hasUnsavedChanges) {
      setPendingPanel(nextPanel);
      return;
    }

    setExpanded((expanded) => !expanded);
    changePanel(nextPanel);
  };

  const confirmPanelChange = (): void => {
    if (!pendingPanel) {
      return;
    }

    setHasUnsavedChanges(false);

    if (pendingPanel === "back") {
      setPendingPanel(undefined);
      onBack?.();
      return;
    }

    setActivePanel(pendingPanel);
    setPendingPanel(undefined);
  };

  const requestBack = (): void => {
    if (!onBack) {
      return;
    }

    if (hasUnsavedChanges) {
      setPendingPanel("back");
      return;
    }

    onBack();
  };

  if (!selectedPet) {
    return null;
  }

  const exportDisabledReason = selectedPet.id === "new-pet"
    ? "请先保存桌宠"
    : hasUnsavedChanges
      ? "请先保存当前修改再导出"
      : !selectedPet.modelPath
        ? "请先导入 Live2D 模型"
        : undefined;

  return (
    <section className="pageShell editorShell" aria-label="桌宠设置">
      <div className="pageHeader editorPageHeader">
        <div className="editorHeaderNav" aria-label="设置导航提示">
          {onBack ? (
            <button className="editorBackButton" type="button" onClick={requestBack} aria-label="返回选择器">
              <ArrowLeft size={17} />
            </button>
          ) : null}
          <span className="editorHeaderCopy">
            <strong>桌宠设置</strong>
            <small>当前栏目：{activePanelLabel}</small>
          </span>
        </div>

        <div className="editorPetIdentity" aria-label="当前编辑模型">
          <span className="editorPetAvatar" aria-hidden="true">
            {selectedPet.avatarImage ? (
              <img src={selectedPet.avatarImage} alt="" />
            ) : (
              <span>{selectedPet.avatar || selectedPet.name.slice(0, 2).toUpperCase() || "新"}</span>
            )}
          </span>
          <span className="editorPetTitle">
            <small className={hasUnsavedChanges ? "unsaved" : undefined}>
              {hasUnsavedChanges ? "有未保存修改" : selectedPet.id === "new-pet" ? "正在创建" : "正在编辑"}
            </small>
            <strong>{selectedPet.name || "新建桌宠"}</strong>
          </span>
        </div>

        <div className="editorHeaderActions">
          <button className="editorExportButton" type="button" disabled={Boolean(exportDisabledReason)} title={exportDisabledReason} onClick={() => setExportDialogOpen(true)}>
            <Archive size={16} />
            导出桌宠
          </button>
        </div>
      </div>

      <div className="editorLayout">
        <aside className="editorTabs" aria-label="编辑分类">
          {editorTabs.map((tab) => {
            const Icon = tab.icon;

            return (
              <button
                className={activePanel === tab.id ? "editorTab active" : "editorTab"}
                type="button"
                key={tab.id}
                onClick={() => changePanel(tab.id)}
              >
                <Icon size={18} />
                <span>{tab.label}</span>
              </button>
            );
          })}
          <button
            className={
              ["interaction", ...interactionSubTabs.map((tab) => tab.id)].includes(activePanel)
                ? "editorTab active"
                : "editorTab"
            }
            type="button"
            onClick={() => changeGroupedPanel("themeStyle", setInteractionExpanded)}
          >
            <Palette size={18} />
            <span>交互面板</span>
            <ChevronRight className={interactionExpanded ? "editorTabArrow expanded" : "editorTabArrow"} size={17} />
          </button>
          {interactionExpanded ? (
            <div className="editorSubTabs" aria-label="交互面板子栏目">
              {interactionSubTabs.map((tab) => {
                const Icon = tab.icon;

                return (
                  <button
                    className={activePanel === tab.id ? "editorSubTab active" : "editorSubTab"}
                    type="button"
                    key={tab.id}
                    onClick={() => changePanel(tab.id)}
                  >
                    <Icon size={16} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <button
            className={["ai", ...aiSubTabs.map((tab) => tab.id)].includes(activePanel) ? "editorTab active" : "editorTab"}
            type="button"
            onClick={() => changeGroupedPanel("aiConfig", setAiExpanded)}
          >
            <Bot size={18} />
            <span>AI设置</span>
            <ChevronRight className={aiExpanded ? "editorTabArrow expanded" : "editorTabArrow"} size={17} />
          </button>
          {aiExpanded ? (
            <div className="editorSubTabs" aria-label="AI 设置子栏目">
              {aiSubTabs.map((tab) => {
                const Icon = tab.icon;
                const locked = tab.id === "vision" && !llmReady;

                return (
                  <button
                    className={[activePanel === tab.id ? "editorSubTab active" : "editorSubTab", locked ? "locked" : ""].filter(Boolean).join(" ")}
                    type="button"
                    key={tab.id}
                    disabled={locked}
                    aria-disabled={locked}
                    title={locked ? "请先保存并应用有效的 LLM 配置" : undefined}
                    onClick={() => changePanel(tab.id)}
                  >
                    <Icon size={16} />
                    <span>{tab.label}</span>
                    {locked ? <Lock size={12} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <button
            className={["dialogue", ...dialogueSubTabs.map((tab) => tab.id)].includes(activePanel) ? "editorTab active" : "editorTab"}
            type="button"
            onClick={() => changeGroupedPanel("voiceInput", setDialogueExpanded)}
          >
            <MessagesSquare size={18} />
            <span>语音系统</span>
            <ChevronRight className={dialogueExpanded ? "editorTabArrow expanded" : "editorTabArrow"} size={17} />
          </button>
          {dialogueExpanded ? (
            <div className="editorSubTabs" aria-label="语音系统子栏目">
              {dialogueSubTabs.map((tab) => {
                const Icon = tab.icon;

                return (
                  <button
                    className={activePanel === tab.id ? "editorSubTab active" : "editorSubTab"}
                    type="button"
                    key={tab.id}
                    onClick={() => changePanel(tab.id)}
                  >
                    <Icon size={16} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <button className={activePanel === "mood" ? "editorTab active" : "editorTab"} type="button" onClick={() => changePanel("mood")}>
            <MoodIcon size={18} /><span>{moodEditorTab.label}</span>
          </button>
        </aside>

        <div className="editorContent">
          {activePanel === "basic" ? (
            <BasicPanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "themeStyle" ? (
            <ThemePanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "quickActions" ? (
            <QuickActionsPanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "live2d" ? (
            <Live2DPanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "expressions" ? (
            <ExpressionPanel
              pet={selectedPet}
              onSavedPet={onSavedPet}
              onDirtyChange={setHasUnsavedChanges}
            />
          ) : null}
          {activePanel === "events" ? (
            <EventLinesPanel
              pet={selectedPet}
              onSavedPet={onSavedPet}
              onDirtyChange={setHasUnsavedChanges}
            />
          ) : null}
          {activePanel === "persona" ? (
            <PersonaPanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "aiConfig" ? <AiPanel pet={selectedPet} onDirtyChange={setHasUnsavedChanges} /> : null}
          {activePanel === "vision" ? (
            <VisionPanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "voiceInput" ? (
            <VoiceInputPanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "voiceReply" ? (
            <VoicePanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "presetVoice" ? (
            <PresetVoicePanel pet={selectedPet} onDirtyChange={setHasUnsavedChanges} />
          ) : null}
          {activePanel === "mood" ? <MoodPanel pet={selectedPet} onSavedPet={onSavedPet} onDirtyChange={setHasUnsavedChanges} /> : null}
        </div>
        <div className="editorCanvasOverlayHost" id="editor-canvas-overlay" />
      </div>

      {pendingPanel ? (
        <UnsavedChangesDialog onCancel={() => setPendingPanel(undefined)} onConfirm={confirmPanelChange} />
      ) : null}
      {exportDialogOpen ? <PetPackageExportDialog pet={selectedPet} onClose={() => setExportDialogOpen(false)} /> : null}
    </section>
  );
}

function Live2DPanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const hasModel = Boolean(pet.modelPath);
  const modelFileName = pet.modelPath.split("/").at(-1) ?? pet.modelPath;
  const [scanResult, setScanResult] = useState<Live2DFolderScanResult | undefined>();
  const [saving, setSaving] = useState(false);
  const [generatingEntry, setGeneratingEntry] = useState(false);
  const [draggingLive2DFolder, setDraggingLive2DFolder] = useState(false);
  const [selectingLive2DFolder, setSelectingLive2DFolder] = useState(!hasModel);
  const [resultMessage, setResultMessage] = useState<{ ok: boolean; message: string } | undefined>();
  const [saveResultMessage, setSaveResultMessage] = useState<{ ok: boolean; message: string } | undefined>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSources, setPreviewSources] = useState<Live2DImportedSource[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewMessage, setPreviewMessage] = useState<string>();
  const [previewAction, setPreviewAction] = useState<Live2DPreviewAction | undefined>();
  const [activePreviewId, setActivePreviewId] = useState<string>();
  const [previewCanvasKey, setPreviewCanvasKey] = useState(0);
  const [previewModelPath, setPreviewModelPath] = useState<string>();
  const [previewMode, setPreviewMode] = useState<"saved" | "candidate">("saved");
  const [autoPreviewPetId, setAutoPreviewPetId] = useState<string>();
  const selectedFolderPath = scanResult?.folderPath;
  const canImport = Boolean(scanResult?.ok && selectedFolderPath && pet.id !== "new-pet");
  const saveStepReady = canImport;
  const summaryTextureCount = scanResult?.textureCount ?? pet.live2dSettings?.textureCount;
  const summaryMotionCount = scanResult?.motionCount ?? pet.live2dSettings?.motionCount;
  const summaryExpressionCount = scanResult?.expressionCount ?? pet.live2dSettings?.expressionCount;
  const formatLive2DCount = (count?: number): string => (typeof count === "number" ? `${count} 个` : "未统计");
  const summaryEntryName = scanResult?.entryFileName ?? pet.live2dSettings?.entryFileName ?? modelFileName;
  const shouldShowImportFlow = selectingLive2DFolder || !hasModel || Boolean(scanResult && !scanResult.ok);
  const resourceReady = shouldShowImportFlow ? Boolean(scanResult?.ok) : scanResult ? scanResult.ok : hasModel;
  const shouldShowDetailedChecks = Boolean(scanResult);
  const resourceChecks = [
    { label: "模型入口", value: hasModel ? modelFileName : "待选择", ready: hasModel },
    { label: "Moc 文件", value: hasModel ? "已找到" : "待检查", ready: hasModel },
    { label: "贴图", value: hasModel ? formatLive2DCount(summaryTextureCount) : "待检查", ready: hasModel },
    { label: "动作", value: hasModel ? formatLive2DCount(summaryMotionCount) : "待检查", ready: hasModel },
    { label: "表情", value: hasModel ? formatLive2DCount(summaryExpressionCount) : "待检查", ready: hasModel }
  ];
  const visibleResourceChecks = scanResult?.checks ?? resourceChecks;
  const motionPreviewItems = previewSources
    .filter((source) => source.kind === "motion")
    .map((source, index, sources) => ({
      ...source,
      index: sources.slice(0, index).filter((item) => item.name === source.name).length
    }));
  const expressionPreviewItems = previewSources.filter((source) => source.kind === "expression");

  const ensureCanSelectLive2DFolder = (): boolean => {
    if (pet.id === "new-pet") {
      setResultMessage({
        ok: false,
        message: "请先在基础信息里保存桌宠，再导入 Live2D 模型。"
      });
      return false;
    }

    return true;
  };

  const applyLive2DScanResult = (nextScanResult: Live2DFolderScanResult): void => {
    onDirtyChange(nextScanResult.ok);
    setScanResult(nextScanResult);
    setSelectingLive2DFolder(true);
    setSaveResultMessage(undefined);
    setResultMessage({
      ok: nextScanResult.ok,
      message: nextScanResult.message
    });

    if (nextScanResult.ok && nextScanResult.folderPath) {
      void openLive2DPreview({ mode: "candidate", folderPath: nextScanResult.folderPath });
    } else {
      setPreviewOpen(false);
      setPreviewModelPath(undefined);
      setPreviewSources([]);
    }
  };

  const pickLive2DFolder = async (): Promise<void> => {
    if (!ensureCanSelectLive2DFolder()) {
      return;
    }

    const nextScanResult = await window.desktopPet?.live2dImport.selectFolder();

    if (!nextScanResult || nextScanResult.canceled) {
      return;
    }

    applyLive2DScanResult(nextScanResult);
  };

  const validateDroppedLive2DFolder = async (folderPath: string): Promise<void> => {
    if (!folderPath) {
      setResultMessage({
        ok: false,
        message: "没有读取到拖入文件夹路径，请使用“选择文件夹”。"
      });
      return;
    }

    const nextScanResult = await window.desktopPet?.live2dImport.validateFolder(folderPath);

    if (nextScanResult) {
      applyLive2DScanResult(nextScanResult);
    }
  };

  const handleLive2DDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    setDraggingLive2DFolder(false);

    if (!ensureCanSelectLive2DFolder()) {
      return;
    }

    const droppedFile = event.dataTransfer.files[0];
    const droppedPath = droppedFile
      ? window.desktopPet?.live2dImport.getDroppedFolderPath(droppedFile)
      : undefined;

    void validateDroppedLive2DFolder(droppedPath ?? "");
  };

  const saveLive2DModel = async (): Promise<void> => {
    if (!selectedFolderPath) {
      setResultMessage({
        ok: false,
        message: "请先选择 Live2D 模型文件夹。"
      });
      return;
    }

    setSaving(true);
    setSaveResultMessage(undefined);

    try {
      const importResult = await window.desktopPet?.live2dImport.importModel({
        petId: pet.id,
        sourceFolderPath: selectedFolderPath
      });

      if (!importResult) {
        return;
      }

      const nextSaveResultMessage = {
        ok: importResult.ok,
        message: importResult.message
      };

      setResultMessage(nextSaveResultMessage);
      setSaveResultMessage(nextSaveResultMessage);

      if (importResult.scan) {
        setScanResult(importResult.scan);
      }

      if (importResult.ok && importResult.pet) {
        onDirtyChange(false);
        setSelectingLive2DFolder(false);
        onSavedPet?.(importResult.pet);
        await openLive2DPreview({ mode: "saved", pet: importResult.pet });
      }
    } finally {
      setSaving(false);
    }
  };

  const generateLive2DEntry = async (): Promise<void> => {
    if (!selectedFolderPath) {
      setResultMessage({
        ok: false,
        message: "请先选择 Live2D 模型文件夹。"
      });
      return;
    }

    setGeneratingEntry(true);
    setSaveResultMessage(undefined);

    try {
      const generateResult = await window.desktopPet?.live2dImport.generateEntry(selectedFolderPath);

      if (!generateResult) {
        return;
      }

      if (generateResult.scan) {
        onDirtyChange(generateResult.scan.ok);
        setScanResult(generateResult.scan);

        if (generateResult.scan.ok && generateResult.scan.folderPath) {
          await openLive2DPreview({ mode: "candidate", folderPath: generateResult.scan.folderPath });
        }
      }

      setResultMessage({
        ok: generateResult.ok,
        message: generateResult.message
      });
    } finally {
      setGeneratingEntry(false);
    }
  };

  async function openLive2DPreview(
    options:
      | { mode: "saved"; pet?: PetDefinition }
      | { mode: "candidate"; folderPath: string } = { mode: "saved", pet }
  ): Promise<void> {
    const targetPet = options.mode === "saved" ? options.pet ?? pet : undefined;

    if (options.mode === "saved" && !targetPet?.modelPath) {
      setPreviewMessage("当前桌宠还没有导入 Live2D 模型。");
      return;
    }

    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewMessage(undefined);
    setPreviewAction(undefined);
    setActivePreviewId(undefined);
    setPreviewCanvasKey((currentKey) => currentKey + 1);
    setPreviewMode(options.mode);

    try {
      if (options.mode === "candidate") {
        const previewResult = await window.desktopPet?.live2dImport.createPreviewModel(options.folderPath);

        if (!previewResult?.ok || !previewResult.modelPath) {
          setPreviewModelPath(undefined);
          setPreviewSources([]);
          setPreviewMessage(previewResult?.message ?? "当前选择的模型无法预览。");
          return;
        }

        setPreviewModelPath(previewResult.modelPath);
        const result = await window.desktopPet?.live2dImport.scanPreviewSources(options.folderPath);

        setPreviewSources(result?.sources ?? []);
        setPreviewMessage(result?.message ?? "候选模型扫描完成。");
        return;
      }

      setPreviewModelPath(targetPet?.modelPath);
      const result = targetPet ? await window.desktopPet?.live2dImport.scanImportedSources(targetPet.id) : undefined;

      setPreviewSources(result?.sources ?? []);
      setPreviewMessage(result?.message ?? "扫描完成。");
    } catch {
      setPreviewSources([]);
      setPreviewMessage("扫描动作和表情失败，请确认模型入口声明完整。");
    } finally {
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    if (!pet.modelPath || selectingLive2DFolder || previewOpen || autoPreviewPetId === pet.id) {
      return;
    }

    setAutoPreviewPetId(pet.id);
    void openLive2DPreview({ mode: "saved", pet });
  }, [autoPreviewPetId, pet, previewOpen, selectingLive2DFolder]);

  const playPreviewExpression = (source: Live2DImportedSource): void => {
    const id = Date.now();

    setActivePreviewId(`expression-${source.name}-${source.file}`);
    setPreviewAction({
      id,
      kind: "expression",
      name: source.name
    });
  };

  const playPreviewMotion = (source: Live2DImportedSource, index: number): void => {
    const id = Date.now();

    setActivePreviewId(`motion-${source.name}-${source.file}-${index}`);
    setPreviewAction({
      id,
      kind: "motion",
      group: source.name,
      index
    });
  };

  const resetLive2DPreview = (): void => {
    const id = Date.now();

    setActivePreviewId(undefined);
    setPreviewAction({
      id,
      kind: "reset"
    });
  };

  const returnToImportedModel = (): void => {
    setSelectingLive2DFolder(false);
    setScanResult(undefined);
    setResultMessage(undefined);
    setSaveResultMessage(undefined);
    setDraggingLive2DFolder(false);
    setPreviewOpen(false);
    setPreviewModelPath(undefined);
    setPreviewSources([]);
    onDirtyChange(false);
  };

  const startSelectingLive2DFolder = (): void => {
    setSelectingLive2DFolder(true);
    setScanResult(undefined);
    setResultMessage(undefined);
    setSaveResultMessage(undefined);
    setDraggingLive2DFolder(false);
    setPreviewOpen(false);
    setPreviewModelPath(undefined);
    setPreviewSources([]);
    onDirtyChange(false);
  };

  const closeLive2DPreview = (): void => {
    setPreviewOpen(false);
    setPreviewAction(undefined);
    setActivePreviewId(undefined);
    setPreviewModelPath(undefined);
  };

  return (
    <div className="editorPanel">
      <div className="panelTitleRow">
        <div>
          <h2>Live2D 导入</h2>
          <p>{hasModel ? "模型已导入，可导入新模型或测试动作/表情。" : "选择模型文件夹、检查资源，再保存到当前桌宠。"}</p>
        </div>
        <span className={resourceReady ? "connectionBadge ok" : "connectionBadge wait"}>
          {resourceReady ? "资源完整" : "待导入"}
        </span>
      </div>

      {hasModel && !shouldShowImportFlow ? (
        <section className="live2dReadyCard" aria-label="已导入 Live2D 模型">
          <div className="live2dReadyHeader">
            <span className="readyIcon">
              <CheckCircle2 size={22} />
            </span>
            <div>
              <h3>Live2D 模型已导入</h3>
              <p>当前桌宠会使用这个模型入口加载 Live2D。</p>
            </div>
            <button className="secondaryAction compact" type="button" onClick={startSelectingLive2DFolder}>
              <FolderOpen size={15} />
              导入新模型
            </button>
            <button className="secondaryAction compact" type="button" onClick={() => void openLive2DPreview({ mode: "saved" })}>
              <Smile size={15} />
              测试动作/表情
            </button>
          </div>
          <div className="live2dSummaryGrid">
            <span>
              <strong>模型入口</strong>
              <em>{summaryEntryName}</em>
            </span>
            <span>
              <strong>贴图</strong>
              <em>{formatLive2DCount(summaryTextureCount)}</em>
            </span>
            <span>
              <strong>动作</strong>
              <em>{formatLive2DCount(summaryMotionCount)}</em>
            </span>
            <span>
              <strong>表情</strong>
              <em>{formatLive2DCount(summaryExpressionCount)}</em>
            </span>
          </div>
        </section>
      ) : null}

      {shouldShowImportFlow ? (
        <>
          {hasModel ? (
            <div className="live2dFlowToolbar">
              <button className="secondaryAction compact" type="button" onClick={returnToImportedModel}>
                <ChevronRight size={15} className="backChevron" />
                返回已导入模型
              </button>
              <span>返回后会保留当前已保存模型；未保存的新选择不会生效。</span>
            </div>
          ) : null}

          <div className="importStepList" aria-label="Live2D 导入步骤">
            <span className="importStep active">1. 选择模型文件夹</span>
            <span className={scanResult ? "importStep active" : "importStep"}>2. 检查模型资源</span>
            <span className={saveStepReady ? "importStep active" : "importStep"}>3. 保存桌宠</span>
          </div>

          <div
            className={draggingLive2DFolder ? "importDropzone dragging" : "importDropzone"}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDraggingLive2DFolder(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.currentTarget === event.target) {
                setDraggingLive2DFolder(false);
              }
            }}
            onDrop={handleLive2DDrop}
          >
            <div className="importDropzonePrimary">
              <span className="importDropzoneIcon" aria-hidden="true">
                <FolderOpen size={24} />
              </span>
              <div className="importDropzoneCopy">
                <strong>选择 Live2D 模型文件夹</strong>
                <span>{selectedFolderPath ?? "支持 .model3.json 或 Cubism 2 model.json。"}</span>
              </div>
              <button className="primaryAction" type="button" onClick={() => void pickLive2DFolder()}>
                <FolderOpen size={17} />
                选择文件夹
              </button>
            </div>

            <div className="importDropzoneMeta" aria-label="Live2D 导入要求">
              <span>
                <FileJson size={15} />
                模型入口
              </span>
              <span>
                <CheckCircle2 size={15} />
                本地复制
              </span>
              <span>
                <CheckCircle2 size={15} />
                自动检查资源
              </span>
            </div>
          </div>

          <PanelSaveActions
            onSave={() => void saveLive2DModel()}
            saving={saving}
            disabled={!canImport}
            disabledReason={
              pet.id === "new-pet"
                ? "请先保存基础信息"
                : scanResult && !scanResult.ok
                  ? "请先选择资源完整的 Live2D 文件夹"
                  : "请先选择包含 Live2D 入口文件的模型文件夹"
            }
            result={saveResultMessage}
            saved={Boolean(saveResultMessage?.ok)}
          />
        </>
      ) : null}

      {shouldShowDetailedChecks ? (
        <div className="live2dImportSection">
          <div className="sectionMiniHeader">
            <strong>资源检查</strong>
            <span>{scanResult?.message ?? (hasModel ? "模型入口已就绪" : "选择文件夹后自动检查")}</span>
            {scanResult?.ok && selectedFolderPath ? (
              <button
                className="secondaryAction compact"
                type="button"
                onClick={() => void openLive2DPreview({ mode: "candidate", folderPath: selectedFolderPath })}
              >
                <Smile size={15} />
                预览模型
              </button>
            ) : null}
          </div>
          <div className="resourceChecklist compact">
            {visibleResourceChecks.map((item) => {
              const normalizedItem = normalizeLive2DResourceCheck(item);

              return (
              <div className={normalizedItem.ready ? "resourceItem ready" : "resourceItem"} key={normalizedItem.label}>
                {normalizedItem.ready ? <CheckCircle2 size={18} /> : <FileJson size={18} />}
                <span>{item.label}</span>
                <strong>{normalizedItem.value}</strong>
                {scanResult?.needsGeneratedEntry && "status" in item && item.status === "warning" ? (
                  <button
                    className="inlineFixButton"
                    type="button"
                    disabled={generatingEntry}
                    onClick={() => void generateLive2DEntry()}
                  >
                    {generatingEntry ? "声明中" : "自动声明"}
                  </button>
                ) : null}
              </div>
            );
            })}
          </div>
        </div>
      ) : null}

      {previewOpen ? (
        <section className="live2dPreviewPanel" aria-label="测试动作和表情">
          <div className="live2dPreviewHeader">
            <div>
              <h3>{previewMode === "candidate" ? "预览待导入模型" : "测试动作/表情"}</h3>
              <p>
                {previewMode === "candidate"
                  ? "保存前确认模型显示、动作和表情是否正常。"
                  : "确认模型自带动作和表情是否正常，后续可用于事件绑定和 AI 表现映射。"}
              </p>
            </div>
            <div className="live2dPreviewActions">
              <button className="secondaryAction compact" type="button" onClick={resetLive2DPreview}>
                <RotateCcw size={16} />
                重置状态
              </button>
              <button className="secondaryAction compact" type="button" onClick={closeLive2DPreview}>
                <XCircle size={17} />
                收起预览
              </button>
            </div>
          </div>

          <div className="live2dPreviewGrid">
            <div className="live2dPreviewStage">
              <Live2DCanvas
                key={`${pet.id}-${previewCanvasKey}`}
                modelPath={previewModelPath ?? pet.modelPath}
                fallbackText={pet.avatar ?? pet.name.slice(0, 2).toUpperCase()}
                expressions={pet.expressions}
                expressionEffects={pet.expressionEffects}
                previewAction={previewAction}
                neutralPreview
                fitMode="previewContain"
              />
            </div>

            <div className="live2dPreviewControls">
              <div className="live2dPreviewStatus">
                <strong>{previewLoading ? "扫描中" : "可预览"}</strong>
                <span>{previewMessage ?? "读取当前模型入口中的动作和表情。"}</span>
              </div>

              <div className="previewControlGroup">
                <h4>动作</h4>
                {motionPreviewItems.length ? (
                  <div className="previewButtonList">
                    {motionPreviewItems.map((source) => {
                      const previewId = `motion-${source.name}-${source.file}-${source.index}`;

                      return (
                        <button
                          className={activePreviewId === previewId ? "previewTrigger active" : "previewTrigger"}
                          type="button"
                          key={previewId}
                          onClick={() => playPreviewMotion(source, source.index)}
                        >
                          <strong>{source.name}</strong>
                          <span>{source.fileName}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="previewEmptyText">没有扫描到动作。</p>
                )}
              </div>

              <div className="previewControlGroup">
                <h4>表情</h4>
                {expressionPreviewItems.length ? (
                  <div className="previewButtonList">
                    {expressionPreviewItems.map((source) => {
                      const previewId = `expression-${source.name}-${source.file}`;

                      return (
                        <button
                          className={activePreviewId === previewId ? "previewTrigger active" : "previewTrigger"}
                          type="button"
                          key={previewId}
                          onClick={() => playPreviewExpression(source)}
                        >
                          <strong>{source.name}</strong>
                          <span>{source.fileName}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="previewEmptyText">没有扫描到表情。</p>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {resultMessage && (!resultMessage.ok || resultMessage !== saveResultMessage) ? (
        <div className={resultMessage.ok ? "settingsResult ok" : "settingsResult error"}>
          {resultMessage.ok ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
          <span>{resultMessage.message}</span>
        </div>
      ) : null}

    </div>
  );
}

function normalizeLive2DResourceCheck(
  item: Live2DResourceCheck | { label: string; value: string; ready: boolean }
): { label: string; value: string; ready: boolean } {
  if ("ready" in item) {
    return item;
  }

  return {
    label: item.label,
    value: item.status === "ready" ? item.message : item.message,
    ready: item.status === "ready" || item.status === "warning"
  };
}

function VoicePanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const initialVoiceDraft: LocalPetVoiceModelDraft = {
    petId: pet.id,
    enabled: pet.voiceModelSettings?.enabled ?? pet.capabilities.voiceOutput,
    connected: pet.voiceModelSettings?.connected ?? false,
    modelVersion: pet.voiceModelSettings?.modelVersion ?? defaultPetVoiceModelVersion,
    gptSoVitsRootPath: pet.voiceModelSettings?.gptSoVitsRootPath,
    sovitsModelPath: pet.voiceModelSettings?.sovitsModelPath,
    gptModelPath: pet.voiceModelSettings?.gptModelPath,
    referenceAudioPath: pet.voiceModelSettings?.referenceAudioPath,
    referenceText: pet.voiceModelSettings?.referenceText ?? "",
    referenceLanguage: pet.voiceModelSettings?.referenceLanguage ?? pet.voiceModelSettings?.language ?? "zh",
    language: pet.voiceModelSettings?.language ?? "zh",
    playMode: "sentence",
    inferenceDevice: pet.voiceModelSettings?.inferenceDevice ?? "auto",
    halfPrecision: pet.voiceModelSettings?.halfPrecision ?? true,
    syncTextWithVoice: pet.voiceModelSettings?.syncTextWithVoice ?? true
  };
  const [draft, setDraft] = useState<LocalPetVoiceModelDraft>(initialVoiceDraft);
  const [savedDraft, setSavedDraft] = useState<LocalPetVoiceModelDraft>(initialVoiceDraft);
  const [connectionState, setConnectionState] = useState<VoiceConnectionState>(
    initialVoiceDraft.connected ? "connected" : "failed"
  );
  const [connectionPopup, setConnectionPopup] = useState<"connecting" | "connected" | "disconnected" | undefined>();
  const connectionPopupTimerRef = useRef<number>();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();
  const [saveResult, setSaveResult] = useState<LocalPetSaveResult | undefined>();
  const connected = connectionState === "connected";
  const optionsEditable = connected && draft.enabled;
  const runtimeEditable = !connected && connectionPopup !== "connecting";
  const serviceStatusText =
    connectionPopup === "connecting" ? "连接中" : connected ? "已连接" : "未连接";
  const popupHost = document.getElementById("editor-canvas-overlay") ?? document.body;

  const showConnectionPopup = (nextPopup: "connecting" | "connected" | "disconnected" | undefined): void => {
    if (connectionPopupTimerRef.current) {
      window.clearTimeout(connectionPopupTimerRef.current);
      connectionPopupTimerRef.current = undefined;
    }
    setConnectionPopup(nextPopup);
    if (nextPopup === "connected" || nextPopup === "disconnected") {
      connectionPopupTimerRef.current = window.setTimeout(() => {
        setConnectionPopup(undefined);
        connectionPopupTimerRef.current = undefined;
      }, 1200);
    }
  };

  useEffect(() => () => {
    if (connectionPopupTimerRef.current) window.clearTimeout(connectionPopupTimerRef.current);
  }, []);

  useEffect(() => {
    if (!result || result === saveResult) {
      return;
    }

    const dismissTimer = window.setTimeout(() => {
      setResult((currentResult) => (currentResult === result ? undefined : currentResult));
    }, result.ok ? 1400 : 2200);

    return () => {
      window.clearTimeout(dismissTimer);
    };
  }, [result, saveResult]);

  const markVoiceDirty = (nextDraft: LocalPetVoiceModelDraft): void => {
    onDirtyChange(JSON.stringify(nextDraft) !== JSON.stringify(savedDraft));
  };

  const updateVoiceDraft = (patch: Partial<LocalPetVoiceModelDraft>): void => {
    setResult(undefined);
    setSaveResult(undefined);
    setDraft((currentDraft) => {
      const nextDraft = {
        ...currentDraft,
        ...patch
      };

      markVoiceDirty(nextDraft);

      return nextDraft;
    });
  };

  const pickVoiceFile = async (kind: LocalPetVoiceResourceKind): Promise<void> => {
    const pickResult = await window.desktopPet?.petConfig.pickVoiceModelFile(kind);

    if (!pickResult?.ok || !pickResult.filePath) {
      if (pickResult && !pickResult.ok) {
        setSaveResult(undefined);
        setResult({
          ok: false,
          message: pickResult.message
        });
      }
      return;
    }

    const patch: Partial<LocalPetVoiceModelDraft> =
      kind === "sovits"
        ? {
            sovitsModelPath: pickResult.filePath
          }
        : kind === "gpt"
          ? {
              gptModelPath: pickResult.filePath
            }
          : {
              referenceAudioPath: pickResult.filePath
            };

    updateVoiceDraft(patch);
  };

  const connectVoiceService = async (): Promise<void> => {
    showConnectionPopup("connecting");
    setSaveResult(undefined);
    const connectionResult = await window.desktopPet?.petConfig.testVoiceModelConnection(draft);

    if (connectionResult?.ok) {
      const connectedDraft = {
        ...draft,
        connected: true,
        enabled: true
      };
      const saveResult = await window.desktopPet?.petConfig.saveVoiceModel(connectedDraft);

      if (!saveResult?.ok || !saveResult.pet) {
        setConnectionState("failed");
        showConnectionPopup(undefined);
        setResult({
          ok: false,
          message: saveResult?.message ?? "连接成功，但保存连接状态失败。"
        });
        return;
      }

      setConnectionState("connected");
      setDraft(connectedDraft);
      setSavedDraft(connectedDraft);
      setResult(undefined);
      onDirtyChange(false);
      onSavedPet?.(saveResult.pet);
      showConnectionPopup("connected");
      return;
    }

    setConnectionState("failed");
    showConnectionPopup(undefined);
    updateVoiceDraft({
      connected: false,
      enabled: false
    });
    setResult({
      ok: false,
      message: connectionResult?.message ?? "连接失败。"
    });
  };

  const disconnectVoiceService = async (): Promise<void> => {
    const disconnectResult = await window.desktopPet?.petConfig.disconnectVoiceModel();
    const disconnected = Boolean(disconnectResult?.ok);
    const disconnectedDraft = {
      ...draft,
      connected: false,
      enabled: false
    };

    setConnectionState("failed");
    setSaveResult(undefined);
    setDraft(disconnectedDraft);
    setSavedDraft(disconnectedDraft);
    setResult(disconnected ? undefined : {
      ok: false,
      message: disconnectResult?.message ?? "断开连接失败。"
    });
    showConnectionPopup(disconnected ? "disconnected" : undefined);
    onDirtyChange(false);
    onSavedPet?.({
      ...pet,
      capabilities: {
        ...pet.capabilities,
        voiceOutput: false
      },
      voiceModelSettings: pet.voiceModelSettings
        ? {
            ...pet.voiceModelSettings,
            connected: false,
            enabled: false
          }
        : undefined
    });
  };

  const toggleConnection = async (): Promise<void> => {
    if (connected) {
      await disconnectVoiceService();
      return;
    }

    if (connectionPopup === "connecting") {
      return;
    }

    await connectVoiceService();
  };

  const saveVoiceModel = async (draftOverride?: LocalPetVoiceModelDraft): Promise<void> => {
    if (pet.id === "new-pet") {
      const nextSaveResult: LocalPetSaveResult = {
        ok: false,
        message: "请先保存基础信息，再配置声音模型。"
      };

      setResult(nextSaveResult);
      setSaveResult(nextSaveResult);
      return;
    }

    setSaving(true);
    setSaveResult(undefined);

    try {
      const draftToSave = draftOverride ?? draft;
      const saveResult = await window.desktopPet?.petConfig.saveVoiceModel(draftToSave);

      if (!saveResult) {
        return;
      }

      if (saveResult.ok && saveResult.pet) {
        setDraft(draftToSave);
        setSavedDraft(draftToSave);
        setResult(saveResult);
        setSaveResult(saveResult);
        onDirtyChange(false);
        onSavedPet?.(saveResult.pet);
      } else {
        setResult(saveResult);
        setSaveResult(saveResult);
      }
    } finally {
      setSaving(false);
    }
  };

  const saveVoiceRootPath = async (): Promise<void> => {
    await saveVoiceModel({
      ...draft,
      gptSoVitsRootPath: draft.gptSoVitsRootPath?.trim(),
      connected: false,
      enabled: draft.enabled && connected
    });
  };

  return (
    <div className="editorPanel voiceEditorPanel">
      {connectionPopup
        ? createPortal(
            <div className={`voiceConnectPopup voiceConnectionPopup ${connectionPopup === "connecting" ? "connecting" : "success"}`} role="status" aria-live="polite">
              <span className="voiceConnectionIcon" aria-hidden="true">
                {connectionPopup === "connecting" ? <LoaderCircle size={22} /> : <CheckCircle2 size={22} />}
              </span>
              <div className="voiceConnectionCopy">
                <strong>{connectionPopup === "connecting" ? "正在连接声音服务" : connectionPopup === "connected" ? "声音服务已连接" : "声音服务已断开"}</strong>
                <p>{connectionPopup === "connecting" ? "正在检查 GPT-SoVITS 服务和声音资源。" : connectionPopup === "connected" ? "GPT-SoVITS 已就绪，可以生成和播放语音。" : "GPT-SoVITS 已断开，需要时可以重新连接。"}</p>
              </div>
            </div>,
            popupHost
          )
        : null}

      <div className="panelTitleRow">
        <div>
          <h2>声音模型</h2>
          <p>为当前桌宠绑定本地 GPT-SoVITS 服务，保存服务地址、模型路径、参考音频和参考文本。</p>
        </div>
      </div>

      <section className="voiceConfigCard voiceResourceCard" aria-label="资源配置">
        <div className="voiceCardHeader">
          <div>
            <span className="sectionIconTitle">
              <Volume2 size={19} />
              <h2>资源配置</h2>
            </span>
            <p>使用本机默认 GPT-SoVITS 地址，选择声音资源后再连接。</p>
          </div>
          <button
            className={connected ? "connectAction disconnect" : "connectAction"}
            type="button"
            disabled={connectionPopup === "connecting"}
            onClick={() => void toggleConnection()}
          >
            {connected ? <XCircle size={16} /> : <PlugZap size={16} />}
            {connected ? "断开连接" : connectionPopup === "connecting" ? "连接中" : "连接"}
          </button>
        </div>
        <label className="formField">
          <span>GPT-SoVITS 本地根目录（完整文件夹路径）</span>
          <input
            value={draft.gptSoVitsRootPath ?? ""}
            placeholder="例如：D:\\gpt\\GPT-SoVITS"
            onChange={(event) => updateVoiceDraft({ gptSoVitsRootPath: event.target.value })}
          />
        </label>

        <div className="voiceRuntimeGrid">
          <label className="formField">
            <span>模型版本</span>
            <AppleSelect
              value={draft.modelVersion}
              disabled={!runtimeEditable}
              ariaLabel="GPT-SoVITS 模型版本"
              options={voiceModelVersionOptions}
              onChange={(nextVersion) =>
                updateVoiceDraft({ modelVersion: nextVersion as PetVoiceModelVersion })
              }
            />
          </label>
          <label className="formField">
            <span>推理设备</span>
            <AppleSelect
              value={draft.inferenceDevice}
              disabled={!runtimeEditable}
              ariaLabel="语音推理设备"
              options={[
                { value: "auto", label: "自动检测" },
                { value: "cuda", label: "CUDA" },
                { value: "cpu", label: "CPU" }
              ]}
              onChange={(nextDeviceValue) => {
                const nextDevice = nextDeviceValue as PetVoiceInferenceDevice;

                updateVoiceDraft({
                  inferenceDevice: nextDevice,
                  halfPrecision: nextDevice === "cpu" ? false : draft.halfPrecision
                });
              }}
            />
          </label>
          <div className="voiceOptionToggle compact">
            <div>
              <h3>半精度推理</h3>
              <p>CUDA 可用时减少显存占用。</p>
            </div>
            <label
              className={
                runtimeEditable && draft.inferenceDevice !== "cpu"
                  ? "settingsSwitch"
                  : "settingsSwitch disabled"
              }
            >
              <input
                type="checkbox"
                checked={draft.halfPrecision}
                disabled={!runtimeEditable || draft.inferenceDevice === "cpu"}
                onChange={(event) => updateVoiceDraft({ halfPrecision: event.target.checked })}
              />
              <span />
            </label>
          </div>
        </div>

        <div className="voiceFileList">
          <VoiceFileRow
            icon={<FileCode2 size={18} />}
            title="SoVITS 模型"
            fileName={draft.sovitsModelPath}
            hint=".pth，可放在项目外任意本地目录"
            onPick={() => void pickVoiceFile("sovits")}
          />
          <VoiceFileRow
            icon={<FileCode2 size={18} />}
            title="GPT 模型"
            fileName={draft.gptModelPath}
            hint=".ckpt，只保存路径引用"
            onPick={() => void pickVoiceFile("gpt")}
          />
          <VoiceFileRow
            icon={<FileAudio size={18} />}
            title="参考音频"
            fileName={draft.referenceAudioPath}
            hint="干净的参考音频，时长 3-10 秒"
            onPick={() => void pickVoiceFile("referenceAudio")}
          />
        </div>

        <label className="formField">
          <span>参考文本</span>
          <textarea
            rows={4}
            value={draft.referenceText}
            placeholder="参考音频对应的文本"
            onChange={(event) => updateVoiceDraft({ referenceText: event.target.value })}
          />
        </label>
        <label className="formField">
          <span>参考音频语言</span>
          <AppleSelect
            value={draft.referenceLanguage}
            ariaLabel="参考音频语言"
            options={voiceLanguageOptions}
            onChange={(nextLanguage) =>
              updateVoiceDraft({ referenceLanguage: nextLanguage as PetVoiceLanguage })
            }
          />
        </label>
      </section>

      <section className="voiceConfigCard voiceEnableSection" aria-label="启用语音回复">
        <div className="voiceEnableCopy">
          <h3>启用语音回复</h3>
          <p>
            {connected
              ? "连接成功后已自动打开。关闭后仍可保留资源配置，只显示文字和字幕。"
              : "关闭后仍可保留资源配置，只显示文字和字幕。"}
          </p>
        </div>
        <label className={connected ? "voiceToggle" : "voiceToggle disabled"}>
          <span>关闭</span>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={!connected}
            onChange={(event) => {
              updateVoiceDraft({
                enabled: event.target.checked
              });
            }}
          />
          <i aria-hidden="true" />
          <span>打开</span>
        </label>
      </section>

      <section
        className={optionsEditable ? "voiceEnabledOptions" : "voiceEnabledOptions disabled"}
        aria-label="语音回复选项"
      >
        <label className="formField">
          <span>输出语言</span>
          <AppleSelect
            value={draft.language}
            disabled={!optionsEditable}
            ariaLabel="语音回复语言"
            options={voiceLanguageOptions}
            onChange={(nextLanguage) => updateVoiceDraft({ language: nextLanguage as PetVoiceLanguage })}
          />
        </label>
        <div className="voiceOptionToggle">
          <div>
            <h3>首句就绪后输出</h3>
            <p>开启后会先等首句音频就绪再显示和播放；等待时会继续流式预合成后续句子。</p>
          </div>
          <label className={optionsEditable ? "settingsSwitch" : "settingsSwitch disabled"}>
            <input
              type="checkbox"
              checked={draft.syncTextWithVoice}
              disabled={!optionsEditable}
              onChange={(event) =>
                updateVoiceDraft({
                  syncTextWithVoice: event.target.checked,
                  playMode: "sentence"
                })
              }
            />
            <span />
          </label>
        </div>
      </section>

      {result && result !== saveResult
        ? createPortal(
            <div
              className={result.ok ? "voiceConnectPopup voiceFeedbackPopup success" : "voiceConnectPopup voiceFeedbackPopup error"}
              role={result.ok ? "status" : "alert"}
              aria-live={result.ok ? "polite" : "assertive"}
            >
              <span className="voiceFeedbackIcon" aria-hidden="true">
                {result.ok ? <CheckCircle2 size={22} /> : <XCircle size={22} />}
              </span>
              <strong>{result.ok ? "操作成功" : "操作未完成"}</strong>
              <p>{result.message}</p>
            </div>,
            popupHost
          )
        : null}

      <PanelSaveActions
        onSave={() => void saveVoiceModel()}
        saving={saving}
        result={saveResult}
        saved={Boolean(saveResult?.ok)}
      />
    </div>
  );
}
