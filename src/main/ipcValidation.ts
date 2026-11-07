import { assertValidPetId } from "../shared/validation/petId";
import { MEMORY_LIMITS } from "../shared/types/memory";
import { assertMemoryBackupConfirmRequest } from "../shared/validation/memoryBackup";
import {
  petChatDecorationIcons,
  petChatDecorationSlots,
  petRadialMenuActionKinds
} from "../shared/types/pet";
import { startupRendererStages } from "../shared/types/startup";
import {
  isPetDesktopScale,
  maxPetDesktopScale,
  minPetDesktopScale
} from "../shared/validation/petUiSettings";
import { isPetVoiceModelVersion } from "../shared/validation/petVoiceModel";
import { normalizePetLineValue } from "../shared/validation/petDefinition";
import { isPetMoodRangeId, isSystemMoodEvent } from "../shared/mood";
import { AI_PROMPT_LIMITS } from "../shared/aiContract";
import {
  AI_CHAT_LIMITS,
  isAiChatImageMimeType
} from "../shared/types/ai";
import {
  assertMemoryClearRequest,
  assertMemoryCreateRequest,
  assertMemoryExportRequest,
  assertMemoryGetRequest,
  assertMemoryListRequest,
  assertMemoryObjectBudget,
  assertMemoryRevisionRequest,
  assertMemorySearchRequest,
  assertMemorySettingsSaveRequest,
  assertMemorySourceConversationRequest,
  assertMemoryUpdateRequest
} from "../shared/validation/memory";
import {
  SCREEN_LIMITS,
  assertScreenAwarenessSettingsRequest,
  assertScreenFrameRequest,
  assertScreenMonitorReplyStatusRequest,
  assertScreenSourceSelectionRequest,
  assertScreenStopRequest,
  assertScreenVisionConnectionDraft,
  assertScreenVisionTimingRequest
} from "../shared/validation/screen";

interface PayloadLimits {
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
  maxTotalStringLength?: number;
  maxBinaryBytes?: number;
  maxTotalBinaryBytes?: number;
  maxNodes?: number;
}

interface ValidationBudget {
  nodes: number;
  totalStringLength: number;
  totalBinaryBytes: number;
}

const defaultLimits: Required<PayloadLimits> = {
  maxDepth: 12,
  maxArrayLength: 2048,
  maxObjectKeys: 2048,
  maxStringLength: 1_000_000,
  maxTotalStringLength: 4_000_000,
  maxBinaryBytes: 262_144,
  maxTotalBinaryBytes: 4_194_304,
  maxNodes: 20_000
};

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const speechSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export const validatedIpcChannels = new Set([
  "app:get-version",
  "app-update:get-state",
  "app-update:acknowledge-completion",
  "app-update:check",
  "app-update:download",
  "app-update:download-github",
  "app-update:cancel",
  "app-update:dismiss",
  "app-update:ignore-version",
  "app-update:install",
  "app-update:open-release",
  "app-update:startup-ready",
  "app:open-local-help",
  "timed-diagnostics-test:get-snapshot",
  "app-window:is-shown",
  "app-window:startup-surface-ready",
  "app-window:startup-timing",
  "pet-config:list-local",
  "pet-config:restore-backup",
  "pet-config:import-ui-theme",
  "pet-config:save-basic-info",
  "pet-config:save-persona",
  "pet-config:save-expression-mappings",
  "pet-config:save-event-settings",
  "pet-config:save-ui-settings",
  "pet-config:save-voice-input",
  "pet-config:pick-voice-model-file",
  "pet-config:test-voice-model-connection",
  "pet-config:disconnect-voice-model",
  "pet-config:save-voice-model",
  "pet-config:import-avatar",
  "pet-config:save-avatar-crop",
  "pet-config:delete",
  "mood:get-editor-state",
  "mood:save-settings",
  "mood:import-range-voice",
  "mood:remove-range-voice",
  "mood:preview-enter-source",
  "preset-voice:get-overview",
  "preset-voice:get-task",
  "preset-voice:start",
  "preset-voice:cancel",
  "preset-voice:preview",
  "preset-voice:load-runtime",
  "preset-voice:delete-all",
  "preset-voice:delete-one",
  "mood:get-display-state",
  "mood:report-system-event",
  "mood:save-meter-position",
  "live2d-import:select-folder",
  "live2d-import:validate-folder",
  "live2d-import:generate-entry",
  "live2d-import:create-preview-model",
  "live2d-import:import-model",
  "live2d-import:scan-imported-sources",
  "live2d-import:scan-preview-sources",
  "ai-settings:list",
  "ai-settings:get",
  "ai-settings:list-models",
  "ai-settings:test-output",
  "ai-settings:save",
  "screen-vision:get-availability",
  "screen-vision:test-current",
  "screen-vision:list-models",
  "screen-vision:test-independent",
  "screen-vision:save-independent",
  "screen-vision:save-settings",
  "screen-vision:pet-availability",
  "screen-vision:list-sources",
  "screen-vision:start",
  "screen-vision:frame",
  "screen-vision:stop",
  "screen-vision:reply-status",
  "screen-vision:get-state",
  "screen-vision:timing",
  "pet-package:inspect-export",
  "pet-package:export",
  "pet-package:begin-import",
  "pet-package:list-import-ai-models",
  "pet-package:test-import-ai",
  "pet-package:pick-gpt-sovits-root",
  "pet-package:test-import-voice",
  "pet-package:commit-import",
  "pet-package:cancel-import",
  "pet-package:cancel-operation",
  "memory:get-summary",
  "memory:list",
  "memory:get",
  "memory:get-source-conversation",
  "memory:search",
  "memory:create",
  "memory:update",
  "memory:forget",
  "memory:undo-forget",
  "memory:clear",
  "memory:export",
  "memory:prepare-import",
  "memory:confirm-import",
  "memory:cancel-import",
  "memory:rebuild-index",
  "memory:get-settings",
  "memory:save-settings",
  "memory:get-provider-status",
  "memory:test-provider",
  "memory:get-status",
  "ai-chat:stream",
  "ai-chat:cancel",
  "speech-to-text:transcribe",
  "text-to-speech:speak",
  "text-to-speech:stop",
  "speech-stream:start",
  "speech-stream:audio",
  "speech-stream:stop",
  "window:minimize",
  "window:close",
  "pet-window:show",
  "pet-window:close",
  "pet-window:toggle-click-through",
  "pet-window:set-click-through",
  "pet-window:set-click-through-control-interactive",
  "pet-window:start-drag",
  "pet-window:move-drag",
  "pet-window:end-drag",
  "pet-window:get-state",
  "pet-window:get-payload",
  "pet-window:preview-source",
  "pet-window:consume-pending-source-preview",
  "pet-window:complete-source-preview"
]);

