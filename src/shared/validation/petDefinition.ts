import type {
  PetDefinition,
  PetLine,
  PetPresetAudio,
  PetMoodSettings,
  PetVoiceLanguage,
  PetVoiceModelSettings
} from "../types/pet";
import { isPetMoodRangeId } from "../mood";
import { normalizePetVoiceModelVersion } from "./petVoiceModel";
import { normalizePetDesktopPosition, normalizePetDesktopScale } from "./petUiSettings";
import { assertSupportedConfigVersion } from "./configVersion";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordOrEmpty(value: unknown, fieldName: string): UnknownRecord {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error(`桌宠配置字段 ${fieldName} 的类型无效。`);
  }

  return value;
}

function stringOrDefault(value: unknown, fallback: string, fieldName: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new Error(`桌宠配置字段 ${fieldName} 的类型无效。`);
  }

  return value;
}

function booleanOrDefault(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`桌宠配置字段 ${fieldName} 的类型无效。`);
  }

  return value;
}

const presetLineIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const presetResourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function normalizePresetAudio(value: unknown, fieldName: string): PetPresetAudio | undefined {
  if (value === undefined || value === null) return undefined;
  const audio = recordOrEmpty(value, fieldName);
  const resourceId = stringOrDefault(audio.resourceId, "", `${fieldName}.resourceId`).trim();
  const sourceTextHash = stringOrDefault(audio.sourceTextHash, "", `${fieldName}.sourceTextHash`).trim();
  const spokenText = stringOrDefault(audio.spokenText, "", `${fieldName}.spokenText`).trim();
  const voiceFingerprint = stringOrDefault(audio.voiceFingerprint, "", `${fieldName}.voiceFingerprint`).trim();
  const personaFingerprint = audio.personaFingerprint === undefined
    ? undefined
    : stringOrDefault(audio.personaFingerprint, "", `${fieldName}.personaFingerprint`).trim();
  const mimeType = stringOrDefault(audio.mimeType, "", `${fieldName}.mimeType`).trim().toLowerCase();
  const language = String(audio.language);
  const generatedAt = Number(audio.generatedAt);
  const durationMs = audio.durationMs === undefined ? undefined : Number(audio.durationMs);

  if (
    audio.schemaVersion !== 1 ||
    !presetResourceIdPattern.test(resourceId) ||
    !sha256Pattern.test(sourceTextHash) ||
    !spokenText || spokenText.length > 2_000 ||
    !["zh", "ja", "en"].includes(language) ||
    !/^audio\/[a-z0-9.+-]{1,64}$/.test(mimeType) ||
    !sha256Pattern.test(voiceFingerprint) ||
    (personaFingerprint !== undefined && !sha256Pattern.test(personaFingerprint)) ||
    !Number.isSafeInteger(generatedAt) || generatedAt <= 0 ||
    (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 30 * 60_000)) ||
    (audio.requestedMoodRange !== undefined && !isPetMoodRangeId(audio.requestedMoodRange)) ||
    (audio.resolvedMoodRange !== undefined && !isPetMoodRangeId(audio.resolvedMoodRange))
  ) {
    throw new Error(`${fieldName} 的预设语音元数据无效。`);
  }

  return {
    schemaVersion: 1,
    resourceId,
    sourceTextHash,
    spokenText,
    language: language as PetPresetAudio["language"],
    mimeType,
    ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs) }),
    voiceFingerprint,
    ...(personaFingerprint === undefined ? {} : { personaFingerprint }),
    ...(audio.requestedMoodRange === undefined ? {} : { requestedMoodRange: audio.requestedMoodRange }),
    ...(audio.resolvedMoodRange === undefined ? {} : { resolvedMoodRange: audio.resolvedMoodRange }),
    generatedAt
  };
}

export function normalizePetLineValue(
  value: unknown,
  fieldName: string,
  maxTextLength = 2_000
): PetLine {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > maxTextLength) throw new Error(`${fieldName} 的台词无效。`);
    return text;
  }

  const line = recordOrEmpty(value, fieldName);
  const text = stringOrDefault(line.text, "", `${fieldName}.text`).trim();
  const id = line.id === undefined ? undefined : stringOrDefault(line.id, "", `${fieldName}.id`).trim();
  const audioPath = line.audioPath === undefined
    ? undefined
    : stringOrDefault(line.audioPath, "", `${fieldName}.audioPath`).trim();

  if (
    !text || text.length > maxTextLength ||
    (id !== undefined && !presetLineIdPattern.test(id)) ||
    (audioPath !== undefined && (!audioPath || audioPath.length > 2_048 || audioPath.includes("\0")))
  ) {
    throw new Error(`${fieldName} 的台词无效。`);
  }

  const presetAudio = normalizePresetAudio(line.presetAudio, `${fieldName}.presetAudio`);

  return {
    ...(id === undefined ? {} : { id }),
    text,
    ...(presetAudio ? { presetAudio } : {}),
    ...(audioPath === undefined ? {} : { audioPath })
  };
}

