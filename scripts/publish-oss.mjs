import { fileURLToPath } from "node:url";
import { createOssReleasePlan, ossTarget, publishOssRelease, publishErrorMessage, readOssCredentials } from "./oss-publisher.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => !["--check", "--dry-run"].includes(arg))) {
  console.error("用法：npm.cmd run publish:oss [-- --check | -- --dry-run]");
  process.exit(1);
}
try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (args[0] === "--dry-run") {
    const plan = await createOssReleasePlan(root);
    console.log(`OSS 发布计划 ${plan.version}（未联网、未上传）`);
    for (const file of plan.files) console.log(`${file.key} (${file.size} bytes)`);
  } else {
    // SDK/HTTP debugging can expose signed headers. The Windows entry point
    // disables it before Node starts; direct invocations must do the same.
    if (process.env.DEBUG || process.env.NODE_DEBUG) throw new Error("debug-logging-enabled");
    const credentials = readOssCredentials();
    const { default: OSS } = await import("ali-oss");
    const client = new OSS({ ...ossTarget, ...credentials, secure: true, authorizationV4: true, retryMax: 0, timeout: 300_000 });
    if (args[0] === "--check") {
      await client.listV2({ prefix: ossTarget.prefix, "max-keys": 1 });
      console.log("OSS 凭据验证通过：可读取 zhuomianling/updates/windows/，未上传或覆盖文件。");
    } else {
      const result = await publishOssRelease(client, root, (message) => console.log(message));
      console.log(`OSS ${result.version} 发布完成：安装包已验证，latest.yml 已更新。`);
    }
  }
} catch (error) {
  console.error(publishErrorMessage(error));
  process.exitCode = 1;
}
