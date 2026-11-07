import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "app-builder-lib";
import { createUpdateInfoTasks, writeUpdateInfoFiles } from "app-builder-lib/out/publish/updateInfoBuilder";
import { readReleaseNotes, verifyUpdateArtifacts } from "../../../../scripts/update-release-metadata.mjs";

const require = createRequire(import.meta.url);
const { load, dump } = require("js-yaml");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zml-update-audit-"));
  roots.push(root);
  const config = JSON.parse(await fs.readFile(new URL("../../../../package.json", import.meta.url), "utf8"));
  await fs.mkdir(path.join(root, "docs/releases"), { recursive: true });
  await fs.mkdir(path.join(root, "release"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(config));
  const notes = `# 桌面灵 ${config.version}\n\n- 国内下载和更新说明\n- 取消后可重新下载\n`;
  await fs.writeFile(path.join(root, "docs/releases/current.md"), notes);
  const file = path.join(root, `release/zhuomianling-setup-${config.version}.exe`);
  const content = Buffer.from("synthetic installer bytes; not executable");
  await fs.writeFile(file, content);
  await fs.writeFile(`${file}.blockmap`, "synthetic blockmap");
  // Exercise electron-builder's actual metadata generator with synthetic bytes;
  // no app packaging, signing, user resources or network requests are involved.
  const packager = {
    platform: Platform.WINDOWS, platformSpecificBuildOptions: config.build.win, config: config.build,
    appInfo: { version: config.version }, info: { metadata: { dependencies: config.dependencies } },
    getResource: async (custom: string) => path.join(root, custom)
  };
  const tasks = await createUpdateInfoTasks({
    packager, target: { outDir: path.join(root, "release") }, arch: 1, file,
    updateInfo: { sha512: createHash("sha512").update(content).digest("base64"), size: content.length }
  } as unknown as Parameters<typeof createUpdateInfoTasks>[0], [config.build.publish]);
  await writeUpdateInfoFiles(tasks, { emitArtifactCreated: vi.fn() } as unknown as Parameters<typeof writeUpdateInfoFiles>[1]);
  const metadataFile = path.join(root, "release/latest.yml");
  const metadata = load(await fs.readFile(metadataFile, "utf8"));
  return { root, notes, file, metadataFile, metadata, version: config.version };
}

describe("update artifact and release note audit", () => {
  it("embeds complete Chinese release notes in the actual builder-generated OSS manifest", async () => {
    const { root, notes, metadata } = await fixture();
    expect(metadata.releaseNotes).toBe(notes);
    expect(metadata.files).toHaveLength(1);
    await expect(verifyUpdateArtifacts(root)).resolves.toBeUndefined();
  });

  it.each([undefined, "旧版本说明"])("rejects missing or stale notes in latest.yml", async (notes) => {
    const { root, metadata, metadataFile } = await fixture();
    metadata.releaseNotes = notes;
    await fs.writeFile(metadataFile, dump(metadata));
    await expect(verifyUpdateArtifacts(root)).rejects.toThrow("complete release notes");
  });

  it("rejects a changed installer even when its size matches", async () => {
    const { root, file } = await fixture();
    const content = await fs.readFile(file);
    content[0] ^= 1;
    await fs.writeFile(file, content);
    await expect(verifyUpdateArtifacts(root)).rejects.toThrow("SHA-512");
  });

  it("requires new version notes when bumping the package and rejects oversized or empty changes", async () => {
    const { root, version } = await fixture();
    await expect(readReleaseNotes(root, "999.0.0")).rejects.toThrow("this package version");
    await fs.writeFile(path.join(root, "docs/releases/current.md"), `# 桌面灵 ${version}\n\n`);
    await expect(readReleaseNotes(root, version)).rejects.toThrow("nonempty");
    await fs.writeFile(path.join(root, "docs/releases/current.md"), `# 桌面灵 ${version}\n${"更新".repeat(2500)}`);
    await expect(readReleaseNotes(root, version)).rejects.toThrow("4000");
  });
});
