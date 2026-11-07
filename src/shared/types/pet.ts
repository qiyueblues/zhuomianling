import type { MemorySettings } from "./memory";
import type { PetMoodRangeId } from "../mood";
import type { ScreenAwarenessMode } from "./screen";

export interface PetCapabilities {
  chat: boolean;
  voiceInput?: boolean;
  voiceOutput: boolean;
  subtitles: boolean;
}

export interface PetFeature {
  title: string;
  description: string;
  status: "ready" | "planned";
}

export interface PetDetails {
  role: string;
  personality: string;
  scenes: string[];
  features: PetFeature[];
}

export type PetSubtitleTone = "soft" | "bright" | "calm";

export type BasePetLineEvent =
  | "ready"
  | "click"
  | "chatOpen"
  | "chatClose"
  | "userMessage"
  | "aiReply"
  | "idle"
  | "drag"
  | "rapidClick"
  | "clickThroughOn"
  | "clickThroughOff"
  | "closing"
  | "modelError";

export type PetLineEvent = BasePetLineEvent | (string & {});

export interface PetPresetAudio {
  schemaVersion: 1;
  resourceId: string;
  sourceTextHash: string;
  spokenText: string;
  language: PetVoiceLanguage;
  mimeType: string;
  durationMs?: number;
  voiceFingerprint: string;
  /** Present when spokenText was produced by persona-aware localization. */
  personaFingerprint?: string;
  requestedMoodRange?: PetMoodRangeId;
  resolvedMoodRange?: PetMoodRangeId;
  generatedAt: number;
}

export interface PetPresetLine {
  /** Stable local identifier assigned when a legacy string line is first persisted as an object. */
  id?: string;
  text: string;
  presetAudio?: PetPresetAudio;
  /** Legacy field retained for read compatibility. New preset audio never stores a path here. */
  audioPath?: string;
}
export type PetLine = string | PetPresetLine;
export type PetLineMap = Partial<Record<PetLineEvent, PetLine[]>>;

export interface PetEventSettings {
  expression?: PetExpressionKey;
  expressionDurationMs?: number;
  source?: PetExpressionSourceItem;
  sourceDurationMs?: number;
  /** Defaults to true. When false, event lines may still play preset audio without showing a subtitle bubble. */
  showSubtitle?: boolean;
  [key: string]: unknown;
}

export type PetEventSettingsMap = Partial<Record<PetLineEvent, PetEventSettings>>;

export interface PetSubtitleStyle {
  tone: PetSubtitleTone;
  maxWidth?: number;
}

export type BasePetExpressionKey =
  | "happy"
  | "nervous"
  | "normal"
  | "panic"
  | "focus"
  | "awake"
  | "offline"
  | "shy"
  | "ready"
  | "melt"
  | "impact"
  | "crying";

export type PetExpressionKey = BasePetExpressionKey | (string & {});
export type PetExpressionMap = Partial<Record<PetExpressionKey, string | number>>;
export type PetExpressionDescriptionMap = Partial<Record<PetExpressionKey, string>>;
export type PetExpressionSourceKind = "expression" | "motion";
export type PetExpressionSourceKindMap = Partial<Record<PetExpressionKey, PetExpressionSourceKind>>;
export type PetExpressionSourceFileMap = Partial<Record<PetExpressionKey, string>>;

export interface PetExpressionSourceItem {
  sourceFileName: string;
  runtimeName?: string | number;
  sourceKind: PetExpressionSourceKind;
  description?: string;
  effects?: PetExpressionEffect;
}

export interface PetExpressionParameterEffect {
  id: string;
  value: number;
}

export interface PetExpressionPartOpacityEffect {
  idOrIndex: string | number;
  opacity: number;
}

export interface PetExpressionEffect {
  parameters?: PetExpressionParameterEffect[];
  parts?: PetExpressionPartOpacityEffect[];
}

