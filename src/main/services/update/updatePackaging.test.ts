import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isProductionNodeModulePath } from "../../../../scripts/release-asset-policy.mjs";
import { updateFeed, ossUpdateUrl } from "./updateSources";

describe("updater release boundaries", () => {
  it("allows reviewed updater runtime trees and rejects executable extras", () => {
    for (const allowed of [
      "node_modules/electron-updater/out/main.js", "node_modules/electron-updater/out/providers/GitHubProvider.js",
      "node_modules/electron-updater/node_modules/semver/functions/compare.js",
      "node_modules/semver/functions/compare.js",
      "node_modules/builder-util-runtime/out/httpExecutor.js", "node_modules/fs-extra/lib/index.js",
      "node_modules/js-yaml/lib/loader.js", "node_modules/debug/src/node.js", "node_modules/lazy-val/out/main.js",
      "node_modules/tiny-typed-emitter/lib/index.js", "node_modules/electron-updater/package.json"
    ]) expect(isProductionNodeModulePath(allowed), allowed).toBe(false);
    for (const denied of [
      "node_modules/electron-updater/out/main.js.map", "node_modules/electron-updater/out/test/malicious.js",
      "node_modules/electron-updater/node_modules/unknown/index.js", "node_modules/semver/bin/semver.js",
      "node_modules/js-yaml/bin/js-yaml.js", "node_modules/unknown/index.js",
      "node_modules/ali-oss/lib/client.js"
    ]) expect(isProductionNodeModulePath(denied), denied).toBe(true);
  });

  it("uses OSS as the packaged source, embeds local notes, and keeps package commands from publishing", async () => {
    const config = JSON.parse(await fs.readFile(new URL("../../../../package.json", import.meta.url), "utf8"));
    expect(config.dependencies["electron-updater"]).toBeTruthy();
    expect(config.dependencies["ali-oss"]).toBeUndefined();
    expect(config.devDependencies["ali-oss"]).toBe("6.23.0");
    expect(config.build.publish).toEqual(updateFeed("oss"));
    expect(config.build.releaseInfo).toEqual({ releaseNotesFile: "docs/releases/current.md" });
    expect(config.build.nsis.include).toBe("scripts/nsis/update-installer.nsh");
    expect(config.scripts.build).toContain("verify:release-notes");
    expect(config.scripts["dist:win"]).toContain("--publish never");
    expect(config.scripts["dist:win"]).toContain("verify:update-artifacts");
  });

  it("restricts the alternate source to the same stable version's GitHub assets", () => {
    expect(updateFeed("oss").url).toBe(ossUpdateUrl);
    expect(updateFeed("github", "1.6.0").url).toBe("https://github.com/qiyueblues/zhuomianling/releases/download/v1.6.0/");
    for (const invalid of [undefined, "../latest", "1.6.0-beta.1", "https://other.test", "1.6.0/../../"]) {
      expect(() => updateFeed("github", invalid)).toThrow();
    }
  });
});