function stringArrayOrDefault(value: unknown, fallback: string[], fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [...fallback];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`桌宠配置字段 ${fieldName} 的类型无效。`);
  }

  return [...value];
}

function normalizePetEventSettings(value: unknown): PetDefinition["eventSettings"] {
  if (value === undefined || value === null) {
    return undefined;
  }

  const settings = recordOrEmpty(value, "eventSettings");

  return Object.fromEntries(
    Object.entries(settings).map(([eventName, rawSettings]) => {
      if (!eventName.trim() || eventName.length > 128) {
        throw new Error(`桌宠配置字段 eventSettings.${eventName} 的类型无效。`);
      }

      const eventSettings = recordOrEmpty(rawSettings, `eventSettings.${eventName}`);

      return [
        eventName,
        {
          ...eventSettings,
          ...(eventSettings.showSubtitle === undefined
            ? {}
            : {
                showSubtitle: booleanOrDefault(
                  eventSettings.showSubtitle,
                  true,
                  `eventSettings.${eventName}.showSubtitle`
                )
              })
        }
      ];
    })
  ) as NonNullable<PetDefinition["eventSettings"]>;
}

function normalizeVoiceModelSettings(value: unknown): PetVoiceModelSettings | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const settings = recordOrEmpty(value, "voiceModelSettings");
  const language = ["zh", "ja", "en"].includes(String(settings.language))
    ? settings.language as PetVoiceLanguage
    : "zh";

  return {
    ...settings,
    enabled: booleanOrDefault(settings.enabled, false, "voiceModelSettings.enabled"),
    connected: booleanOrDefault(settings.connected, false, "voiceModelSettings.connected"),
    modelVersion: normalizePetVoiceModelVersion(settings.modelVersion),
    gptSoVitsRootPath: stringOrDefault(
      settings.gptSoVitsRootPath,
      "",
      "voiceModelSettings.gptSoVitsRootPath"
    ),
    sovitsModelPath: stringOrDefault(
      settings.sovitsModelPath,
      "",
      "voiceModelSettings.sovitsModelPath"
    ),
    gptModelPath: stringOrDefault(
      settings.gptModelPath,
      "",
      "voiceModelSettings.gptModelPath"
    ),
    referenceAudioPath: stringOrDefault(
      settings.referenceAudioPath,
      "",
      "voiceModelSettings.referenceAudioPath"
    ),
    referenceText: stringOrDefault(
      settings.referenceText,
      "",
      "voiceModelSettings.referenceText"
    ),
    referenceLanguage: ["zh", "ja", "en"].includes(String(settings.referenceLanguage))
      ? settings.referenceLanguage as PetVoiceLanguage
      : language,
    language,
    playMode: "sentence",
    inferenceDevice: ["auto", "cuda", "cpu"].includes(String(settings.inferenceDevice))
      ? settings.inferenceDevice as PetVoiceModelSettings["inferenceDevice"]
      : "auto",
    halfPrecision: booleanOrDefault(
      settings.halfPrecision,
      true,
      "voiceModelSettings.halfPrecision"
    ),
    syncTextWithVoice: booleanOrDefault(
      settings.syncTextWithVoice,
      true,
      "voiceModelSettings.syncTextWithVoice"
    )
  } as PetVoiceModelSettings;
}

export function normalizePetMoodSettings(value: unknown): PetMoodSettings | undefined {
  if (value === undefined || value === null) return undefined;
  const settings = recordOrEmpty(value, "moodSettings");
  const rawRanges = recordOrEmpty(settings.ranges, "moodSettings.ranges");
  const ranges: NonNullable<PetMoodSettings["ranges"]> = {};

  for (const [rangeId, rawRange] of Object.entries(rawRanges)) {
    if (!isPetMoodRangeId(rangeId)) throw new Error(`未知的心情区间 ${rangeId}。`);
    const range = recordOrEmpty(rawRange, `moodSettings.ranges.${rangeId}`);
    const normalized: NonNullable<PetMoodSettings["ranges"]>[typeof rangeId] = {};
    if (range.enterSource !== undefined) {
      const source = recordOrEmpty(range.enterSource, `moodSettings.ranges.${rangeId}.enterSource`);
      const fileName = stringOrDefault(source.sourceFileName, "", "enterSource.sourceFileName").trim();
      if (!fileName || fileName.length > 255 || /[\\/\0]/.test(fileName) || !["motion", "expression"].includes(String(source.sourceKind))) {
        throw new Error("心情进入表现源无效。");
      }
      normalized.enterSource = {
        sourceFileName: fileName,
        sourceKind: source.sourceKind as "motion" | "expression",
        ...(typeof source.runtimeName === "string" || typeof source.runtimeName === "number" ? { runtimeName: source.runtimeName } : {}),
        ...(typeof source.description === "string" && source.description.length <= 500 ? { description: source.description } : {})
      };
    }
    if (range.enterLine !== undefined) {
      try {
        normalized.enterLine = normalizePetLineValue(
          range.enterLine,
          `moodSettings.ranges.${rangeId}.enterLine`,
          300
        );
      } catch {
        throw new Error("心情进入台词无效。");
      }
    }
    if (range.voiceOverride !== undefined) {
      const voice = recordOrEmpty(range.voiceOverride, `moodSettings.ranges.${rangeId}.voiceOverride`);
      const referenceAudio = stringOrDefault(voice.referenceAudio, "", "voiceOverride.referenceAudio").trim();
      const referenceText = stringOrDefault(voice.referenceText, "", "voiceOverride.referenceText").trim();
      if (!referenceAudio || referenceAudio.length > 255 || /[\\/\0:]/.test(referenceAudio) || !referenceText || referenceText.length > 500) {
        throw new Error("心情区间语音配置无效。");
      }
      normalized.voiceOverride = { referenceAudio, referenceText };
    }
    if (normalized.enterSource || normalized.enterLine || normalized.voiceOverride) ranges[rangeId] = normalized;
  }
  return Object.keys(ranges).length ? { ranges } : {};
}

