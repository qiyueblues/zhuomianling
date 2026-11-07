import { ChevronDown, Download, ExternalLink, FileText, RefreshCw, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppUpdateState, AppUpdateActionResult } from "../../../shared/types/appUpdate";

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AppUpdateControl({ showButton = true }: { showButton?: boolean }): JSX.Element {
  const [state, setState] = useState<AppUpdateState>();
  const [opened, setOpened] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [savingIgnore, setSavingIgnore] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const visible = opened || state?.prompt === true;

  useEffect(() => {
    const api = window.desktopPet?.appUpdate;
    if (!api) return;
    let mounted = true;
    let receivedEvent = false;
    const unsubscribe = api.onChanged((next) => {
      receivedEvent = true;
      if (mounted) setState(next);
    });
    void api.getState().then((next) => {
      if (mounted && !receivedEvent) setState(next);
    }).catch(() => undefined);
    api.startupReady();
    return () => { mounted = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (visible && dialog && !dialog.open) dialog.showModal();
    if (!visible && dialog?.open) {
      dialog.close();
      triggerRef.current?.focus();
    }
  }, [visible]);

  const reportAction = (result: AppUpdateActionResult): void => {
    if (!result.ok) setActionError(result.message ?? "操作未完成，请重试。");
  };
  const failAction = (): void => { setActionError("更新服务暂时不可用，请稍后重试。"); };
  const runStateAction = (action: "check" | "download" | "downloadGithub" | "cancel"): void => {
    setActionError(undefined);
    void window.desktopPet?.appUpdate[action]().then(setState).catch(failAction);
  };
  const close = (): void => {
    if (state?.phase === "installing" || savingIgnore) return;
    setOpened(false);
    setActionError(undefined);
    void window.desktopPet?.appUpdate.dismiss().then(setState).catch(failAction);
  };
  const ignore = (): void => {
    setSavingIgnore(true);
    setActionError(undefined);
    void window.desktopPet?.appUpdate.ignoreVersion().then((result) => {
      reportAction(result);
      if (result.ok) setOpened(false);
    }).catch(failAction).finally(() => setSavingIgnore(false));
  };

  const phase = state?.phase ?? "idle";
  const downloading = phase === "downloading";
  const installing = phase === "installing";
  const available = phase === "available";
  const downloaded = phase === "downloaded";
  const canDownload = state?.mode === "installer" && !!state.latestVersion && (available || phase === "error");
  const title = downloading ? "正在下载更新" : downloaded ? "更新已准备就绪" : installing ? "正在准备重启安装"
    : state?.latestVersion && available ? "发现新版本" : "软件更新";
  const buttonLabel = downloading ? `下载中 ${Math.floor(state?.progress?.percent ?? 0)}%`
    : downloaded ? "重启更新" : available ? "发现新版" : "检查更新";

  return (
    <>
      {showButton ? (
        <button ref={triggerRef} className="topbarImportButton appUpdateTrigger" type="button"
          aria-haspopup="dialog" onClick={() => {
            setOpened(true);
            setActionError(undefined);
            if (!["downloading", "downloaded", "installing", "available"].includes(phase)) runStateAction("check");
          }}>
          {downloading ? <Download size={16} /> : <RefreshCw size={16} />}
          {buttonLabel}
        </button>
      ) : null}
      <dialog ref={dialogRef} className="appUpdateDialog" aria-labelledby="app-update-title"
        onCancel={(event) => { event.preventDefault(); close(); }}>
        <div className="appUpdateHeading">
          <span className="appUpdateIcon" aria-hidden="true"><Download size={23} /></span>
          <button className="iconButton appUpdateClose" type="button" aria-label={downloading ? "后台下载" : "关闭更新窗口"}
            disabled={installing || savingIgnore} onClick={close}><X size={19} /></button>
        </div>
        <h2 id="app-update-title">{title}</h2>
        <p className="appUpdateVersion">当前版本 {state?.currentVersion ?? "…"}
          {state?.latestVersion ? <> <span aria-hidden="true">→</span> 新版本 {state.latestVersion}</> : null}
        </p>
        {phase === "checking" ? <p role="status">正在连接国内更新源，检查新版本…</p> : null}
        {state?.mode === "development" ? <p>开发环境不检查或安装更新。发布后的安装版会在启动时自动检测。</p> : null}
        {state?.mode === "portable" ? <p>当前为免安装版，请前往 GitHub 下载新版并手动替换程序。</p> : null}
        {state?.latestVersion && !installing ? (
          <details key={state.latestVersion} className="appUpdateChangelog">
            <summary className="appUpdateNotesToggle">
              <FileText size={16} aria-hidden="true" />
              <span>更新内容</span>
              <ChevronDown className="appUpdateNotesChevron" size={16} aria-hidden="true" />
            </summary>
            <pre className="appUpdateNotes">{state.releaseNotes?.trim() || "此版本暂未提供更新说明，可前往 GitHub 发布页查看。"}</pre>
          </details>
        ) : null}
        {available && state?.mode === "installer" ? <p>推荐使用国内下载，完成后可选择重启安装。</p> : null}
        {downloaded ? <p>更新包已下载并校验完成。请先保存正在编辑的内容，再重启安装。</p> : null}
        {installing ? <p role="status">正在结束语音、屏幕捕获和后台任务，请稍候…</p> : null}
        {downloading ? (
          <div className="appUpdateDownload" aria-live="polite">
            <div className="appUpdateProgressLabel"><strong>{state?.downloadSource === "github" ? "正在直连 GitHub 下载" : "正在通过国内 OSS 下载"}</strong><span>{Math.floor(state?.progress?.percent ?? 0)}%</span></div>
            <progress aria-label="更新下载进度" max={100} value={state?.progress?.percent ?? 0} />
            <div className="appUpdateProgressMeta"><span>{megabytes(state?.progress?.transferred ?? 0)} / {state?.progress?.total ? megabytes(state.progress.total) : "获取文件大小中"}</span>
              <span>{megabytes(state?.progress?.bytesPerSecond ?? 0)}/s</span></div>
          </div>
        ) : null}
        {state?.message ? <p className={phase === "error" ? "appUpdateError" : "appUpdateMessage"} role="status">{state.message}</p> : null}
        {actionError ? <p className="appUpdateError" role="alert">{actionError}</p> : null}
        <div className="appUpdateActions">
          {available ? <button className="appUpdateIgnore" type="button" disabled={savingIgnore} onClick={ignore}>
            {savingIgnore ? "正在保存…" : "不再提示此版本"}</button> : null}
          {downloading ? <button className="secondaryAction" type="button" disabled={state?.message === "正在取消下载…"}
            onClick={() => runStateAction("cancel")}>{state?.message === "正在取消下载…" ? "正在取消…" : "取消下载"}</button> : null}
          {!downloading && !installing ? <button className="secondaryAction" type="button" disabled={savingIgnore} onClick={close}>
            {available || downloaded ? "稍后" : "关闭"}</button> : null}
          {canDownload ? <button className="primaryAction" type="button" disabled={savingIgnore} onClick={() => runStateAction("download")}>
            <Download size={16} />国内下载（推荐）</button> : null}
          {downloaded ? <button className="primaryAction" type="button" onClick={() => {
            setActionError(undefined);
            void window.desktopPet?.appUpdate.install().then(reportAction).catch(failAction);
          }}><RotateCw size={16} />重启并安装</button> : null}
          {phase === "error" ? <button className={canDownload ? "secondaryAction" : "primaryAction"} type="button" onClick={() => runStateAction("check")}>重新检查</button> : null}
        </div>
        {canDownload ? <button className="appUpdateReleaseLink" type="button" disabled={savingIgnore}
          onClick={() => runStateAction("downloadGithub")}><Download size={13} />使用 GitHub 下载</button> : null}
        {!installing ? <button className="appUpdateReleaseLink" type="button" onClick={() => {
          void window.desktopPet?.appUpdate.openReleasePage().then(reportAction).catch(failAction);
        }}><ExternalLink size={13} />前往 GitHub 发布页</button> : null}
      </dialog>
    </>
  );
}
