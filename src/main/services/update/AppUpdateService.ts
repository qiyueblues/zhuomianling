import { CancellationToken, type AppUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import type { AppUpdateMode, AppUpdateState, AppUpdateActionResult, AppUpdateSource } from "../../../shared/types/appUpdate";

export type UpdateDriver = Pick<AppUpdater,
  "on" | "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade" |
  "disableWebInstaller" | "logger" | "checkForUpdates" | "downloadUpdate" | "quitAndInstall"
>;

interface UpdateServiceOptions {
  createDriver: (source: AppUpdateSource, version?: string) => UpdateDriver;
  mode: AppUpdateMode;
  currentVersion: string;
  ignoredVersion?: string;
  completedVersion?: string;
  saveIgnoredVersion: (version: string) => Promise<void>;
  prepareToInstall: () => Promise<void>;
  closeConnections: () => Promise<void>;
  onChanged: (state: AppUpdateState) => void;
}

const checkTimeoutMs = 20_000;
const downloadStallTimeoutMs = 60_000;
const isVersion = (version: unknown): version is string =>
  typeof version === "string" && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(version);

function installerIdentity(info: UpdateInfo): string {
  const file = info.files?.[0];
  if (!isVersion(info.version) || info.files?.length !== 1 ||
    file?.url !== `zhuomianling-setup-${info.version}.exe` ||
    !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
    !Number.isSafeInteger(file.size) || file.size! <= 0 || file.size! > 8 * 1024 ** 3 || "packages" in info) {
    throw new Error("invalid-update-metadata");
  }
  return JSON.stringify([info.version, file.url, file.sha512, file.size]);
}

function notesText(notes: UpdateInfo["releaseNotes"]): string | undefined {
  const entities: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " "
  };
  const text = typeof notes === "string" ? notes : Array.isArray(notes)
    ? notes.slice(0, 5).map((note) => note.note ?? "").join("\n") : "";
  // GitHub may return HTML release notes. Display plain text, never HTML.
  return text.slice(0, 16_384)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|pre|blockquote)>/gi, "\n")
    .replace(/<li(?:\s[^>]*)?>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => entities[entity.toLowerCase()] ?? entity)
    .replace(/\n{3,}/g, "\n\n")
    .trim().slice(0, 4000) || undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | undefined)?.code ?? "";
  if (/SHA|CHECKSUM|SIGNATURE/.test(code)) return "更新包校验失败，请稍后重试或前往 GitHub 下载。";
  if (/ENOSPC/.test(code)) return "磁盘空间不足，请清理后重试。";
  if (/LATEST_VERSION_NOT_FOUND|CHANNEL_FILE_NOT_FOUND|NO_PUBLISHED_VERSIONS/.test(code)) {
    return "更新源尚未提供更新清单，请稍后重试或前往 GitHub 发布页下载。";
  }
  return fallback;
}

