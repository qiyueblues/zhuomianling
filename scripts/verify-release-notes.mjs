import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readReleaseNotes } from "./update-release-metadata.mjs";

try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await readReleaseNotes(root, version);
  console.log("Release notes audit passed: current version and bounded changes are present.");
} catch (error) {
  console.error(`Release notes audit failed: ${error instanceof Error ? error.message : "invalid release notes"}`);
  process.exit(1);
}
