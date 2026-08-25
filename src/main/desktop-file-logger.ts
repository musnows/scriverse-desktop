import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

export const DESKTOP_LOG_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const DESKTOP_LOG_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;
export const DESKTOP_LOG_ARCHIVE_DELAY_MS = 5 * 60 * 1000;
export const DESKTOP_LOG_ARCHIVE_RETRY_MS = 60 * 1000;
const DESKTOP_LOG_QUOTA_CHECK_INTERVAL_MS = 60 * 1000;
const DESKTOP_LOG_ACTIVE_NAME = "desktop.log";
const ROTATED_LOG_PATTERN = /^desktop-\d{8}T\d{6}-\d+\.log$/u;
const ARCHIVED_LOG_PATTERN = /^desktop-\d{8}T\d{6}-\d+\.zip$/u;
const ARCHIVE_TEMP_PATTERN = /^desktop-\d{8}T\d{6}-\d+\.zip\.tmp-/u;

type DesktopLogStream = "stdout" | "stderr";
type ManagedLogFile = {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
};
type ScheduledArchive = {
  dueAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export type DesktopFileLoggerOptions = {
  fileMaxBytes?: number;
  totalMaxBytes?: number;
  archiveDelayMs?: number;
  archiveRetryMs?: number;
  quotaCheckIntervalMs?: number;
  now?: () => Date;
  archiveFile?: (sourcePath: string, targetPath: string) => Promise<void>;
};

export type DesktopProcessLogging = {
  logger: DesktopFileLogger;
  dispose: () => void;
};

function safeUnlink(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return !existsSync(path);
  }
}

function archiveTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "");
}

