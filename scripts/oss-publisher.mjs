import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { verifyUpdateArtifacts } from "./update-release-metadata.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
export const ossTarget = Object.freeze({
  region: "oss-cn-beijing", bucket: "zhuomianling",
  endpoint: "https://oss-cn-beijing.aliyuncs.com", prefix: "updates/windows/"
});
const latestKey = `${ossTarget.prefix}latest.yml`;
const failure = (code) => Object.assign(new Error(code), { code });

export function readOssCredentials(env = process.env) {
  const accessKeyId = env.OSS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = env.OSS_ACCESS_KEY_SECRET?.trim();
  if (!accessKeyId || !accessKeySecret) throw failure("MISSING_CREDENTIALS");
  return { accessKeyId, accessKeySecret, ...(env.OSS_SECURITY_TOKEN ? { stsToken: env.OSS_SECURITY_TOKEN } : {}) };
}

/** Never print SDK messages: they can include signed headers or credentials. */
export function publishErrorMessage(error) {
  switch (error?.code) {
    case "MISSING_CREDENTIALS": return "缺少 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET 环境变量。";
    case "AccessDenied": return "OSS 拒绝访问，请检查此凭据对更新目录的权限。";
    case "InvalidAccessKeyId": case "SignatureDoesNotMatch": case "SecurityTokenExpired":
      return "OSS 凭据校验失败，请检查环境变量或凭据有效期。";
    case "REMOTE_NEWER": return "OSS 已有更高版本，已停止发布，未覆盖更新清单。";
    case "ASSET_CONFLICT": return "同版本安装包或 blockmap 已存在且内容不同，请递增版本后重新构建。";
    case "REMOTE_CHANGED": return "发布期间 OSS 更新清单发生变化，已停止覆盖，请核对后继续。";
    case "REMOTE_INVALID": return "OSS 现有更新清单无效，已停止发布，请先核对远端文件。";
    case "UPLOAD_MISMATCH": return "OSS 上传结果校验失败，已停止后续发布，请核对远端文件。";
    case "LOCAL_INVALID": return "本地发布文件边界或大小无效，已停止上传。";
    default: return "OSS 发布或校验失败，已停止操作；请检查构建审计、网络及远端状态后再继续。";
  }
}

export async function createOssReleasePlan(projectRoot) {
  await verifyUpdateArtifacts(projectRoot);
  const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const root = await realpath(projectRoot);
  const releaseRoot = await realpath(path.join(root, "release"));
  const relative = path.relative(root, releaseRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw failure("LOCAL_INVALID");
  const filenames = [`zhuomianling-setup-${version}.exe`, `zhuomianling-setup-${version}.exe.blockmap`, "latest.yml"];
  const files = [];
  for (const name of filenames) {
    const filePath = path.join(releaseRoot, name);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || path.dirname(await realpath(filePath)) !== releaseRoot ||
      info.size <= 0 || info.size > 5 * 1024 ** 3) throw failure("LOCAL_INVALID");
    const sha512 = createHash("sha512");
    const md5 = createHash("md5");
    for await (const chunk of createReadStream(filePath)) { sha512.update(chunk); md5.update(chunk); }
    files.push({ name, path: filePath, key: `${ossTarget.prefix}${name}`, size: info.size,
      sha512: sha512.digest("base64"), md5: md5.digest("hex") });
  }
  const metadataBytes = await readFile(files[2].path);
  const metadata = load(metadataBytes.toString("utf8"));
  if (metadata.version !== version || metadata.files[0].sha512 !== files[0].sha512 ||
    metadata.files[0].size !== files[0].size ||
    createHash("sha512").update(metadataBytes).digest("base64") !== files[2].sha512) throw failure("LOCAL_INVALID");
  return { version, files, metadataBytes };
}

async function headOrMissing(client, key) {
  try { return (await client.head(key)).res.headers; }
  catch (error) {
    if (error?.code === "NoSuchKey") return undefined;
    throw error;
  }
}

async function remoteManifest(client) {
  const headers = await headOrMissing(client, latestKey);
  if (!headers) return undefined;
  if (!Number.isSafeInteger(Number(headers["content-length"])) ||
    Number(headers["content-length"]) <= 0 || Number(headers["content-length"]) > 32_768) throw failure("REMOTE_INVALID");
  const { content } = await client.get(latestKey);
  if (!Buffer.isBuffer(content) || content.length > 32_768) throw failure("REMOTE_INVALID");
  let metadata;
  try { metadata = load(content.toString("utf8")); } catch { throw failure("REMOTE_INVALID"); }
  if (!/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(metadata?.version)) throw failure("REMOTE_INVALID");
  return { content, version: metadata.version };
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function matchesFile(headers, file) {
  return headers && Number(headers["content-length"]) === file.size &&
    (headers["x-oss-meta-sha512"] === file.sha512 || headers.etag?.replaceAll('"', "").toLowerCase() === file.md5);
}

/** Only these three audited objects can be written; latest.yml is always last. */
export async function publishOssRelease(client, projectRoot, log = () => undefined) {
  const plan = await createOssReleasePlan(projectRoot);
  const previous = await remoteManifest(client);
  if (previous && compareVersions(previous.version, plan.version) > 0) throw failure("REMOTE_NEWER");
  // Check every immutable object before uploading anything. Reruns skip identical
  // assets; an interrupted upload can be resumed without replacing published bytes.
  const existing = await Promise.all(plan.files.slice(0, 2).map((file) => headOrMissing(client, file.key)));
  for (let i = 0; i < 2; i++) if (existing[i] && !matchesFile(existing[i], plan.files[i])) throw failure("ASSET_CONFLICT");
  for (let i = 0; i < plan.files.length; i++) {
    const file = plan.files[i];
    if (i < 2 && existing[i]) { log(`已核对并保留 ${file.name}`); continue; }
    if (i === 2) {
      const current = await remoteManifest(client);
      if (Boolean(previous) !== Boolean(current) || (previous && !previous.content.equals(current.content))) throw failure("REMOTE_CHANGED");
    }
    log(`正在${i === 2 ? "更新清单" : "上传"} ${file.name}`);
    const headers = {
      "Content-MD5": Buffer.from(file.md5, "hex").toString("base64"),
      "Cache-Control": i === 2 ? "no-cache" : "public, max-age=31536000, immutable",
      ...(i < 2 || !previous ? { "x-oss-forbid-overwrite": "true" } : {})
    };
    await client.put(file.key, i === 2 ? plan.metadataBytes : file.path, {
      timeout: 300_000, headers, meta: { sha512: file.sha512 },
      mime: i === 2 ? "text/yaml; charset=utf-8" : "application/octet-stream"
    });
    if (!matchesFile(await headOrMissing(client, file.key), file)) throw failure("UPLOAD_MISMATCH");
    if (i === 2) {
      const published = await remoteManifest(client);
      if (!published?.content.equals(plan.metadataBytes)) throw failure("UPLOAD_MISMATCH");
    }
    log(`已验证 ${file.name}`);
  }
  return { version: plan.version, keys: plan.files.map((file) => file.key) };
}