export type PetExpressionEffectMap = Partial<Record<PetExpressionKey, PetExpressionEffect>>;
export type PetChatLanguage = "zh" | "ja" | "en";
export type PetReplyLength = "short" | "medium" | "long";
export type PetVoiceLanguage = "zh" | "ja" | "en";
export type PetVoiceReplyMode = "sentence";
export type PetVoiceInferenceDevice = "auto" | "cuda" | "cpu";
export type PetVoiceInputSilenceSeconds = number;
export type BuiltInPetUiTheme = "soft" | "rock" | "pixel" | "journal" | "cyber" | "minimal";
export type PetUiTheme = BuiltInPetUiTheme | "custom";
export type PetMoodMeterEffectStyle = "halo" | "lightning" | "pixel" | "ink" | "scan" | "minimal";
export type PetMoodMeterFrame = "soft-pill" | "rounded" | "sharp" | "pixel" | "cut-corner";
export type PetMoodMeterParticleStyle = "float" | "dust" | "pixel" | "scan" | "minimal";
export type PetExpressionSelectionMode = "semantic" | "random";
export type PetExpressionRandomScope = PetExpressionSourceKind | "all";

export const petChatDecorationSlots = [
  "header-left",
  "header-right",
  "frame-top-right",
  "body-watermark"
] as const;

export const petChatDecorationIcons = [
  "audio-waveform", "binary", "blocks", "box", "circle",
  "circle-dashed", "circuit-board", "citrus", "cpu", "feather",
  "flower-2", "gamepad-2", "guitar", "heart", "joystick", "leaf", "minus",
  "music-2", "notebook-pen", "scan-line", "sparkles",
  "square", "star", "zap"
] as const;

export type PetChatDecorationSlot = (typeof petChatDecorationSlots)[number];
export type PetChatDecorationIcon = (typeof petChatDecorationIcons)[number];
export type PetChatDecorations = Partial<Record<PetChatDecorationSlot, PetChatDecorationIcon>>;

export const petRadialMenuActionKinds = [
  "passThrough",
  "touch",
  "chat",
  "mood",
  "danger",
  "vision"
] as const;

export type PetRadialMenuActionKind = (typeof petRadialMenuActionKinds)[number];

export interface PetCustomThemeRadialMenuAction {
  surface: string;
  text: string;
  border?: string;
}

export interface PetCustomThemeRadialMenu {
  radius?: number;
  surface: string;
  text: string;
  border: string;
  shadow?: string;
  activeBorder?: string;
  center: PetCustomThemeRadialMenuAction;
  actions: Record<PetRadialMenuActionKind, PetCustomThemeRadialMenuAction>;
}

export interface PetCustomThemeMoodRangeStyle {
  frameOpacity: number;
  glowOpacity: number;
  glowRadius: number;
  liquidOpacity: number;
  boundaryWidth: number;
  waveAmplitude: number;
  particleOpacity: number;
  auraOpacity: number;
  accentOpacity: number;
  animationSeconds: number;
}

export interface PetCustomThemeMoodMeter {
  upColor: string;
  downColor: string;
  calmColor?: string;
  surface?: string;
  emptyColor?: string;
  textColor?: string;
  frameColor?: string;
  boundaryColor?: string;
  particleColor?: string;
  shadow?: string;
  insetShadow?: string;
  frame: PetMoodMeterFrame;
  particleStyle: PetMoodMeterParticleStyle;
  effectStyle: PetMoodMeterEffectStyle;
  ranges: Record<PetMoodRangeId, PetCustomThemeMoodRangeStyle>;
}

export interface PetCustomThemeTokens {
  background: string;
  surface: string;
  petSurface?: string;
  headerSurface?: string;
  headerText?: string;
  inputSurface?: string;
  userSurface?: string;
  text: string;
  mutedText: string;
  accent: string;
  accentStrong?: string;
  decorationPrimary?: string;
  decorationSecondary?: string;
  watermarkColor?: string;
  border: string;
  danger?: string;
  shadow?: string;
  radius?: number;
}

