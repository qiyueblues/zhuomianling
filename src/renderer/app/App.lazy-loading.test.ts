import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("App initial module boundary", () => {
  it("keeps Live2D-bearing and non-selector views out of the initial static graph", async () => {
    const source = await fs.readFile(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source).toContain('import { PetSelector } from "../components/PetSelector/PetSelector"');
    expect(source).not.toMatch(/^import\s+\{\s*PetEditor\s*\}\s+from/m);
    expect(source).not.toMatch(/^import\s+\{\s*PetStage\s*\}\s+from/m);
    expect(source).not.toMatch(/^import\s+\{\s*MemoryBook\s*\}\s+from/m);
    expect(source).toContain('import("../components/PetEditor/PetEditor")');
    expect(source).toContain('import("../components/PetStage/PetStage")');
    expect(source).toContain('import("../components/MemoryBook/MemoryBook")');
    expect(source).toContain('import("../components/HelpCenter/HelpCenter")');
    expect(source).toContain('import("../components/AppUpdate/AppUpdateControl")');
    expect(source).toContain("const updateControl = !isStartupSplashVisible");
    expect(source).toContain('await import("../styles/surfaces/85-help-center.css")');
    expect(source).not.toMatch(/^import\s+\{\s*HelpCenter\s*\}\s+from/m);
    expect(source).toContain("<DeferredViewBoundary");
    expect(source).toContain('title="桌宠详情加载失败"');
    expect(source).toContain('title="桌宠编辑器加载失败"');
    expect(source).toContain('title="记忆书加载失败"');
    expect(source).toContain("正在加载，请稍候…");
    expect(source).not.toContain("按需载入");
  });

  // TIMED DIAGNOSTICS TEST MODULE: timed-launcher visibility and lazy-boundary coverage.
  it("exposes the TIMED DIAGNOSTICS TEST MODULE only through the timed launcher flag", async () => {
    const source = await fs.readFile(new URL("./App.tsx", import.meta.url), "utf8");
    const testGate = await fs.readFile(
      new URL("../components/TimedDiagnosticsTest/timedDiagnosticsTest.ts", import.meta.url),
      "utf8"
    );

    expect(source).toContain("TIMED_DIAGNOSTICS_TEST_ENABLED");
    expect(source).toContain('import("../components/TimedDiagnosticsTest/TimedDiagnosticsTestPage")');
    expect(testGate).toContain('import.meta.env.VITE_SCREEN_MONITOR_DEBUG === "1"');
    expect(testGate).toContain("TIMED_DIAGNOSTICS_TEST_MAX_REQUESTS = 10");
  });

  it("starts a fresh memory-book session whenever it is opened from the home view", async () => {
    const source = await fs.readFile(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source).toContain("delete memoryBookStateRef.current[petId]");
    expect(source).toContain("initialState={memoryBookStateRef.current[selectedPet.id]}");
  });

  it("does not execute Cubism Core before the main page reaches DOM ready", async () => {
    const html = await fs.readFile(new URL("../../../index.html", import.meta.url), "utf8");

    expect(html).not.toContain("live2dcubismcore.min.js");
    expect(html).toContain('src="/src/renderer/main.tsx"');
  });

  it("starts the splash minimum from the static first paint and cancels the show fallback after reveal", async () => {
    const [html, appSource, windowSource] = await Promise.all([
      fs.readFile(new URL("../../../index.html", import.meta.url), "utf8"),
      fs.readFile(new URL("./App.tsx", import.meta.url), "utf8"),
      fs.readFile(new URL("../../main/window.ts", import.meta.url), "utf8")
    ]);

    expect(html).toContain("window.__desktopPetStartupSurfaceShownAt = performance.now()");
    expect(appSource).toContain("function getRemainingStartupSplashMs()");
    expect(appSource).toContain(
      "MIN_STARTUP_SPLASH_MS - (performance.now() - startupSurfaceShownAt)"
    );
    expect(appSource).toContain("}, remainingMs)");
    expect(windowSource).toContain("function clearFallbackShowTimer()");
    expect(windowSource).toContain("hasRevealedStartupSurface = true;\n  clearFallbackShowTimer();");
  });

  it("keeps renderer bootstrap dependencies independently measurable", async () => {
    const source = await fs.readFile(new URL("../main.tsx", import.meta.url), "utf8");

    expect(source).not.toMatch(/^import\s+React/m);
    expect(source).not.toMatch(/^import\s+ReactDOM/m);
    expect(source).not.toMatch(/^import\s+\{\s*App\s*\}/m);
    expect(source).not.toMatch(/^import\s+["']\.\/styles\.css["']/m);
    expect(source).toContain('import("react")');
    expect(source).toContain('import("react-dom/client")');
    expect(source).toContain('import("./styles.css")');
    expect(source).toContain('import("./app/App")');
  });

  it("prewarms the main-window development graph before Electron requests it", async () => {
    const config = await fs.readFile(new URL("../../../vite.config.ts", import.meta.url), "utf8");

    expect(config).toContain("warmup:");
    expect(config).toContain('ignored: ["**/.cache/**"]');
    expect(config).toContain('"./src/renderer/app/App.tsx"');
    expect(config).toContain('"./src/renderer/styles.css"');
    expect(config).toContain('"./src/renderer/styles/**/*.css"');
    expect(config).toContain('"./src/renderer/components/PetSelector/PetSelector.tsx"');
    expect(config).toContain('include: ["react", "react-dom/client", "lucide-react"]');
  });
});
