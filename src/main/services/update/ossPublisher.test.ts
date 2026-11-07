import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOssReleasePlan, ossTarget, publishOssRelease, publishErrorMessage, readOssCredentials } from "../../../../scripts/oss-publisher.mjs";

const require = createRequire(import.meta.url);
const { dump } = require("js-yaml");
const roots: string[] = [];
const hash = (bytes: Buffer, type: string, encoding: "hex" | "base64") => createHash(type).update(bytes).digest(encoding);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "zml-oss-publisher-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "release"));
  await fs.mkdir(path.join(root, "docs/releases"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.5.0" }));
  const notes = "# 桌面灵 1.5.0\n\n- 国内更新说明与可取消的下载\n";
  await fs.writeFile(path.join(root, "docs/releases/current.md"), notes);
  const name = "zhuomianling-setup-1.5.0.exe";
  const bytes = Buffer.from("synthetic installer, no executable or user data");
  const sha512 = hash(bytes, "sha512", "base64");
  await fs.writeFile(path.join(root, "release", name), bytes);
  await fs.writeFile(path.join(root, "release", `${name}.blockmap`), "synthetic blockmap");
  const metadata = { version: "1.5.0", path: name, sha512,
    files: [{ url: name, size: bytes.length, sha512 }], releaseNotes: notes };
  const manifest = Buffer.from(dump(metadata));
  await fs.writeFile(path.join(root, "release/latest.yml"), manifest);
  return { root, name, manifest };
}

class FakeOss {
  objects = new Map<string, { content: Buffer; headers: Record<string, string> }>();
  onPut?: (key: string) => void;
  seed(key: string, content: Buffer, meta?: Record<string, string>) {
    this.objects.set(key, { content, headers: { "content-length": String(content.length),
      etag: `"${hash(content, "md5", "hex")}"`, ...meta } });
  }
  head = vi.fn(async (key: string) => {
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error("Object does not exist"), { code: "NoSuchKey" });
    return { res: { headers: object.headers } };
  });
  get = vi.fn(async (key: string) => ({ content: this.objects.get(key)!.content }));
  put = vi.fn(async (key: string, source: string | Buffer, options: { headers: Record<string, string>; meta: Record<string, string> }) => {
    this.onPut?.(key);
    if (options.headers["x-oss-forbid-overwrite"] === "true" && this.objects.has(key)) {
      throw Object.assign(new Error("exists"), { code: "FileAlreadyExists" });
    }
    const content = Buffer.isBuffer(source) ? source : await fs.readFile(source);
    expect(options.headers["Content-MD5"]).toBe(hash(content, "md5", "base64"));
    expect(options.meta.sha512).toBe(hash(content, "sha512", "base64"));
    this.seed(key, content, { "x-oss-meta-sha512": options.meta.sha512, "cache-control": options.headers["Cache-Control"] });
  });
}

