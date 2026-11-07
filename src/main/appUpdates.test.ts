import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { application, existsSync } = vi.hoisted(() => ({
  application: { isPackaged: true, getVersion: () => "1.7.0", getPath: () => "unused" },
  existsSync: vi.fn(() => true)
}));
vi.mock("electron", () => ({ app: application, shell: {} }));
vi.mock("node:fs", () => ({ existsSync }));
vi.mock("./services/config/durableJsonFile", () => ({ writeJsonFileAtomically: vi.fn() }));

const originalArgv = process.argv;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: "win32" });
  process.argv = ["app.exe", "--updated"];
  application.isPackaged = true;
  existsSync.mockReturnValue(true);
  vi.stubEnv("PORTABLE_EXECUTABLE_FILE", "");
  vi.stubEnv("PORTABLE_EXECUTABLE_DIR", "");
});
afterEach(() => {
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
});

describe("update completion notice", () => {
  it("reports the actually running installed version once without loading the updater", async () => {
    const updates = await import("./appUpdates");
    expect(await updates.getAppUpdateState()).toMatchObject({ currentVersion: "1.7.0", completedVersion: "1.7.0" });
    await updates.acknowledgeAppUpdateCompletion();
    expect((await updates.getAppUpdateState()).completedVersion).toBeUndefined();
  });

  it.each(["ordinary-start", "development", "portable"])("does not announce success for %s", async (scenario) => {
    if (scenario === "ordinary-start") process.argv = ["app.exe"];
    if (scenario === "development") application.isPackaged = false;
    if (scenario === "portable") existsSync.mockReturnValue(false);
    const updates = await import("./appUpdates");
    expect((await updates.getAppUpdateState()).completedVersion).toBeUndefined();
  });
});
