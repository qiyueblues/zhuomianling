import { EventEmitter } from "node:events";
import { CancellationToken, type UpdateCheckResult, type UpdateInfo } from "electron-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdateService, type UpdateDriver } from "./AppUpdateService";
import type { AppUpdateState } from "../../../shared/types/appUpdate";

const info = (version = "1.6.0"): UpdateInfo => ({ version,
  files: [{ url: `zhuomianling-setup-${version}.exe`, sha512: Buffer.alloc(64, 1).toString("base64"), size: 4096 }],
  releaseDate: "2026-11-07T00:00:00Z", releaseNotes: "<p>新增功能</p>" });
const result = (version = "1.6.0", available = true): UpdateCheckResult => ({
  isUpdateAvailable: available, updateInfo: info(version), versionInfo: info(version)
});

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  disableWebInstaller = false;
  logger = null;
  checkForUpdates = vi.fn(async (): Promise<UpdateCheckResult | null> => result());
  downloadUpdate = vi.fn(async (_token?: CancellationToken): Promise<string[]> => ["private-installer-path"]);
  quitAndInstall = vi.fn();
}

function setup(mode: AppUpdateState["mode"] = "installer", ignoredVersion?: string, completedVersion?: string) {
  const driver = new FakeUpdater();
  const githubDriver = new FakeUpdater();
  const createDriver = vi.fn((source: "oss" | "github", _version?: string) =>
    (source === "oss" ? driver : githubDriver) as unknown as UpdateDriver);
  const saveIgnoredVersion = vi.fn(async (_version: string) => undefined);
  const prepareToInstall = vi.fn(async () => undefined);
  const closeConnections = vi.fn(async () => undefined);
  const onChanged = vi.fn();
  const service = new AppUpdateService({
    createDriver, mode, currentVersion: "1.5.0", ignoredVersion, completedVersion,
    saveIgnoredVersion, prepareToInstall, closeConnections, onChanged
  });
  return { service, driver, githubDriver, createDriver, saveIgnoredVersion, prepareToInstall, closeConnections, onChanged };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("AppUpdateService", () => {
  it("keeps the completion notice across checks until it has been shown", async () => {
    const { service, driver } = setup("installer", undefined, "1.5.0");
    driver.checkForUpdates.mockResolvedValue(result("1.5.0", false));
    expect((await service.check()).completedVersion).toBe("1.5.0");
    service.acknowledgeCompletion();
    expect((await service.check()).completedVersion).toBeUndefined();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
  });
  it("preserves release-note paragraphs and lists as bounded plain text", async () => {
    const { service, driver } = setup();
    const release = result();
    release.updateInfo.releaseNotes = "<h2>本次更新</h2><ul><li>新增 &quot;更新内容&quot; 按钮</li><li>修复下载取消</li></ul><p>查看后再更新<br>支持稍后处理</p>";
    driver.checkForUpdates.mockResolvedValue(release);
    expect((await service.check()).releaseNotes).toBe('本次更新\n• 新增 "更新内容" 按钮\n• 修复下载取消\n\n查看后再更新\n支持稍后处理');
  });

  it("keeps missing notes optional and limits release-note display length", async () => {
    const { service, driver } = setup();
    const release = result();
    release.updateInfo.releaseNotes = undefined;
    driver.checkForUpdates.mockResolvedValue(release);
    expect((await service.check()).releaseNotes).toBeUndefined();
    release.updateInfo.releaseNotes = [{ version: "1.6.0", note: "修复".repeat(5000) }];
    expect((await service.check()).releaseNotes).toHaveLength(4000);
  });

  it("checks stable releases without downloading or installing on ordinary quit", async () => {
    const { service, driver } = setup();
    const first = service.check();
    expect(service.check()).toBe(first);
    expect((await first)).toMatchObject({ phase: "available", latestVersion: "1.6.0", prompt: true, releaseNotes: "新增功能" });
    expect(driver.autoDownload).toBe(false);
    expect(driver.autoInstallOnAppQuit).toBe(false);
    expect(driver.allowPrerelease).toBe(false);
    expect(driver.allowDowngrade).toBe(false);
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
  });

  it("remembers only the ignored version and still prompts for later versions", async () => {
    const { service, driver, saveIgnoredVersion } = setup("installer", "1.6.0");
    expect(await service.check()).toMatchObject({ phase: "available", prompt: false });
    driver.checkForUpdates.mockResolvedValue(result("1.7.0"));
    expect(await service.check()).toMatchObject({ latestVersion: "1.7.0", prompt: true });
    expect(await service.ignoreVersion()).toEqual({ ok: true });
    expect(saveIgnoredVersion).toHaveBeenCalledWith("1.7.0");
    expect(service.getState()).toMatchObject({ ignoredVersion: "1.7.0", prompt: false });
    expect(await service.check()).toMatchObject({ phase: "available", prompt: false });
  });

  it("keeps the reminder when saving the ignored version fails", async () => {
    const { service, saveIgnoredVersion } = setup();
    await service.check();
    saveIgnoredVersion.mockRejectedValue(new Error("private-file-path"));
    expect(await service.ignoreVersion()).toMatchObject({ ok: false });
    expect(service.getState()).toMatchObject({ prompt: true, ignoredVersion: undefined });
  });

  it("does not network in development and prevents portable packages from installing", async () => {
    const dev = setup("development");
    await dev.service.check();
    expect(dev.driver.checkForUpdates).not.toHaveBeenCalled();
    const portable = setup("portable");
    expect(await portable.service.check()).toMatchObject({ phase: "available", prompt: true });
    await portable.service.download();
    expect(await portable.service.install()).toEqual({ ok: false });
    expect(portable.driver.downloadUpdate).not.toHaveBeenCalled();
    expect(portable.driver.quitAndInstall).not.toHaveBeenCalled();
  });

  it("cancels the real download token and rejects late completion and installation", async () => {
    const { service, driver } = setup();
    const aborted = vi.fn();
    driver.downloadUpdate.mockImplementation((token) => token!.createPromise((_resolve, _reject, onCancel) => onCancel(aborted)));
    await service.check();
    const download = service.download();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.download()).toBe(download);
    expect(service.getState().phase).toBe("downloading");
    service.cancelDownload();
    await download;
    expect(aborted).toHaveBeenCalledOnce();
    expect(service.getState()).toMatchObject({ phase: "available", message: "已取消下载。", prompt: false });
    driver.emit("update-downloaded", { ...info(), downloadedFile: "private-installer-path" });
    expect(await service.install()).toEqual({ ok: false });
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    // A later explicit retry can download the same release.
    driver.downloadUpdate.mockResolvedValue(["private-installer-path"]);
    expect(await service.download()).toMatchObject({ phase: "installing" });
  });

  it("aborts a stalled download and can retry without exposing raw errors", async () => {
    const { service, driver, closeConnections } = setup();
    driver.downloadUpdate.mockImplementation((token) => token!.createPromise(() => undefined));
    await service.check();
    const download = service.download();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await download).toMatchObject({ phase: "error", message: expect.stringContaining("长时间无响应") });
    expect(closeConnections).toHaveBeenCalled();
    driver.downloadUpdate.mockRejectedValue(new Error("secret-header /private/path"));
    expect(await service.download()).toMatchObject({ phase: "error", message: "从国内更新源下载失败，请重试或选择其他下载来源。" });
  });

  it("publishes bounded progress and never sends downloaded file paths to the renderer", async () => {
    const { service, driver, onChanged } = setup();
    let finish!: (paths: string[]) => void;
    driver.downloadUpdate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await service.check();
    const download = service.download();
    await vi.advanceTimersByTimeAsync(0);
    driver.emit("download-progress", { percent: 25, transferred: 1024, total: 4096, bytesPerSecond: 512, privateField: "private-file" });
    expect(service.getState().progress).toEqual({ percent: 25, transferred: 1024, total: 4096, bytesPerSecond: 512 });
    finish(["private-installer-path"]);
    expect(await download).toMatchObject({ phase: "installing", prompt: true });
    expect(JSON.stringify(onChanged.mock.calls)).not.toContain("private-");
    expect(driver.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it("automatically installs the verified download once after waiting for shutdown cleanup", async () => {
    const { service, driver, prepareToInstall } = setup();
    expect(await service.install()).toEqual({ ok: false });
    await service.check();
    let finish!: () => void;
    prepareToInstall.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const download = service.download();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState().phase).toBe("installing");
    const install = service.install();
    expect(service.install()).toBe(install);
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    // Download stall timers cannot cancel a valid installation preparation.
    await vi.advanceTimersByTimeAsync(60_000);
    finish();
    expect(await install).toEqual({ ok: true });
    expect(await download).toMatchObject({ phase: "installing" });
    expect(driver.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it("allows retry after cleanup failure and prevents installation after process shutdown", async () => {
    const { service, driver, prepareToInstall } = setup();
    await service.check();
    prepareToInstall.mockRejectedValue(new Error("private-cleanup-error"));
    expect(await service.download()).toMatchObject({ phase: "downloaded", message: "准备更新失败，请稍后重试。" });
    expect(service.getState().phase).toBe("downloaded");
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    let finish!: () => void;
    prepareToInstall.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const install = service.install();
    service.stop();
    finish();
    expect(await install).toEqual({ ok: false });
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not proceed after an installer error while cleanup is pending", async () => {
    const { service, driver, prepareToInstall } = setup();
    await service.check();
    let finish!: () => void;
    prepareToInstall.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const download = service.download();
    await vi.advanceTimersByTimeAsync(0);
    driver.emit("error", new Error("private-installer-path"));
    finish();
    await download;
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ phase: "error", message: "无法启动更新安装程序，请重试或前往 GitHub 下载。" });
  });

  it("times out checks, closes real updater connections and ignores late results", async () => {
    const { service, driver, closeConnections } = setup();
    let finish!: (value: UpdateCheckResult) => void;
    driver.checkForUpdates.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const check = service.check();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await check).toMatchObject({ phase: "error", prompt: false, message: expect.stringContaining("超时") });
    expect(closeConnections).toHaveBeenCalledOnce();
    finish(result());
    await Promise.resolve();
    expect(service.getState().phase).toBe("error");
  });

  it("shows no automatic error dialog and handles missing metadata with a controlled message", async () => {
    const { service, driver } = setup();
    driver.checkForUpdates.mockRejectedValue(Object.assign(new Error("private-data"), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }));
    expect(await service.check()).toMatchObject({ phase: "error", prompt: false, message: expect.stringContaining("更新清单") });
    driver.checkForUpdates.mockResolvedValue(result("1.5.0", false));
    expect(await service.check()).toMatchObject({ phase: "idle", prompt: false, latestVersion: undefined, message: "当前已是最新版本。" });
  });

  it("checks and reads notes from OSS without contacting GitHub, and defaults to OSS downloads", async () => {
    const { service, driver, githubDriver, createDriver } = setup();
    expect(await service.check()).toMatchObject({ releaseNotes: "新增功能" });
    expect(createDriver.mock.calls).toEqual([["oss", undefined]]);
    expect(await service.download()).toMatchObject({ phase: "installing", downloadSource: "oss" });
    expect(driver.downloadUpdate).toHaveBeenCalledOnce();
    expect(githubDriver.checkForUpdates).not.toHaveBeenCalled();
    expect(githubDriver.downloadUpdate).not.toHaveBeenCalled();
  });

  it("only contacts the chosen GitHub version on explicit download, preserving OSS notes", async () => {
    const { service, driver, githubDriver, createDriver } = setup();
    await service.check();
    const release = result();
    release.updateInfo.releaseNotes = "备用来源的其他说明";
    githubDriver.checkForUpdates.mockResolvedValue(release);
    expect(await service.download("github")).toMatchObject({ phase: "installing", downloadSource: "github", releaseNotes: "新增功能" });
    expect(createDriver).toHaveBeenLastCalledWith("github", "1.6.0");
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    expect(await service.install()).toEqual({ ok: false });
    expect(githubDriver.quitAndInstall).toHaveBeenCalledOnce();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(["version", "hash", "size", "filename"])("rejects %s mismatches on the alternate source before downloading", async (change) => {
    const { service, githubDriver } = setup();
    await service.check();
    const release = result(change === "version" ? "1.7.0" : "1.6.0");
    if (change === "hash") release.updateInfo.files[0].sha512 = Buffer.alloc(64, 2).toString("base64");
    if (change === "size") release.updateInfo.files[0].size = 8192;
    if (change === "filename") release.updateInfo.files[0].url = "https://untrusted.test/private-file.exe";
    githubDriver.checkForUpdates.mockResolvedValue(release);
    expect(await service.download("github")).toMatchObject({ phase: "error", prompt: true });
    expect(githubDriver.downloadUpdate).not.toHaveBeenCalled();
    expect(await service.install()).toEqual({ ok: false });
  });

  it("can cancel an alternate-source metadata request and ignore its late response", async () => {
    const { service, driver, githubDriver, closeConnections } = setup();
    await service.check();
    let finish!: (value: UpdateCheckResult) => void;
    githubDriver.checkForUpdates.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const task = service.download("github");
    expect(service.getState()).toMatchObject({ phase: "downloading", downloadSource: "github" });
    service.cancelDownload();
    expect(await task).toMatchObject({ phase: "available", prompt: false, message: "已取消下载。" });
    expect(closeConnections).toHaveBeenCalled();
    expect(await service.download()).toMatchObject({ phase: "installing", downloadSource: "oss" });
    finish(result());
    githubDriver.emit("download-progress", { percent: 90, transferred: 1, total: 1, bytesPerSecond: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState()).toMatchObject({ phase: "installing", downloadSource: "oss", progress: undefined });
    expect(githubDriver.downloadUpdate).not.toHaveBeenCalled();
    expect(driver.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("closes a stalled source recheck and allows a retry from the other source", async () => {
    const { service, driver, githubDriver, closeConnections } = setup();
    await service.check();
    driver.checkForUpdates.mockImplementation(() => new Promise(() => undefined));
    const task = service.download();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await task).toMatchObject({ phase: "error", message: expect.stringContaining("长时间无响应") });
    expect(closeConnections).toHaveBeenCalled();
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    expect(await service.download("github")).toMatchObject({ phase: "installing", downloadSource: "github" });
    expect(githubDriver.downloadUpdate).toHaveBeenCalledOnce();
  });

  it("does not silently switch sources when OSS is unavailable or reuse an older target after a failed check", async () => {
    const { service, driver, githubDriver } = setup();
    await service.check();
    driver.checkForUpdates.mockRejectedValue(new Error("private-oss-error"));
    expect(await service.check()).toMatchObject({ phase: "error", latestVersion: undefined, releaseNotes: undefined, prompt: false });
    await service.download("github");
    expect(githubDriver.checkForUpdates).not.toHaveBeenCalled();
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
  });

  it.each(["cancel", "stop"] as const)("does not auto-install a late successful download after %s", async (action) => {
    const { service, driver, prepareToInstall } = setup();
    let finish!: (paths: string[]) => void;
    driver.downloadUpdate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await service.check();
    const download = service.download();
    await vi.advanceTimersByTimeAsync(0);
    if (action === "cancel") service.cancelDownload();
    else service.stop();
    finish(["private-installer-path"]);
    await download;
    expect(prepareToInstall).not.toHaveBeenCalled();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
  });
});
