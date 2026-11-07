import { app } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AiConnectionConfig } from "../../../shared/types/ai";
import { isValidPetId } from "../../../shared/validation/petId";
import { removeFileDurably, writeJsonFileAtomically } from "../config/durableJsonFile";
import { getSecureStringCiphertext, setSecureStringCiphertext } from "../config/secureConfigStore";

const scope = "ai-api-key";
const maxJournalBytes = 256 * 1024;

interface ConnectionTransaction {
  version: 1;
  petId: string;
  nextFingerprint: string;
  previousCiphertext: string | null;
}

function journalPath(): string {
  return path.join(app.getPath("userData"), "ai-connection-transaction.json");
}

function fingerprint(config: AiConnectionConfig | undefined): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(stable(config ?? null))).digest("hex");
}

async function assertSafeJournal(): Promise<void> {
  try {
    const stat = await fs.lstat(journalPath());
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxJournalBytes) {
      throw new Error("AI_CONNECTION_TRANSACTION_CORRUPTED");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Caller serializes ALL AI metadata writes and recovery through the settings queue. */
export async function recoverAiConnectionTransaction(
  readConnection: (petId: string) => Promise<AiConnectionConfig | undefined>
): Promise<void> {
  await assertSafeJournal();
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(journalPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("AI_CONNECTION_TRANSACTION_CORRUPTED");
  }
  const record = value as Partial<ConnectionTransaction> | null;
  if (!record || record.version !== 1 || !isValidPetId(record.petId) ||
    typeof record.nextFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.nextFingerprint) ||
    !(record.previousCiphertext === null || (typeof record.previousCiphertext === "string" &&
      record.previousCiphertext.length > 0 && record.previousCiphertext.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(record.previousCiphertext)))) {
    throw new Error("AI_CONNECTION_TRANSACTION_CORRUPTED");
  }
  // Metadata replacement is the commit point. Only an uncommitted update
  // restores the old cipher; a committed update keeps the durable new key.
  if (fingerprint(await readConnection(record.petId)) !== record.nextFingerprint) {
    await setSecureStringCiphertext(scope, record.petId, record.previousCiphertext ?? undefined);
  }
  await removeFileDurably(journalPath());
}

export async function commitAiConnectionTransaction(
  config: AiConnectionConfig,
  ciphertext: string,
  writeMetadata: () => Promise<void>,
  readConnection: (petId: string) => Promise<AiConnectionConfig | undefined>
): Promise<void> {
  await assertSafeJournal();
  const journal: ConnectionTransaction = {
    version: 1,
    petId: config.petId,
    nextFingerprint: fingerprint(config),
    previousCiphertext: await getSecureStringCiphertext(scope, config.petId) ?? null
  };
  if (Buffer.byteLength(JSON.stringify(journal)) > maxJournalBytes) throw new Error("AI_CONNECTION_TRANSACTION_TOO_LARGE");
  await writeJsonFileAtomically(journalPath(), journal);
  try {
    await setSecureStringCiphertext(scope, config.petId, ciphertext);
    await writeMetadata();
  } catch (error) {
    // Failed rollback leaves the journal intact and subsequent operations
    // blocked until recovery succeeds, rather than returning mixed settings.
    await recoverAiConnectionTransaction(readConnection);
    throw error;
  }
  await removeFileDurably(journalPath());
}
