import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_AUTO_CAPTURE_CONSENT,
  MEMORY_LIMITS,
  MEMORY_SOURCE_EXPORT_CONSENT,
  MEMORY_SOURCE_RETENTION_CONSENT
} from "../types/memory";
import {
  assertMemoryExportRequest,
  assertMemoryObjectBudget,
  assertMemoryRecordInput,
  assertMemoryRetrieveResponse,
  assertMemorySettingsSaveRequest,
  assertMemorySourceConversationRequest,
  MemoryValidationError,
  normalizeMemoryPageRequest,
  normalizeMemorySettings
} from "./memory";

describe("memory settings validation", () => {
  it("treats a missing legacy setting as a fresh, fully disabled default", () => {
    const first = normalizeMemorySettings(undefined);
    const second = normalizeMemorySettings(undefined);

    expect(first).toEqual(DEFAULT_MEMORY_SETTINGS);
    expect(first.onboardingCompleted).toBe(false);
    expect(first.recallEnabled).toBe(false);
    expect(first.autoCaptureEnabled).toBe(false);
    expect(first.retainSources).toBe(false);
    expect(first).not.toBe(second);
  });

  it("accepts bounded partial settings and fills defaults", () => {
    expect(normalizeMemorySettings({ recallEnabled: true, recallLimit: 10 })).toEqual({
      ...DEFAULT_MEMORY_SETTINGS,
      onboardingCompleted: true,
      recallEnabled: true,
      recallLimit: 10
    });
  });

  it.each([
    { recallLimit: 0 },
    { recallLimit: 11 },
    { contextBudgetChars: 511 },
    { contextBudgetChars: 4097 },
    { onboardingCompleted: "yes" },
    { recallEnabled: "yes" },
    { providerProfileId: "x".repeat(MEMORY_LIMITS.providerProfileIdChars + 1) }
  ])("rejects an out-of-contract setting: %o", (settings) => {
    expect(() => normalizeMemorySettings(settings)).toThrow(MemoryValidationError);
  });

  it("normalizes and bounds cursor pagination", () => {
    expect(normalizeMemoryPageRequest({})).toEqual({
      pageSize: MEMORY_LIMITS.pageSizeDefault,
      cursor: undefined
    });
    expect(() => normalizeMemoryPageRequest({ pageSize: MEMORY_LIMITS.pageSizeMax + 1 })).toThrow(
      MemoryValidationError
    );
  });
});

describe("memory DTO validation", () => {
  it("accepts only bounded pet and memory IDs for a source conversation lookup", () => {
    expect(() => assertMemorySourceConversationRequest({
      petId: "pet-a",
      memoryId: "memory-1"
    })).not.toThrow();
    expect(() => assertMemorySourceConversationRequest({
      petId: "pet-a",
      memoryId: "x".repeat(MEMORY_LIMITS.idChars + 1)
    })).toThrow(MemoryValidationError);
  });
  it("accepts a bounded record and rejects cross-contract content", () => {
    const record = {
      id: "memory-1",
      petId: "pet-a",
      chapter: "about_you" as const,
      memoryType: "profile" as const,
      content: "Likes tea",
      origin: "manual" as const
    };
    expect(() => assertMemoryRecordInput(record)).not.toThrow();
    expect(() =>
      assertMemoryRecordInput({
        ...record,
        content: "x".repeat(MEMORY_LIMITS.contentChars + 1)
      })
    ).toThrow(MemoryValidationError);
  });

  it("enforces the shared serialized object budget", () => {
    expect(() => assertMemoryObjectBudget({ value: "small" })).not.toThrow();
    expect(() =>
      assertMemoryObjectBudget({ value: "x".repeat(MEMORY_LIMITS.objectBudgetBytes) })
    ).toThrow(MemoryValidationError);
  });

  it("requires explicit consent tokens for automatic capture, source retention, and source export", () => {
    const settings = {
      ...DEFAULT_MEMORY_SETTINGS,
      autoCaptureEnabled: true,
      retainSources: true
    };
    expect(() => assertMemorySettingsSaveRequest({ petId: "pet-a", settings })).toThrow(
      MemoryValidationError
    );
    expect(() => assertMemorySettingsSaveRequest({
      petId: "pet-a",
      settings,
      autoCaptureConsent: MEMORY_AUTO_CAPTURE_CONSENT,
      sourceRetentionConsent: MEMORY_SOURCE_RETENTION_CONSENT
    })).not.toThrow();
    expect(() => assertMemoryExportRequest({
      petId: "pet-a",
      options: { includeSources: true }
    })).toThrow(MemoryValidationError);
    expect(() => assertMemoryExportRequest({
      petId: "pet-a",
      options: { includeSources: true },
      sourceExportConsent: MEMORY_SOURCE_EXPORT_CONSENT
    })).not.toThrow();
  });

  it("requires an explicit recall answer policy and forbids items on unknown checks", () => {
    const memory = {
      id: "memory-1",
      petId: "pet-a",
      chapter: "about_you" as const,
      memoryType: "profile" as const,
      content: "用户喜欢咖啡",
      tags: [],
      important: false,
      origin: "manual" as const,
      sourceAvailable: false,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
      revision: 1
    };
    expect(() => assertMemoryRetrieveResponse({
      items: [{ memory, score: 0.9 }],
      answerPolicy: "verified"
    }, "pet-a")).not.toThrow();
    expect(() => assertMemoryRetrieveResponse({
      items: [{ memory, score: 0.9 }],
      answerPolicy: "unknown"
    }, "pet-a")).toThrow(MemoryValidationError);
    expect(() => assertMemoryRetrieveResponse({ items: [] } as never)).toThrow(MemoryValidationError);
  });
});