/**
 * 将历史版本中尚未存在的字段补成当前运行时默认值。
 * 该函数只返回内存副本；读取旧配置本身不会触发磁盘写入。
 */
export function normalizeLegacyPetDefinition(pet: PetDefinition): PetDefinition {
  const rawPet = pet as unknown as UnknownRecord;
  assertSupportedConfigVersion(rawPet.schemaVersion, 1);
  const capabilities = recordOrEmpty(rawPet.capabilities, "capabilities");
  const details = recordOrEmpty(rawPet.details, "details");
  const uiSettings = recordOrEmpty(rawPet.uiSettings, "uiSettings");
  const subtitleStyle = recordOrEmpty(rawPet.subtitleStyle, "subtitleStyle");
  const legacyScenes = details.scenes ?? details.scenarios;
  const rawLines = recordOrEmpty(rawPet.lines, "lines");
  const lines = Object.fromEntries(
    Object.entries(rawLines).map(([eventName, value]) => {
      if (!eventName.trim() || eventName.length > 128 || !Array.isArray(value) || value.length > 256) {
        throw new Error(`桌宠配置字段 lines.${eventName} 的类型无效。`);
      }
      return [eventName, value.map((line, index) => normalizePetLineValue(line, `lines.${eventName}.${index}`))];
    })
  ) as PetDefinition["lines"];

  return {
    ...pet,
    schemaVersion: 1,
    description: stringOrDefault(rawPet.description, "", "description"),
    modelPath: stringOrDefault(rawPet.modelPath, "", "modelPath"),
    personaPrompt: stringOrDefault(rawPet.personaPrompt, "", "personaPrompt"),
    capabilities: {
      ...capabilities,
      chat: booleanOrDefault(capabilities.chat, false, "capabilities.chat"),
      voiceInput: booleanOrDefault(
        capabilities.voiceInput,
        false,
        "capabilities.voiceInput"
      ),
      voiceOutput: booleanOrDefault(
        capabilities.voiceOutput,
        false,
        "capabilities.voiceOutput"
      ),
      subtitles: booleanOrDefault(capabilities.subtitles, true, "capabilities.subtitles")
    },
    details: {
      ...details,
      role: stringOrDefault(details.role, "", "details.role"),
      personality: stringOrDefault(details.personality, "", "details.personality"),
      scenes: stringArrayOrDefault(legacyScenes, [], "details.scenes"),
      features: Array.isArray(details.features) ? details.features : []
    },
    voiceModelSettings: normalizeVoiceModelSettings(rawPet.voiceModelSettings),
    lines,
    eventSettings: normalizePetEventSettings(rawPet.eventSettings),
    moodSettings: normalizePetMoodSettings(rawPet.moodSettings),
    uiSettings: {
      ...uiSettings,
      theme: typeof uiSettings.theme === "string" ? uiSettings.theme : "soft",
      clickThroughOpacity: typeof uiSettings.clickThroughOpacity === "number"
        ? uiSettings.clickThroughOpacity
        : 0.45,
      cursorFollowEnabled: booleanOrDefault(
        uiSettings.cursorFollowEnabled,
        true,
        "uiSettings.cursorFollowEnabled"
      ),
      desktopScale: normalizePetDesktopScale(uiSettings.desktopScale),
      desktopPosition: normalizePetDesktopPosition(uiSettings.desktopPosition)
    } as PetDefinition["uiSettings"],
    subtitleStyle: {
      ...subtitleStyle,
      tone: ["soft", "bright", "calm"].includes(String(subtitleStyle.tone))
        ? subtitleStyle.tone
        : "soft"
    } as PetDefinition["subtitleStyle"]
  };
}
