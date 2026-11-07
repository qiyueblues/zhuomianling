export const aiProviderOptions = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com" },
  { id: "gemini", name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }
] as const;

export type AiProviderSelectId = (typeof aiProviderOptions)[number]["id"] | "custom";

export function normalizeAiBaseUrl(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim();

  if (!trimmedBaseUrl) {
    return "";
  }

  try {
    const url = new URL(trimmedBaseUrl);
    const credentials = url.username
      ? `${url.username}${url.password ? `:${url.password}` : ""}@`
      : "";
    const normalizedPath = url.pathname.replace(/\/+$/, "");

    // URL canonicalizes the protocol/host casing, default port and dot segments.
    // Fragments are deliberately excluded because they are never sent to the API.
    return `${url.protocol}//${credentials}${url.host}${normalizedPath}${url.search}`;
  } catch {
    // Keep invalid drafts editable while still applying the same conservative
    // trailing-slash normalization on both the renderer and main process.
    return trimmedBaseUrl.replace(/\/+$/, "");
  }
}

export interface AiConnectionDraft {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  models?: AiModelOption[];
}

export function findAiProviderByBaseUrl(baseUrl: string): (typeof aiProviderOptions)[number] | undefined {
  const normalizedBaseUrl = normalizeAiBaseUrl(baseUrl);
  return aiProviderOptions.find((provider) => normalizeAiBaseUrl(provider.baseUrl) === normalizedBaseUrl);
}

export function getOpenAiCompatibleProviderName(baseUrl: string): string {
  const configuredProvider = findAiProviderByBaseUrl(baseUrl);
  if (configuredProvider) return configuredProvider.name;
  try {
    const hostname = new URL(normalizeAiBaseUrl(baseUrl)).hostname.toLowerCase();
    if (hostname === "api.openai.com") return "OpenAI";
    if (hostname === "api.deepseek.com") return "DeepSeek";
    if (hostname === "generativelanguage.googleapis.com") return "Gemini";
    if (hostname === "api.x.ai") return "xAI";
    if (hostname === "openrouter.ai") return "OpenRouter";
  } catch {
    // Invalid drafts remain editable and use the protocol-level fallback label.
  }
  return "OpenAI Compatible";
}

export type AiOutputMode = "json-schema" | "json-object" | "prompt-json" | "plain-text";
export type AiProtocolTier = "full" | "text";
export type AiOutputCapabilityConfidence = "tested" | "fallback";

export type AiChatImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export function isAiChatImageMimeType(value: unknown): value is AiChatImageMimeType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

export const AI_CHAT_LIMITS = Object.freeze({
  maxContextMessages: 12,
  maxImageBytes: 512 * 1024,
  maxTotalImageBytes: 6 * 1024 * 1024
});

export interface AiChatImageAttachment {
  data: Uint8Array;
  mimeType: AiChatImageMimeType;
}

export interface AiOutputCapability {
  baseUrl: string;
  model: string;
  mode: AiOutputMode;
  protocolTier: AiProtocolTier;
  streaming: boolean;
  confidence: AiOutputCapabilityConfidence;
  checkedAt: string;
  probeVersion?: 2;
}

export interface AiOutputCapabilityTestResult extends AiConnectionTestResult {
  capability?: AiOutputCapability;
}

export interface AiConnectionConfig {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  models?: AiModelOption[];
  outputCapability?: AiOutputCapability;
  updatedAt: string;
}

export interface AiConnectionSummary {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  models: AiModelOption[];
  hasApiKey: boolean;
  outputCapability?: AiOutputCapability;
  updatedAt?: string;
}

export interface AiConnectionTestResult {
  ok: boolean;
  message: string;
  checkedAt: string;
  code?:
    | "API_KEY_REQUIRED"
    | "INVALID_AI_SETTINGS"
    | "CONFIG_VERSION_UNSUPPORTED"
    | "SECURE_STORAGE_UNAVAILABLE"
    | "SECURE_STORAGE_CORRUPTED";
}

export interface AiModelOption {
  id: string;
  name: string;
}

export interface AiModelListResult extends AiConnectionTestResult {
  models: AiModelOption[];
}

export interface AiConnectionSaveResult {
  config: AiConnectionSummary;
  test: AiConnectionTestResult;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Optional screenshot attached to this exact conversation message. */
  image?: AiChatImageAttachment;
}

export interface AiChatRequest {
  petId: string;
  messages: AiChatMessage[];
}

export interface AiChatStreamRequest extends AiChatRequest {
  requestId: string;
}

export interface AiChatStreamCancelRequest {
  petId?: string;
  requestId?: string;
  streamId?: string;
}

export interface AiChatStreamCancelResult {
  ok: boolean;
  message: string;
  canceled: number;
}

export interface AiChatStreamStartResult {
  ok: boolean;
  message: string;
  requestId?: string;
  streamId?: string;
}

export interface AiChatStreamEvent {
  streamId: string;
  requestId: string;
  petId: string;
  ok: boolean;
  type: "chunk" | "done" | "error" | "canceled";
  delta?: string;
  content?: string;
  voiceText?: string;
  emotion?: string;
  protocolTier?: AiProtocolTier;
  quality?: "structured" | "recovered" | "plain-text";
  message?: string;
  reason?: "renderer" | "replaced" | "owner-destroyed" | "connect-timeout" | "idle-timeout" | "total-timeout";
}

export interface AiChatResponse {
  ok: boolean;
  message: string;
  content?: string;
  emotion?: string;
  voiceText?: string;
}