export interface PetCustomTheme {
  id: string;
  name: string;
  description: string;
  version: number;
  author?: string;
  importedAt?: string;
  tokens: PetCustomThemeTokens;
  chatDecorations?: PetChatDecorations;
  radialMenu?: PetCustomThemeRadialMenu;
  moodMeter?: PetCustomThemeMoodMeter;
}

export interface PetCustomThemeImportResult {
  ok: boolean;
  message: string;
  canceled?: boolean;
  theme?: PetCustomTheme;
}

export interface PetPersonaSettings {
  chatLanguage: PetChatLanguage;
  replyLength?: PetReplyLength;
}

export interface PetVoiceInputSettings {
  provider: "tencent-asr";
  hasCredentials: boolean;
  connected: boolean;
  autoEndEnabled: boolean;
  silenceSeconds: PetVoiceInputSilenceSeconds;
  volumeThreshold: number;
  continuousConversationEnabled: boolean;
}

export const petVoiceModelVersions = [
  "v1",
  "v2",
  "v3",
  "v4",
  "v2Pro",
  "v2ProPlus",
  "v5dev",
  "v5turbo"
] as const;

export type PetVoiceModelVersion = (typeof petVoiceModelVersions)[number];

export const defaultPetVoiceModelVersion: PetVoiceModelVersion = "v2ProPlus";

export interface PetVoiceModelSettings {
  enabled: boolean;
  connected: boolean;
  modelVersion?: PetVoiceModelVersion;
  gptSoVitsRootPath?: string;
  sovitsModelPath?: string;
  gptModelPath?: string;
  referenceAudioPath?: string;
  referenceText: string;
  referenceLanguage?: PetVoiceLanguage;
  language: PetVoiceLanguage;
  playMode: PetVoiceReplyMode;
  inferenceDevice?: PetVoiceInferenceDevice;
  halfPrecision?: boolean;
  syncTextWithVoice?: boolean;
}

export interface PetMoodVoiceOverride {
  referenceAudio: string;
  referenceText: string;
}

export interface PetMoodRangeSettings {
  enterSource?: PetExpressionSourceItem;
  /** 在进入此心情区间时显示的桌宠专属字幕。 */
  enterLine?: PetLine;
  voiceOverride?: PetMoodVoiceOverride;
}

export interface PetMoodSettings {
  ranges?: Partial<Record<PetMoodRangeId, PetMoodRangeSettings>>;
}

export interface PetLive2DSettings {
  format?: "cubism2" | "cubism4-5";
  entryFileName?: string;
  textureCount: number;
  motionCount: number;
  expressionCount: number;
}

export interface PetDesktopPosition {
  x: number;
  y: number;
}

export interface PetUiSettings {
  theme: PetUiTheme;
  customTheme?: PetCustomTheme;
  clickThroughOpacity?: number;
  cursorFollowEnabled?: boolean;
  desktopScale?: number;
  desktopPosition?: PetDesktopPosition;
}

export interface ScreenAwarenessSettings {
  enabled: boolean;
  mode?: ScreenAwarenessMode;
  persistentCaptureEnabled?: boolean;
}

export interface PetDefinition {
  id: string;
  name: string;
  description: string;
  modelPath: string;
  avatar?: string;
  avatarImage?: string;
  personaPrompt: string;
  defaultVoice?: string;
  personaSettings?: PetPersonaSettings;
  voiceInputSettings?: PetVoiceInputSettings;
  voiceModelSettings?: PetVoiceModelSettings;
  live2dSettings?: PetLive2DSettings;
  uiSettings?: PetUiSettings;
  memorySettings?: MemorySettings;
  screenAwarenessSettings?: ScreenAwarenessSettings;
  moodSettings?: PetMoodSettings;
  capabilities: PetCapabilities;
  details: PetDetails;
  expressions?: PetExpressionMap;
  expressionDescriptions?: PetExpressionDescriptionMap;
  expressionSelectionMode?: PetExpressionSelectionMode;
  expressionRandomScope?: PetExpressionRandomScope;
  expressionSourceKinds?: PetExpressionSourceKindMap;
  expressionSourceFiles?: PetExpressionSourceFileMap;
  expressionSources?: PetExpressionSourceItem[];
  expressionEffects?: PetExpressionEffectMap;
  eventSettings?: PetEventSettingsMap;
  lines?: PetLineMap;
  subtitleStyle?: PetSubtitleStyle;
  isLocal?: boolean;
}

