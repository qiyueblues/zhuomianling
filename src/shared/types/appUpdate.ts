export type AppUpdateMode = "installer" | "portable" | "development";
export type AppUpdateSource = "oss" | "github";
export type AppUpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error";

/** Only public, bounded display data crosses the main-window IPC boundary. */
export interface AppUpdateState {
  mode: AppUpdateMode;
  phase: AppUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string;
  downloadSource?: AppUpdateSource;
  prompt: boolean;
  ignoredVersion?: string;
  completedVersion?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
  message?: string;
}

export interface AppUpdateActionResult {
  ok: boolean;
  message?: string;
}
