import { app, shell } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppUpdateState, AppUpdateActionResult, AppUpdateSource } from "../shared/types/appUpdate";
import type { AppUpdateService } from "./services/update/AppUpdateService";
import { writeJsonFileAtomically } from "./services/config/durableJsonFile";

const releasePage = "https://github.com/qiyueblues/zhuomianling/releases/latest";
let servicePromise: Promise<AppUpdateService> | undefined;
let prepareToInstall: () => Promise<void> = async () => { throw new Error("Update shutdown is not configured."); };
let emitState: (state: AppUpdateState) => void = () => undefined;
let startupTimer: NodeJS.Timeout | undefined;
let startupScheduled = false;
let stopped = false;
let completionAcknowledged = false;

export function configureAppUpdates(options: {
  prepareToInstall: () => Promise<void>;
  onChanged: (state: AppUpdateState) => void;
}): void {
  prepareToInstall = options.prepareToInstall;
  emitState = options.onChanged;
}

function getMode(): AppUpdateState["mode"] {
  if (!app.isPackaged) return "development";
  if (process.platform !== "win32" || process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR ||
    !existsSync(path.join(path.dirname(process.execPath), "Uninstall 桌面灵.exe"))) return "portable";
  return "installer";
}

function initialState(): AppUpdateState {
  const mode = getMode();
  const currentVersion = app.getVersion();
  return { mode, phase: "idle", currentVersion, prompt: false,
    // NSIS only passes --updated when launching the successfully installed app.
    // Do not infer success from a cached download or a pending install attempt.
    completedVersion: !completionAcknowledged && mode === "installer" && process.argv.includes("--updated")
      ? currentVersion : undefined };
}

export async function acknowledgeAppUpdateCompletion(): Promise<void> {
  completionAcknowledged = true;
  if (servicePromise) (await servicePromise).acknowledgeCompletion();
}

async function loadIgnoredVersion(): Promise<string | undefined> {
  try {
    const file = path.join(app.getPath("userData"), "app-updates.json");
    if ((await fs.stat(file)).size > 4096) return undefined;
    const value = JSON.parse(await fs.readFile(file, "utf8")) as { ignoredVersion?: unknown };
    return typeof value?.ignoredVersion === "string" && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value.ignoredVersion)
      ? value.ignoredVersion : undefined;
  } catch {
    // This file contains only an optional reminder preference; a failed read
    // must never prevent startup or silently disable future update reminders.
    return undefined;
  }
}

function getService(): Promise<AppUpdateService> {
  servicePromise ??= (async () => {
    const [{ NsisUpdater }, { AppUpdateService }, { updateFeed }, ignoredVersion] = await Promise.all([
      import("electron-updater"), import("./services/update/AppUpdateService"), import("./services/update/updateSources"), loadIgnoredVersion()
    ]);
    let activeDriver: InstanceType<typeof NsisUpdater> | undefined;
    const service = new AppUpdateService({
      createDriver: (source, version) => {
        activeDriver = new NsisUpdater(updateFeed(source, version));
        return activeDriver;
      },
      mode: getMode(), currentVersion: app.getVersion(), ignoredVersion,
      completedVersion: initialState().completedVersion,
      saveIgnoredVersion: (version) => writeJsonFileAtomically(path.join(app.getPath("userData"), "app-updates.json"), { ignoredVersion: version }),
      prepareToInstall: () => prepareToInstall(),
      closeConnections: () => activeDriver?.netSession.closeAllConnections() ?? Promise.resolve(),
      onChanged: (state) => emitState(state)
    });
    if (stopped) service.stop();
    return service;
  })().catch((error) => {
    servicePromise = undefined;
    throw error;
  });
  return servicePromise;
}

/** Called only after the renderer has finished its splash, once per process. */
export function scheduleStartupUpdateCheck(): void {
  if (stopped || startupScheduled || !app.isPackaged) return;
  startupScheduled = true;
  startupTimer = setTimeout(() => {
    startupTimer = undefined;
    void checkAppUpdates().catch(() => undefined);
  }, 1500);
  startupTimer.unref();
}

export async function getAppUpdateState(): Promise<AppUpdateState> {
  return servicePromise ? (await servicePromise).getState() : initialState();
}

export async function checkAppUpdates(): Promise<AppUpdateState> {
  if (stopped || !app.isPackaged) return initialState();
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = undefined;
  try {
    return await (await getService()).check();
  } catch {
    const state: AppUpdateState = { ...initialState(), phase: "error", message: "更新服务暂时不可用，请稍后重试。" };
    emitState(state);
    return state;
  }
}

export async function downloadAppUpdate(source: AppUpdateSource = "oss"): Promise<AppUpdateState> {
  return servicePromise ? (await servicePromise).download(source) : initialState();
}

export async function cancelAppUpdate(): Promise<AppUpdateState> {
  return servicePromise ? (await servicePromise).cancelDownload() : initialState();
}

export async function dismissAppUpdate(): Promise<AppUpdateState> {
  return servicePromise ? (await servicePromise).dismiss() : initialState();
}

export async function ignoreAppUpdateVersion(): Promise<AppUpdateActionResult> {
  return servicePromise ? (await servicePromise).ignoreVersion() : { ok: false };
}

export async function installAppUpdate(): Promise<AppUpdateActionResult> {
  return servicePromise ? (await servicePromise).install() : { ok: false };
}

export async function openAppUpdateReleasePage(): Promise<AppUpdateActionResult> {
  try {
    await shell.openExternal(releasePage);
    return { ok: true };
  } catch {
    return { ok: false, message: "无法打开 GitHub 发布页，请稍后重试。" };
  }
}

export function stopAppUpdates(): void {
  stopped = true;
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = undefined;
  void servicePromise?.then((service) => service.stop()).catch(() => undefined);
}
