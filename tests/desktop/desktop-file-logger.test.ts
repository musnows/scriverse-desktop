import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_LOG_ARCHIVE_DELAY_MS,
  DESKTOP_LOG_ARCHIVE_RETRY_MS,
  DESKTOP_LOG_FILE_MAX_BYTES,
  DESKTOP_LOG_TOTAL_MAX_BYTES,
  DesktopFileLogger,
  installDesktopProcessLogging,
  redactDesktopLogText
} from "../../src/main/desktop-file-logger.js";
import { rendererConsoleLogLine } from "../../src/main/renderer-console-logging.js";

function logDirectory(): string {
  const path = join(tmpdir(), `scriverse-desktop-logs-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
}

async function waitFor(assertion: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Desktop log state");
}

function rotatedLogs(directory: string): string[] {
  return readdirSync(directory).filter((name) => /^desktop-.*\.log$/u.test(name));
}

function archives(directory: string): string[] {
  return readdirSync(directory).filter((name) => /^desktop-.*\.zip$/u.test(name));
}

describe("Desktop 文件日志", () => {
  it("使用 100 MiB 单文件、500 MiB 默认总量和约定的压缩时序", () => {
    expect(DESKTOP_LOG_FILE_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(DESKTOP_LOG_TOTAL_MAX_BYTES).toBe(500 * 1024 * 1024);
    expect(DESKTOP_LOG_ARCHIVE_DELAY_MS).toBe(5 * 60 * 1000);
    expect(DESKTOP_LOG_ARCHIVE_RETRY_MS).toBe(60 * 1000);
  });

  it("持久化 stdout 和 stderr 并脱敏凭据", async () => {
    const directory = logDirectory();
    const logging = installDesktopProcessLogging(directory, { fileMaxBytes: 4_096, totalMaxBytes: 16_384 });
    const token = `scrvd_${"a".repeat(43)}`;
    try {
      process.stderr.write("persistent probe\n");
      logging.logger.write("stderr", token);
    } finally {
      await logging.dispose();
    }
    const path = join(directory, "desktop.log");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("persistent probe");
    expect(content).toContain("[desktop-token]");
    expect(content).not.toContain(token);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("脱敏带空格的 JSON 凭据和 Authorization", () => {
    const original = '{"password":"secret phrase","apiKey":"sk-private-value","Authorization":"Bearer bearer-value"}';
    const redacted = redactDesktopLogText(original);
    expect(redacted).not.toContain("secret phrase");
    expect(redacted).not.toContain("sk-private-value");
    expect(redacted).not.toContain("bearer-value");
    expect(redacted.match(/\[credential\]|\[api-key\]/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("滚动后的每个日志文件都不超过配置上限", async () => {
    const directory = logDirectory();
    const logger = new DesktopFileLogger(directory, {
      fileMaxBytes: 220,
      totalMaxBytes: 4_400,
      archiveDelayMs: 60_000
    });
    for (let index = 0; index < 12; index += 1) logger.write("stdout", `line-${index}-${"内容".repeat(40)}`);
    await logger.dispose();
    const logFiles = readdirSync(directory).filter((name) => name.endsWith(".log"));
    expect(logFiles.length).toBeGreaterThan(2);
    for (const name of logFiles) expect(statSync(join(directory, name)).size).toBeLessThanOrEqual(220);
  });

  it("滚动后等待再压缩为 ZIP 并删除原日志", async () => {
    const directory = logDirectory();
    const logger = new DesktopFileLogger(directory, {
      fileMaxBytes: 200,
      totalMaxBytes: 4_000,
      archiveDelayMs: 50,
      archiveRetryMs: 20
    });
    logger.write("stderr", "x".repeat(260));
    await logger.flush();
    expect(rotatedLogs(directory).length).toBeGreaterThan(0);
    expect(archives(directory)).toHaveLength(0);
    await waitFor(() => archives(directory).length > 0);
    expect(rotatedLogs(directory)).toHaveLength(0);
    expect(readFileSync(join(directory, archives(directory)[0]!)).subarray(0, 2).toString("ascii")).toBe("PK");
    await logger.dispose();
  });

  it("压缩失败时按重试间隔再次处理", async () => {
    const directory = logDirectory();
    let attempts = 0;
    const logger = new DesktopFileLogger(directory, {
      fileMaxBytes: 180,
      totalMaxBytes: 3_600,
      archiveDelayMs: 10,
      archiveRetryMs: 20,
      archiveFile: async (_sourcePath, targetPath) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        writeFileSync(targetPath, Buffer.from("PK retry archive"), { mode: 0o600 });
      }
    });
    logger.write("stderr", "x".repeat(240));
    await logger.flush();
    await waitFor(() => attempts >= 2 && archives(directory).length > 0);
    expect(rotatedLogs(directory)).toHaveLength(0);
    await logger.dispose();
  });

  it("压缩历史文件时新的输出只写入当前日志", async () => {
    const directory = logDirectory();
    let sourceSizeDuringArchive = 0;
    let logger!: DesktopFileLogger;
    logger = new DesktopFileLogger(directory, {
      fileMaxBytes: 200,
      totalMaxBytes: 4_000,
      archiveDelayMs: 10,
      archiveRetryMs: 20,
      archiveFile: async (sourcePath, targetPath) => {
        const before = statSync(sourcePath).size;
        logger.write("stderr", "written-during-archive");
        await logger.flush();
        sourceSizeDuringArchive = statSync(sourcePath).size;
        expect(sourceSizeDuringArchive).toBe(before);
        expect(readFileSync(join(directory, "desktop.log"), "utf8")).toContain("written-during-archive");
        writeFileSync(targetPath, Buffer.from("PK detached archive"), { mode: 0o600 });
      }
    });
    logger.write("stderr", "x".repeat(260));
    await logger.flush();
    await waitFor(() => archives(directory).length > 0);
    expect(sourceSizeDuringArchive).toBe(200);
    await logger.dispose();
  });

  it("超过总量上限时先删除最老的 ZIP", async () => {
    const directory = logDirectory();
    const oldest = join(directory, "desktop-20260825T000000-0001.zip");
    const newest = join(directory, "desktop-20260825T000001-0002.zip");
    writeFileSync(oldest, Buffer.alloc(70));
    writeFileSync(newest, Buffer.alloc(70));
    utimesSync(oldest, new Date(1_000), new Date(1_000));
    utimesSync(newest, new Date(2_000), new Date(2_000));
    const logger = new DesktopFileLogger(directory, { fileMaxBytes: 20, totalMaxBytes: 100 });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    await logger.dispose();
  });

  it("运行时降低总量上限会立即清理最老 ZIP", async () => {
    const directory = logDirectory();
    const oldest = join(directory, "desktop-20260825T000000-0001.zip");
    const newest = join(directory, "desktop-20260825T000001-0002.zip");
    writeFileSync(oldest, Buffer.alloc(70));
    writeFileSync(newest, Buffer.alloc(70));
    utimesSync(oldest, new Date(1_000), new Date(1_000));
    utimesSync(newest, new Date(2_000), new Date(2_000));
    const logger = new DesktopFileLogger(directory, { fileMaxBytes: 20, totalMaxBytes: 200 });
    await logger.setTotalMaxBytes(100);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    await logger.dispose();
  });

  it("没有可删除 ZIP 时停止追加以保持日志总量上限", async () => {
    const directory = logDirectory();
    const pending = join(directory, "desktop-20260825T000000-0001.log");
    writeFileSync(pending, Buffer.alloc(90));
    const logger = new DesktopFileLogger(directory, {
      fileMaxBytes: 20,
      totalMaxBytes: 100,
      archiveDelayMs: 60_000
    });
    logger.write("stderr", "quota-bound-entry");
    await logger.flush();
    const total = readdirSync(directory)
      .filter((name) => name.endsWith(".log") || name.endsWith(".zip"))
      .reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
    expect(total).toBeLessThanOrEqual(100);
    expect(existsSync(join(directory, "desktop.log"))).toBe(false);
    await logger.dispose();
  });

  it("启动时恢复已完成但尚未改名的临时 ZIP", async () => {
    const directory = logDirectory();
    const temporary = join(directory, "desktop-20260825T000000-0001.zip.tmp-recovery");
    const archive = join(directory, "desktop-20260825T000000-0001.zip");
    writeFileSync(temporary, Buffer.from("PK recovered archive"));
    const logger = new DesktopFileLogger(directory, { fileMaxBytes: 20, totalMaxBytes: 200 });
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(archive)).toBe(true);
    await logger.dispose();
  });

  it("只把 Renderer warning 和 error 写入主进程日志", () => {
    expect(rendererConsoleLogLine("selector", {
      level: "info", message: "ready", lineNumber: 1, sourceId: "app://desktop/selector.js"
    })).toBeNull();
    expect(rendererConsoleLogLine("remote-workspace", {
      level: "error", message: "load failed", lineNumber: 9, sourceId: "app://desktop/app.js"
    })).toBe("[renderer:remote-workspace:error] load failed (app://desktop/app.js:9)\n");
    expect(rendererConsoleLogLine("selector", {
      level: "warning", message: "x".repeat(20_100), lineNumber: 2, sourceId: ""
    })).toContain("[truncated] (unknown:2)");
  });
});
