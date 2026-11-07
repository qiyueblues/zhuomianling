import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PetVoiceModelVersion } from "../../../shared/types/pet";
import {
  sanitizeVoiceDiagnosticText,
  toUserFacingGptSoVitsError,
  validateGptSoVitsRoot,
  validateReadableVoiceFile,
  validateVoiceModelResources
} from "./voiceResourceValidation";

let temporaryDirectory = "";

async function createRuntimeFixture(includeV5 = false): Promise<void> {
  const files = ["runtime/python.exe", "api_v2.py"];
  if (includeV5) files.push("GPT_SoVITS/module/models_v5.py", "GPT_SoVITS/pretrained_models/gsv-v5-pretrained/vocoder.pth");
  for (const relativePath of files) {
    const target = path.join(temporaryDirectory, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "fixture");
  }
  for (const name of ["chinese-roberta-wwm-ext-large", "chinese-hubert-base"]) {
    await fs.mkdir(path.join(temporaryDirectory, "GPT_SoVITS", "pretrained_models", name), { recursive: true });
  }
}

async function createVoiceFixture(modelVersion: PetVoiceModelVersion, sovitsHeader = "PK") {
  const resources = {
    modelVersion,
    gptSoVitsRootPath: temporaryDirectory,
    sovitsModelPath: path.join(temporaryDirectory, "voice.pth"),
    gptModelPath: path.join(temporaryDirectory, "voice.ckpt"),
    referenceAudioPath: path.join(temporaryDirectory, "reference.wav")
  };
  await fs.writeFile(resources.sovitsModelPath, `${sovitsHeader}fixture`);
  await fs.writeFile(resources.gptModelPath, "fixture");
  await fs.writeFile(resources.referenceAudioPath, "fixture");
  return resources;
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-voice-resource-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("voice resource validation", () => {
  it("reports a moved reference audio without exposing a raw filesystem error", async () => {
    await expect(
      validateReadableVoiceFile(path.join(temporaryDirectory, "moved.wav"), "referenceAudio")
    ).rejects.toThrow("找不到参考音频“moved.wav”，文件可能已被移动或删除，请重新选择。");
  });

  it("rejects a model with the wrong file type", async () => {
    const modelPath = path.join(temporaryDirectory, "model.txt");
    await fs.writeFile(modelPath, "fixture", "utf8");

    await expect(validateReadableVoiceFile(modelPath, "sovits")).rejects.toThrow(
      "SoVITS 模型“model.txt”的文件类型不受支持，请重新选择。"
    );
  });

  it("rejects an arbitrary readable directory as a GPT-SoVITS root", async () => {
    await expect(validateGptSoVitsRoot(temporaryDirectory)).rejects.toThrow(
      "缺少：runtime"
    );
  });

  it("accepts the complete directory structure required by the managed runtime", async () => {
    await createRuntimeFixture();

    await expect(validateGptSoVitsRoot(temporaryDirectory)).resolves.toBeUndefined();
  });

  it.each(["v5dev", "v5turbo"] as const)("rejects an old runtime or missing V5 vocoder for %s", async (version) => {
    await createRuntimeFixture();
    await expect(validateGptSoVitsRoot(temporaryDirectory, version)).rejects.toThrow("models_v5.py");

    await createRuntimeFixture(true);
    const vocoder = path.join(temporaryDirectory, "GPT_SoVITS", "pretrained_models", "gsv-v5-pretrained", "vocoder.pth");
    await fs.rm(vocoder);
    await expect(validateGptSoVitsRoot(temporaryDirectory, version)).rejects.toThrow("vocoder.pth");
    await fs.mkdir(vocoder);
    await expect(validateGptSoVitsRoot(temporaryDirectory, version)).rejects.toThrow("类型不正确");
  });

  it.each(["v5dev", "v5turbo"] as const)("accepts standalone %s weights without requiring a LoRA base", async (version) => {
    await createRuntimeFixture(true);
    const resources = await createVoiceFixture(version);
    await expect(validateVoiceModelResources(resources)).resolves.toBeUndefined();
  });

  it.each([
    ["v5dev", "07"], ["v5turbo", "08"]
  ] as const)("requires the matching base model for %s LoRA weights", async (version, header) => {
    await createRuntimeFixture(true);
    const resources = await createVoiceFixture(version, header);
    await expect(validateVoiceModelResources(resources)).rejects.toThrow(`s2G${version}.pth`);

    // Having the other variant's base is insufficient.
    const otherVersion = version === "v5dev" ? "v5turbo" : "v5dev";
    const baseDirectory = path.join(temporaryDirectory, "GPT_SoVITS", "pretrained_models", "gsv-v5-pretrained");
    await fs.writeFile(path.join(baseDirectory, `s2G${otherVersion}.pth`), "fixture");
    await expect(validateVoiceModelResources(resources)).rejects.toThrow(`s2G${version}.pth`);

    await fs.writeFile(path.join(baseDirectory, `s2G${version}.pth`), "fixture");
    await expect(validateVoiceModelResources(resources)).resolves.toBeUndefined();
    await expect(validateVoiceModelResources({ ...resources, modelVersion: otherVersion })).rejects.toThrow("模型版本不匹配");
  });
});

describe("voice diagnostics", () => {
  it("splits carriage-return progress updates and keeps diagnostics bounded", () => {
    const raw = [
      "服务启动失败",
      ...Array.from({ length: 200 }, (_, index) => `${index}/1500 ${index}% 42.8it/s 推理中`),
      "最终原因：模型版本不匹配"
    ].join("\r");
    const diagnostic = sanitizeVoiceDiagnosticText(raw, 120);

    expect(diagnostic).toContain("服务启动失败");
    expect(diagnostic).toContain("最终原因：模型版本不匹配");
    expect(diagnostic.length).toBeLessThanOrEqual(120);
    expect(diagnostic).not.toContain("1500");
    expect(diagnostic).not.toContain("it/s");
  });

  it("maps missing-file and out-of-memory failures to actionable Chinese messages", () => {
    expect(toUserFacingGptSoVitsError("FileNotFoundError: old.wav", 500)).toContain(
      "重新选择文件并重新连接"
    );
    expect(toUserFacingGptSoVitsError("CUDA out of memory", 500)).toContain("显存不足");
  });
});
