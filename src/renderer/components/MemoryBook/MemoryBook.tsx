import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  HardDrive,
  Heart,
  LayoutList,
  MessageSquareQuote,
  MoonStar,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  MEMORY_AUTO_CAPTURE_CONSENT,
  MEMORY_AUTO_CAPTURE_CONSENT_NOTICE,
  MEMORY_CHAPTERS,
  MEMORY_SOURCE_EXPORT_CONSENT,
  MEMORY_SOURCE_RETENTION_CONSENT
} from "../../../shared/types/memory";
import type {
  MemoryChapter,
  MemoryManagementStatus,
  MemoryRecord,
  MemorySourceConversation,
  MemorySettings as MemorySettingsDto,
  MemorySummary
} from "../../../shared/types/memory";
import type { PetDefinition } from "../../../shared/types/pet";
import {
  MEMORY_CHAPTER_META,
  MEMORY_ORIGIN_LABELS,
  advanceMemoryBookPage,
  createMemoryBookRouteState,
  formatMemoryDate,
  getMemoryBookRequestPageSizes,
  getMemoryBookRestoreScrollTop,
  memoryErrorMessage,
  retreatMemoryBookPage,
  resetMemoryBookPagination
} from "./memoryBookState";
import type { MemoryBookChapterFilter, MemoryBookRouteState } from "./memoryBookState";
import { MemorySourcePanel } from "./MemorySourcePanel";
import { MemoryBackupExportPanel, MemoryBackupImportPanel } from "./MemoryBackupPanels";
import type { MemoryBackupInspection } from "../../../shared/types/memoryBackup";

const LIST_PAGE_SIZE = 5;
const MEMORY_ONBOARDING_PAGE_TURN_MS = 1200;

interface MemoryBookProps {
  pet: PetDefinition;
  initialState?: MemoryBookRouteState;
  onStateChange?: (state: MemoryBookRouteState) => void;
  onBack: () => void;
}

interface UndoState {
  memoryId: string;
  revision: number;
  label: string;
}

type EditorState = { mode: "create"; chapter: MemoryChapter } | { mode: "edit"; memory: MemoryRecord };

interface SourceConversationState {
  memory: MemoryRecord;
  loading: boolean;
  source?: MemorySourceConversation;
  error?: string;
}

function initialChapter(value: MemoryBookChapterFilter): MemoryChapter {
  return value === "all" ? "about_you" : value;
}

function avatarFallback(pet: PetDefinition): string {
  return pet.avatar || pet.name.trim().slice(0, 2).toUpperCase() || "记";
}

function MemoryDialog({
  title,
  children,
  onClose,
  wide = false
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    panelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    <div className="memoryDialogOverlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        className={wide ? "memoryDialog memoryDialogWide" : "memoryDialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === "Tab") {
            const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
              "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
            )).filter((element) => !element.hasAttribute("hidden"));
            const first = focusable[0];
            const last = focusable.at(-1);
            if (!first || !last) {
              event.preventDefault();
            } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button className="memoryIconButton" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

function MemoryOnboardingDialog({
  petName,
  busy,
  animationsEnabled,
  turningPage,
  error,
  onConfirm,
  onDecline
}: {
  petName: string;
  busy: boolean;
  animationsEnabled: boolean;
  turningPage: boolean;
  error?: string;
  onConfirm: () => void;
  onDecline: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div className={`${animationsEnabled ? "memoryOnboardingOverlay" : "memoryOnboardingOverlay noMotion"}${turningPage ? " turningPage" : ""}`} role="presentation">
      <div
        className="memoryOnboardingDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-onboarding-title"
        aria-describedby="memory-onboarding-description"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            onDecline();
          }
        }}
      >
        <div className="memoryOnboardingPage" aria-hidden="true">
          <span className="memoryOnboardingPageMark"><BookOpen size={38} /></span>
          <span>记忆书正在苏醒</span>
        </div>
        <div className="memoryOnboardingFront">
          <span className="memoryOnboardingAura" aria-hidden="true" />
          <div className="memoryOnboardingSigil" aria-hidden="true"><MoonStar size={26} /><Sparkles size={16} /></div>
          <p className="memoryOnboardingKicker">首次启用</p>
          <h2 id="memory-onboarding-title">让记忆书开始回应你</h2>
          <p id="memory-onboarding-description">开启后，{petName} 会在对话中回想与你有关的记忆，并在完整回复后整理值得长期保存的内容。</p>
          {error ? <div className="memoryOnboardingError" role="alert"><AlertTriangle size={17} />{error}</div> : null}
          <div className="memoryOnboardingActions">
            <button className="secondaryAction" type="button" disabled={busy} onClick={onDecline}>暂不启用</button>
            <button className="primaryAction" type="button" disabled={busy} onClick={onConfirm}><Sparkles size={17} />{busy ? "正在开启" : "开启对话记忆"}</button>
          </div>
        </div>
        <div className="memoryOnboardingInsideCover" aria-hidden="true"><BookOpen size={42} /></div>
      </div>
    </div>
  );
}

function MemorySelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  fullWidth = false
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  fullWidth?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const choose = (index: number): void => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setHighlightedIndex(index);
    setOpen(false);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setOpen(true);
      setHighlightedIndex((current) => (current + direction + options.length) % options.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setOpen(true);
      setHighlightedIndex(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(highlightedIndex);
      else {
        setHighlightedIndex(selectedIndex);
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className={fullWidth ? "memorySelectControl fullWidth" : "memorySelectControl"} ref={rootRef}>
      <button
        className="memorySelectTrigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-option-${highlightedIndex}` : undefined}
        onClick={() => {
          setHighlightedIndex(selectedIndex);
          setOpen((current) => !current);
        }}
        onKeyDown={handleKeyDown}
      >
        <span>{options[selectedIndex]?.label ?? value}</span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {open ? <div className="memorySelectMenu" id={listboxId} role="listbox" aria-label={ariaLabel}>
        {options.map((option, index) => <button
          className={highlightedIndex === index ? "highlighted" : ""}
          type="button"
          role="option"
          aria-selected={option.value === value}
          id={`${listboxId}-option-${index}`}
          tabIndex={-1}
          key={option.value}
          onPointerEnter={() => setHighlightedIndex(index)}
          onClick={() => choose(index)}
        ><span>{option.label}</span><Check size={15} aria-hidden="true" /></button>)}
      </div> : null}
    </div>
  );
}

function MemoryEditor({
  state,
  busy,
  onClose,
  onSubmit
}: {
  state: EditorState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (value: { chapter: MemoryChapter; content: string; tags: string[]; important: boolean }) => void;
}): JSX.Element {
  const memory = state.mode === "edit" ? state.memory : undefined;
  const [chapter, setChapter] = useState<MemoryChapter>(
    memory?.chapter ?? (state.mode === "create" ? state.chapter : "about_you")
  );
  const [content, setContent] = useState(memory?.content ?? "");
  const [tags, setTags] = useState(memory?.tags.join("，") ?? "");
  const [important, setImportant] = useState(memory?.important ?? false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!content.trim()) return;
    onSubmit({
      chapter,
      content: content.trim(),
      tags: tags.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 16),
      important
    });
  };

  return (
    <MemoryDialog title={state.mode === "edit" ? "编辑记忆" : "写下一条记忆"} onClose={onClose} wide>
      <form className="memoryEditorForm" onSubmit={submit}>
        <div className="memoryEditorField"><span>章节</span><MemorySelect value={chapter} options={MEMORY_CHAPTERS.map((value) => ({ value, label: MEMORY_CHAPTER_META[value].label }))} onChange={setChapter} ariaLabel="记忆章节" fullWidth /></div>
        <label>记忆正文
          <textarea autoFocus maxLength={8192} rows={8} required value={content} onChange={(event) => setContent(event.target.value)} />
          <small>{content.length} / 8192</small>
        </label>
        <label>标签 <span>用逗号分隔，最多 16 个</span>
          <input maxLength={512} value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：旅行，咖啡" />
        </label>
        <label className="memoryCheckRow">
          <input type="checkbox" checked={important} onChange={(event) => setImportant(event.target.checked)} />
          标记为重要记忆
        </label>
        <div className="memoryDialogActions">
          <button className="secondaryAction" type="button" onClick={onClose}>取消</button>
          <button className="primaryAction" type="submit" disabled={busy || !content.trim()}>{busy ? "保存中" : "保存记忆"}</button>
        </div>
      </form>
    </MemoryDialog>
  );
}

