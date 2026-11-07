import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// Parse with the updater's locked YAML dependency without loading Electron.
const updaterRequire = createRequire(new URL("../node_modules/electron-updater/package.json", import.meta.url));
const { load } = updaterRequire("js-yaml");
const normalize = (text) => text.replace(/\r\n/g, "\n").trim();

export async function readReleaseNotes(projectRoot, version) {
  const file = path.join(projectRoot, "docs/releases/current.md");
  if ((await stat(file)).size > 16_384) throw new Error("release notes exceed the metadata limit");
  const notes = normalize(await readFile(file, "utf8"));
  if (!/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(version) || notes.split("\n")[0] !== `# 桌面灵 ${version}` ||
    notes.length > 4000 || !notes.split("\n").slice(1).join("\n").trim()) {
    throw new Error("release notes must contain this package version and nonempty changes within 4000 characters");
  }
  return notes;
}

export async function verifyUpdateArtifacts(projectRoot) {
  const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const notes = await readReleaseNotes(projectRoot, version);
  const releaseRoot = path.join(projectRoot, "release");
  const metadataPath = path.join(releaseRoot, "latest.yml");
  if ((await stat(metadataPath)).size > 32_768) throw new Error("update metadata is too large");
  const metadata = load(await readFile(metadataPath, "utf8"));
  if (metadata?.version !== version || !Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error("update metadata must describe exactly this version's NSIS installer");
  }
  if (typeof metadata.releaseNotes !== "string" || normalize(metadata.releaseNotes) !== notes) {
    throw new Error("latest.yml must embed this version's complete release notes from docs/releases/current.md");
  }
  const file = metadata.files[0];
  const filename = `zhuomianling-setup-${version}.exe`;
  if (file.url !== filename || metadata.path !== filename || metadata.sha512 !== file.sha512 || metadata.packages) {
    throw new Error("update metadata must point to the local NSIS installer, never the portable executable");
  }
  const installerPath = path.join(releaseRoot, filename);
  if ((await stat(installerPath)).size !== file.size) throw new Error("installer size differs from latest.yml");
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(installerPath)) hash.update(chunk);
  if (hash.digest("base64") !== file.sha512) throw new Error("installer SHA-512 differs from latest.yml");
  if (!(await stat(`${installerPath}.blockmap`)).isFile()) throw new Error("installer blockmap is missing");
}
