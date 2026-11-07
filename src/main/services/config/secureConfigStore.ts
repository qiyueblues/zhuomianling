import { app, safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomically } from "./durableJsonFile";

interface SecureSecretsFile {
  version: 1;
  secrets: Record<string, Record<string, string>>;
}

interface SecureStringPayload {
  version: 1;
  value: string;
  binding?: string;
}

const secureSecretsFileName = "secure-secrets.json";

let mutationQueue: Promise<void> = Promise.resolve();

export class SecureStorageUnavailableError extends Error {
  readonly code = "SECURE_STORAGE_UNAVAILABLE";

  constructor() {
    super("当前系统的本机安全存储不可用，无法安全保存或读取密钥。");
    this.name = "SecureStorageUnavailableError";
  }
}

export class SecureStorageCorruptedError extends Error {
  readonly code = "SECURE_STORAGE_CORRUPTED";

  constructor() {
    super("本机安全存储内容损坏，请重新填写相关密钥。");
    this.name = "SecureStorageCorruptedError";
  }
}

function getSecureSecretsPath(): string {
  return path.join(app.getPath("userData"), secureSecretsFileName);
}

function validateSecretAddress(scope: string, petId: string): void {
  if (!scope.trim() || !petId.trim()) {
    throw new Error("Secure secret scope and petId are required.");
  }
}

function isBase64Ciphertext(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function parseSecureSecretsFile(value: unknown): SecureSecretsFile {
  if (!value || typeof value !== "object") {
    throw new SecureStorageCorruptedError();
  }

  const candidate = value as {
    version?: unknown;
    secrets?: unknown;
  };

  if (candidate.version !== 1 || !candidate.secrets || typeof candidate.secrets !== "object") {
    throw new SecureStorageCorruptedError();
  }

  const secrets: Record<string, Record<string, string>> = {};

  for (const [scope, rawScopeSecrets] of Object.entries(candidate.secrets)) {
    if (!rawScopeSecrets || typeof rawScopeSecrets !== "object") {
      throw new SecureStorageCorruptedError();
    }

    const scopeSecrets: Record<string, string> = {};

    for (const [petId, ciphertext] of Object.entries(rawScopeSecrets)) {
      if (!isBase64Ciphertext(ciphertext)) {
        throw new SecureStorageCorruptedError();
      }

      scopeSecrets[petId] = ciphertext;
    }

    secrets[scope] = scopeSecrets;
  }

  return {
    version: 1,
    secrets
  };
}

async function readSecureSecretsFile(): Promise<SecureSecretsFile> {
  try {
    const content = await fs.readFile(getSecureSecretsPath(), "utf8");
    return parseSecureSecretsFile(JSON.parse(content) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: 1,
        secrets: {}
      };
    }

    if (error instanceof SecureStorageCorruptedError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new SecureStorageCorruptedError();
    }

    throw error;
  }
}

async function writeSecureSecretsFile(settings: SecureSecretsFile): Promise<void> {
  await writeJsonFileAtomically(getSecureSecretsPath(), settings);
}

function runSerializedMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(mutation, mutation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

export function assertSecureStorageAvailable(): void {
  let encryptionAvailable = false;

  try {
    encryptionAvailable = app.isReady() && safeStorage.isEncryptionAvailable();
  } catch {
    encryptionAvailable = false;
  }

  if (!encryptionAvailable) {
    throw new SecureStorageUnavailableError();
  }
}

export async function getSecureString(
  scope: string,
  petId: string,
  expectedBinding?: string
): Promise<string | undefined> {
  validateSecretAddress(scope, petId);
  const settings = await readSecureSecretsFile();
  const ciphertext = settings.secrets[scope]?.[petId];

  if (!ciphertext) {
    return undefined;
  }

  assertSecureStorageAvailable();

  let decrypted: string;

  try {
    decrypted = safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  } catch {
    throw new SecureStorageCorruptedError();
  }

  let payload: SecureStringPayload;

  try {
    payload = JSON.parse(decrypted) as SecureStringPayload;
  } catch {
    throw new SecureStorageCorruptedError();
  }

  if (
    payload.version !== 1 ||
    typeof payload.value !== "string" ||
    (payload.binding !== undefined && typeof payload.binding !== "string")
  ) {
    throw new SecureStorageCorruptedError();
  }

  if (expectedBinding !== undefined && payload.binding !== expectedBinding) {
    return undefined;
  }

  return payload.value;
}

export async function setSecureString(
  scope: string,
  petId: string,
  value: string,
  binding?: string
): Promise<void> {
  validateSecretAddress(scope, petId);
  await setSecureStringCiphertext(scope, petId, encryptSecureString(value, binding));
}

/** Main-process persistence only; never expose ciphertext or snapshots over IPC. */
export function encryptSecureString(value: string, binding?: string): string {
  assertSecureStorageAvailable();
  const payload: SecureStringPayload = {
    version: 1,
    value,
    ...(binding === undefined ? {} : { binding })
  };
  return safeStorage.encryptString(JSON.stringify(payload)).toString("base64");
}

export async function getSecureStringCiphertext(scope: string, petId: string): Promise<string | undefined> {
  validateSecretAddress(scope, petId);
  return (await readSecureSecretsFile()).secrets[scope]?.[petId];
}

export async function setSecureStringCiphertext(scope: string, petId: string, ciphertext: string | undefined): Promise<void> {
  validateSecretAddress(scope, petId);
  if (ciphertext !== undefined && !isBase64Ciphertext(ciphertext)) throw new SecureStorageCorruptedError();

  await runSerializedMutation(async () => {
    const settings = await readSecureSecretsFile();
    if (ciphertext === undefined) {
      if (!settings.secrets[scope]?.[petId]) return;
      delete settings.secrets[scope][petId];
      if (!Object.keys(settings.secrets[scope]).length) delete settings.secrets[scope];
    } else {
      settings.secrets[scope] = { ...(settings.secrets[scope] ?? {}), [petId]: ciphertext };
    }
    await writeSecureSecretsFile(settings);
  });
}

export async function deleteSecureString(scope: string, petId: string): Promise<void> {
  validateSecretAddress(scope, petId);

  await runSerializedMutation(async () => {
    const settings = await readSecureSecretsFile();
    const scopeSecrets = settings.secrets[scope];

    if (!scopeSecrets || !(petId in scopeSecrets)) {
      return;
    }

    delete scopeSecrets[petId];

    if (!Object.keys(scopeSecrets).length) {
      delete settings.secrets[scope];
    }

    await writeSecureSecretsFile(settings);
  });
}

export async function deletePetSecrets(petId: string): Promise<void> {
  if (!petId.trim()) {
    throw new Error("Secure secret petId is required.");
  }

  await runSerializedMutation(async () => {
    const settings = await readSecureSecretsFile();
    let changed = false;

    for (const [scope, scopeSecrets] of Object.entries(settings.secrets)) {
      if (!(petId in scopeSecrets)) {
        continue;
      }

      delete scopeSecrets[petId];
      changed = true;

      if (!Object.keys(scopeSecrets).length) {
        delete settings.secrets[scope];
      }
    }

    if (changed) {
      await writeSecureSecretsFile(settings);
    }
  });
}