function fail(channel: string, message: string): never {
  throw new Error(`IPC ${channel} 参数无效：${message}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(channel: string, value: unknown, label = "请求"): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail(channel, `${label}必须是普通对象。`);
  }

  return value;
}

function assertAllowedKeys(channel: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) fail(channel, `不允许字段 ${unknown}。`);
}

function validateMemoryObject<T>(
  channel: string,
  value: unknown,
  allowed: readonly string[],
  validate: (request: T) => unknown
): Record<string, unknown> {
  const request = assertRecord(channel, value);
  assertAllowedKeys(channel, request, allowed);
  try {
    validate(request as T);
    assertMemoryObjectBudget(request);
  } catch (error) {
    fail(channel, error instanceof Error ? error.message : "记忆请求无效。");
  }
  assertSafePayload(channel, request, {
    maxArrayLength: MEMORY_LIMITS.tags,
    maxObjectKeys: 32,
    maxStringLength: MEMORY_LIMITS.contentChars,
    maxTotalStringLength: MEMORY_LIMITS.objectBudgetBytes
  });
  return request;
}

function assertManagementPageSize(channel: string, value: unknown): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MEMORY_LIMITS.managementPageSizeMax)
  ) {
    fail(channel, `pageSize 必须是 1-${MEMORY_LIMITS.managementPageSizeMax} 的整数。`);
  }
}

function assertString(
  channel: string,
  value: unknown,
  label: string,
  maxLength: number,
  options?: { allowEmpty?: boolean; pattern?: RegExp }
): string {
  if (typeof value !== "string") {
    fail(channel, `${label}必须是字符串。`);
  }

  if (!options?.allowEmpty && value.length === 0) {
    fail(channel, `${label}不能为空。`);
  }

  if (value.length > maxLength) {
    fail(channel, `${label}长度不能超过 ${maxLength}。`);
  }

  if (options?.pattern && !options.pattern.test(value)) {
    fail(channel, `${label}格式无效。`);
  }

  return value;
}

function assertOptionalString(
  channel: string,
  value: unknown,
  label: string,
  maxLength: number,
  options?: { pattern?: RegExp }
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return assertString(channel, value, label, maxLength, {
    allowEmpty: true,
    pattern: options?.pattern
  });
}

function assertPetId(channel: string, value: unknown, label = "petId"): string {
  try {
    return assertValidPetId(value);
  } catch (error: unknown) {
    fail(channel, `${label}：${error instanceof Error ? error.message : "格式无效。"}`);
  }
}

function assertRequestId(channel: string, value: unknown, label = "requestId"): string {
  return assertString(channel, value, label, 128, { pattern: requestIdPattern });
}

function assertSafePayload(
  channel: string,
  value: unknown,
  limitsOverrides: PayloadLimits = {}
): void {
  const limits = { ...defaultLimits, ...limitsOverrides };
  const budget: ValidationBudget = {
    nodes: 0,
    totalStringLength: 0,
    totalBinaryBytes: 0
  };
  // Electron's structured clone payloads may legitimately share an object
  // instance (for example, one expression source selected by multiple
  // events). Only an object encountered on the active traversal path is a
  // circular reference; a globally seen object is not.
  const activeAncestors = new WeakSet<object>();

  const visit = (item: unknown, depth: number): void => {
    budget.nodes += 1;

    if (budget.nodes > limits.maxNodes) {
      fail(channel, "对象节点过多。");
    }

    if (depth > limits.maxDepth) {
      fail(channel, "对象嵌套过深。");
    }

    if (item === null || item === undefined || typeof item === "boolean") {
      return;
    }

    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        fail(channel, "数字必须是有限值。");
      }
      return;
    }

    if (typeof item === "string") {
      if (item.length > limits.maxStringLength) {
        fail(channel, `单个字符串长度不能超过 ${limits.maxStringLength}。`);
      }
      budget.totalStringLength += item.length;
      if (budget.totalStringLength > limits.maxTotalStringLength) {
        fail(channel, `字符串总长度不能超过 ${limits.maxTotalStringLength}。`);
      }
      return;
    }

    if (item instanceof ArrayBuffer) {
      if (item.byteLength > limits.maxBinaryBytes) {
        fail(channel, `二进制数据不能超过 ${limits.maxBinaryBytes} 字节。`);
      }
      budget.totalBinaryBytes += item.byteLength;
      if (budget.totalBinaryBytes > limits.maxTotalBinaryBytes) {
        fail(channel, `二进制数据总量不能超过 ${limits.maxTotalBinaryBytes} 字节。`);
      }
      return;
    }

    if (ArrayBuffer.isView(item)) {
      if (item.byteLength > limits.maxBinaryBytes) {
        fail(channel, `二进制数据不能超过 ${limits.maxBinaryBytes} 字节。`);
      }
      budget.totalBinaryBytes += item.byteLength;
      if (budget.totalBinaryBytes > limits.maxTotalBinaryBytes) {
        fail(channel, `二进制数据总量不能超过 ${limits.maxTotalBinaryBytes} 字节。`);
      }
      return;
    }

    if (typeof item !== "object") {
      fail(channel, "包含不支持的数据类型。");
    }

    if (activeAncestors.has(item)) {
      fail(channel, "对象不能包含循环引用。");
    }
    activeAncestors.add(item);

    try {
      if (Array.isArray(item)) {
        if (item.length > limits.maxArrayLength) {
          fail(channel, `数组长度不能超过 ${limits.maxArrayLength}。`);
        }
        for (const child of item) {
          visit(child, depth + 1);
        }
        return;
      }

      const record = assertRecord(channel, item);
      const entries = Object.entries(record);
      if (entries.length > limits.maxObjectKeys) {
        fail(channel, `对象字段数量不能超过 ${limits.maxObjectKeys}。`);
      }

      for (const [key, child] of entries) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          fail(channel, `不允许字段 ${key}。`);
        }
        visit(child, depth + 1);
      }
    } finally {
      activeAncestors.delete(item);
    }
  };

  visit(value, 0);
}

function expectArgumentCount(channel: string, args: unknown[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    fail(channel, `参数数量应为 ${min === max ? min : `${min}-${max}`}。`);
  }
}

function validatePetDraft(channel: string, value: unknown, maxStringLength = 200_000): void {
  const draft = assertRecord(channel, value);
  assertPetId(channel, draft.petId);
  assertSafePayload(channel, draft, {
    maxStringLength,
    maxTotalStringLength: Math.max(1_000_000, maxStringLength * 2)
  });
}

function validateCustomTheme(channel: string, value: unknown): void {
  const theme = assertRecord(channel, value, "customTheme");
  assertAllowedKeys(channel, theme, [
    "id",
    "name",
    "description",
    "version",
    "author",
    "importedAt",
    "tokens",
    "chatDecorations",
    "radialMenu",
    "moodMeter"
  ]);
  assertString(channel, theme.id, "customTheme.id", 40);
  assertString(channel, theme.name, "customTheme.name", 32);
  assertString(channel, theme.description, "customTheme.description", 72, { allowEmpty: true });
  if (typeof theme.version !== "number" || !Number.isFinite(theme.version)) {
    fail(channel, "customTheme.version 必须是有限数值。");
  }
  assertOptionalString(channel, theme.author, "customTheme.author", 32);
  assertOptionalString(channel, theme.importedAt, "customTheme.importedAt", 64);

  const tokens = assertRecord(channel, theme.tokens, "customTheme.tokens");
  const tokenKeys = [
    "background",
    "surface",
    "petSurface",
    "headerSurface",
    "headerText",
    "inputSurface",
    "userSurface",
    "text",
    "mutedText",
    "accent",
    "accentStrong",
    "decorationPrimary",
    "decorationSecondary",
    "watermarkColor",
    "border",
    "danger",
    "shadow",
    "radius"
  ] as const;
  assertAllowedKeys(channel, tokens, tokenKeys);
  for (const key of tokenKeys) {
    if (key === "radius") continue;
    if (tokens[key] !== undefined) {
      assertString(channel, tokens[key], `customTheme.tokens.${key}`, 180);
    }
  }
  if (
    tokens.radius !== undefined &&
    (typeof tokens.radius !== "number" || !Number.isFinite(tokens.radius))
  ) {
    fail(channel, "customTheme.tokens.radius 必须是有限数值。");
  }

  if (theme.chatDecorations !== undefined) {
    const decorations = assertRecord(channel, theme.chatDecorations, "customTheme.chatDecorations");
    assertAllowedKeys(channel, decorations, petChatDecorationSlots);
    for (const [slot, icon] of Object.entries(decorations)) {
      if (typeof icon !== "string" || !petChatDecorationIcons.includes(icon as never)) {
        fail(channel, `customTheme.chatDecorations.${slot} 图标无效。`);
      }
    }
  }

  if (theme.radialMenu !== undefined) {
    const radialMenu = assertRecord(channel, theme.radialMenu, "customTheme.radialMenu");
    assertAllowedKeys(channel, radialMenu, [
      "radius",
      "surface",
      "text",
      "border",
      "shadow",
      "activeBorder",
      "center",
      "actions"
    ]);
    for (const key of ["surface", "text", "border", "shadow", "activeBorder"] as const) {
      if (radialMenu[key] !== undefined) {
        assertString(channel, radialMenu[key], `customTheme.radialMenu.${key}`, 180);
      }
    }
    if (
      radialMenu.radius !== undefined &&
      (typeof radialMenu.radius !== "number" || !Number.isFinite(radialMenu.radius))
    ) {
      fail(channel, "customTheme.radialMenu.radius 必须是有限数值。");
    }

    const validateAction = (value: unknown, field: string): void => {
      const action = assertRecord(channel, value, field);
      assertAllowedKeys(channel, action, ["surface", "text", "border"]);
      for (const key of ["surface", "text", "border"] as const) {
        if (action[key] !== undefined) {
          assertString(channel, action[key], `${field}.${key}`, 180);
        }
      }
    };

    if (radialMenu.center !== undefined) {
      validateAction(radialMenu.center, "customTheme.radialMenu.center");
    }
    if (radialMenu.actions !== undefined) {
      const actions = assertRecord(channel, radialMenu.actions, "customTheme.radialMenu.actions");
      assertAllowedKeys(channel, actions, petRadialMenuActionKinds);
      for (const kind of petRadialMenuActionKinds) {
        if (actions[kind] !== undefined) {
          validateAction(actions[kind], `customTheme.radialMenu.actions.${kind}`);
        }
      }
    }
  }
  if (theme.moodMeter !== undefined) {
    const meter = assertRecord(channel, theme.moodMeter, "customTheme.moodMeter");
    assertAllowedKeys(channel, meter, [
      "upColor", "downColor", "calmColor", "surface", "emptyColor", "textColor",
      "frameColor", "boundaryColor", "particleColor", "shadow", "insetShadow",
      "frame", "particleStyle", "effectStyle", "ranges"
    ]);
    assertString(channel, meter.upColor, "customTheme.moodMeter.upColor", 180);
    assertString(channel, meter.downColor, "customTheme.moodMeter.downColor", 180);
    for (const key of ["calmColor", "surface", "emptyColor", "textColor", "frameColor", "boundaryColor", "particleColor", "shadow", "insetShadow"] as const) {
      assertOptionalString(channel, meter[key], `customTheme.moodMeter.${key}`, 180);
    }
    for (const key of ["upColor", "downColor", "calmColor", "surface", "emptyColor", "textColor", "frameColor", "boundaryColor", "particleColor", "shadow", "insetShadow"] as const) {
      const value = meter[key];
      if (typeof value === "string" && (/[;{}<>@]/.test(value) || /(?:url|expression|import)\s*\(/i.test(value))) {
        fail(channel, `customTheme.moodMeter.${key} 包含不安全的样式值。`);
      }
    }
    if (!["soft-pill","rounded","sharp","pixel","cut-corner"].includes(String(meter.frame))) fail(channel, "customTheme.moodMeter.frame 无效。");
    if (!["float","dust","pixel","scan","minimal"].includes(String(meter.particleStyle))) fail(channel, "customTheme.moodMeter.particleStyle 无效。");
    if (!["halo","lightning","pixel","ink","scan","minimal"].includes(String(meter.effectStyle))) fail(channel, "customTheme.moodMeter.effectStyle 无效。");
    if (meter.ranges !== undefined) {
      const ranges = assertRecord(channel, meter.ranges, "customTheme.moodMeter.ranges");
      assertAllowedKeys(channel, ranges, ["darkened", "slump", "downcast", "calm", "pleasant", "joyful", "excited"]);
      const rangeKeys = ["frameOpacity", "glowOpacity", "glowRadius", "liquidOpacity", "boundaryWidth", "waveAmplitude", "particleOpacity", "auraOpacity", "accentOpacity", "animationSeconds"] as const;
      const limits: Record<(typeof rangeKeys)[number], readonly [number, number]> = {
        frameOpacity: [0, 1], glowOpacity: [0, 1], glowRadius: [0, 32], liquidOpacity: [0, 1],
        boundaryWidth: [.25, 4], waveAmplitude: [0, 5], particleOpacity: [0, 1],
        auraOpacity: [0, 1], accentOpacity: [0, 1], animationSeconds: [.6, 12]
      };
      for (const [rangeId, rawStyle] of Object.entries(ranges)) {
        const style = assertRecord(channel, rawStyle, `customTheme.moodMeter.ranges.${rangeId}`);
        assertAllowedKeys(channel, style, rangeKeys);
        for (const key of rangeKeys) {
          if (style[key] === undefined) continue;
          const [min, max] = limits[key];
          if (typeof style[key] !== "number" || !Number.isFinite(style[key]) || (style[key] as number) < min || (style[key] as number) > max) {
            fail(channel, `customTheme.moodMeter.ranges.${rangeId}.${key} 必须在 ${min}-${max} 范围内。`);
          }
        }
      }
    }
  }
}

function validatePetLine(
  channel: string,
  value: unknown,
  label: string,
  maxTextLength: number
): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const line = assertRecord(channel, value, label);
    assertAllowedKeys(channel, line, ["id", "text", "presetAudio", "audioPath"]);
    if (line.presetAudio !== undefined) {
      const audio = assertRecord(channel, line.presetAudio, `${label}.presetAudio`);
      assertAllowedKeys(channel, audio, [
        "schemaVersion",
        "resourceId",
        "sourceTextHash",
        "spokenText",
        "language",
        "mimeType",
        "durationMs",
        "voiceFingerprint",
        "personaFingerprint",
        "requestedMoodRange",
        "resolvedMoodRange",
        "generatedAt"
      ]);
    }
  }
  try {
    normalizePetLineValue(value, label, maxTextLength);
  } catch (error) {
    fail(channel, error instanceof Error ? error.message : `${label} 无效。`);
  }
}

function validateAiChat(channel: string, value: unknown, requireRequestId: boolean): void {
  const request = assertRecord(channel, value);
  assertPetId(channel, request.petId);
  if (requireRequestId) {
    assertRequestId(channel, request.requestId);
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > 128) {
    fail(channel, "messages 必须包含 1-128 条消息。");
  }
  for (const messageValue of request.messages) {
    const message = assertRecord(channel, messageValue, "消息");
    assertAllowedKeys(channel, message, ["role", "content", "image"]);
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      fail(channel, "消息 role 无效。");
    }
    assertString(
      channel,
      message.content,
      "消息 content",
      AI_PROMPT_LIMITS.conversationMessageCharacters,
      { allowEmpty: true }
    );
    if (message.image !== undefined) {
      const image = assertRecord(channel, message.image, "消息 image");
      assertAllowedKeys(channel, image, ["data", "mimeType"]);
      if (!isAiChatImageMimeType(image.mimeType)) {
        fail(channel, "消息 image MIME 无效。");
      }
      const data = image.data;
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
        fail(channel, "消息 image data 无效。");
      }
      if (data.byteLength < 32 || data.byteLength > AI_CHAT_LIMITS.maxImageBytes) {
        fail(channel, "消息 image 大小无效。");
      }
    }
  }
  assertSafePayload(channel, request, {
    maxArrayLength: 128,
    maxStringLength: AI_PROMPT_LIMITS.conversationMessageCharacters,
    maxTotalStringLength: AI_PROMPT_LIMITS.conversationTotalCharacters,
    maxBinaryBytes: AI_CHAT_LIMITS.maxImageBytes,
    maxTotalBinaryBytes: AI_CHAT_LIMITS.maxTotalImageBytes
  });
}

export function validateIpcArguments(channel: string, args: unknown[]): void {
  if (!validatedIpcChannels.has(channel)) {
    fail(channel, "没有注册运行时 schema。");
  }

  const noArgumentChannels = new Set([
    "app:get-version",
    "app-update:get-state",
    "app-update:acknowledge-completion",
    "app-update:check",
    "app-update:download",
    "app-update:download-github",
    "app-update:cancel",
    "app-update:dismiss",
    "app-update:ignore-version",
    "app-update:install",
    "app-update:open-release",
    "app-update:startup-ready",
    "app:open-local-help",
    "app-window:is-shown",
    "pet-config:list-local",
    "pet-config:import-ui-theme",
    "pet-config:disconnect-voice-model",
    "live2d-import:select-folder",
    "ai-settings:list",
    "pet-package:begin-import",
    "pet-package:pick-gpt-sovits-root",
    "window:minimize",
    "window:close",
    "pet-window:toggle-click-through",
    "pet-window:end-drag",
    "pet-window:get-state",
    "pet-window:get-payload",
    "pet-window:consume-pending-source-preview"
    ,"mood:get-display-state",
    "screen-vision:pet-availability",
    "screen-vision:list-sources",
    "screen-vision:get-state"
  ]);

  if (noArgumentChannels.has(channel)) {
    expectArgumentCount(channel, args, 0);
    return;
  }

  if (channel === "screen-vision:get-availability" || channel === "screen-vision:test-current") {
    expectArgumentCount(channel, args, 1);
    assertPetId(channel, args[0]);
    return;
  }

  if (
    channel === "screen-vision:list-models" ||
    channel === "screen-vision:test-independent" ||
    channel === "screen-vision:save-independent"
  ) {
    expectArgumentCount(channel, args, 1);
    try {
      assertScreenVisionConnectionDraft(args[0]);
      assertSafePayload(channel, args[0], {
        maxArrayLength: SCREEN_LIMITS.maxModels,
        maxStringLength: 16_384,
        maxTotalStringLength: 262_144,
        maxObjectKeys: 32
      });
    } catch (error) {
      fail(channel, error instanceof Error ? error.message : "视觉连接参数无效。");
    }
    return;
  }

  if (channel === "screen-vision:save-settings") {
    expectArgumentCount(channel, args, 1);
    try {
      assertScreenAwarenessSettingsRequest(args[0]);
      assertSafePayload(channel, args[0], {
        maxStringLength: 128,
        maxTotalStringLength: 512,
        maxObjectKeys: 8
      });
    } catch (error) {
      fail(channel, error instanceof Error ? error.message : "视觉设置参数无效。");
    }
    return;
  }

  if (channel === "screen-vision:start") {
    expectArgumentCount(channel, args, 1);
    try {
      assertScreenSourceSelectionRequest(args[0]);
      assertSafePayload(channel, args[0], {
        maxArrayLength: SCREEN_LIMITS.maxContextMessages,
        maxStringLength: SCREEN_LIMITS.maxContextMessageCharacters,
        maxTotalStringLength: SCREEN_LIMITS.maxQuestionCharacters + 24_000,
        maxBinaryBytes: AI_CHAT_LIMITS.maxImageBytes,
        maxTotalBinaryBytes: AI_CHAT_LIMITS.maxTotalImageBytes,
        maxObjectKeys: 64
      });
    } catch (error) {
      fail(channel, error instanceof Error ? error.message : "屏幕来源参数无效。");
    }
    return;
  }

  if (channel === "screen-vision:frame") {
    expectArgumentCount(channel, args, 1);
    try {
      assertScreenFrameRequest(args[0]);
      assertSafePayload(channel, args[0], {
        maxBinaryBytes: SCREEN_LIMITS.maxFrameBytes,
        maxTotalBinaryBytes: SCREEN_LIMITS.maxObjectBudgetBytes,
        maxStringLength: SCREEN_LIMITS.maxQuestionCharacters,
        maxTotalStringLength:
          SCREEN_LIMITS.maxQuestionCharacters +
          SCREEN_LIMITS.maxContextMessages * SCREEN_LIMITS.maxContextMessageCharacters +
          1_024,
        maxObjectKeys: 32
      });
    } catch (error) {
      fail(channel, error instanceof Error ? error.message : "屏幕帧参数无效。");
    }
    return;
  }

  if (channel === "screen-vision:stop") {
    expectArgumentCount(channel, args, 1);
    try {
      assertScreenStopRequest(args[0]);
      assertSafePayload(channel, args[0], {
        maxStringLength: SCREEN_LIMITS.maxSessionIdCharacters,
        maxTotalStringLength: 512,
        maxObjectKeys: 8
      });
    } catch (error) {
      fail(channel, error instanceof Error ? error.message : "停止视觉请求无效。");
    }
    return;
  }

  if (channel === "screen-vision:reply-status") {
    expectArgumentCount(channel, args, 1);
    try {
      assertScreenMonitorReplyStatusRequest(args[0]);
      assertSafePayload(channel, args[0], {
        maxStringLength: SCREEN_LIMITS.maxSessionIdCharacters,
        maxTotalStringLength: 512,
        maxObjectKeys: 8
      });
    } catch (error) {
      fail(channel, error instanceof Error ? error.message : "视觉回复状态无效。");
    }
    return;
  }

  if (channel === "screen-vision:timing") {
    expectArgumentCount(channel, args, 1);
    try {
      assertScreenVisionTimingRequest(args[0]);
      assertSafePayload(channel, args[0], {
        maxStringLength: 128,
        maxTotalStringLength: 512,
        maxObjectKeys: 8
      });
    } catch (error) {
      fail(channel, error instanceof Error ? error.message : "视觉计时参数无效。");
    }
    return;
  }

  if (channel === "app-window:startup-surface-ready") {
    expectArgumentCount(channel, args, 0, 1);
    assertOptionalString(channel, args[0], "reason", 120);
    return;
  }

  if (channel === "mood:get-editor-state") {
    expectArgumentCount(channel, args, 1); assertPetId(channel, args[0]); return;
  }

  if (channel === "mood:report-system-event") {
    expectArgumentCount(channel, args, 1);
    if (!isSystemMoodEvent(args[0])) fail(channel, "事件类型无效。");
    return;
  }

  if (channel === "mood:save-meter-position") {
    expectArgumentCount(channel, args, 1);
    const position = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, position, ["left", "top"]);
    for (const key of ["left", "top"] as const) if (typeof position[key] !== "number" || !Number.isFinite(position[key]) || Math.abs(position[key] as number) > 100_000) fail(channel, `${key} 无效。`);
    return;
  }

  if (channel === "mood:save-settings") {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, draft, ["petId", "settings"]); assertPetId(channel, draft.petId);
    const settings = assertRecord(channel, draft.settings); assertAllowedKeys(channel, settings, ["ranges"]);
    const ranges = settings.ranges === undefined ? {} : assertRecord(channel, settings.ranges);
    for (const [id, raw] of Object.entries(ranges)) {
      if (!isPetMoodRangeId(id)) fail(channel, "包含未知心情区间。");
      const range = assertRecord(channel, raw); assertAllowedKeys(channel, range, ["enterSource", "enterLine", "voiceOverride"]);
      if (range.enterLine !== undefined) validatePetLine(channel, range.enterLine, "enterLine", 300);
    }
    assertSafePayload(channel, draft, { maxStringLength: 2_048, maxTotalStringLength: 8_000, maxObjectKeys: 128 });
    return;
  }

  if (channel === "mood:import-range-voice" || channel === "mood:remove-range-voice" || channel === "mood:preview-enter-source") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, request, channel === "mood:import-range-voice" ? ["petId","rangeId","referenceText"] : channel === "mood:preview-enter-source" ? ["petId","rangeId","source"] : ["petId","rangeId"]);
    assertPetId(channel, request.petId);
    if (!isPetMoodRangeId(request.rangeId)) fail(channel, "rangeId 无效。");
    if (channel === "mood:import-range-voice") assertString(channel, request.referenceText, "referenceText", 500, { allowEmpty: true });
    if (channel === "mood:preview-enter-source") {
      const source = assertRecord(channel, request.source, "source");
      assertAllowedKeys(channel, source, ["sourceFileName","runtimeName","sourceKind","description","effects"]);
      assertString(channel, source.sourceFileName, "sourceFileName", 255);
      if (source.sourceKind !== "motion" && source.sourceKind !== "expression") fail(channel, "sourceKind 无效。");
      assertSafePayload(channel, source, { maxStringLength: 500, maxTotalStringLength: 4_000, maxObjectKeys: 64 });
    }
    return;
  }

  if (channel === "pet-config:save-ui-settings") {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, draft, [
      "petId",
      "theme",
      "customTheme",
      "removeCustomTheme",
      "clickThroughOpacity",
      "cursorFollowEnabled",
      "desktopScale"
    ]);
    if (!["soft", "rock", "pixel", "journal", "cyber", "minimal", "custom"].includes(
      draft.theme as string
    )) {
      fail(channel, "theme 无效。");
    }
    if (draft.removeCustomTheme !== undefined && typeof draft.removeCustomTheme !== "boolean") {
      fail(channel, "removeCustomTheme 必须是布尔值。");
    }
    if (draft.removeCustomTheme === true && draft.theme === "custom") {
      fail(channel, "启用自定义主题时不能删除 customTheme。");
    }
    if (draft.removeCustomTheme === true && draft.customTheme !== undefined) {
      fail(channel, "删除 customTheme 时不能同时提交主题定义。");
    }
    if (draft.theme === "custom") {
      validateCustomTheme(channel, draft.customTheme);
    } else if (draft.customTheme !== undefined) {
      // 已导入主题与当前激活的内置主题可以同时存在；只有显式删除才清除它。
      validateCustomTheme(channel, draft.customTheme);
    }
    if (draft.desktopScale !== undefined && !isPetDesktopScale(draft.desktopScale)) {
      fail(
        channel,
        `desktopScale 必须是 ${minPetDesktopScale}-${maxPetDesktopScale} 之间的有限数值。`
      );
    }
    validatePetDraft(channel, draft);
    return;
  }

  if (channel === "pet-config:save-persona") {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    assertPetId(channel, draft.petId);
    assertString(channel, draft.personaPrompt, "personaPrompt", AI_PROMPT_LIMITS.personaCharacters, { allowEmpty: true });
    if (draft.chatLanguage !== "zh" && draft.chatLanguage !== "ja" && draft.chatLanguage !== "en") fail(channel, "chatLanguage 无效。");
    if (draft.replyLength !== undefined && draft.replyLength !== "short" && draft.replyLength !== "medium" && draft.replyLength !== "long") fail(channel, "replyLength 无效。");
    assertSafePayload(channel, draft, { maxStringLength: AI_PROMPT_LIMITS.personaCharacters, maxTotalStringLength: AI_PROMPT_LIMITS.personaCharacters + 256 });
    return;
  }

  if (channel === "pet-config:save-expression-mappings") {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    assertPetId(channel, draft.petId);
    if (!Array.isArray(draft.mappings) || draft.mappings.length > 128) fail(channel, "mappings 数量无效。");
    let descriptionCharacters = 0;
    for (const rawMapping of draft.mappings) {
      const mapping = assertRecord(channel, rawMapping, "mapping");
      const description = assertString(channel, mapping.description, "mapping.description", AI_PROMPT_LIMITS.expressionDescriptionCharacters, { allowEmpty: true });
      descriptionCharacters += description.length;
    }
    if (descriptionCharacters > AI_PROMPT_LIMITS.expressionDescriptionsTotalCharacters) fail(channel, "表情描述总长度超出限制。");
    validatePetDraft(channel, draft, AI_PROMPT_LIMITS.expressionDescriptionsTotalCharacters);
    return;
  }

  if (channel === "pet-config:save-event-settings") {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    if (!Array.isArray(draft.events) || draft.events.length > 128) {
      fail(channel, "events 数量无效。");
    }
    for (const rawEvent of draft.events) {
      const event = assertRecord(channel, rawEvent, "event");
      if (event.showSubtitle !== undefined && typeof event.showSubtitle !== "boolean") {
        fail(channel, "event.showSubtitle 必须是布尔值。");
      }
    }
    validatePetDraft(channel, draft);
    return;
  }

  if (channel === "pet-config:save-voice-input") {
    expectArgumentCount(channel, args, 1);
    validatePetDraft(channel, args[0]);
    return;
  }

  if (channel === "pet-package:inspect-export" || channel === "pet-package:export") {
    expectArgumentCount(channel, args, 1);
    assertPetId(channel, args[0]);
    return;
  }

  if (channel === "pet-package:list-import-ai-models") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, request, ["sessionId", "baseUrl", "apiKey"]);
    assertString(channel, request.sessionId, "sessionId", 64);
    assertString(channel, request.baseUrl, "baseUrl", 4096);
    assertString(channel, request.apiKey, "apiKey", 16_384);
    assertSafePayload(channel, request, { maxStringLength: 16_384, maxTotalStringLength: 32_768 });
    return;
  }

  if (channel === "pet-package:test-import-ai") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, request, ["sessionId", "draft"]);
    assertString(channel, request.sessionId, "sessionId", 64);
    const draft = assertRecord(channel, request.draft, "draft");
    assertAllowedKeys(channel, draft, ["baseUrl", "model", "apiKey"]);
    assertString(channel, draft.baseUrl, "baseUrl", 4096);
    assertString(channel, draft.model, "model", 512);
    assertString(channel, draft.apiKey, "apiKey", 16_384);
    assertSafePayload(channel, request, { maxStringLength: 16_384, maxTotalStringLength: 262_144 });
    return;
  }

  if (channel === "pet-package:test-import-voice") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, request, ["sessionId", "gptSoVitsRootPath"]);
    assertString(channel, request.sessionId, "sessionId", 64);
    assertString(channel, request.gptSoVitsRootPath, "gptSoVitsRootPath", 32_768);
    return;
  }

  if (channel === "pet-package:commit-import") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, request, ["sessionId"]);
    assertString(channel, request.sessionId, "sessionId", 64);
    return;
  }

  if (channel === "pet-package:cancel-import") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, request, ["sessionId", "operationId"]);
    assertOptionalString(channel, request.sessionId, "sessionId", 64);
    assertOptionalString(channel, request.operationId, "operationId", 64);
    return;
  }

  if (channel === "pet-package:cancel-operation") {
    expectArgumentCount(channel, args, 1);
    assertString(channel, args[0], "operationId", 64);
    return;
  }

  if (channel === "pet-config:save-basic-info") {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    if (draft.id !== undefined) {
      assertPetId(channel, draft.id, "id");
    }
    assertString(channel, draft.name, "name", 128);
    assertSafePayload(channel, draft, {
      maxArrayLength: 64,
      maxStringLength: 8_000_000,
      maxTotalStringLength: 10_000_000
    });
    return;
  }

  if (channel === "pet-config:pick-voice-model-file") {
    expectArgumentCount(channel, args, 1);
    if (args[0] !== "sovits" && args[0] !== "gpt" && args[0] !== "referenceAudio") {
      fail(channel, "资源类型无效。");
    }
    return;
  }

  if (channel === "pet-config:import-avatar") {
    expectArgumentCount(channel, args, 0, 1);
    if (args[0] !== undefined) {
      assertPetId(channel, args[0]);
    }
    return;
  }

  if (channel === "pet-config:save-avatar-crop") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    if (request.petId !== undefined) {
      assertPetId(channel, request.petId);
    }
    assertString(channel, request.dataUrl, "dataUrl", 16_000_000);
    assertSafePayload(channel, request, {
      maxStringLength: 16_000_000,
      maxTotalStringLength: 16_000_128
    });
    return;
  }

  if (
    channel === "pet-config:delete" ||
    channel === "pet-config:restore-backup" ||
    channel === "live2d-import:scan-imported-sources" ||
    channel === "ai-settings:get"
  ) {
    expectArgumentCount(channel, args, 1);
    assertPetId(channel, args[0]);
    return;
  }

  if (
    channel === "live2d-import:validate-folder" ||
    channel === "live2d-import:generate-entry" ||
    channel === "live2d-import:create-preview-model" ||
    channel === "live2d-import:scan-preview-sources"
  ) {
    expectArgumentCount(channel, args, 1);
    assertString(channel, args[0], "folderPath", 32_768);
    return;
  }

  if (channel === "live2d-import:import-model") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertPetId(channel, request.petId);
    assertString(channel, request.sourceFolderPath, "sourceFolderPath", 32_768);
    assertSafePayload(channel, request, { maxStringLength: 32_768 });
    return;
  }

  if (
    channel === "ai-settings:list-models" ||
    channel === "ai-settings:test-output" ||
    channel === "ai-settings:save"
  ) {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    assertPetId(channel, draft.petId);
    assertString(channel, draft.providerName, "providerName", 128, { allowEmpty: true });
    assertString(channel, draft.baseUrl, "baseUrl", 4096, { allowEmpty: true });
    assertString(channel, draft.model, "model", 512, { allowEmpty: true });
    assertString(channel, draft.apiKey, "apiKey", 16_384, { allowEmpty: true });
    assertSafePayload(channel, draft, {
      maxArrayLength: 512,
      maxStringLength: 16_384,
      maxTotalStringLength: 262_144
    });
    return;
  }

  if (
    channel === "pet-config:test-voice-model-connection" ||
    channel === "pet-config:save-voice-model"
  ) {
    expectArgumentCount(channel, args, 1);
    const draft = assertRecord(channel, args[0]);
    if (!isPetVoiceModelVersion(draft.modelVersion)) {
      fail(channel, "modelVersion 不是受支持的 GPT-SoVITS 模型版本。");
    }
    validatePetDraft(channel, draft);
    return;
  }

  if (channel === "app-window:startup-timing") {
    expectArgumentCount(channel, args, 1);
    if (typeof args[0] !== "string" || !startupRendererStages.includes(args[0] as never)) {
      fail(channel, "startup stage 无效。");
    }
    return;
  }

  // TIMED DIAGNOSTICS TEST MODULE: the main-window snapshot has no payload.
  if (channel === "timed-diagnostics-test:get-snapshot") {
    expectArgumentCount(channel, args, 0);
    return;
  }

  if (
    channel === "memory:get-summary" ||
    channel === "memory:prepare-import" ||
    channel === "memory:rebuild-index" ||
    channel === "memory:get-settings" ||
    channel === "memory:get-provider-status" ||
    channel === "memory:test-provider" ||
    channel === "memory:get-status"
  ) {
    expectArgumentCount(channel, args, 1);
    assertPetId(channel, args[0]);
    return;
  }

  if (channel === "memory:list") {
    expectArgumentCount(channel, args, 1);
    const request = validateMemoryObject(
      channel,
      args[0],
      ["petId", "cursor", "pageSize", "chapters", "importantOnly", "sort", "fromTime", "toTime"],
      assertMemoryListRequest
    );
    assertManagementPageSize(channel, request.pageSize);
    return;
  }

  if (channel === "memory:search") {
    expectArgumentCount(channel, args, 1);
    const request = validateMemoryObject(
      channel,
      args[0],
      ["petId", "query", "cursor", "pageSize", "chapters", "importantOnly", "sort", "fromTime", "toTime"],
      assertMemorySearchRequest
    );
    assertManagementPageSize(channel, request.pageSize);
    return;
  }

  if (channel === "memory:get") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(channel, args[0], ["petId", "memoryId", "includeDeleted"], assertMemoryGetRequest);
    return;
  }

  if (channel === "memory:get-source-conversation") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(
      channel,
      args[0],
      ["petId", "memoryId"],
      assertMemorySourceConversationRequest
    );
    return;
  }

  if (channel === "memory:create") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(
      channel,
      args[0],
      ["petId", "chapter", "memoryType", "content", "tags", "important", "origin", "sourceTime"],
      assertMemoryCreateRequest
    );
    return;
  }

  if (channel === "memory:update") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(
      channel,
      args[0],
      ["petId", "memoryId", "expectedRevision", "chapter", "content", "tags", "important"],
      assertMemoryUpdateRequest
    );
    return;
  }

  if (channel === "memory:forget" || channel === "memory:undo-forget") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(
      channel,
      args[0],
      ["petId", "memoryId", "expectedRevision"],
      assertMemoryRevisionRequest
    );
    return;
  }

  if (channel === "memory:clear") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(channel, args[0], ["petId", "confirmPetId"], assertMemoryClearRequest);
    return;
  }

  if (channel === "memory:export") {
    expectArgumentCount(channel, args, 1);
    const request = validateMemoryObject(
      channel,
      args[0],
      ["petId", "options", "sourceExportConsent"],
      assertMemoryExportRequest
    );
    const options = assertRecord(channel, request.options, "options");
    assertAllowedKeys(channel, options, ["includeSources"]);
    return;
  }

  if (channel === "memory:confirm-import" || channel === "memory:cancel-import") {
    expectArgumentCount(channel, args, 1);
    validateMemoryObject(channel, args[0], ["petId", "token"], assertMemoryBackupConfirmRequest);
    return;
  }

  if (channel === "memory:save-settings") {
    expectArgumentCount(channel, args, 1);
    const request = validateMemoryObject(
      channel,
      args[0],
      ["petId", "settings", "autoCaptureConsent", "sourceRetentionConsent"],
      assertMemorySettingsSaveRequest
    );
    const settings = assertRecord(channel, request.settings, "settings");
    assertAllowedKeys(channel, settings, [
      "onboardingCompleted",
      "recallEnabled",
      "autoCaptureEnabled",
      "recallLimit",
      "contextBudgetChars",
      "retainSources",
      "providerProfileId"
    ]);
    return;
  }

  if (channel === "ai-chat:stream") {
    expectArgumentCount(channel, args, 1);
    validateAiChat(channel, args[0], true);
    return;
  }

  if (
    channel === "preset-voice:get-overview" ||
    channel === "preset-voice:get-task" ||
    channel === "preset-voice:delete-all"
  ) {
    expectArgumentCount(channel, args, 1);
    assertPetId(channel, args[0]);
    return;
  }

  if (channel === "preset-voice:start") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, request, ["petId", "scope", "targetId", "translation", "targetLanguage"]);
    assertPetId(channel, request.petId);
    if (request.scope !== "missing" && request.scope !== "all") fail(channel, "scope 无效。");
    if (request.translation !== "source" && request.translation !== "translate") {
      fail(channel, "translation 无效。");
    }
    if (
      request.targetLanguage !== undefined &&
      request.targetLanguage !== "zh" && request.targetLanguage !== "ja" && request.targetLanguage !== "en"
    ) {
      fail(channel, "targetLanguage 无效。");
    }
    if (request.translation === "translate" && request.targetLanguage === undefined) {
      fail(channel, "AI 翻译必须指定 targetLanguage。");
    }
    if (request.targetId !== undefined) {
      assertRequestId(channel, request.targetId, "targetId");
    }
    assertSafePayload(channel, request, { maxStringLength: 128, maxTotalStringLength: 640 });
    return;
  }

  if (
    channel === "preset-voice:cancel" ||
    channel === "preset-voice:preview" ||
    channel === "preset-voice:load-runtime" ||
    channel === "preset-voice:delete-one"
  ) {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertAllowedKeys(channel, request, channel === "preset-voice:cancel" ? ["petId", "taskId"] : ["petId", "targetId"]);
    assertPetId(channel, request.petId);
    assertRequestId(
      channel,
      channel === "preset-voice:cancel" ? request.taskId : request.targetId,
      channel === "preset-voice:cancel" ? "taskId" : "targetId"
    );
    return;
  }

  if (channel === "ai-chat:cancel") {
    expectArgumentCount(channel, args, 0, 1);
    if (args[0] === undefined) {
      return;
    }
    const request = assertRecord(channel, args[0]);
    if (request.petId !== undefined) {
      assertPetId(channel, request.petId);
    }
    if (request.requestId !== undefined) {
      assertRequestId(channel, request.requestId);
    }
    assertOptionalString(channel, request.streamId, "streamId", 128, { pattern: requestIdPattern });
    assertSafePayload(channel, request, { maxStringLength: 128, maxTotalStringLength: 384 });
    return;
  }

  if (channel === "speech-to-text:transcribe") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    if (request.petId !== undefined) {
      assertPetId(channel, request.petId);
    }
    if (
      request.format !== "wav" &&
      request.format !== "pcm" &&
      request.format !== "mp3" &&
      request.format !== "m4a" &&
      request.format !== "ogg-opus" &&
      request.format !== "aac" &&
      request.format !== "amr"
    ) {
      fail(channel, "format 不是受支持的音频格式。");
    }
    assertString(channel, request.audioBase64, "audioBase64", 24_000_000);
    assertSafePayload(channel, request, {
      maxStringLength: 24_000_000,
      maxTotalStringLength: 24_001_000
    });
    return;
  }

  if (channel === "text-to-speech:speak") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertPetId(channel, request.petId);
    assertRequestId(channel, request.requestId);
    assertOptionalString(channel, request.sessionId, "sessionId", 128, {
      pattern: requestIdPattern
    });
    assertString(channel, request.text, "text", 20_000);
    assertSafePayload(channel, request, { maxStringLength: 20_000, maxTotalStringLength: 21_000 });
    return;
  }

  if (channel === "text-to-speech:stop") {
    expectArgumentCount(channel, args, 0, 1);
    if (args[0] === undefined) {
      return;
    }
    const request = assertRecord(channel, args[0]);
    if (request.petId !== undefined) {
      assertPetId(channel, request.petId);
    }
    if (request.requestId !== undefined) {
      assertRequestId(channel, request.requestId);
    }
    assertOptionalString(channel, request.sessionId, "sessionId", 128, {
      pattern: requestIdPattern
    });
    assertSafePayload(channel, request, { maxStringLength: 128, maxTotalStringLength: 384 });
    return;
  }

  if (channel === "speech-stream:start") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertPetId(channel, request.petId);
    assertString(channel, request.sessionId, "sessionId", 128, { pattern: speechSessionIdPattern });
    return;
  }

  if (channel === "speech-stream:audio") {
    expectArgumentCount(channel, args, 1);
    const chunk = assertRecord(channel, args[0]);
    assertString(channel, chunk.sessionId, "sessionId", 128, { pattern: speechSessionIdPattern });
    if (!(chunk.audio instanceof ArrayBuffer) || chunk.audio.byteLength > 262_144) {
      fail(channel, "audio 必须是不超过 262144 字节的 ArrayBuffer。");
    }
    return;
  }

  if (channel === "speech-stream:stop") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertString(channel, request.sessionId, "sessionId", 128, { pattern: speechSessionIdPattern });
    return;
  }

  if (channel === "pet-window:show") {
    expectArgumentCount(channel, args, 1);
    const payload = assertRecord(channel, args[0]);
    assertPetId(channel, payload.id, "id");
    assertString(channel, payload.name, "name", 128);
    assertString(channel, payload.modelPath, "modelPath", 32_768);
    assertOptionalString(channel, payload.avatar, "avatar", 2_000_000);
    assertSafePayload(channel, payload, {
      maxArrayLength: 4096,
      maxStringLength: 2_000_000,
      maxTotalStringLength: 4_000_000,
      maxNodes: 40_000
    });
    return;
  }

  if (channel === "pet-window:preview-source") {
    expectArgumentCount(channel, args, 1);
    const request = assertRecord(channel, args[0]);
    assertPetId(channel, request.petId);
    const source = assertRecord(channel, request.source, "source");
    if (source.sourceKind !== "motion" && source.sourceKind !== "expression") {
      fail(channel, "sourceKind 无效。");
    }
    assertString(channel, source.sourceFileName, "sourceFileName", 1024);
    if (typeof source.runtimeName !== "string" && typeof source.runtimeName !== "number") {
      fail(channel, "runtimeName 必须是字符串或数字。");
    }
    if (typeof source.runtimeName === "string") {
      assertString(channel, source.runtimeName, "runtimeName", 1024);
    } else if (!Number.isFinite(source.runtimeName)) {
      fail(channel, "runtimeName 必须是有限数字。");
    }
    assertSafePayload(channel, request, { maxStringLength: 1024, maxTotalStringLength: 4096 });
    return;
  }

  if (channel === "pet-window:complete-source-preview") {
    expectArgumentCount(channel, args, 1);
    if (typeof args[0] !== "number" || !Number.isSafeInteger(args[0]) || args[0] < 1) {
      fail(channel, "previewId 无效。");
    }
    return;
  }

  if (channel === "pet-window:close") {
    expectArgumentCount(channel, args, 0, 1);
    if (args[0] === undefined) {
      return;
    }
    const options = assertRecord(channel, args[0]);
    if (options.playEffect !== undefined && typeof options.playEffect !== "boolean") {
      fail(channel, "playEffect 必须是布尔值。");
    }
    return;
  }

  if (
    channel === "pet-window:set-click-through" ||
    channel === "pet-window:set-click-through-control-interactive"
  ) {
    expectArgumentCount(channel, args, 1);
    if (typeof args[0] !== "boolean") {
      fail(channel, "参数必须是布尔值。");
    }
    return;
  }

  if (channel === "pet-window:start-drag" || channel === "pet-window:move-drag") {
    expectArgumentCount(channel, args, 1);
    const point = assertRecord(channel, args[0]);
    if (
      typeof point.x !== "number" ||
      !Number.isFinite(point.x) ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.y) ||
      Math.abs(point.x) > 1_000_000 ||
      Math.abs(point.y) > 1_000_000
    ) {
      fail(channel, "拖拽坐标无效。");
    }
    return;
  }

  fail(channel, "没有注册运行时 schema。");
}