export class AppUpdateService {
  private state: AppUpdateState;
  private stopped = false;
  private checkTask?: Promise<AppUpdateState>;
  private downloadTask?: Promise<AppUpdateState>;
  private installTask?: Promise<AppUpdateActionResult>;
  private ignoreTask?: Promise<AppUpdateActionResult>;
  private downloadToken?: CancellationToken;
  private downloadTimer?: NodeJS.Timeout;
  private cancelRequested = false;
  private downloadTimedOut = false;
  private lastProgressAt = 0;
  private expectedInstaller?: string;
  private downloadDriver?: UpdateDriver;
  private installedDriver?: UpdateDriver;

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = {
      mode: options.mode, phase: "idle", currentVersion: options.currentVersion,
      ignoredVersion: options.ignoredVersion, completedVersion: options.completedVersion, prompt: false
    };
  }

  private createDriver(source: AppUpdateSource, version?: string): UpdateDriver {
    const driver = this.options.createDriver(source, version);
    driver.autoDownload = false;
    driver.autoInstallOnAppQuit = false;
    driver.allowPrerelease = false;
    driver.allowDowngrade = false;
    driver.disableWebInstaller = true;
    driver.logger = null;
    // The updater also rejects the operation promise. Keep its error event
    // handled without exposing raw URLs, paths, headers or provider text.
    driver.on("error", () => {
      if (this.installedDriver === driver && this.state.phase === "installing") {
        this.patch({ phase: "error", message: "无法启动更新安装程序，请重试或前往 GitHub 下载。", prompt: true });
      }
    });
    driver.on("download-progress", (progress) => {
      if (this.downloadDriver === driver) this.onProgress(progress);
    });
    return driver;
  }

  getState(): AppUpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined };
  }

  acknowledgeCompletion(): void {
    this.patch({ completedVersion: undefined });
  }

  private patch(patch: Partial<AppUpdateState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.options.onChanged(this.getState());
  }

  check(): Promise<AppUpdateState> {
    if (this.stopped || this.state.mode === "development") return Promise.resolve(this.getState());
    if (this.checkTask) return this.checkTask;
    if (this.downloadTask || this.installTask || this.state.phase === "downloaded") return Promise.resolve(this.getState());
    this.checkTask = this.performCheck().finally(() => { this.checkTask = undefined; });
    return this.checkTask;
  }

  private async performCheck(): Promise<AppUpdateState> {
    this.expectedInstaller = undefined;
    this.patch({ phase: "checking", latestVersion: undefined, releaseNotes: undefined, downloadSource: undefined,
      progress: undefined, message: undefined, prompt: false });
    let timeout: NodeJS.Timeout | undefined;
    let expired = false;
    try {
      const result = await Promise.race([
        this.createDriver("oss").checkForUpdates(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            expired = true;
            void this.options.closeConnections().catch(() => undefined);
            reject(new Error("update-check-timeout"));
          }, checkTimeoutMs);
        })
      ]);
      if (!result) throw new Error("updater-unavailable");
      if (!isVersion(result.updateInfo.version)) throw new Error("invalid-update-version");
      const available = result.isUpdateAvailable;
      if (available) this.expectedInstaller = installerIdentity(result.updateInfo);
      this.patch({
        phase: available ? "available" : "idle",
        latestVersion: available ? result.updateInfo.version : undefined,
        releaseNotes: available ? notesText(result.updateInfo.releaseNotes) : undefined,
        prompt: available && result.updateInfo.version !== this.state.ignoredVersion,
        message: available ? undefined : "当前已是最新版本。"
      });
    } catch (error) {
      this.patch({ phase: "error", prompt: false, message: expired
        ? "连接国内更新源超时，请检查网络后重试，也可前往 GitHub 发布页下载。"
        : errorMessage(error, "检查更新失败，请稍后重试，也可前往 GitHub 发布页下载。") });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return this.getState();
  }

  dismiss(): AppUpdateState {
    this.patch({ prompt: false });
    return this.getState();
  }

  ignoreVersion(): Promise<AppUpdateActionResult> {
    if (this.ignoreTask) return this.ignoreTask;
    const version = this.state.latestVersion;
    if (this.stopped || this.state.phase !== "available" || !isVersion(version)) return Promise.resolve({ ok: false });
    this.ignoreTask = this.options.saveIgnoredVersion(version).then(() => {
      this.patch({ ignoredVersion: version, prompt: false });
      return { ok: true };
    }).catch(() => ({ ok: false, message: "未能保存“不再提示”设置，请重试。" }))
      .finally(() => { this.ignoreTask = undefined; });
    return this.ignoreTask;
  }

  download(source: AppUpdateSource = "oss"): Promise<AppUpdateState> {
    if (this.downloadTask) return this.downloadTask;
    if (this.stopped || this.checkTask || this.installTask || this.state.mode !== "installer" || !this.expectedInstaller || !this.state.latestVersion ||
      !["available", "error"].includes(this.state.phase)) return Promise.resolve(this.getState());
    this.downloadTask = this.performDownload(source).finally(() => { this.downloadTask = undefined; });
    return this.downloadTask;
  }

  private async performDownload(source: AppUpdateSource): Promise<AppUpdateState> {
    let verified = false;
    const token = new CancellationToken();
    this.downloadToken = token;
    this.cancelRequested = false;
    this.downloadTimedOut = false;
    this.patch({ phase: "downloading", downloadSource: source,
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, message: undefined, prompt: true });
    this.resetDownloadTimeout(token);
    try {
      const driver = this.createDriver(source, this.state.latestVersion);
      this.downloadDriver = driver;
      // Each attempt has its own provider. Never reuse a timed-out check or
      // accept a different release/hash when changing download sources.
      const result = await token.createPromise<Awaited<ReturnType<UpdateDriver["checkForUpdates"]>>>((resolve, reject, onCancel) => {
        onCancel(() => { void this.options.closeConnections().catch(() => undefined); });
        driver.checkForUpdates().then(resolve, reject);
      });
      if (token.cancelled || this.stopped) throw new Error("update-cancelled");
      if (!result?.isUpdateAvailable || installerIdentity(result.updateInfo) !== this.expectedInstaller) {
        throw Object.assign(new Error("update-source-mismatch"), { code: "UPDATE_SOURCE_MISMATCH" });
      }
      await driver.downloadUpdate(token);
      if (this.downloadTimedOut) throw new Error("update-download-timeout");
      if (!token.cancelled && !this.stopped) {
        this.installedDriver = driver;
        verified = true;
        this.patch({ phase: "downloaded", progress: undefined, prompt: true });
      }
    } catch (error) {
      if (!this.cancelRequested) {
        this.patch({ phase: "error", progress: undefined, message: this.downloadTimedOut
          ? "下载长时间无响应，已停止下载。请重试或选择其他下载来源。"
          : (error as { code?: string })?.code === "UPDATE_SOURCE_MISMATCH"
            ? "下载来源的版本或校验信息与更新提示不一致，请重新检查更新或稍后重试。"
            : errorMessage(error, `从${source === "oss" ? "国内更新源" : " GitHub"}下载失败，请重试或选择其他下载来源。`), prompt: true });
      }
    } finally {
      if (this.downloadTimer) clearTimeout(this.downloadTimer);
      this.downloadTimer = undefined;
      this.downloadDriver = undefined;
      if (token.cancelled) await this.options.closeConnections().catch(() => undefined);
      this.downloadToken = undefined;
      token.dispose();
      if (this.cancelRequested) this.patch({ phase: "available", progress: undefined, message: "已取消下载。", prompt: false });
    }
    // Starting this download is the user's consent to install this exact
    // release. Clear download cancellation/timers before shutdown begins.
    if (verified && !this.stopped && !this.cancelRequested && this.state.phase === "downloaded") {
      await this.install();
    }
    return this.getState();
  }

  private resetDownloadTimeout(token: CancellationToken): void {
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    this.downloadTimer = setTimeout(() => {
      this.downloadTimedOut = true;
      token.cancel();
      void this.options.closeConnections().catch(() => undefined);
    }, downloadStallTimeoutMs);
  }

  private onProgress(progress: ProgressInfo): void {
    if (this.stopped || this.cancelRequested || this.downloadTimedOut || this.state.phase !== "downloading" || !this.downloadToken) return;
    this.resetDownloadTimeout(this.downloadToken);
    const now = Date.now();
    if (now - this.lastProgressAt < 200 && progress.percent < 100) return;
    this.lastProgressAt = now;
    const nonnegative = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;
    this.patch({ progress: {
      percent: Math.min(100, nonnegative(progress.percent)), transferred: nonnegative(progress.transferred),
      total: nonnegative(progress.total), bytesPerSecond: nonnegative(progress.bytesPerSecond)
    } });
  }

  cancelDownload(): AppUpdateState {
    if (this.state.phase === "downloading" && this.downloadToken) {
      this.cancelRequested = true;
      this.downloadToken.cancel();
      this.patch({ message: "正在取消下载…" });
    }
    return this.getState();
  }

  install(): Promise<AppUpdateActionResult> {
    if (this.installTask) return this.installTask;
    if (this.stopped || this.state.mode !== "installer" || this.state.phase !== "downloaded") return Promise.resolve({ ok: false });
    this.patch({ phase: "installing", message: undefined, prompt: true });
    this.installTask = (async (): Promise<AppUpdateActionResult> => {
      try {
        await this.options.prepareToInstall();
        if (this.stopped || this.state.phase !== "installing") return { ok: false };
        // --updated uses our NSIS progress-only flow. A visible progress page
        // survives this process exiting; --force-run opens the new app.
        this.installedDriver!.quitAndInstall(false, true);
        return { ok: this.state.phase === "installing" };
      } catch {
        this.patch({ phase: "downloaded", message: "准备更新失败，请稍后重试。", prompt: true });
        return { ok: false, message: "准备更新失败，请稍后重试。" };
      }
    })().finally(() => { this.installTask = undefined; });
    return this.installTask;
  }

  stop(): void {
    this.stopped = true;
    this.downloadToken?.cancel();
    if (this.downloadTimer) clearTimeout(this.downloadTimer);
    void this.options.closeConnections().catch(() => undefined);
  }
}
