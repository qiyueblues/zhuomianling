import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import yauzl from "yauzl";
import { ZipFile } from "yazl";
import { MEMORY_BACKUP_KIND, MEMORY_BACKUP_LIMITS, MEMORY_BACKUP_VERSION, type MemoryBackupData, type MemoryBackupManifest } from "../../../shared/types/memoryBackup";
import { assertMemoryBackupData } from "../../../shared/validation/memoryBackup";
import { MemoryValidationError } from "../../../shared/validation/memory";
import { writeBufferFileAtomically } from "../config/durableJsonFile";

const archiveLimit = MEMORY_BACKUP_LIMITS.bytes + 1024 * 1024;
const hash = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

export async function writeMemoryBackup(filePath: string, data: MemoryBackupData, petName: string): Promise<void> {
  assertMemoryBackupData(data);
  const payload = Buffer.from(JSON.stringify(data));
  if (payload.length > MEMORY_BACKUP_LIMITS.bytes) throw new MemoryValidationError("记忆备份超过 64 MiB 限制。");
  const manifest: MemoryBackupManifest = {
    kind: MEMORY_BACKUP_KIND,
    formatVersion: MEMORY_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    petName: petName.slice(0, 128),
    recordCount: data.records.length,
    sourceCount: data.sources.length,
    dataBytes: payload.length,
    dataSha256: hash(payload)
  };
  const zip = new ZipFile();
  const completion = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of zip.outputStream) {
      size += (chunk as Buffer).length;
      if (size > archiveLimit) throw new MemoryValidationError("记忆备份超过容量限制。");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  })();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
  zip.addBuffer(payload, "memories.json");
  zip.end();
  await writeBufferFileAtomically(filePath, await completion, { mode: 0o600 });
}

export async function readMemoryBackup(filePath: string): Promise<{ manifest: MemoryBackupManifest; data: MemoryBackupData }> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > archiveLimit) {
    throw new MemoryValidationError("请选择有效且不超过 65 MiB 的记忆备份文件。");
  }
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => {
      if (error || !value) reject(new MemoryValidationError("无法读取记忆备份压缩包。"));
      else resolve(value);
    });
  });
  try {
    if (zip.entryCount !== 2) throw new MemoryValidationError("记忆备份的文件清单不正确。");
    const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      const result = new Map<string, Buffer>();
      zip.on("error", () => reject(new MemoryValidationError("记忆备份压缩包已损坏。")));
      zip.on("end", () => resolve(result));
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          const maximum = entry.fileName === "manifest.json" ? MEMORY_BACKUP_LIMITS.manifestBytes : MEMORY_BACKUP_LIMITS.bytes;
          const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (!["manifest.json", "memories.json"].includes(entry.fileName) || result.has(entry.fileName) ||
              (entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod) ||
              (unixType !== 0 && unixType !== 0x8000) || entry.uncompressedSize > maximum) {
            throw new MemoryValidationError("记忆备份包含无效文件或超过容量限制。");
          }
          const stream = await new Promise<NodeJS.ReadableStream>((done, fail) => {
            zip.openReadStream(entry, (error, value) => error || !value ? fail(error) : done(value));
          });
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            size += (chunk as Buffer).length;
            if (size > maximum) throw new MemoryValidationError("记忆备份超过解压容量限制。");
            chunks.push(chunk as Buffer);
          }
          result.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    const manifestBytes = files.get("manifest.json");
    const payload = files.get("memories.json");
    if (!manifestBytes || !payload) throw new MemoryValidationError("记忆备份缺少必要文件。");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as MemoryBackupManifest;
    if (!manifest || typeof manifest !== "object" || manifest.kind !== MEMORY_BACKUP_KIND) {
      throw new MemoryValidationError("所选文件不是桌面灵记忆备份。");
    }
    if (manifest.formatVersion !== MEMORY_BACKUP_VERSION) throw new MemoryValidationError("不支持此记忆备份格式版本，请使用兼容的软件版本。");
    if (Object.keys(manifest).some((key) => !["kind", "formatVersion", "exportedAt", "petName", "recordCount", "sourceCount", "dataBytes", "dataSha256"].includes(key)) ||
        typeof manifest.exportedAt !== "string" || manifest.exportedAt.length > 64 || !Number.isFinite(Date.parse(manifest.exportedAt)) ||
        typeof manifest.petName !== "string" || manifest.petName.length > 128 || manifest.dataBytes !== payload.length || manifest.dataSha256 !== hash(payload)) {
      throw new MemoryValidationError("记忆备份完整性校验失败。");
    }
    const data: unknown = JSON.parse(payload.toString("utf8"));
    assertMemoryBackupData(data);
    if (manifest.recordCount !== data.records.length || manifest.sourceCount !== data.sources.length) {
      throw new MemoryValidationError("记忆备份记录数量与清单不一致。");
    }
    return { manifest, data };
  } catch (error) {
    if (error instanceof MemoryValidationError) throw error;
    throw new MemoryValidationError("记忆备份已损坏或内容不正确。");
  } finally {
    zip.close();
  }
}
