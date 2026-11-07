import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".cache/update-progress-ui/zml-update-progress.exe");
if (process.platform !== "win32") throw new Error("The installer progress surface is built on Windows.");
const compiler = path.join(process.env.WINDIR ?? "C:/Windows", "Microsoft.NET/Framework/v4.0.30319/csc.exe");
await fs.access(compiler);
await fs.mkdir(path.dirname(output), { recursive: true });
const result = spawnSync(compiler, [
  "/nologo", "/target:winexe", "/platform:x86", "/optimize+", "/codepage:65001",
  "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
  `/out:${output}`, path.join(root, "scripts/nsis/UpdateProgress.cs")
], { cwd: root, encoding: "utf8", windowsHide: true, shell: false });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Installer progress surface compilation failed: ${result.stdout}${result.stderr}`);
console.log("Installer progress surface compiled (installer-only, no application data).");