const latestKey = `${ossTarget.prefix}latest.yml`;
describe("OSS release publication", () => {
  it("only writes audited versioned assets and then the complete latest manifest", async () => {
    const { root, name, manifest } = await fixture();
    const client = new FakeOss();
    const log = vi.fn();
    const result = await publishOssRelease(client, root, log);
    expect(result.version).toBe("1.5.0");
    expect(client.put.mock.calls.map(([key]) => key)).toEqual([
      `${ossTarget.prefix}${name}`, `${ossTarget.prefix}${name}.blockmap`, latestKey
    ]);
    expect(client.objects.get(latestKey)?.content).toEqual(manifest);
    expect(client.objects.get(latestKey)?.headers["cache-control"]).toBe("no-cache");
    expect(client.objects.get(`${ossTarget.prefix}${name}`)?.headers["cache-control"]).toContain("immutable");
  });

  it("overwrites the previous latest.yml while retaining all older versioned assets", async () => {
    const { root, manifest } = await fixture();
    const client = new FakeOss();
    client.seed(latestKey, Buffer.from(dump({ version: "1.4.0" })));
    const oldKey = `${ossTarget.prefix}zhuomianling-setup-1.4.0.exe`;
    client.seed(oldKey, Buffer.from("old installer"));
    await publishOssRelease(client, root);
    expect(client.objects.get(latestKey)?.content).toEqual(manifest);
    expect(client.objects.get(oldKey)?.content.toString()).toBe("old installer");
  });

  it("does not promote latest.yml when an asset upload fails, and does not retry", async () => {
    const { root } = await fixture();
    const client = new FakeOss();
    const previous = Buffer.from(dump({ version: "1.4.0" }));
    client.seed(latestKey, previous);
    client.onPut = (key) => { if (key.endsWith(".blockmap")) throw new Error("synthetic network failure"); };
    await expect(publishOssRelease(client, root)).rejects.toThrow();
    expect(client.put).toHaveBeenCalledTimes(2);
    expect(client.objects.get(latestKey)?.content).toEqual(previous);
  });

  it("refuses to replace differing same-version bytes before starting any upload", async () => {
    const { root, name } = await fixture();
    const client = new FakeOss();
    client.seed(`${ossTarget.prefix}${name}`, Buffer.from("different installer"));
    await expect(publishOssRelease(client, root)).rejects.toMatchObject({ code: "ASSET_CONFLICT" });
    expect(client.put).not.toHaveBeenCalled();
  });

  it("can continue after an interrupted publication by skipping already verified identical assets", async () => {
    const { root, name } = await fixture();
    const client = new FakeOss();
    const bytes = await fs.readFile(path.join(root, "release", name));
    // A browser-uploaded, single-part object without custom metadata is also verifiable by MD5.
    client.seed(`${ossTarget.prefix}${name}`, bytes);
    await publishOssRelease(client, root);
    expect(client.put.mock.calls.map(([key]) => key)).toEqual([`${ossTarget.prefix}${name}.blockmap`, latestKey]);
  });

  it("never downgrades an already published higher version", async () => {
    const { root } = await fixture();
    const client = new FakeOss();
    client.seed(latestKey, Buffer.from(dump({ version: "1.10.0" })));
    await expect(publishOssRelease(client, root)).rejects.toMatchObject({ code: "REMOTE_NEWER" });
    expect(client.put).not.toHaveBeenCalled();
  });

  it("stops if another publication changes the remote manifest before promotion", async () => {
    const { root } = await fixture();
    const client = new FakeOss();
    client.seed(latestKey, Buffer.from(dump({ version: "1.4.0" })));
    const otherRelease = Buffer.from(dump({ version: "1.6.0" }));
    client.onPut = (key) => { if (key.endsWith(".blockmap")) client.seed(latestKey, otherRelease); };
    await expect(publishOssRelease(client, root)).rejects.toMatchObject({ code: "REMOTE_CHANGED" });
    expect(client.put).toHaveBeenCalledTimes(2);
    expect(client.objects.get(latestKey)?.content).toEqual(otherRelease);
  });

  it("does not upload from a corrupted local release or ignore permission errors", async () => {
    const { root, name } = await fixture();
    const client = new FakeOss();
    await fs.appendFile(path.join(root, "release", name), "corrupt bytes");
    await expect(publishOssRelease(client, root)).rejects.toThrow();
    expect(client.head).not.toHaveBeenCalled();
    const valid = await fixture();
    client.head.mockRejectedValue(Object.assign(new Error("raw private details"), { code: "AccessDenied" }));
    await expect(publishOssRelease(client, valid.root)).rejects.toMatchObject({ code: "AccessDenied" });
    expect(client.put).not.toHaveBeenCalled();
  });

  it("can prepare an audited offline upload plan without touching OSS", async () => {
    const { root } = await fixture();
    const plan = await createOssReleasePlan(root);
    expect(plan.files).toHaveLength(3);
    expect(plan.files[2].key).toBe(latestKey);
  });

  it("reads credentials only from the designated environment fields and redacts all provider details", () => {
    expect(() => readOssCredentials({})).toThrow();
    expect(readOssCredentials({ OSS_ACCESS_KEY_ID: "synthetic-id", OSS_ACCESS_KEY_SECRET: "synthetic-secret" }))
      .toEqual({ accessKeyId: "synthetic-id", accessKeySecret: "synthetic-secret" });
    for (const code of ["SignatureDoesNotMatch", "AccessDenied", "RequestError", "unknown-secret-code"]) {
      const message = publishErrorMessage({ code, message: "synthetic-secret signed-header /private/path", request: { key: "synthetic-secret" } });
      expect(message).not.toMatch(/synthetic|signed-header|private|unknown-secret/);
    }
  });
});