function safeUtf8SliceEnd(buffer: Buffer, start: number, maximumEnd: number): number {
  if (maximumEnd >= buffer.length) return buffer.length;
  let end = maximumEnd;
  while (end > start && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return end === start ? maximumEnd : end;
}

export function redactDesktopLogText(input: string): string {
  return input
    .replace(/scrvd_[A-Za-z0-9_-]{43}/gu, "[desktop-token]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[api-key]")
    .replace(/((?:["']?)(?:api[_ -]?key|token|password|authorization)(?:["']?)\s*[:=]\s*)(["'])(.*?)\2/giu, "$1$2[credential]$2")
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s"',}]+/giu, "$1[credential]")
    .replace(/((?:api[_ -]?key|token|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/giu, "$1[credential]");
}

export async function zipDesktopLog(sourcePath: string, targetPath: string): Promise<void> {
  const archive = new ZipFile();
  archive.addFile(sourcePath, basename(sourcePath), { compress: true, compressionLevel: 9 });
  archive.end();
  await pipeline(archive.outputStream, createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
}

export class DesktopFileLogger {
  private readonly activePath: string;
  private readonly fileMaxBytes: number;
  private readonly totalMaxBytes: number;
  private readonly archiveDelayMs: number;
  private readonly archiveRetryMs: number;
  private readonly quotaCheckIntervalMs: number;
  private readonly now: () => Date;
  private readonly archiveFile: (sourcePath: string, targetPath: string) => Promise<void>;
  private readonly scheduledArchives = new Map<string, ScheduledArchive>();
  private activeSize = 0;
  private managedTotalBytes = 0;
  private rotationSequence = 0;
  private lastQuotaCheckAt = 0;
  private disposed = false;

  constructor(readonly directory: string, options: DesktopFileLoggerOptions = {}) {
    this.fileMaxBytes = options.fileMaxBytes ?? DESKTOP_LOG_FILE_MAX_BYTES;
    this.totalMaxBytes = options.totalMaxBytes ?? DESKTOP_LOG_TOTAL_MAX_BYTES;
    this.archiveDelayMs = options.archiveDelayMs ?? DESKTOP_LOG_ARCHIVE_DELAY_MS;
    this.archiveRetryMs = options.archiveRetryMs ?? DESKTOP_LOG_ARCHIVE_RETRY_MS;
    this.quotaCheckIntervalMs = options.quotaCheckIntervalMs ?? DESKTOP_LOG_QUOTA_CHECK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.archiveFile = options.archiveFile ?? zipDesktopLog;
    if (!Number.isSafeInteger(this.fileMaxBytes) || this.fileMaxBytes < 1) throw new Error("日志文件上限无效");
    if (!Number.isSafeInteger(this.totalMaxBytes) || this.totalMaxBytes < this.fileMaxBytes) throw new Error("日志目录上限无效");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    this.activePath = join(directory, DESKTOP_LOG_ACTIVE_NAME);
    this.removeInterruptedArchiveFiles();
    this.refreshManagedTotal();
    this.activeSize = existsSync(this.activePath) ? statSync(this.activePath).size : 0;
    if (this.activeSize >= this.fileMaxBytes) this.rotateActiveLog();
    this.scheduleExistingRotatedLogs();
    this.enforceQuota(true);
  }

  write(stream: DesktopLogStream, chunk: string | Uint8Array): void {
    if (this.disposed) return;
    const input = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (input === "") return;
    const timestamp = this.now().toISOString();
    const normalized = redactDesktopLogText(input.replace(/\r\n?/gu, "\n"));
    const lines = normalized.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const payload = Buffer.from(lines.map((line) => `${timestamp} [${stream}] ${line}\n`).join(""), "utf8");
    if (payload.length === 0) return;
    try {
      this.appendPayload(payload);
      this.enforceQuota(false);
    } catch {
      // 日志写入失败不能阻止 Desktop 主流程继续运行。
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const scheduled of this.scheduledArchives.values()) clearTimeout(scheduled.timer);
    this.scheduledArchives.clear();
  }

  private appendPayload(payload: Buffer): void {
    let offset = 0;
    while (offset < payload.length) {
      if (this.activeSize >= this.fileMaxBytes) this.rotateActiveLog();
      let capacity = this.fileMaxBytes - this.activeSize;
      if (capacity < 4 && payload.length - offset > capacity) {
        this.rotateActiveLog();
        capacity = this.fileMaxBytes;
      }
      const maximumEnd = Math.min(payload.length, offset + capacity);
      const end = safeUtf8SliceEnd(payload, offset, maximumEnd);
      const part = payload.subarray(offset, end);
      if (!this.makeRoomFor(part.length)) return;
      appendFileSync(this.activePath, part, { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(this.activePath, 0o600);
      this.activeSize += part.length;
      this.managedTotalBytes += part.length;
      offset = end;
      if (this.activeSize >= this.fileMaxBytes) this.rotateActiveLog();
    }
  }

  private rotateActiveLog(): void {
    if (!existsSync(this.activePath) || this.activeSize === 0) {
      this.activeSize = 0;
      return;
    }
    const rotatedPath = this.nextRotatedPath();
    renameSync(this.activePath, rotatedPath);
    this.activeSize = 0;
    this.scheduleArchive(rotatedPath, this.archiveDelayMs);
    this.enforceQuota(true);
  }

  private nextRotatedPath(): string {
    const timestamp = archiveTimestamp(this.now());
    for (;;) {
      this.rotationSequence += 1;
      const path = join(this.directory, `desktop-${timestamp}-${String(this.rotationSequence).padStart(4, "0")}.log`);
      if (!existsSync(path)) return path;
    }
  }

  private scheduleExistingRotatedLogs(): void {
    const currentTime = this.now().getTime();
    for (const file of this.managedFiles().filter((item) => ROTATED_LOG_PATTERN.test(item.name))) {
      const delay = Math.max(0, file.mtimeMs + this.archiveDelayMs - currentTime);
      this.scheduleArchive(file.path, delay);
    }
  }

  private scheduleArchive(path: string, delayMs: number): void {
    if (this.disposed || !existsSync(path)) return;
    const dueAt = Date.now() + Math.max(0, delayMs);
    const existing = this.scheduledArchives.get(path);
    if (existing && existing.dueAt <= dueAt) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.scheduledArchives.delete(path);
      void this.archiveRotatedLog(path);
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.scheduledArchives.set(path, { dueAt, timer });
  }

  private async archiveRotatedLog(sourcePath: string): Promise<void> {
    if (this.disposed || !existsSync(sourcePath)) return;
    const archivePath = sourcePath.replace(/\.log$/u, ".zip");
    const temporaryPath = `${archivePath}.tmp-${randomUUID()}`;
    try {
      if (!existsSync(archivePath)) {
        this.enforceQuotaForArchive(statSync(sourcePath).size);
        await this.archiveFile(sourcePath, temporaryPath);
        if (process.platform !== "win32") chmodSync(temporaryPath, 0o600);
        unlinkSync(sourcePath);
        renameSync(temporaryPath, archivePath);
      } else {
        unlinkSync(sourcePath);
      }
      this.refreshManagedTotal();
      this.enforceQuota(true);
    } catch {
      if (existsSync(sourcePath)) {
        safeUnlink(temporaryPath);
        this.scheduleArchive(sourcePath, this.archiveRetryMs);
      } else if (existsSync(temporaryPath) && !existsSync(archivePath)) {
        try {
          renameSync(temporaryPath, archivePath);
        } catch {
          // 下次启动会恢复已经完成但尚未改名的 ZIP。
        }
      }
      this.refreshManagedTotal();
      this.enforceQuota(true);
    }
  }

  private removeInterruptedArchiveFiles(): void {
    for (const file of this.managedFiles(true).filter((item) => ARCHIVE_TEMP_PATTERN.test(item.name))) {
      const archivePath = file.path.replace(/\.tmp-.+$/u, "");
      const sourcePath = archivePath.replace(/\.zip$/u, ".log");
      if (existsSync(sourcePath) || existsSync(archivePath)) {
        safeUnlink(file.path);
        continue;
      }
      try {
        renameSync(file.path, archivePath);
      } catch {
        // 保留完整临时 ZIP，等待下次启动再次恢复。
      }
    }
  }

  private managedFiles(includeTemporary = false): ManagedLogFile[] {
    const files: ManagedLogFile[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const managed = entry.name === DESKTOP_LOG_ACTIVE_NAME
        || ROTATED_LOG_PATTERN.test(entry.name)
        || ARCHIVED_LOG_PATTERN.test(entry.name)
        || (includeTemporary && ARCHIVE_TEMP_PATTERN.test(entry.name));
      if (!managed) continue;
      const path = join(this.directory, entry.name);
      try {
        const stats = statSync(path);
        files.push({ name: entry.name, path, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch {
        // 文件可能在扫描期间被另一个压缩任务完成或清理。
      }
    }
    return files;
  }

  private enforceQuota(force: boolean): void {
    const currentTime = this.now().getTime();
    if (!force && currentTime - this.lastQuotaCheckAt < this.quotaCheckIntervalMs) return;
    this.lastQuotaCheckAt = currentTime;
    this.managedTotalBytes = this.deleteOldestArchivesUntil(this.totalMaxBytes);
  }

  private enforceQuotaForArchive(sourceSize: number): void {
    this.managedTotalBytes = this.deleteOldestArchivesUntil(Math.max(this.fileMaxBytes, this.totalMaxBytes - sourceSize));
  }

  private makeRoomFor(bytes: number): boolean {
    if (this.managedTotalBytes + bytes <= this.totalMaxBytes) return true;
    this.refreshManagedTotal();
    if (this.managedTotalBytes + bytes <= this.totalMaxBytes) return true;
    this.managedTotalBytes = this.deleteOldestArchivesUntil(Math.max(0, this.totalMaxBytes - bytes));
    return this.managedTotalBytes + bytes <= this.totalMaxBytes;
  }

  private refreshManagedTotal(): void {
    this.managedTotalBytes = this.managedFiles().reduce((sum, file) => sum + file.size, 0);
  }

  private deleteOldestArchivesUntil(limit: number): number {
    const managed = this.managedFiles();
    let total = managed.reduce((sum, file) => sum + file.size, 0);
    if (total <= limit) return total;
    const archives = managed
      .filter((file) => ARCHIVED_LOG_PATTERN.test(file.name))
      .toSorted((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    for (const archive of archives) {
      if (total <= limit) break;
      if (safeUnlink(archive.path)) total -= archive.size;
    }
    return total;
  }
}

export function installDesktopProcessLogging(directory: string, options: DesktopFileLoggerOptions = {}): DesktopProcessLogging {
  const logger = new DesktopFileLogger(directory, options);
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = function writeStdout(chunk: string | Uint8Array, ...args: unknown[]): boolean {
    logger.write("stdout", chunk);
    return Reflect.apply(stdoutWrite, process.stdout, [chunk, ...args]) as boolean;
  } as typeof process.stdout.write;
  process.stderr.write = function writeStderr(chunk: string | Uint8Array, ...args: unknown[]): boolean {
    logger.write("stderr", chunk);
    return Reflect.apply(stderrWrite, process.stderr, [chunk, ...args]) as boolean;
  } as typeof process.stderr.write;
  return {
    logger,
    dispose: () => {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
      logger.dispose();
    }
  };
}
