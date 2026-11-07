import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type BackupSource = "current-or-replacement" | "replacement";

export interface AtomicJsonBackupOptions {
  filePath: string;
  source?: BackupSource;
  validateCurrent?: (value: unknown) => boolean;
}

export interface AtomicJsonWriteOptions {
  backup?: AtomicJsonBackupOptions;
}

export interface AtomicFileWriteOptions {
  mode?: number;
}

function isErrnoException(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  return codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directoryHandle: fs.FileHandle | undefined;

  try {
    directoryHandle = await fs.open(directoryPath, "r");
    await directoryHandle.sync();
  } catch (error) {
    // Windows does not consistently allow opening or syncing directory handles.
    if (!isErrnoException(error, "EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM")) {
      throw error;
    }
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

export async function syncParentDirectory(filePath: string): Promise<void> {
  await syncDirectory(path.dirname(filePath));
}

export async function removeFileDurably(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
  await syncParentDirectory(filePath);
}

async function renameWithTransientRetries(sourcePath: string, targetPath: string): Promise<void> {
  const retryDelaysMs = [0, 10, 25, 50];
  let lastError: unknown;

  for (const retryDelayMs of retryDelaysMs) {
    if (retryDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }

    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;

      if (!isErrnoException(error, "EACCES", "EBUSY", "EPERM")) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function writeFileContentsAtomically(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicFileWriteOptions = {}
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true });
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryHandle: fs.FileHandle | undefined;

  try {
    temporaryHandle = await fs.open(temporaryPath, "wx", options.mode ?? 0o600);
    await temporaryHandle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await renameWithTransientRetries(temporaryPath, filePath);
    await syncDirectory(directoryPath);
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function writeTextFileAtomically(
  filePath: string,
  content: string,
  options?: AtomicFileWriteOptions
): Promise<void> {
  return writeFileContentsAtomically(filePath, content, options);
}

export function writeBufferFileAtomically(
  filePath: string,
  content: Uint8Array,
  options?: AtomicFileWriteOptions
): Promise<void> {
  return writeFileContentsAtomically(filePath, content, options);
}

async function getCurrentBackupContent(
  filePath: string,
  replacementContent: string,
  backup: AtomicJsonBackupOptions
): Promise<string | undefined> {
  if (backup.source === "replacement") {
    return replacementContent;
  }

  let currentContent: string;

  try {
    currentContent = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return replacementContent;
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(currentContent.replace(/^\uFEFF/, "")) as unknown;

    if (backup.validateCurrent && !backup.validateCurrent(parsed)) {
      return undefined;
    }

    return currentContent;
  } catch {
    // Never replace a known-good backup with damaged current content.
    return undefined;
  }
}

/**
 * Durably replaces a JSON file without exposing a partially written target.
 * The optional backup is also replaced through a same-directory temp file.
 */
export async function writeJsonFileAtomically(
  filePath: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {}
): Promise<void> {
  const serializedValue = JSON.stringify(value, null, 2);

  if (serializedValue === undefined) {
    throw new Error("Cannot persist a non-serializable JSON value.");
  }

  const replacementContent = `${serializedValue}\n`;

  if (options.backup) {
    const backupContent = await getCurrentBackupContent(
      filePath,
      replacementContent,
      options.backup
    );

    if (backupContent !== undefined) {
      await writeTextFileAtomically(options.backup.filePath, backupContent);
    }
  }

  await writeTextFileAtomically(filePath, replacementContent);
}
