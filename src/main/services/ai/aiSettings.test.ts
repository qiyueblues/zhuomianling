import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAiBaseUrl } from "../../../shared/types/ai";

const electronMock = vi.hoisted(() => ({
  userDataPath: "",
  encryptionAvailable: true,
  encryptString: vi.fn((value: string) => Buffer.from(value, "utf8").reverse()),
  decryptString: vi.fn((value: Buffer) => Buffer.from(value).reverse().toString("utf8"))
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath,
    isReady: () => true
  },
  safeStorage: {
    isEncryptionAvailable: () => electronMock.encryptionAvailable,
    encryptString: electronMock.encryptString,
    decryptString: electronMock.decryptString
  }
}));

let temporaryDirectory = "";
let fetchMock: ReturnType<typeof vi.fn>;

function createModelsResponse(): Response {
  return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function createProbeResponse(content = '{"reply":"probe-ok","moodDelta":0}'): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }
  );
}

async function writeLegacySettings(apiKey = "legacy-secret"): Promise<void> {
  await fs.writeFile(
    path.join(temporaryDirectory, "ai-connections.json"),
    JSON.stringify({
      connections: {
        "pet-a": {
          petId: "pet-a",
          providerName: "Provider A",
          baseUrl: "https://old.example.com/",
          model: "model-a",
          models: [{ id: "model-a", name: "model-a" }],
          apiKey,
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      }
    }),
    "utf8"
  );
}

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-ai-settings-"));
  electronMock.userDataPath = temporaryDirectory;
  electronMock.encryptionAvailable = true;
  electronMock.encryptString.mockClear();
  electronMock.decryptString.mockClear();
  fetchMock = vi.fn(async () => createModelsResponse());
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("AI API key storage", () => {
  async function saveVerified(petId = "pet-a", baseUrl = "https://new.example.com", apiKey = "new-secret") {
    const { saveAiConnection } = await import("./aiSettings");
    return saveAiConnection({ petId, baseUrl, apiKey, providerName: "Fixture", model: "model-a" }, {
      models: [{ id: "model-a", name: "model-a" }], checkedAt: "2026-11-07T00:00:00.000Z",
      outputCapability: {
        baseUrl, model: "model-a", mode: "json-schema", protocolTier: "full", streaming: true,
        confidence: "tested", checkedAt: "2026-11-07T00:00:00.000Z", probeVersion: 2
      }
    });
  }

  it.each(["https://new.example.com", "https://old.example.com"])("preserves the old connection on metadata failure for %s", async (baseUrl) => {
    await writeLegacySettings();
    const { getAiConnectionConfig } = await import("./aiSettings");
    await getAiConnectionConfig("pet-a");
    const settingsPath = path.join(temporaryDirectory, "ai-connections.json");
    const original = await fs.readFile(settingsPath, "utf8");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (String(target) === settingsPath) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return originalRename(source, target);
    });
    const result = await saveVerified("pet-a", baseUrl);
    renameSpy.mockRestore();
    expect(result.test.ok).toBe(false);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
    await expect(getAiConnectionConfig("pet-a")).resolves.toMatchObject({ baseUrl: "https://old.example.com", apiKey: "legacy-secret" });
    await expect(fs.access(path.join(temporaryDirectory, "ai-connection-transaction.json"))).rejects.toThrow();
  });

  it("recovers an interrupted rollback after restart without reverting other pets' secrets", async () => {
    await writeLegacySettings();
    await (await import("./aiSettings")).getAiConnectionConfig("pet-a");
    const { setSecureString } = await import("../config/secureConfigStore");
    await setSecureString("fixture", "pet-b", "other-secret");
    let secureWrites = 0;
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (String(target) === path.join(temporaryDirectory, "ai-connections.json")) throw new Error("metadata failure");
      if (String(target) === path.join(temporaryDirectory, "secure-secrets.json") && ++secureWrites > 1) throw new Error("rollback failure");
      return originalRename(source, target);
    });
    expect((await saveVerified()).test.ok).toBe(false);
    const journalPath = path.join(temporaryDirectory, "ai-connection-transaction.json");
    const journal = await fs.readFile(journalPath, "utf8");
    expect(journal).not.toContain("legacy-secret");
    expect(journal).not.toContain("new-secret");
    renameSpy.mockRestore();
    vi.resetModules();
    const restarted = await import("./aiSettings");
    await expect(restarted.getAiConnectionConfig("pet-a")).resolves.toMatchObject({ apiKey: "legacy-secret", baseUrl: "https://old.example.com" });
    const { getSecureString } = await import("../config/secureConfigStore");
    await expect(getSecureString("fixture", "pet-b")).resolves.toBe("other-secret");
    await expect(fs.access(journalPath)).rejects.toThrow();
  });

  it("keeps the committed new connection when restarting before journal removal", async () => {
    await writeLegacySettings();
    await (await import("./aiSettings")).getAiConnectionConfig("pet-a");
    const journalPath = path.join(temporaryDirectory, "ai-connection-transaction.json");
    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === journalPath) throw new Error("interrupted before cleanup");
      return originalRm(target, options);
    });
    await saveVerified();
    await expect(fs.access(journalPath)).resolves.toBeUndefined();
    rmSpy.mockRestore();
    vi.resetModules();
    const restarted = await import("./aiSettings");
    await expect(restarted.getAiConnectionConfig("pet-a")).resolves.toMatchObject({ apiKey: "new-secret", baseUrl: "https://new.example.com" });
    await expect(fs.access(journalPath)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let readers observe a new key paired with old metadata", async () => {
    await writeLegacySettings();
    const { getAiConnectionConfig } = await import("./aiSettings");
    await getAiConnectionConfig("pet-a");
    let resumeCommit!: () => void;
    let reachedCommit!: () => void;
    const blocked = new Promise<void>((resolve) => { reachedCommit = resolve; });
    const resume = new Promise<void>((resolve) => { resumeCommit = resolve; });
    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (String(target) === path.join(temporaryDirectory, "ai-connections.json")) {
        reachedCommit();
        await resume;
      }
      return originalRename(source, target);
    });
    const saving = saveVerified();
    await blocked;
    let resolved = false;
    const reading = getAiConnectionConfig("pet-a").then((value) => { resolved = true; return value; });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(resolved).toBe(false);
    } finally { resumeCommit(); }
    expect((await saving).test.ok).toBe(true);
    await expect(reading).resolves.toMatchObject({ apiKey: "new-secret", baseUrl: "https://new.example.com" });
    spy.mockRestore();
  });

  it("blocks reads and writes when the recovery journal has an unknown format", async () => {
    await writeLegacySettings();
    const { getAiConnectionConfig } = await import("./aiSettings");
    await getAiConnectionConfig("pet-a");
    const securePath = path.join(temporaryDirectory, "secure-secrets.json");
    const previous = await fs.readFile(securePath, "utf8");
    const journalPath = path.join(temporaryDirectory, "ai-connection-transaction.json");
    const unknownJournal = '{"version":2,"future":true}';
    await fs.writeFile(journalPath, unknownJournal);
    await expect(getAiConnectionConfig("pet-a")).rejects.toThrow("AI_CONNECTION_TRANSACTION_CORRUPTED");
    expect((await saveVerified()).test.ok).toBe(false);
    expect(await fs.readFile(securePath, "utf8")).toBe(previous);
    expect(await fs.readFile(journalPath, "utf8")).toBe(unknownJournal);
  });

  it("does not replace existing credentials when a first save cannot commit", async () => {
    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (String(target) === path.join(temporaryDirectory, "ai-connections.json")) throw new Error("metadata failure");
      return originalRename(source, target);
    });
    expect((await saveVerified()).test.ok).toBe(false);
    spy.mockRestore();
    const { getSecureString } = await import("../config/secureConfigStore");
    await expect(getSecureString("ai-api-key", "pet-a")).resolves.toBeUndefined();
    await expect((await import("./aiSettings")).getAiConnectionConfig("pet-a")).resolves.toBeUndefined();
  });

  it("rejects future versions before migrating credentials or writing files", async () => {
    const original = JSON.stringify({ version: 4, future: { keep: true }, connections: {
      "pet-a": { petId: "pet-a", baseUrl: "https://future.example", model: "model-a", apiKey: "future-secret" }
    } });
    const settingsPath = path.join(temporaryDirectory, "ai-connections.json");
    await fs.writeFile(settingsPath, original);
    const { getAiConnectionConfig, migrateLegacyAiConnections, deleteAiConnection } = await import("./aiSettings");
    await expect(migrateLegacyAiConnections()).rejects.toMatchObject({ code: "CONFIG_VERSION_UNSUPPORTED" });
    await expect(getAiConnectionConfig("pet-a")).rejects.toMatchObject({ code: "CONFIG_VERSION_UNSUPPORTED" });
    expect((await saveVerified()).test).toMatchObject({ ok: false, code: "CONFIG_VERSION_UNSUPPORTED" });
    await expect(deleteAiConnection("pet-a")).rejects.toMatchObject({ code: "CONFIG_VERSION_UNSUPPORTED" });
    expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
    expect(electronMock.encryptString).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(temporaryDirectory, "secure-secrets.json"))).rejects.toThrow();
  });

  it.each([0, -1, "3", null, 2.5])("rejects invalid version %s without rewriting it", async (version) => {
    const settingsPath = path.join(temporaryDirectory, "ai-connections.json");
    const original = JSON.stringify({ version, connections: {} });
    await fs.writeFile(settingsPath, original);
    await expect((await import("./aiSettings")).migrateLegacyAiConnections()).rejects.toThrow(/版本无效/);
    expect(await fs.readFile(settingsPath, "utf8")).toBe(original);
  });

  it("does not interpret an unrecognized unversioned file as an empty configuration", async () => {
    const file = path.join(temporaryDirectory, "ai-connections.json");
    await fs.writeFile(file, '{"unrecognized":true}');
    await expect((await import("./aiSettings")).migrateLegacyAiConnections()).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe('{"unrecognized":true}');
  });

  it("does not migrate a malformed legacy connection or its plaintext key", async () => {
    const file = path.join(temporaryDirectory, "ai-connections.json");
    const original = JSON.stringify({ connections: { "pet-a": { unknownField: true, apiKey: "private-key" } } });
    await fs.writeFile(file, original);
    await expect((await import("./aiSettings")).migrateLegacyAiConnections()).rejects.toThrow(/unrecognized/);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(electronMock.encryptString).not.toHaveBeenCalled();
  });

  it("canonicalizes endpoint bindings consistently", () => {
    expect(normalizeAiBaseUrl(" HTTPS://API.Example.COM:443/v1///#fragment ")).toBe(
      "https://api.example.com/v1"
    );
    expect(normalizeAiBaseUrl("http://Example.COM:80/")).toBe("http://example.com");
  });

  it("persists verified import evidence without repeating network probes", async () => {
    const { getAiConnectionSummary, saveAiConnection } = await import("./aiSettings");
    const checkedAt = "2026-07-28T00:00:00.000Z";
    const result = await saveAiConnection(
      {
        petId: "imported-pet",
        providerName: "Provider A",
        baseUrl: "https://api.example.com/v1",
        model: "model-a",
        apiKey: "private-key",
        models: [{ id: "model-a", name: "Model A" }]
      },
      {
        models: [{ id: "model-a", name: "Model A" }],
        checkedAt,
        outputCapability: {
          baseUrl: "https://api.example.com/v1",
          model: "model-a",
          mode: "json-schema",
          protocolTier: "full",
          streaming: true,
          confidence: "tested",
          checkedAt,
          probeVersion: 2
        }
      }
    );

    expect(result.test).toMatchObject({ ok: true, checkedAt });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(getAiConnectionSummary("imported-pet")).resolves.toMatchObject({
      model: "model-a",
      hasApiKey: true,
      outputCapability: { mode: "json-schema", confidence: "tested" }
    });
  });

  it("migrates a legacy plaintext key and removes it from public metadata", async () => {
    await writeLegacySettings();
    const {
      getAiConnectionConfig,
      getAiConnectionSummary,
      migrateLegacyAiConnections
    } = await import("./aiSettings");

    await migrateLegacyAiConnections();
    await migrateLegacyAiConnections();
    const summary = await getAiConnectionSummary("pet-a");
    const resolved = await getAiConnectionConfig("pet-a");
    const metadataContent = await fs.readFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      "utf8"
    );
    const secureContent = await fs.readFile(
      path.join(temporaryDirectory, "secure-secrets.json"),
      "utf8"
    );

    expect(summary?.hasApiKey).toBe(true);
    expect(resolved?.apiKey).toBe("legacy-secret");
    expect(metadataContent).not.toContain("apiKey");
    expect(metadataContent).not.toContain("legacy-secret");
    expect(secureContent).not.toContain("legacy-secret");
    expect(secureContent).not.toContain("https://old.example.com");
  });

  it("only reuses a saved key for the same normalized Base URL", async () => {
    await writeLegacySettings();
    const { listAiModels } = await import("./aiSettings");

    const sameEndpoint = await listAiModels({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://old.example.com",
      model: "model-a",
      apiKey: ""
    });

    expect(sameEndpoint.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer legacy-secret"
    );

    fetchMock.mockClear();
    const changedEndpoint = await listAiModels({
      petId: "pet-a",
      providerName: "Provider B",
      baseUrl: "https://new.example.com",
      model: "model-a",
      apiKey: ""
    });

    expect(changedEndpoint.ok).toBe(false);
    expect(changedEndpoint.code).toBe("API_KEY_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();

    const explicitNewKey = await listAiModels({
      petId: "pet-a",
      providerName: "Provider B",
      baseUrl: "https://new.example.com",
      model: "model-a",
      apiKey: "new-secret"
    });

    expect(explicitNewKey.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer new-secret"
    );
  });

  it("preserves concurrent saves for different pets without writing plaintext keys", async () => {
    const { saveAiConnection } = await import("./aiSettings");

    await Promise.all([
      saveAiConnection({
        petId: "pet-a",
        providerName: "Provider A",
        baseUrl: "https://a.example.com",
        model: "model-a",
        apiKey: "secret-a"
      }),
      saveAiConnection({
        petId: "pet-b",
        providerName: "Provider B",
        baseUrl: "https://b.example.com",
        model: "model-b",
        apiKey: "secret-b"
      })
    ]);

    const metadataContent = await fs.readFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      "utf8"
    );
    const metadata = JSON.parse(metadataContent) as {
      connections: Record<string, Record<string, unknown>>;
    };

    expect(Object.keys(metadata.connections).sort()).toEqual(["pet-a", "pet-b"]);
    expect(metadata.connections["pet-a"]).not.toHaveProperty("apiKey");
    expect(metadata.connections["pet-b"]).not.toHaveProperty("apiKey");
    expect(metadataContent).not.toContain("secret-a");
    expect(metadataContent).not.toContain("secret-b");
  });

  it("fails closed when a legacy key cannot be encrypted", async () => {
    await writeLegacySettings();
    electronMock.encryptionAvailable = false;
    const { listAiModels } = await import("./aiSettings");

    const result = await listAiModels({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://old.example.com",
      model: "model-a",
      apiKey: ""
    });
    const legacyContent = await fs.readFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      "utf8"
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("SECURE_STORAGE_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(legacyContent).toContain("legacy-secret");
  });

  it("keeps legacy AI metadata intact when its atomic rename fails", async () => {
    await writeLegacySettings();
    const settingsPath = path.join(temporaryDirectory, "ai-connections.json");
    const originalContent = await fs.readFile(settingsPath, "utf8");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (path.resolve(String(target)) === path.resolve(settingsPath)) {
        throw Object.assign(new Error("fixture AI rename failure"), { code: "EIO" });
      }

      return originalRename(source, target);
    });
    const { migrateLegacyAiConnections } = await import("./aiSettings");

    try {
      await expect(migrateLegacyAiConnections()).rejects.toThrow("fixture AI rename failure");
      expect(await fs.readFile(settingsPath, "utf8")).toBe(originalContent);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("does not contact the API when a new key cannot be stored safely", async () => {
    electronMock.encryptionAvailable = false;
    const { saveAiConnection } = await import("./aiSettings");

    const result = await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://new.example.com",
      model: "model-a",
      apiKey: "new-secret"
    });

    expect(result.test.ok).toBe(false);
    expect(result.test.code).toBe("SECURE_STORAGE_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not contact the API when encryption throws despite being available", async () => {
    electronMock.encryptString.mockImplementationOnce(() => {
      throw new Error("fixture encryption failure");
    });
    const { saveAiConnection } = await import("./aiSettings");

    const result = await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://new.example.com",
      model: "model-a",
      apiKey: "new-secret"
    });

    expect(result.test.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists a v3 capability for the exact endpoint and model without exposing the key", async () => {
    fetchMock
      .mockResolvedValueOnce(createModelsResponse())
      .mockResolvedValueOnce(createProbeResponse());
    const {
      getAiConnectionConfig,
      getAiConnectionSummary,
      saveAiConnection
    } = await import("./aiSettings");

    const saved = await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1/",
      model: "model-a",
      apiKey: "private-key"
    });
    const summary = await getAiConnectionSummary("pet-a");
    const resolved = await getAiConnectionConfig("pet-a");
    const metadataContent = await fs.readFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      "utf8"
    );
    const metadata = JSON.parse(metadataContent) as {
      version: number;
      connections: Record<string, { outputCapability?: Record<string, unknown> }>;
    };

    expect(saved.config.outputCapability).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      mode: "json-schema",
      protocolTier: "full",
      streaming: true,
      confidence: "tested"
    });
    expect(summary?.outputCapability).toEqual(saved.config.outputCapability);
    expect(resolved?.outputCapability).toEqual(saved.config.outputCapability);
    expect(metadata.version).toBe(3);
    expect(metadata.connections["pet-a"]?.outputCapability).toEqual(saved.config.outputCapability);
    expect(metadataContent).not.toContain("private-key");
  });

  it("reuses successful model and output checks when saving the same key", async () => {
    fetchMock
      .mockResolvedValueOnce(createModelsResponse())
      .mockResolvedValueOnce(createProbeResponse());
    const { listAiModels, saveAiConnection, testAiOutputCapability } = await import("./aiSettings");
    const draft = {
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1/",
      model: "model-a",
      apiKey: "private-key"
    };

    await expect(listAiModels(draft)).resolves.toMatchObject({ ok: true });
    await expect(testAiOutputCapability(draft)).resolves.toMatchObject({
      ok: true,
      capability: { confidence: "tested" }
    });

    const saved = await saveAiConnection(draft);

    expect(saved.test).toMatchObject({ ok: true });
    expect(saved.test.message).toContain("已复用已完成的输出能力测试");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retests output capability when the API key changes", async () => {
    fetchMock
      .mockResolvedValueOnce(createModelsResponse())
      .mockResolvedValueOnce(createProbeResponse());
    const { listAiModels, saveAiConnection, testAiOutputCapability } = await import("./aiSettings");
    const firstDraft = {
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "private-key"
    };

    await listAiModels(firstDraft);
    await testAiOutputCapability(firstDraft);
    await saveAiConnection(firstDraft);

    fetchMock
      .mockResolvedValueOnce(createModelsResponse())
      .mockResolvedValueOnce(createProbeResponse());
    await saveAiConnection({ ...firstDraft, apiKey: "new-private-key" });

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reuses persisted tested capability when the saved key is unchanged", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 3,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Provider A",
            baseUrl: "https://api.example.com/v1",
            model: "model-a",
            models: [{ id: "model-a", name: "model-a" }],
            outputCapability: {
              baseUrl: "https://api.example.com/v1",
              model: "model-a",
              mode: "json-schema",
              protocolTier: "full",
              streaming: true,
              confidence: "tested",
              checkedAt: "2026-07-15T00:00:00.000Z",
              probeVersion: 2
            },
            updatedAt: "2026-07-15T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const { setSecureString } = await import("../config/secureConfigStore");
    await setSecureString("ai-api-key", "pet-a", "private-key", "https://api.example.com/v1");

    const { saveAiConnection } = await import("./aiSettings");
    const saved = await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: ""
    });

    expect(saved.test.ok).toBe(true);
    expect(saved.config.outputCapability).toMatchObject({ confidence: "tested" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards a stored capability when its endpoint or model tuple is stale", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 3,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Provider A",
            baseUrl: "https://api.example.com/v1",
            model: "model-new",
            models: [{ id: "model-new", name: "model-new" }],
            outputCapability: {
              baseUrl: "https://api.example.com/v1",
              model: "model-old",
              mode: "json-schema",
              streaming: true,
              confidence: "tested",
              checkedAt: "2026-07-15T00:00:00.000Z"
            },
            updatedAt: "2026-07-15T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const { getAiConnectionSummary } = await import("./aiSettings");

    await expect(getAiConnectionSummary("pet-a")).resolves.toMatchObject({
      baseUrl: "https://api.example.com/v1",
      model: "model-new",
      outputCapability: undefined
    });
  });

  it("upgrades a v2 connection without capability metadata and keeps it usable", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 2,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Legacy Provider",
            baseUrl: "https://legacy.example.com/v1/",
            model: "legacy-model",
            models: [{ id: "legacy-model", name: "Legacy Model" }],
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const { getAiConnectionSummary } = await import("./aiSettings");

    const summary = await getAiConnectionSummary("pet-a");
    const rewritten = JSON.parse(
      await fs.readFile(path.join(temporaryDirectory, "ai-connections.json"), "utf8")
    ) as { version: number; connections: Record<string, Record<string, unknown>> };

    expect(summary).toMatchObject({
      petId: "pet-a",
      providerName: "Legacy Provider",
      baseUrl: "https://legacy.example.com/v1",
      model: "legacy-model",
      models: [{ id: "legacy-model", name: "Legacy Model" }],
      outputCapability: undefined
    });
    expect(rewritten.version).toBe(3);
    expect(rewritten.connections["pet-a"]).not.toHaveProperty("outputCapability");
  });

  it("rechecks legacy capability metadata through prompt JSON instead of trapping it in text mode", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 3,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Legacy Provider",
            baseUrl: "https://legacy.example.com/v1",
            model: "legacy-model",
            outputCapability: {
              baseUrl: "https://legacy.example.com/v1",
              model: "legacy-model",
              mode: "json-object",
              streaming: true,
              confidence: "tested",
              checkedAt: "2026-01-01T00:00:00.000Z"
            },
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const { getAiConnectionSummary } = await import("./aiSettings");
    const summary = await getAiConnectionSummary("pet-a");
    const rewritten = JSON.parse(
      await fs.readFile(path.join(temporaryDirectory, "ai-connections.json"), "utf8")
    );

    expect(summary?.outputCapability).toMatchObject({
      mode: "prompt-json",
      protocolTier: "full",
      confidence: "fallback"
    });
    expect(rewritten.connections["pet-a"].outputCapability).toMatchObject({
      mode: "prompt-json",
      protocolTier: "full",
      confidence: "fallback"
    });
  });

  it("preserves a genuinely tested v2 plain-text capability", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 3,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Provider A",
            baseUrl: "https://api.example.com/v1",
            model: "model-a",
            outputCapability: {
              baseUrl: "https://api.example.com/v1",
              model: "model-a",
              mode: "plain-text",
              protocolTier: "text",
              streaming: true,
              confidence: "tested",
              checkedAt: "2026-07-22T00:00:00.000Z",
              probeVersion: 2
            },
            updatedAt: "2026-07-22T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const { getAiConnectionSummary } = await import("./aiSettings");

    await expect(getAiConnectionSummary("pet-a")).resolves.toMatchObject({
      outputCapability: {
        mode: "plain-text",
        protocolTier: "text",
        confidence: "tested",
        probeVersion: 2
      }
    });
  });

  it("discards stored output capability metadata whose mode and tier disagree", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 3,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Provider A",
            baseUrl: "https://api.example.com/v1",
            model: "model-a",
            outputCapability: {
              baseUrl: "https://api.example.com/v1",
              model: "model-a",
              mode: "json-object",
              protocolTier: "text",
              streaming: true,
              confidence: "tested",
              checkedAt: "2026-07-15T00:00:00.000Z"
            },
            updatedAt: "2026-07-15T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const { getAiConnectionSummary } = await import("./aiSettings");

    await expect(getAiConnectionSummary("pet-a")).resolves.toMatchObject({
      outputCapability: undefined
    });
  });

  it("does not replace a tested capability when an explicit retest hits rate limiting", async () => {
    fetchMock
      .mockResolvedValueOnce(createModelsResponse())
      .mockResolvedValueOnce(createProbeResponse());
    const {
      getAiConnectionSummary,
      saveAiConnection,
      testAiOutputCapability
    } = await import("./aiSettings");
    await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "private-key"
    });
    fetchMock.mockReset().mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    const result = await testAiOutputCapability({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: ""
    });
    const summary = await getAiConnectionSummary("pet-a");

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("限流")
    });
    expect(result.capability).toBeUndefined();
    expect(summary?.outputCapability).toMatchObject({
      mode: "json-schema",
      protocolTier: "full",
      confidence: "tested"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires three consecutive text-only probes before downgrading a saved full protocol", async () => {
    fetchMock
      .mockResolvedValueOnce(createModelsResponse())
      .mockResolvedValueOnce(createProbeResponse());
    const {
      getAiConnectionSummary,
      saveAiConnection,
      testAiOutputCapability
    } = await import("./aiSettings");
    await saveAiConnection({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: "private-key"
    });

    fetchMock.mockReset();
    for (let probeIndex = 0; probeIndex < 3; probeIndex += 1) {
      for (let structuredAttempt = 0; structuredAttempt < 6; structuredAttempt += 1) {
        fetchMock.mockResolvedValueOnce(createProbeResponse('{"reply":"probe-ok"}'));
      }
      fetchMock.mockResolvedValueOnce(createProbeResponse("probe-ok"));
    }

    const draft = {
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: ""
    };
    const first = await testAiOutputCapability(draft);
    const second = await testAiOutputCapability(draft);
    const beforeThreshold = await getAiConnectionSummary("pet-a");
    const third = await testAiOutputCapability(draft);
    const afterThreshold = await getAiConnectionSummary("pet-a");

    expect(first).toMatchObject({
      ok: true,
      message: expect.stringContaining("1/3"),
      capability: { protocolTier: "full" }
    });
    expect(second).toMatchObject({
      ok: true,
      message: expect.stringContaining("2/3"),
      capability: { protocolTier: "full" }
    });
    expect(beforeThreshold?.outputCapability).toMatchObject({ protocolTier: "full" });
    expect(third).toMatchObject({
      ok: true,
      capability: { mode: "plain-text", protocolTier: "text" }
    });
    expect(afterThreshold?.outputCapability).toMatchObject({
      mode: "plain-text",
      protocolTier: "text"
    });
  });

  it("upgrades a saved text fallback after a successful explicit retest", async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, "ai-connections.json"),
      JSON.stringify({
        version: 3,
        connections: {
          "pet-a": {
            petId: "pet-a",
            providerName: "Provider A",
            baseUrl: "https://api.example.com/v1",
            model: "model-a",
            outputCapability: {
              baseUrl: "https://api.example.com/v1",
              model: "model-a",
              mode: "plain-text",
              protocolTier: "text",
              streaming: true,
              confidence: "fallback",
              checkedAt: "2026-07-15T00:00:00.000Z"
            },
            updatedAt: "2026-07-15T00:00:00.000Z"
          }
        }
      }),
      "utf8"
    );
    const securePath = path.join(temporaryDirectory, "secure-secrets.json");
    const { setSecureString } = await import("../config/secureConfigStore");
    await setSecureString("ai-api-key", "pet-a", "secret", "https://api.example.com/v1");
    expect(await fs.stat(securePath)).toBeTruthy();
    fetchMock.mockResolvedValueOnce(createProbeResponse());
    const { getAiConnectionSummary, testAiOutputCapability } = await import("./aiSettings");

    const result = await testAiOutputCapability({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
      apiKey: ""
    });
    const summary = await getAiConnectionSummary("pet-a");

    expect(result).toMatchObject({ ok: true, capability: { protocolTier: "full" } });
    expect(summary?.outputCapability).toMatchObject({
      mode: "json-schema",
      protocolTier: "full",
      confidence: "tested"
    });
  });

  it("uses only a fixed probe conversation and does not create memory data", async () => {
    await writeLegacySettings();
    fetchMock.mockResolvedValueOnce(createProbeResponse());
    const { testAiOutputCapability } = await import("./aiSettings");

    const result = await testAiOutputCapability({
      petId: "pet-a",
      providerName: "Provider A",
      baseUrl: "https://old.example.com",
      model: "model-a",
      apiKey: ""
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const entries = await fs.readdir(temporaryDirectory, { recursive: true });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("完整桌宠协议 · 支持流式");
    expect(requestBody.messages).toEqual([
      {
        role: "system",
        content: "这是固定连接能力测试。只返回 JSON，不要输出推理、Markdown 或解释。必须且只能返回 reply 和 moodDelta。"
      },
      { role: "user", content: "将 reply 设置为 probe-ok，将 moodDelta 设置为 0。" }
    ]);
    expect(entries.some((entry) => /memory|ledger|pending/i.test(entry))).toBe(false);
  });
});