function MemoryCard({
  memory,
  onRead,
  onEdit,
  onForget,
  onToggleImportant
}: {
  memory: MemoryRecord;
  onRead: () => void;
  onEdit: () => void;
  onForget: () => void;
  onToggleImportant: () => void;
}): JSX.Element {
  return (
    <article className={memory.important ? "memoryCard important" : "memoryCard"} tabIndex={0} onKeyDown={(event) => {
      if (event.key === "Enter") onRead();
    }}>
      <button className="memoryCardBody" type="button" onClick={onRead} aria-label={`阅读记忆：${memory.content.slice(0, 40)}`}>
        <span className="memoryCardMeta">
          <span>{formatMemoryDate(memory.sourceTime ?? memory.createdAt)}</span>
          <span>{MEMORY_ORIGIN_LABELS[memory.origin]}</span>
        </span>
        <p>{memory.content}</p>
        {memory.tags.length ? <span className="memoryTags">{memory.tags.map((tag) => <em key={tag}>#{tag}</em>)}</span> : null}
      </button>
      <footer>
        <span title={`更新于 ${formatMemoryDate(memory.updatedAt)}`}>修订 {memory.revision}</span>
        <div>
          <button className="memoryIconButton" type="button" aria-label={memory.important ? "取消重要" : "标记重要"} onClick={onToggleImportant}>
            <Star size={16} fill={memory.important ? "currentColor" : "none"} />
          </button>
          <button className="memoryIconButton" type="button" aria-label="编辑记忆" onClick={onEdit}><Pencil size={16} /></button>
          <button className="memoryIconButton danger" type="button" aria-label="忘记这条记忆" onClick={onForget}><Trash2 size={16} /></button>
        </div>
      </footer>
    </article>
  );
}

function MemorySettingsPanel({
  settings,
  status,
  busy,
  onClose,
  onSave,
  onTestProvider,
  onRebuild
}: {
  settings: MemorySettingsDto;
  status?: MemoryManagementStatus;
  busy: boolean;
  onClose: () => void;
  onSave: (settings: MemorySettingsDto) => void;
  onTestProvider: () => void;
  onRebuild: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(settings);
  const [confirmSourceRetention, setConfirmSourceRetention] = useState(false);
  const sourceRetentionToggleRef = useRef<HTMLInputElement>(null);
  const sourceRetentionHelpId = useId();
  const finishSourceRetentionConfirmation = (enabled: boolean): void => {
    if (enabled) setDraft((current) => ({ ...current, retainSources: true }));
    setConfirmSourceRetention(false);
    window.requestAnimationFrame(() => sourceRetentionToggleRef.current?.focus());
  };

  if (confirmSourceRetention) {
    return (
      <MemoryDialog title="开启来源对话保留？" onClose={() => finishSourceRetentionConfirmation(false)} wide>
        <div className="memoryRetentionConsent">
          <div className="memoryRetentionConsentLead">
            <span aria-hidden="true"><MessageSquareQuote size={25} /></span>
            <div>
              <p className="eyebrow">来源追溯</p>
              <h3>保存生成记忆所依据的一轮对话</h3>
              <p>开启后，新记忆可以在详情中查看当时的用户消息和桌宠回复，帮助你判断这条记忆是怎样整理出来的。开启对话召回后，相关原文也会随记忆发送给当前配置的 AI。</p>
            </div>
          </div>
          <div className="memoryRetentionConsentPoints">
            <p><HardDrive size={19} aria-hidden="true" /><span><strong>会增加本机存储占用</strong>来源文本会随对话逐渐积累；此选项本身不会让记忆模型额外常驻运行内存。</span></p>
            <p><BookOpen size={19} aria-hidden="true" /><span><strong>可从记忆详情追溯</strong>打开一条已保留来源的记忆，点击“查看来源对话”即可查看。</span></p>
          </div>
          <p className="memoryRetentionConsentFootnote"><CircleAlert size={17} aria-hidden="true" />之后关闭只会停止保存新的来源对话；已有来源仍跟随对应记忆一起管理和删除。</p>
          <div className="memoryDialogActions">
            <button className="secondaryAction" type="button" onClick={() => finishSourceRetentionConfirmation(false)}>暂不开启</button>
            <button className="primaryAction" type="button" onClick={() => finishSourceRetentionConfirmation(true)}>我知道了，开启</button>
          </div>
        </div>
      </MemoryDialog>
    );
  }

  return (
    <MemoryDialog title="记忆设置与状态" onClose={onClose} wide>
      <div className="memorySettingsPanel">
        <section>
          <h3>对话记忆</h3>
          <label className="memoryToggleRow"><span><strong>在对话中召回</strong><small>用相关记忆及已保留的来源对话帮助桌宠理解上下文</small></span><input type="checkbox" checked={draft.recallEnabled} onChange={(event) => setDraft({ ...draft, recallEnabled: event.target.checked })} /></label>
          <label className="memoryToggleRow"><span><strong>自动整理新记忆</strong><small>{MEMORY_AUTO_CAPTURE_CONSENT_NOTICE}</small></span><input type="checkbox" checked={draft.autoCaptureEnabled} onChange={(event) => setDraft({ ...draft, autoCaptureEnabled: event.target.checked })} /></label>
          <label className="memoryToggleRow"><span><strong>保留来源对话</strong><small id={sourceRetentionHelpId}>生成记忆所依据的一轮对话会保存在当前桌宠的本机记忆目录中</small></span><input ref={sourceRetentionToggleRef} type="checkbox" checked={draft.retainSources} aria-describedby={sourceRetentionHelpId} onChange={(event) => {
            if (event.target.checked) {
              setConfirmSourceRetention(true);
            } else {
              setDraft((current) => ({ ...current, retainSources: false }));
            }
          }} /></label>
          <div className="memorySettingsGrid">
            <label>每次召回条数<input type="number" min={1} max={10} value={draft.recallLimit} onChange={(event) => setDraft({ ...draft, recallLimit: Number(event.target.value) })} /></label>
            <label>上下文字符预算<input type="number" min={512} max={4096} step={128} value={draft.contextBudgetChars} onChange={(event) => setDraft({ ...draft, contextBudgetChars: Number(event.target.value) })} /></label>
          </div>
        </section>
        <section className="memoryServiceStatus">
          <h3>服务状态</h3>
          <p><span>整理服务</span><strong>{status?.provider.state ?? "未知"}</strong></p>
          <p><span>派生索引</span><strong>{status?.indexState === "pending" ? "待同步" : "已同步"}</strong></p>
          <p><span>待整理回合</span><strong>{status?.pendingCaptures ?? 0}</strong></p>
          <p><span>失败队列</span><strong>{status?.deadLetters ?? 0}</strong></p>
          {status?.provider.message ? <small>{status.provider.message}</small> : null}
          <div className="memoryInlineActions">
            <button className="secondaryAction" type="button" disabled={busy} onClick={onTestProvider}><RefreshCw size={16} />测试服务</button>
            <button className="secondaryAction" type="button" disabled={busy} onClick={onRebuild}><RotateCcw size={16} />重建索引</button>
          </div>
        </section>
        <div className="memoryDialogActions">
          <button className="secondaryAction" type="button" onClick={onClose}>取消</button>
          <button className="primaryAction" type="button" disabled={busy} onClick={() => onSave(draft)}>{busy ? "保存中" : "保存设置"}</button>
        </div>
      </div>
    </MemoryDialog>
  );
}

export function MemoryBook({ pet, initialState, onStateChange, onBack }: MemoryBookProps): JSX.Element {
  const api = window.desktopPet?.memory;
  const [route, setRoute] = useState<MemoryBookRouteState>(initialState ?? createMemoryBookRouteState);
  const [summary, setSummary] = useState<MemorySummary>();
  const [status, setStatus] = useState<MemoryManagementStatus>();
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [showPageLoading, setShowPageLoading] = useState(false);
  const [hasResolvedPage, setHasResolvedPage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [onboardingError, setOnboardingError] = useState<string>();
  const [onboardingClosing, setOnboardingClosing] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [editor, setEditor] = useState<EditorState>();
  const [readingMemory, setReadingMemory] = useState<MemoryRecord>();
  const [sourceConversation, setSourceConversation] = useState<SourceConversationState>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const [importOpen, setImportOpen] = useState(false);
  const [importInspection, setImportInspection] = useState<MemoryBackupInspection>();
  const [importError, setImportError] = useState<string>();
  const importInspectionRef = useRef<MemoryBackupInspection>();
  const importSequenceRef = useRef(0);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearConfirm, setClearConfirm] = useState("");
  const [includeSources, setIncludeSources] = useState(false);
  const [undo, setUndo] = useState<UndoState>();
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState(route.query);
  const [singlePage, setSinglePage] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onboardingTimerRef = useRef<number>();
  const sourceRequestSequenceRef = useRef(0);

  useEffect(() => {
    setImportOpen(false);
    setImportInspection(undefined);
    return () => {
      importSequenceRef.current += 1;
      const inspection = importInspectionRef.current;
      importInspectionRef.current = undefined;
      if (inspection) void api?.cancelImport({ petId: pet.id, token: inspection.token });
    };
  }, [api, pet.id]);

  useEffect(() => () => {
    if (onboardingTimerRef.current !== undefined) window.clearTimeout(onboardingTimerRef.current);
  }, []);

  useEffect(() => {
    setOnboardingDismissed(false);
    setOnboardingError(undefined);
    sourceRequestSequenceRef.current += 1;
    setSourceConversation(undefined);
  }, [pet.id]);

  useEffect(() => onStateChange?.(route), [onStateChange, route]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = (): void => setSinglePage(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(route.query.trim()), 260);
    return () => window.clearTimeout(timer);
  }, [route.query]);

  const updateRoute = useCallback((patch: Partial<MemoryBookRouteState>, resetPage = false): void => {
    setRoute((current) => resetPage ? resetMemoryBookPagination(current, patch) : { ...current, ...patch });
  }, []);

  const requestPage = useCallback(async (cursor: string | undefined) => {
    if (!api) return undefined;
    const common = {
      petId: pet.id,
      chapters: route.chapter === "all" ? undefined : [route.chapter],
      importantOnly: route.importantOnly || undefined,
      sort: route.sort,
      fromTime: route.fromTime ? new Date(`${route.fromTime}T00:00:00`).toISOString() : undefined,
      toTime: route.toTime ? new Date(`${route.toTime}T23:59:59.999`).toISOString() : undefined
    } as const;
    const items: MemoryRecord[] = [];
    let nextPageCursor = cursor;
    for (const pageSize of getMemoryBookRequestPageSizes(route.displayMode, singlePage)) {
      const request = { ...common, cursor: nextPageCursor, pageSize };
      const result = debouncedQuery
        ? await api.search({ ...request, query: debouncedQuery })
        : await api.list(request);
      if (!result.ok) return result;
      items.push(...result.value.items);
      nextPageCursor = result.value.nextCursor;
      if (!nextPageCursor) break;
    }
    return { ok: true as const, value: { items, nextCursor: nextPageCursor } };
  }, [api, debouncedQuery, pet.id, route.chapter, route.displayMode, route.fromTime, route.importantOnly, route.sort, route.toTime, singlePage]);

  const refreshOverview = useCallback(async (): Promise<void> => {
    if (!api) {
      setError("当前页面未获得主窗口记忆管理能力。请从桌面灵主窗口打开记忆书。");
      setLoading(false);
      return;
    }
    setError(undefined);
    const [summaryResult, statusResult] = await Promise.all([api.getSummary(pet.id), api.getStatus(pet.id)]);
    if (summaryResult.ok) setSummary(summaryResult.value); else setError(memoryErrorMessage(summaryResult.error));
    if (statusResult.ok) setStatus(statusResult.value); else setError(memoryErrorMessage(statusResult.error));
    setLoading(false);
  }, [api, pet.id]);

  useEffect(() => { void refreshOverview(); }, [refreshOverview, refreshSequence]);

  useEffect(() => {
    if (route.section !== "reading" || !api) return;
    let active = true;
    setPageLoading(true);
    setError(undefined);
    void requestPage(route.cursors[route.pageIndex]).then((result) => {
      if (!active || !result) return;
      setHasResolvedPage(true);
      if (result.ok) {
        setRecords(result.value.items);
        setNextCursor(result.value.nextCursor);
      } else {
        setRecords([]);
        setNextCursor(undefined);
        setError(memoryErrorMessage(result.error));
      }
    }).catch((cause) => {
      if (active) {
        setHasResolvedPage(true);
        setError(cause instanceof Error ? cause.message : "读取记忆失败，请重试。");
      }
    }).finally(() => {
      if (active) setPageLoading(false);
    });
    return () => { active = false; };
  }, [api, debouncedQuery, refreshSequence, requestPage, route.cursors, route.pageIndex, route.section]);

  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: getMemoryBookRestoreScrollTop(route), behavior: "auto" });
  }, []);

  useLayoutEffect(() => {
    if (route.section !== "reading" || pageLoading) return;
    const activeElement = document.activeElement;
    const editingFilter = activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement ||
      activeElement?.getAttribute("contenteditable") === "true";
    if (!editingFilter) pageHeadingRef.current?.focus({ preventScroll: true });
  }, [pageLoading, route.pageIndex, route.section]);

  useLayoutEffect(() => {
    if (!pageLoading) {
      setShowPageLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowPageLoading(true), 180);
    return () => window.clearTimeout(timer);
  }, [pageLoading]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(undefined), 7000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const goNext = useCallback((): void => {
    if (!nextCursor || pageLoading) return;
    setRoute((current) => advanceMemoryBookPage(current, nextCursor));
  }, [nextCursor, pageLoading]);

  const goPrevious = useCallback((): void => {
    const returningToCover = route.pageIndex === 0;
    setRoute((current) => retreatMemoryBookPage(current));
    if (returningToCover) {
      scrollRef.current?.scrollTo({
        top: 0,
        behavior: route.animationsEnabled ? "smooth" : "auto"
      });
    }
  }, [route.animationsEnabled, route.pageIndex]);

  const jumpToEnd = useCallback(async (): Promise<void> => {
    if (!api || pageLoading) return;
    setPageLoading(true);
    let cursor: string | undefined;
    const cursors: Array<string | undefined> = [undefined];
    let lastRecords: MemoryRecord[] = [];
    try {
      for (let page = 0; page < 200; page += 1) {
        const result = await requestPage(cursor);
        if (!result || !result.ok) {
          if (result && !result.ok) setError(memoryErrorMessage(result.error));
          return;
        }
        lastRecords = result.value.items;
        if (!result.value.nextCursor) {
          setRecords(lastRecords);
          setNextCursor(undefined);
          setRoute((current) => ({ ...current, cursors, pageIndex: cursors.length - 1 }));
          return;
        }
        cursor = result.value.nextCursor;
        cursors.push(cursor);
      }
      setError("记忆页数过多，请使用搜索或时间范围缩小结果。");
    } finally {
      setPageLoading(false);
    }
  }, [api, pageLoading, requestPage]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']");
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) return;
      if (event.key === "Escape") {
        if (editor || readingMemory || sourceConversation || settingsOpen || exportOpen || importOpen || clearOpen) return;
        onBack();
      } else if (route.section === "cover" && event.key === "Enter") {
        updateRoute({ section: "reading" });
      } else if (route.section === "reading") {
        if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); goNext(); }
        if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); goPrevious(); }
        if (event.key === "Home") { event.preventDefault(); updateRoute({ cursors: [undefined], pageIndex: 0 }); }
        if (event.key === "End") { event.preventDefault(); void jumpToEnd(); }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [clearOpen, editor, exportOpen, importOpen, goNext, goPrevious, jumpToEnd, onBack, readingMemory, route.section, settingsOpen, sourceConversation, updateRoute]);

  const refreshAfterMutation = (message: string): void => {
    setNotice(message);
    setRefreshSequence((value) => value + 1);
  };

  const saveEditor = async (value: { chapter: MemoryChapter; content: string; tags: string[]; important: boolean }): Promise<void> => {
    if (!api || !editor) return;
    setBusy(true);
    const result = editor.mode === "create"
      ? await api.create({
          petId: pet.id,
          ...value,
          origin: "manual",
          memoryType: value.chapter === "about_you"
            ? "profile"
            : value.chapter === "preferences_habits"
              ? "behavior"
              : value.chapter === "important_events"
                ? "event"
                : "knowledge"
        })
      : await api.update({ petId: pet.id, memoryId: editor.memory.id, expectedRevision: editor.memory.revision, ...value });
    setBusy(false);
    if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
    setEditor(undefined);
    refreshAfterMutation(editor.mode === "create" ? "记忆已写入" : "记忆已更新");
  };

  const toggleImportant = async (memory: MemoryRecord): Promise<void> => {
    if (!api || busy) return;
    setBusy(true);
    const result = await api.update({ petId: pet.id, memoryId: memory.id, expectedRevision: memory.revision, important: !memory.important });
    setBusy(false);
    if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
    refreshAfterMutation(result.value.memory.important ? "已标记为重要记忆" : "已取消重要标记");
  };

  const openSourceConversation = async (memory: MemoryRecord): Promise<void> => {
    const requestSequence = sourceRequestSequenceRef.current + 1;
    sourceRequestSequenceRef.current = requestSequence;
    setReadingMemory(undefined);
    setSourceConversation({ memory, loading: true });
    if (!api) {
      setSourceConversation({ memory, loading: false, error: "当前窗口无法访问记忆来源。" });
      return;
    }
    const result = await api.getSourceConversation({ petId: pet.id, memoryId: memory.id });
    if (sourceRequestSequenceRef.current !== requestSequence) return;
    if (!result.ok) {
      setSourceConversation({ memory, loading: false, error: memoryErrorMessage(result.error) });
      return;
    }
    if (!result.value) {
      setSourceConversation({
        memory,
        loading: false,
        error: "这条记忆标记为已保留来源，但对应的一轮对话没有找到。原记忆仍然可以正常使用。"
      });
      return;
    }
    setSourceConversation({ memory, loading: false, source: result.value });
  };

  const closeSourceConversation = (): void => {
    sourceRequestSequenceRef.current += 1;
    const memory = sourceConversation?.memory;
    setSourceConversation(undefined);
    if (memory) setReadingMemory(memory);
  };

  const forgetMemory = async (memory: MemoryRecord): Promise<void> => {
    if (!api || busy) return;
    setBusy(true);
    const result = await api.forget({ petId: pet.id, memoryId: memory.id, expectedRevision: memory.revision });
    setBusy(false);
    if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
    setReadingMemory(undefined);
    setUndo({ memoryId: result.value.memoryId, revision: result.value.revision, label: memory.content.slice(0, 32) });
    refreshAfterMutation("已忘记这条记忆，可在 7 秒内撤销");
  };

  const undoForget = async (): Promise<void> => {
    if (!api || !undo) return;
    setBusy(true);
    const result = await api.undoForget({ petId: pet.id, memoryId: undo.memoryId, expectedRevision: undo.revision });
    setBusy(false);
    if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
    setUndo(undefined);
    refreshAfterMutation("记忆已恢复");
  };

  const saveSettings = async (draft: MemorySettingsDto): Promise<void> => {
    if (!api) return;
    setBusy(true);
    const result = await api.saveSettings({
      petId: pet.id,
      settings: draft,
      autoCaptureConsent: draft.autoCaptureEnabled ? MEMORY_AUTO_CAPTURE_CONSENT : undefined,
      sourceRetentionConsent: draft.retainSources ? MEMORY_SOURCE_RETENTION_CONSENT : undefined
    });
    setBusy(false);
    if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
    setSettingsOpen(false);
    refreshAfterMutation("记忆设置已保存");
  };

  const completeMemoryOnboarding = async (): Promise<void> => {
    if (!api || !status || busy || onboardingClosing) return;
    setBusy(true);
    setOnboardingError(undefined);
    const settings: MemorySettingsDto = {
      ...status.settings,
      onboardingCompleted: true,
      recallEnabled: true,
      autoCaptureEnabled: true,
      retainSources: false
    };
    const result = await api.saveSettings({
      petId: pet.id,
      settings,
      autoCaptureConsent: MEMORY_AUTO_CAPTURE_CONSENT
    });
    setBusy(false);
    if (!result.ok) {
      setOnboardingError(memoryErrorMessage(result.error));
      return;
    }
    const finish = (): void => {
      setStatus((current) => current ? { ...current, settings: result.value } : current);
      setOnboardingClosing(false);
      refreshAfterMutation("对话记忆已开启");
    };
    const shouldTurnPage = route.animationsEnabled && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!shouldTurnPage) {
      finish();
      return;
    }
    setOnboardingClosing(true);
    onboardingTimerRef.current = window.setTimeout(finish, MEMORY_ONBOARDING_PAGE_TURN_MS);
  };

  const runStatusAction = async (kind: "test" | "rebuild"): Promise<void> => {
    if (!api) return;
    setBusy(true);
    if (kind === "test") {
      const result = await api.testProvider(pet.id);
      setBusy(false);
      if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
      refreshAfterMutation(result.value.message || "整理服务连接正常");
      return;
    }
    const result = await api.rebuildIndex(pet.id);
    setBusy(false);
    if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
    refreshAfterMutation(`索引已重建，共处理 ${result.value.indexedCount} 条记忆`);
  };

  const exportMemories = async (): Promise<void> => {
    if (!api || busy) return;
    setBusy(true);
    setExportError(undefined);
    try {
      const result = await api.export({
        petId: pet.id,
        options: { includeSources },
        sourceExportConsent: includeSources ? MEMORY_SOURCE_EXPORT_CONSENT : undefined
      });
      if (!result.ok) { setExportError(memoryErrorMessage(result.error)); return; }
      setExportOpen(false);
      setNotice(result.value.message);
    } catch {
      setExportError("导出未能完成，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const selectMemoryBackup = async (): Promise<void> => {
    if (!api || busy) return;
    const sequence = ++importSequenceRef.current;
    setBusy(true);
    setImportError(undefined);
    try {
      const result = await api.prepareImport(pet.id);
      if (sequence !== importSequenceRef.current) {
        if (result.ok && !result.value.canceled) void api.cancelImport({ petId: pet.id, token: result.value.inspection.token });
        return;
      }
      if (!result.ok) { setImportError(memoryErrorMessage(result.error)); setImportOpen(true); return; }
      if (result.value.canceled) return;
      importInspectionRef.current = result.value.inspection;
      setImportInspection(result.value.inspection);
      setImportOpen(true);
    } catch {
      if (sequence === importSequenceRef.current) { setImportError("无法读取备份，请重新选择文件。"); setImportOpen(true); }
    } finally {
      if (sequence === importSequenceRef.current) setBusy(false);
    }
  };

  const closeMemoryImport = (): void => {
    if (busy) return;
    const inspection = importInspectionRef.current;
    importInspectionRef.current = undefined;
    if (inspection) void api?.cancelImport({ petId: pet.id, token: inspection.token });
    setImportInspection(undefined);
    setImportOpen(false);
  };

  const confirmMemoryImport = async (): Promise<void> => {
    if (!api || !importInspection || busy) return;
    const sequence = ++importSequenceRef.current;
    setBusy(true);
    setImportError(undefined);
    try {
      const result = await api.confirmImport({ petId: pet.id, token: importInspection.token });
      if (sequence !== importSequenceRef.current) return;
      importInspectionRef.current = undefined;
      setImportInspection(undefined);
      if (!result.ok) { setImportError(memoryErrorMessage(result.error)); return; }
      setImportOpen(false);
      setUndo(undefined);
      updateRoute({ ...createMemoryBookRouteState(), animationsEnabled: route.animationsEnabled });
      refreshAfterMutation(`已恢复 ${result.value.importedCount} 条记忆，跳过 ${result.value.skippedCount} 条已有记录${result.value.indexState === "pending" ? "；索引待同步" : ""}`);
    } catch {
      if (sequence === importSequenceRef.current) setImportError("恢复结果未能返回，请刷新记忆书确认后重试。");
    } finally {
      if (sequence === importSequenceRef.current) setBusy(false);
    }
  };

  const clearAll = async (): Promise<void> => {
    if (!api || clearConfirm !== pet.name) return;
    setBusy(true);
    const result = await api.clear({ petId: pet.id, confirmPetId: pet.id });
    setBusy(false);
    if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
    setClearOpen(false);
    setClearConfirm("");
    updateRoute({ cursors: [undefined], pageIndex: 0 });
    refreshAfterMutation(`已清空 ${result.value.clearedCount} 条记忆`);
  };

  const selectChapter = (chapter: MemoryBookChapterFilter): void => {
    updateRoute({ section: "reading", chapter }, true);
  };

  const locateInChapter = async (memory: MemoryRecord): Promise<void> => {
    if (!api) return;
    setBusy(true);
    let cursor: string | undefined;
    const cursors: Array<string | undefined> = [undefined];
    try {
      for (let page = 0; page < 200; page += 1) {
        const result = await api.list({
          petId: pet.id,
          chapters: [memory.chapter],
          sort: route.sort,
          cursor,
          pageSize: LIST_PAGE_SIZE
        });
        if (!result.ok) { setError(memoryErrorMessage(result.error)); return; }
        if (result.value.items.some((item) => item.id === memory.id)) {
          setDebouncedQuery("");
          setRecords(result.value.items);
          setNextCursor(result.value.nextCursor);
          setRoute((current) => ({
            ...current,
            section: "reading",
            chapter: memory.chapter,
            query: "",
            importantOnly: false,
            fromTime: "",
            toTime: "",
            cursors,
            pageIndex: cursors.length - 1
          }));
          setReadingMemory(undefined);
          setNotice(`已定位到“${MEMORY_CHAPTER_META[memory.chapter].label}”第 ${cursors.length} 页`);
          return;
        }
        if (!result.value.nextCursor) break;
        cursor = result.value.nextCursor;
        cursors.push(cursor);
      }
      setError("这条记忆已不在当前账本中，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleBack = (): void => {
    onStateChange?.({ ...route, scrollTop: scrollRef.current?.scrollTop ?? 0 });
    onBack();
  };

  const returnToCover = (): void => {
    updateRoute({ section: "cover", chapter: "all", scrollTop: 0 }, true);
    scrollRef.current?.scrollTo({
      top: 0,
      behavior: route.animationsEnabled ? "smooth" : "auto"
    });
  };

  const statusTone = status?.provider.state === "ready" && status.indexState === "synced"
    ? "ready"
    : status?.provider.state === "index-dirty" || status?.indexState === "pending"
      ? "warning"
      : "muted";

  const chapterTitle = route.chapter === "all" ? (debouncedQuery ? "搜索结果" : "全部记忆") : MEMORY_CHAPTER_META[route.chapter].label;
  const pageNumber = route.pageIndex + 1;
  const firstPaperRecords = records.slice(0, singlePage ? records.length : 3);
  const secondPaperRecords = singlePage ? [] : records.slice(3);
  const previousPageLabel = route.pageIndex === 0 ? "回到目录" : "上一页";
  const pageTurnControls = (
    <>
      <button
        className="memoryPageTurnButton previous"
        type="button"
        title={previousPageLabel}
        aria-label={previousPageLabel}
        onClick={goPrevious}
      >
        <ChevronLeft size={16} strokeWidth={2.2} />
      </button>
      <button
        className="memoryPageTurnButton next"
        type="button"
        title="下一页"
        aria-label="下一页"
        disabled={!nextCursor || pageLoading}
        onClick={goNext}
      >
        <ChevronRight size={16} strokeWidth={2.2} />
      </button>
    </>
  );

  return (
    <section className="memoryBookShell" ref={scrollRef} aria-label={`${pet.name} 的记忆书`} onScroll={(event) => {
      if (Math.abs(event.currentTarget.scrollTop - route.scrollTop) > 24) updateRoute({ scrollTop: event.currentTarget.scrollTop });
    }}>
      <header className="memoryBookTopbar">
        <button className="memoryBackButton" type="button" onClick={handleBack}><ArrowLeft size={18} />返回详情</button>
        <div className="memoryBookIdentity"><BookOpen size={18} /><span>{pet.name} 的记忆书</span></div>
        <div className="memoryBookTopActions">
          <span className={`memoryStatusPill ${statusTone}`} title={status?.provider.message ?? "记忆服务状态"}>
            <span />{statusTone === "ready" ? "已同步" : statusTone === "warning" ? "待维护" : "本机账本"}
          </span>
          <button className="memoryIconButton" type="button" aria-label="记忆设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></button>
        </div>
      </header>

      <div className="memoryBookToolbar" role="search">
        <label className="memorySearch"><Search size={17} /><span className="srOnly">搜索记忆</span><input ref={searchRef} value={route.query} onChange={(event) => updateRoute({ query: event.target.value }, true)} placeholder="搜索正文或标签（Ctrl+F）" /></label>
        <MemorySelect value={route.sort} options={[{ value: "newest", label: "最新在前" }, { value: "oldest", label: "最早在前" }]} onChange={(sort) => updateRoute({ sort }, true)} ariaLabel="记忆排序" />
        <button className={route.importantOnly ? "memoryToolButton active" : "memoryToolButton"} type="button" aria-pressed={route.importantOnly} onClick={() => updateRoute({ importantOnly: !route.importantOnly }, true)}><Heart size={16} />只看重要</button>
        <button className="memoryToolButton" type="button" disabled={busy} onClick={() => void selectMemoryBackup()}><Upload size={16} />导入</button>
        <button className="memoryToolButton" type="button" disabled={busy} onClick={() => { setExportError(undefined); setExportOpen(true); }}><Download size={16} />导出</button>
        <button className="memoryToolButton" type="button" onClick={() => setEditor({ mode: "create", chapter: initialChapter(route.chapter) })}><Plus size={16} />添加</button>
      </div>

      <div className="memoryDateFilters">
        <CalendarDays size={16} aria-hidden="true" />
        <label>从 <input type="date" value={route.fromTime} max={route.toTime || undefined} onChange={(event) => updateRoute({ fromTime: event.target.value }, true)} /></label>
        <label>到 <input type="date" value={route.toTime} min={route.fromTime || undefined} onChange={(event) => updateRoute({ toTime: event.target.value }, true)} /></label>
        {(route.fromTime || route.toTime || route.query || route.importantOnly) ? <button type="button" onClick={() => updateRoute({ query: "", fromTime: "", toTime: "", importantOnly: false }, true)}>清除筛选</button> : null}
      </div>

      <nav className="memoryBookmarks" aria-label="记忆章节">
        <button className={route.section === "cover" || route.chapter === "all" ? "active" : ""} type="button" onClick={() => selectChapter("all")}><span>{route.section === "cover" ? "目录" : "全部"}</span><strong>{summary?.total ?? 0}</strong></button>
        {MEMORY_CHAPTERS.map((chapter) => <button className={route.section === "reading" && route.chapter === chapter ? "active" : ""} type="button" key={chapter} onClick={() => selectChapter(chapter)}><span>{MEMORY_CHAPTER_META[chapter].shortLabel}</span><strong>{summary?.byChapter[chapter] ?? 0}</strong></button>)}
      </nav>

      {!loading && error && route.section === "cover" ? (
        <div className="memoryCoverError" role="alert">
          <AlertTriangle size={21} />
          <span><strong>记忆书暂时无法完整读取</strong>{error}</span>
          <button type="button" onClick={() => setRefreshSequence((value) => value + 1)}>重试</button>
        </div>
      ) : null}

      {loading ? <div className="memoryCenteredState memoryLoadingState" role="status"><div className="memoryLoadingBook" aria-hidden="true"><span /><span /><MoonStar size={24} /></div><h2>正在唤醒记忆书</h2><p>读取当前桌宠的本机账本与状态…</p></div> : null}

      {!loading && route.section === "cover" ? (
        <div className="memoryCoverScene">
          <button className="memoryCover" type="button" onClick={() => updateRoute({ section: "reading", chapter: "all" }, true)} aria-label={`打开 ${pet.name} 的记忆书，共 ${summary?.total ?? 0} 条记忆`}>
            <span className="memoryCoverBinding" />
            <span className="memoryCoverOrbit" aria-hidden="true"><MoonStar size={28} /><Sparkles size={15} /></span>
            <span className="memoryCoverAvatar">{pet.avatarImage ? <img src={pet.avatarImage} alt="" /> : avatarFallback(pet)}</span>
            <span className="memoryCoverKicker">MEMORY BOOK</span>
            <strong>{pet.name}</strong>
            <span className="memoryCoverCount">收录 {summary?.total ?? 0} 条记忆</span>
            <span className="memoryCoverOpen"><BookOpen size={17} />点击或按 Enter 翻开</span>
          </button>
          <div className="memoryContents" aria-label="章节目录">
            <p className="eyebrow">Contents</p><h2>四个章节，记录相伴点滴</h2>
            {MEMORY_CHAPTERS.map((chapter, index) => <button key={chapter} type="button" onClick={() => selectChapter(chapter)}><span>{String(index + 1).padStart(2, "0")}</span><span><strong>{MEMORY_CHAPTER_META[chapter].label}</strong><small>{MEMORY_CHAPTER_META[chapter].description}</small></span><em>{summary?.byChapter[chapter] ?? 0}</em></button>)}
            {summary?.total === 0 ? <div className="memoryCoverEmpty"><CircleAlert size={18} /><span>这本书还是空白。可以先手动写下一条记忆。</span></div> : null}
          </div>
        </div>
      ) : null}

      {!loading && route.section === "reading" ? (
        <div className={route.animationsEnabled ? "memoryReadingArea" : "memoryReadingArea noMotion"}>
          <header className="memoryReadingHeader">
            <div className="memoryReadingTitle">
              {(route.displayMode !== "book" || !records.length) ? <button className="memoryHeaderReturnButton" type="button" title="回到封面" aria-label="回到封面" onClick={returnToCover}><ChevronLeft size={21} strokeWidth={2.2} /></button> : null}
              <div><p className="eyebrow">Chapter</p><h1 ref={pageHeadingRef} tabIndex={-1}>{chapterTitle}</h1><p aria-live="polite">第 {pageNumber} 页 · 本页 {records.length} 条</p></div>
            </div>
            <div className="memoryViewControls" aria-label="阅读显示">
              <button className={route.displayMode === "book" ? "active" : ""} type="button" aria-pressed={route.displayMode === "book"} onClick={() => updateRoute({ displayMode: "book" }, true)}><BookOpen size={16} />书页</button>
              <button className={route.displayMode === "list" ? "active" : ""} type="button" aria-pressed={route.displayMode === "list"} onClick={() => updateRoute({ displayMode: "list" }, true)}><LayoutList size={16} />列表</button>
              <button className={!route.animationsEnabled ? "active" : ""} type="button" aria-pressed={!route.animationsEnabled} onClick={() => updateRoute({ animationsEnabled: !route.animationsEnabled })}>动画 {route.animationsEnabled ? "开" : "关"}</button>
            </div>
          </header>

          {error ? <div className="memoryInlineError" role="alert"><AlertTriangle size={20} /><span><strong>无法完成读取</strong>{error}</span><button type="button" onClick={() => setRefreshSequence((value) => value + 1)}>重试</button></div> : null}
          {status?.provider.state !== "ready" ? <div className="memoryProviderNotice"><CircleAlert size={18} /><span><strong>{status?.provider.state === "disabled" ? "整理服务未启用" : "整理服务暂不可用"}</strong>手动记忆与本机账本仍可使用。{status?.provider.message ? ` ${status.provider.message}` : ""}</span><button type="button" onClick={() => setSettingsOpen(true)}>查看设置</button></div> : null}
          {(status?.indexState === "pending" || status?.provider.state === "index-dirty") ? <div className="memoryProviderNotice warning"><RefreshCw size={18} /><span><strong>派生索引需要维护</strong>账本内容仍可读；重建只会从账本生成索引。</span><button type="button" onClick={() => void runStatusAction("rebuild")}>重建索引</button></div> : null}

          {showPageLoading && !records.length && !hasResolvedPage ? <div className="memoryCenteredState compact memoryDelayedLoading" role="status"><BookOpen size={25} /><span>正在翻页…</span></div> : null}
          {!records.length && !error && (hasResolvedPage || !pageLoading) ? (
            <div className={`${pageLoading ? "memoryPageStage isLoading" : "memoryPageStage"} ${route.displayMode === "list" ? "listMode" : "bookMode"}`} aria-busy={pageLoading}>
              <div className="memoryCenteredState memoryEmpty"><BookOpen size={34} /><h2>{debouncedQuery ? "没有找到相符记忆" : "这一页还是空白"}</h2><p>{debouncedQuery ? "试试更短的关键词，或清除章节与时间筛选。" : "手动记录一件值得记住的事，之后也可以继续编辑。"}</p><button className="primaryAction" type="button" onClick={() => setEditor({ mode: "create", chapter: initialChapter(route.chapter) })}><Plus size={17} />添加记忆</button></div>
              {pageTurnControls}
              {showPageLoading ? <div className="memoryPageLoadingOverlay" role="status"><span><BookOpen size={18} />正在翻页…</span></div> : null}
            </div>
          ) : null}

          {records.length ? (
            <div className={`${pageLoading ? "memoryPageStage isLoading" : "memoryPageStage"} ${route.displayMode === "list" ? "listMode" : "bookMode"}`} aria-busy={pageLoading}>
            {route.displayMode === "book" ? <div className="memorySpread">
              <span className="memorySpreadAura" aria-hidden="true" />
              <span className="memoryBookCrest" aria-hidden="true"><Sparkles size={20} /></span>
              <span className="memoryBookCorner topRight" aria-hidden="true" />
              <span className="memoryBookCorner bottomLeft" aria-hidden="true" />
              <span className="memoryBookCorner bottomRight" aria-hidden="true" />
              <section className="memoryPaperPage" aria-label={`第 ${singlePage ? pageNumber : pageNumber * 2 - 1} 页`}>
                <header className="memoryPageImprint" aria-hidden="true"><MoonStar size={14} /><span>{chapterTitle}</span></header>
                <div>{firstPaperRecords.map((memory) => <MemoryCard key={memory.id} memory={memory} onRead={() => setReadingMemory(memory)} onEdit={() => setEditor({ mode: "edit", memory })} onForget={() => void forgetMemory(memory)} onToggleImportant={() => void toggleImportant(memory)} />)}</div>
                <footer><span>{singlePage ? pageNumber : pageNumber * 2 - 1}</span></footer>
              </section>
              {!singlePage ? <section className="memoryPaperPage" aria-label={`第 ${pageNumber * 2} 页`}>
                <header className="memoryPageImprint" aria-hidden="true"><Sparkles size={14} /><span>{MEMORY_CHAPTER_META[initialChapter(route.chapter)].shortLabel}</span></header>
                <div>{secondPaperRecords.map((memory) => <MemoryCard key={memory.id} memory={memory} onRead={() => setReadingMemory(memory)} onEdit={() => setEditor({ mode: "edit", memory })} onForget={() => void forgetMemory(memory)} onToggleImportant={() => void toggleImportant(memory)} />)}{secondPaperRecords.length === 0 ? <div className="memoryBlankPage"><MoonStar size={34} /><span>新的记忆会在这里显现</span></div> : null}</div>
                <footer><span>{pageNumber * 2}</span></footer>
              </section> : null}
            </div> : <div className="memoryList" aria-label="记忆列表">{records.map((memory) => <MemoryCard key={memory.id} memory={memory} onRead={() => setReadingMemory(memory)} onEdit={() => setEditor({ mode: "edit", memory })} onForget={() => void forgetMemory(memory)} onToggleImportant={() => void toggleImportant(memory)} />)}</div>}
            {pageTurnControls}
            {showPageLoading ? <div className="memoryPageLoadingOverlay" role="status"><span><BookOpen size={18} />正在翻页…</span></div> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="memoryLiveRegion" aria-live="polite" aria-atomic="true">{notice}</div>
      {notice ? <div className="memoryToast"><Check size={17} />{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice(undefined)}><X size={14} /></button></div> : null}
      {undo ? <div className="memoryUndoToast"><span><strong>已忘记</strong>{undo.label}</span><button type="button" disabled={busy} onClick={() => void undoForget()}><RotateCcw size={16} />撤销</button></div> : null}

      {!loading && status && !status.settings.onboardingCompleted && !onboardingDismissed ? <MemoryOnboardingDialog petName={pet.name} busy={busy || onboardingClosing} animationsEnabled={route.animationsEnabled} turningPage={onboardingClosing} error={onboardingError} onConfirm={() => void completeMemoryOnboarding()} onDecline={() => { setOnboardingDismissed(true); setOnboardingError(undefined); }} /> : null}
      {editor ? <MemoryEditor state={editor} busy={busy} onClose={() => setEditor(undefined)} onSubmit={(value) => void saveEditor(value)} /> : null}
      {readingMemory ? <MemoryDialog title={MEMORY_CHAPTER_META[readingMemory.chapter].label} onClose={() => setReadingMemory(undefined)} wide><article className="memoryDetail"><p>{readingMemory.content}</p>{readingMemory.tags.length ? <div className="memoryTags">{readingMemory.tags.map((tag) => <em key={tag}>#{tag}</em>)}</div> : null}<dl><div><dt>来源</dt><dd>{MEMORY_ORIGIN_LABELS[readingMemory.origin]}</dd></div><div><dt>来源时间</dt><dd>{formatMemoryDate(readingMemory.sourceTime)}</dd></div><div><dt>最后更新</dt><dd>{formatMemoryDate(readingMemory.updatedAt)}</dd></div><div><dt>来源对话</dt><dd>{readingMemory.sourceAvailable ? <button className="memorySourceLink" type="button" onClick={() => void openSourceConversation(readingMemory)}><MessageSquareQuote size={16} aria-hidden="true" />查看来源对话</button> : "未保存"}</dd></div><div><dt>版本</dt><dd>{readingMemory.revision}</dd></div></dl><div className="memoryDialogActions">{route.query ? <button className="secondaryAction" type="button" disabled={busy} onClick={() => void locateInChapter(readingMemory)}><BookOpen size={16} />在章节中定位</button> : null}<button className="secondaryAction dangerText" type="button" onClick={() => void forgetMemory(readingMemory)}><Trash2 size={16} />忘记</button><button className="primaryAction" type="button" onClick={() => { setEditor({ mode: "edit", memory: readingMemory }); setReadingMemory(undefined); }}><Pencil size={16} />编辑</button></div></article></MemoryDialog> : null}
      {sourceConversation ? <MemoryDialog title="来源对话" onClose={closeSourceConversation} wide><MemorySourcePanel petName={pet.name} source={sourceConversation.source} loading={sourceConversation.loading} error={sourceConversation.error} memoryWasEdited={sourceConversation.memory.revision > 1} onRetry={() => void openSourceConversation(sourceConversation.memory)} onBack={closeSourceConversation} /></MemoryDialog> : null}
      {settingsOpen && status ? <MemorySettingsPanel settings={status.settings} status={status} busy={busy} onClose={() => setSettingsOpen(false)} onSave={(value) => void saveSettings(value)} onTestProvider={() => void runStatusAction("test")} onRebuild={() => void runStatusAction("rebuild")} /> : null}
      {exportOpen ? <MemoryDialog title="导出记忆备份" onClose={() => { if (!busy) setExportOpen(false); }}><MemoryBackupExportPanel includeSources={includeSources} busy={busy} error={exportError} onIncludeSources={setIncludeSources} onExport={() => void exportMemories()} /></MemoryDialog> : null}
      {importOpen ? <MemoryDialog title="导入记忆备份" onClose={closeMemoryImport}><MemoryBackupImportPanel inspection={importInspection} petName={pet.name} busy={busy} error={importError} onClose={closeMemoryImport} onConfirm={() => void confirmMemoryImport()} onSelect={() => void selectMemoryBackup()} /></MemoryDialog> : null}
      {clearOpen ? <MemoryDialog title="清空整本记忆" onClose={() => { setClearOpen(false); setClearConfirm(""); }}><div className="memoryDangerPanel"><AlertTriangle size={28} /><p>此操作会忘记当前桌宠的全部记忆。请输入桌宠名称 <strong>{pet.name}</strong> 以确认。</p><label>桌宠名称<input value={clearConfirm} autoComplete="off" onChange={(event) => setClearConfirm(event.target.value)} /></label><div className="memoryDialogActions"><button className="secondaryAction" type="button" onClick={() => { setClearOpen(false); setClearConfirm(""); }}>取消</button><button className="primaryAction danger" type="button" disabled={busy || clearConfirm !== pet.name} onClick={() => void clearAll()}>确认清空</button></div></div></MemoryDialog> : null}

      <footer className="memoryBookFooter"><span>记忆仅属于当前桌宠，并保存在本机。</span><button type="button" onClick={() => setClearOpen(true)}><Trash2 size={15} />清空记忆书</button></footer>
    </section>
  );
}