export interface LocalPetBasicInfoDraft {
  id?: string;
  name: string;
  avatarImage?: string;
  description: string;
  role: string;
  personality: string;
  scenes: string[];
}

export interface LocalPetPersonaDraft {
  petId: string;
  personaPrompt: string;
  chatLanguage: PetChatLanguage;
  replyLength?: PetReplyLength;
}

export interface LocalPetExpressionMappingItem {
  sourceFileName: string;
  runtimeName?: string | number;
  sourceKind: PetExpressionSourceKind;
  mappingKey: string;
  description: string;
  effects?: PetExpressionEffect;
}

export interface LocalPetExpressionMappingDraft {
  petId: string;
  mappings: LocalPetExpressionMappingItem[];
  sources?: PetExpressionSourceItem[];
  expressionSelectionMode?: PetExpressionSelectionMode;
  expressionRandomScope?: PetExpressionRandomScope;
}

export interface LocalPetEventSettingsItem extends PetEventSettings {
  event: PetLineEvent;
  lines: PetLine[];
}

export interface LocalPetEventSettingsDraft {
  petId: string;
  events: LocalPetEventSettingsItem[];
}

export interface LocalPetUiSettingsDraft {
  petId: string;
  theme: PetUiTheme;
  customTheme?: PetCustomTheme;
  /** 仅由编辑器的显式“删除导入主题”操作设置。 */
  removeCustomTheme?: boolean;
  clickThroughOpacity?: number;
  cursorFollowEnabled?: boolean;
  desktopScale?: number;
}

export interface LocalPetScreenAwarenessDraft {
  petId: string;
  enabled: boolean;
  mode?: ScreenAwarenessMode;
  persistentCaptureEnabled?: boolean;
}

export interface LocalPetVoiceInputDraft {
  petId: string;
  appId: string;
  secretId: string;
  secretKey: string;
  connected: boolean;
  autoEndEnabled: boolean;
  silenceSeconds: PetVoiceInputSilenceSeconds;
  volumeThreshold: number;
  continuousConversationEnabled: boolean;
}

export type LocalPetVoiceResourceKind = "sovits" | "gpt" | "referenceAudio";

export interface LocalPetVoiceModelDraft {
  petId: string;
  enabled: boolean;
  connected: boolean;
  modelVersion: PetVoiceModelVersion;
  gptSoVitsRootPath?: string;
  sovitsModelPath?: string;
  gptModelPath?: string;
  referenceAudioPath?: string;
  referenceText: string;
  referenceLanguage: PetVoiceLanguage;
  language: PetVoiceLanguage;
  playMode: PetVoiceReplyMode;
  inferenceDevice: PetVoiceInferenceDevice;
  halfPrecision: boolean;
  syncTextWithVoice: boolean;
}

export interface LocalPetVoiceModelFilePickResult {
  ok: boolean;
  message: string;
  filePath?: string;
  fileName?: string;
}

export interface LocalPetVoiceModelConnectionResult {
  ok: boolean;
  message: string;
}

export interface LocalPetSaveResult {
  ok: boolean;
  message: string;
  pet?: PetDefinition;
}

export interface LocalPetAvatarImportResult {
  ok: boolean;
  message: string;
  avatarImage?: string;
  sourceImage?: string;
}

export interface LocalPetAvatarCropSaveRequest {
  petId?: string;
  dataUrl: string;
}

export interface LocalPetDeleteResult {
  ok: boolean;
  message: string;
  petId: string;
}

export interface LocalPetConfigCorruption {
  code: "PET_CONFIG_CORRUPTED";
  petId: string;
  backupAvailable: boolean;
  message: string;
}

export interface LocalPetListResult {
  ok: boolean;
  pets: PetDefinition[];
  corruption?: LocalPetConfigCorruption;
}
