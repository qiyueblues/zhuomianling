import { describe, expect, it } from "vitest";
import type { PetDefinition } from "../types/pet";
import { normalizeLegacyPetDefinition, normalizePetMoodSettings } from "./petDefinition";

function legacyPet(overrides: Record<string, unknown> = {}): PetDefinition {
  return {
    id: "legacy-pet",
    name: "旧桌宠",
    ...overrides
  } as unknown as PetDefinition;
}

describe("旧版桌宠配置兼容", () => {
  it("只接受已知版本并且仅在内存中补齐旧配置版本", () => {
    const original = legacyPet();
    expect(normalizeLegacyPetDefinition(original).schemaVersion).toBe(1);
    expect(original).not.toHaveProperty("schemaVersion");
    expect(normalizeLegacyPetDefinition(legacyPet({ schemaVersion: 1 })).schemaVersion).toBe(1);
    expect(() => normalizeLegacyPetDefinition(legacyPet({ schemaVersion: 2 })))
      .toThrow(/更新版本/);
    for (const schemaVersion of [0, -1, "1", null, 1.5]) {
      expect(() => normalizeLegacyPetDefinition(legacyPet({ schemaVersion }))).toThrow(/版本无效/);
    }
  });
  it("为旧配置缺失的运行时字段提供内存默认值", () => {
    const original = legacyPet({
      details: { scenarios: ["学习"] },
      voiceModelSettings: {
        enabled: true,
        connected: false,
        referenceAudioPath: "reference.wav"
      }
    });

    const normalized = normalizeLegacyPetDefinition(original);

    expect(normalized).toMatchObject({
      modelPath: "",
      personaPrompt: "",
      capabilities: {
        chat: false,
        voiceInput: false,
        voiceOutput: false,
        subtitles: true
      },
      details: {
        role: "",
        personality: "",
        scenes: ["学习"],
        features: []
      },
      voiceModelSettings: {
        referenceAudioPath: "reference.wav",
        referenceText: "",
        modelVersion: "v2ProPlus",
        language: "zh",
        referenceLanguage: "zh",
        playMode: "sentence"
      },
      uiSettings: {
        theme: "soft",
        cursorFollowEnabled: true,
        desktopScale: 1
      }
    });
    expect((original.voiceModelSettings as unknown as { referenceText?: string }).referenceText)
      .toBeUndefined();
  });

  it("保留有效声音模型版本并收敛无效旧值", () => {
    const v4Pet = normalizeLegacyPetDefinition(legacyPet({
      voiceModelSettings: {
        enabled: false,
        connected: false,
        modelVersion: "v4"
      }
    }));
    const invalidPet = normalizeLegacyPetDefinition(legacyPet({
      voiceModelSettings: {
        enabled: false,
        connected: false,
        modelVersion: "future"
      }
    }));

    expect(v4Pet.voiceModelSettings?.modelVersion).toBe("v4");
    expect(invalidPet.voiceModelSettings?.modelVersion).toBe("v2ProPlus");
  });

  it.each(["v5dev", "v5turbo"])("保留 %s 声音配置而不回退为旧版本", (modelVersion) => {
    const normalized = normalizeLegacyPetDefinition(legacyPet({
      voiceModelSettings: { enabled: false, connected: false, modelVersion }
    }));

    expect(normalized.voiceModelSettings?.modelVersion).toBe(modelVersion);
  });

  it("保留旧配置中已经存在的有效用户设置", () => {
    const normalized = normalizeLegacyPetDefinition(legacyPet({
      modelPath: "pet-resource://local/legacy-pet/live2d/model.model3.json",
      capabilities: { chat: true, voiceOutput: true, subtitles: false },
      details: { role: "助手", personality: "安静", scenes: [], features: [] },
      uiSettings: {
        theme: "journal",
        cursorFollowEnabled: false,
        desktopScale: 1.25,
        desktopPosition: { x: -830.4, y: 940.6 }
      }
    }));

    expect(normalized.modelPath).toContain("model.model3.json");
    expect(normalized.capabilities).toMatchObject({ chat: true, voiceOutput: true, subtitles: false });
    expect(normalized.details).toMatchObject({ role: "助手", personality: "安静" });
    expect(normalized.uiSettings).toMatchObject({
      theme: "journal",
      cursorFollowEnabled: false,
      desktopScale: 1.25,
      desktopPosition: { x: -830, y: 941 }
    });
  });

  it("保留事件气泡开关并拒绝错误类型", () => {
    const normalized = normalizeLegacyPetDefinition(legacyPet({
      eventSettings: {
        click: { showSubtitle: false }
      }
    }));

    expect(normalized.eventSettings?.click?.showSubtitle).toBe(false);
    expect(() => normalizeLegacyPetDefinition(legacyPet({
      eventSettings: {
        click: { showSubtitle: "false" }
      }
    }))).toThrow(/eventSettings\.click\.showSubtitle/);
  });

  it("把桌宠整体比例限制到受支持范围并对齐到五个百分点", () => {
    expect(normalizeLegacyPetDefinition(legacyPet({
      uiSettings: { theme: "soft", desktopScale: 2.5 }
    })).uiSettings?.desktopScale).toBe(1.5);
    expect(normalizeLegacyPetDefinition(legacyPet({
      uiSettings: { theme: "soft", desktopScale: 0.2 }
    })).uiSettings?.desktopScale).toBe(0.7);
    expect(normalizeLegacyPetDefinition(legacyPet({
      uiSettings: { theme: "soft", desktopScale: 0.73 }
    })).uiSettings?.desktopScale).toBe(0.75);
    expect(normalizeLegacyPetDefinition(legacyPet({
      uiSettings: { theme: "soft", desktopScale: "invalid" }
    })).uiSettings?.desktopScale).toBe(1);
  });

  it("丢弃无效或过大的历史桌面位置", () => {
    expect(normalizeLegacyPetDefinition(legacyPet({
      uiSettings: { theme: "soft", desktopPosition: { x: Number.NaN, y: 100 } }
    })).uiSettings?.desktopPosition).toBeUndefined();
    expect(normalizeLegacyPetDefinition(legacyPet({
      uiSettings: { theme: "soft", desktopPosition: { x: 10_000_001, y: 100 } }
    })).uiSettings?.desktopPosition).toBeUndefined();
  });

  it("把已有但类型错误的关键结构交给损坏配置流程处理", () => {
    expect(() => normalizeLegacyPetDefinition(legacyPet({ details: "invalid" })))
      .toThrow("details");
  });

  it("保留进入心情区间时的专属台词，并拒绝空白或超长文本", () => {
    expect(normalizePetMoodSettings({
      ranges: { calm: { enterLine: "  我会慢慢平静下来的。  " } }
    })).toEqual({ ranges: { calm: { enterLine: "我会慢慢平静下来的。" } } });
    expect(() => normalizePetMoodSettings({ ranges: { calm: { enterLine: "   " } } }))
      .toThrow("心情进入台词");
    expect(() => normalizePetMoodSettings({ ranges: { calm: { enterLine: "x".repeat(301) } } }))
      .toThrow("心情进入台词");
  });
});
