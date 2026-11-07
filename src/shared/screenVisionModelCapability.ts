/**
 * Model-name routing used before the visual capability probe.
 *
 * This is deliberately a conservative allow-list. A relay can only be
 * classified from its model id when it keeps a recognizable upstream id (for
 * example `openai/gpt-4o`); an arbitrary relay alias remains unknown and is
 * sent through the real image probe.
 */
export type ScreenVisionModelCapability = "multimodal" | "text-only" | "unknown";

export interface ScreenVisionModelIdentity {
  providerName?: string;
  baseUrl?: string;
  model: string;
}

interface ModelRule {
  provider?: RegExp;
  model: RegExp;
}

function normalize(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u2010-\u2015]/gu, "-")
    .trim();
}

function compact(value: string): string {
  return normalize(value).replace(/[^a-z0-9\u4e00-\u9fff]/gu, "");
}

function providerText(identity: ScreenVisionModelIdentity): string {
  return compact(`${identity.providerName ?? ""} ${identity.baseUrl ?? ""}`);
}

function modelText(model: string): string {
  const normalized = normalize(model).replace(/^models[/:]/u, "");
  return compact(normalized);
}

function isDeepSeekV41OrLater(model: string): boolean {
  // Keep version separators: compacting V4.0 would make it look like V40.
  const version = normalize(model).match(
    /(?:^|[/:])deepseek[-_\s]*v(\d+)(?:\.(\d+)(?:\.\d+)*)?(?=$|[-_\s/:]|[a-z])/u
  );
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 1);
}

const multimodalRules: readonly ModelRule[] = [
  // OpenAI and compatible relays.
  { model: /(?:gpt4o|gpt41|gpt45|gpt4turbo|gpt4vision|chatgpt4o|gpt5)/u },
  { model: /(?:^|)o1(?!mini)|(?:^|)o3(?!mini)|o4mini|computerusepreview/u },

  // Anthropic, Google and xAI.
  { model: /claude(?:3|35|37|4)/u },
  { model: /gemini(?:15|20|2|25|3|provision|vision)/u },
  { model: /grok(?:2vision|vision)/u },

  // Alibaba / Qwen. Keep the VL/Omni marker so ordinary Qwen text models do
  // not become visual merely because they contain "qwen".
  { model: /qwen(?:vl|2vl|25vl|3vl|35vl|omni|2omni|25omni|3omni|35omni|qvq)/u },

  // Chinese hosted model families.
  { model: /doubao(?:.*(?:vision|vl|omni))/u },
  { model: /glm(?:4v|41v|45v|46v)|chatglm(?:.*(?:vision|vl))/u },
  { model: /kimi(?:vl|k25)|moonshot(?:.*(?:vision|vl))/u },
  { model: /ernie(?:.*(?:vision|vl|omni))/u },
  { model: /hunyuan(?:.*(?:vision|vl|omni))/u },
  { model: /sensenova(?:v[56]|.*(?:vision|vl|omni))|sensechat(?:.*(?:vision|vl|omni))/u },
  { model: /step(?:1o|1v|.*(?:vision|vl))/u },

  // Common open and hosted vision checkpoints.
  { model: /(?:pixtral|mistralsmall31|mistralmedium3(?:1)?)/u },
  { model: /llama(?:32.*vision|4(?:scout|maverick)?)/u },
  { model: /phi(?:35vision|4(?:multimodal|vision))/u },
  { model: /internvl/u },
  { model: /minicpm(?:v|o|3v|4v)/u },
  { model: /yivl/u },
  // DeepSeek V4.1+ uses the version policy above; retain this older visual
  // variant while ordinary V4 Flash and V4 Pro remain text-only below.
  { model: /deepseekv4flashvisionexp/u },
  { model: /deepseek(?:vl|ocr)/u },
  { model: /(?:llava|idefics|paligemma|molmo|ovis|aria)/u },

  // Providers whose visual product is identified by an endpoint/model token
  // rather than a stable family name.
  { provider: /(?:minimax|abab)/u, model: /(?:apivlm|minimax.*(?:vl|vision|omni)|abab.*(?:vl|vision))/u },
  { provider: /(?:科大讯飞|讯飞|xfyun|iflytek|spark)/u, model: /(?:imagev3|spark.*(?:vision|vl))/u },
  { provider: /(?:qwen|阿里|通义|dashscope)/u, model: /(?:^|)(?:vl|omni|qvq)/u },
  { provider: /(?:doubao|豆包|volcengine|火山)/u, model: /(?:vision|vl|omni)/u },
  { provider: /(?:glm|智谱|zhipu)/u, model: /(?:^|)(?:4v|41v|45v|46v)/u },
  { provider: /(?:kimi|月之暗面|moonshot)/u, model: /(?:^|)(?:vl|k25)/u },
  { provider: /(?:deepseek|深度求索)/u, model: /(?:^|)(?:vl2|vl|ocr)/u },
  { provider: /(?:stepfun|阶跃星辰|step)/u, model: /(?:^|)(?:1o|1v|vision|vl)/u },
  { provider: /(?:hunyuan|混元|腾讯)/u, model: /(?:vision|vl|omni)/u },
];

