// TIMED DIAGNOSTICS TEST MODULE: screen model capability tests.
import { describe, expect, it } from "vitest";
import { classifyScreenVisionModel } from "./screenVisionModelCapability";

describe("screen vision model-name routing", () => {
  it.each([
    ["OpenAI", "gpt-4o"],
    ["OpenRouter", "openai/gpt-4o"],
    ["阿里云 DashScope", "qwen3.5-omni-plus"],
    ["火山引擎", "doubao-1.5-vision-pro"],
    ["智谱", "glm-4.5v"],
    ["月之暗面", "kimi-k2.5"],
    ["百度智能云", "ernie-4.5-vl"],
    ["腾讯混元", "hunyuan-vision"],
    ["商汤", "SenseNova-V6"],
    ["阶跃星辰", "step-1o"],
    ["OpenAI Compatible", "internvl3"],
    ["中转站", "qwen/qwen2.5-vl-72b-instruct"],
    ["深度求索", "deepseek-vl2-small"],
    ["DeepSeek", "deepseek-v4-flash-vision-exp"],
    ["科大讯飞", "imagev3"]
  ])("classifies %s/%s as multimodal", (providerName, model) => {
    expect(classifyScreenVisionModel({ providerName, model })).toBe("multimodal");
  });

  it.each([
    "deepseek-v4.1-flash",
    "deepseekv4.1flash",
    "DeepSeek_V4.1_Flash",
    "deepseek-v4.1-pro",
    "deepseek-ai/DeepSeek-V4.1",
    "models/deepseek-v4.1.0-flash",
    "deepseek-v4.2-flash",
    "deepseek-v4.10-pro",
    "deepseek-v5-flash",
    "deepseek-v10-pro"
  ])("classifies DeepSeek V4.1 and later versions as multimodal: %s", (model) => {
    expect(classifyScreenVisionModel({ providerName: "中转站", model })).toBe("multimodal");
  });

  it.each([
    ["DeepSeek", "deepseek-v4-flash"],
    ["DeepSeek", "deepseek-v4-pro"],
    ["DeepSeek", "deepseek-v3.1"],
    ["DeepSeek", "deepseek-reasoner"],
    ["DeepSeek", "deepseek-chat"],
    ["百川", "Baichuan4"],
    ["OpenAI", "gpt-3.5-turbo"],
    ["阿里云 DashScope", "qwen-max"],
    ["智谱", "glm-4-flash"]
  ])("classifies %s/%s as text-only", (providerName, model) => {
    expect(classifyScreenVisionModel({ providerName, model })).toBe("text-only");
  });

  it("does not turn an arbitrary alias into a known capability", () => {
    expect(classifyScreenVisionModel({ providerName: "OpenAI", model: "vision-alias" })).toBe("unknown");
    expect(classifyScreenVisionModel({ providerName: "中转站", baseUrl: "https://relay.example.com/v1", model: "default" })).toBe("unknown");
  });

  it.each(["deepseek-v4.0-flash", "deepseek-v4.0.1-flash", "deepseek-v4.x-flash", "default"])(
    "does not infer a newer DeepSeek version from an unknown model: %s",
    (model) => {
      expect(classifyScreenVisionModel({ providerName: "DeepSeek", model })).toBe("unknown");
    }
  );
});
