import { listPackage } from "@electron/asar";
import { spawnSync } from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  isForbiddenReleasePath,
  isProductionNodeModulePath
} from "./release-asset-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const asarPath = path.join(projectRoot, "release", "win-unpacked", "resources", "app.asar");
const unpackedHelpPagePath = path.join(
  projectRoot,
  "release",
  "win-unpacked",
  "resources",
  "app.asar.unpacked",
  "dist",
  "renderer",
  "help.html"
);
const unpackedHelpAssetsPath = path.join(
  projectRoot,
  "release",
  "win-unpacked",
  "resources",
  "app.asar.unpacked",
  "dist",
  "renderer",
  "assets"
);

let asarStat;

try {
  asarStat = await stat(asarPath);
} catch (error) {
  console.error(
    error?.code === "ENOENT"
      ? "Packed asset audit failed: app.asar does not exist. Run the package command first."
      : `Packed asset audit failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

const entries = await listPackage(asarPath);
const forbiddenEntries = entries.filter(isForbiddenReleasePath);
const productionModuleEntries = entries.filter(isProductionNodeModulePath);

if (forbiddenEntries.length || productionModuleEntries.length) {
  console.error("Packed asset audit failed. The generated app.asar contains forbidden entries:");

  for (const entry of [...forbiddenEntries, ...productionModuleEntries].sort()) {
    console.error(`- ${entry}`);
  }

  process.exit(1);
}

console.log(
  `Packed asset audit passed (${entries.length} entries, ${asarStat.size} bytes, only approved production modules).`
);

try {
  const helpPageStat = await stat(unpackedHelpPagePath);
  const helpAssetsStat = await stat(unpackedHelpAssetsPath);
  if (!helpPageStat.isFile() || !helpAssetsStat.isDirectory()) {
    throw new Error("the tutorial entry or asset directory has an unexpected type");
  }
} catch (error) {
  console.error(
    `Packed asset audit failed: the system-browser tutorial entry is not unpacked: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
}

console.log("Packed asset audit passed: system-browser tutorial entry is unpacked.");

try {
  const updaterRequire = createRequire(path.join(projectRoot, "node_modules/electron-updater/package.json"));
  const { load } = updaterRequire("js-yaml");
  const updateConfig = load(await readFile(path.join(projectRoot, "release", "win-unpacked", "resources", "app-update.yml"), "utf8"));
  if (updateConfig?.provider !== "generic" ||
    updateConfig.url !== "https://zhuomianling.oss-cn-beijing.aliyuncs.com/updates/windows/" ||
    updateConfig.token || updateConfig.requestHeaders || updateConfig.useMultipleRangeRequest !== false) {
    throw new Error("updater must use the public project OSS source without credentials or custom headers");
  }
  if (!entries.some((entry) => entry.replace(/\\/g, "/").endsWith("/node_modules/electron-updater/out/main.js"))) {
    throw new Error("electron-updater runtime is missing from app.asar");
  }
} catch (error) {
  console.error(`Packed asset audit failed: ${error instanceof Error ? error.message : "invalid updater configuration"}`);
  process.exit(1);
}
console.log("Packed asset audit passed: public OSS update source and updater runtime are present.");

const memoryRuntimeRoot = path.join(
  projectRoot,
  "release",
  "win-unpacked",
  "resources",
  "memory-sidecar"
);
const runtimeAudit = spawnSync(
  process.execPath,
  [path.join(scriptDirectory, "verify-memory-runtime.mjs"), "--root", memoryRuntimeRoot],
  { stdio: "inherit", windowsHide: true }
);
if (runtimeAudit.error || runtimeAudit.status !== 0) {
  console.error("Packed asset audit failed: packaged memory runtime is missing or invalid.");
  process.exit(1);
}