const textOnlyRules: readonly ModelRule[] = [
  // Legacy DeepSeek text models and unversioned chat/reasoner aliases.
  // V4.1+ is matched first; VL/VL2 remains a separate visual model family.
  { model: /deepseek(?:chat|reasoner|r1|r2|coder|v3|v31|v4(?:flash|pro))/u },
  { provider: /(?:deepseek|深度求索)/u, model: /(?:^|)(?:chat|reasoner|r1|r2|v3|v31|v4(?:flash|pro))/u },

  { model: /baichuan(?:2turbo|3turbo|4)/u },
  { model: /qwen(?:turbo|plus|max|2|25|3)(?!vl|omni|qvq)/u },
  { model: /doubao(?:pro|lite|seed)(?!.*(?:vision|vl|omni))/u },
  { model: /glm(?:4(?:plus|air|flash|long|assistant)?|45|46)(?!v)/u },
  { model: /(?:moonshotv1|kimik2(?!5)|kimi(?:latest|turbo))/u },
  { model: /hunyuan(?:turbo|pro|lite|t1)(?!.*(?:vision|vl|omni))/u },

  // Text-only variants of otherwise multimodal vendors.
  { model: /(?:gpt35|o1mini|o3mini|davinci|textembedding)/u },
  { model: /(?:claude2|claudeinstant)/u },
  { model: /(?:gemma|mistrallarge|mistralsmall|mixtral|ministral|codestral)/u },
  { model: /llama(?:2|3|31|33)(?!.*vision)/u },
  { model: /phi(?:2|3|4)(?!.*(?:vision|multimodal))/u },
  { model: /(?:step1|step15)(?!.*(?:vision|vl|omni))/u },
  { model: /(?:yilarge|yi15|abab|minimax(?:text|01))/u },
];

function matchesRule(rule: ModelRule, model: string, provider: string): boolean {
  return rule.model.test(model) && (!rule.provider || rule.provider.test(provider));
}

/**
 * Classify only recognizable model identities. Provider information is used
 * for short endpoint-specific ids such as MiniMax `API-vlm` and iFlytek
 * `imagev3`; it is never enough by itself to classify an arbitrary model.
 */
export function classifyScreenVisionModel(
  identity: ScreenVisionModelIdentity
): ScreenVisionModelCapability {
  const model = modelText(identity.model);
  if (!model) return "unknown";
  const provider = providerText(identity);

  if (isDeepSeekV41OrLater(identity.model) || multimodalRules.some((rule) => matchesRule(rule, model, provider))) {
    return "multimodal";
  }
  if (textOnlyRules.some((rule) => matchesRule(rule, model, provider))) {
    return "text-only";
  }
  return "unknown";
}

// Descriptive alias for callers that prefer the word "match".
export const matchScreenVisionModelCapability = classifyScreenVisionModel;
