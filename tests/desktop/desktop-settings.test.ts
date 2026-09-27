import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopSettingsStore } from "../../src/main/desktop-settings-store.js";
import {
  DEFAULT_DESKTOP_LOG_STORAGE_LIMIT_MIB,
  DEFAULT_DESKTOP_COLOR_THEME,
  DEFAULT_LOCAL_SERVER_PORT,
  DEFAULT_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD,
  DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS,
  LOCAL_SERVER_PORT_SCAN_COUNT,
  LocalServerPortUnavailableError,
  localServerPortCandidates,
  MAX_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD,
  MIN_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD,
  selectLocalServerPort
} from "../../src/shared/desktop-settings-contract.js";

describe("Desktop 系统设置与本地端口", () => {
  it("默认使用 20000 以上端口并持久化用户设置", () => {
    const path = join(tmpdir(), `scriverse-desktop-settings-${process.pid}-${crypto.randomUUID()}`, "settings.json");
    const store = new DesktopSettingsStore(path);
    expect(store.get()).toEqual({
      localServerPort: DEFAULT_LOCAL_SERVER_PORT,
      logStorageLimitMiB: DEFAULT_DESKTOP_LOG_STORAGE_LIMIT_MIB,
      colorTheme: DEFAULT_DESKTOP_COLOR_THEME,
      remoteServerUnreachableFailureThreshold: DEFAULT_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD,
      updatedAt: null
    });
    const updated = store.update({
      colorTheme: DEFAULT_DESKTOP_COLOR_THEME,
      localServerPort: 24_321,
      logStorageLimitMiB: 2_048,
      remoteServerUnreachableFailureThreshold: 2
    });
    expect(updated).toMatchObject({
      localServerPort: 24_321,
      logStorageLimitMiB: 2_048,
      colorTheme: DEFAULT_DESKTOP_COLOR_THEME,
      remoteServerUnreachableFailureThreshold: 2,
      updatedAt: expect.any(String)
    });
    expect(new DesktopSettingsStore(path).get()).toEqual(updated);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 1,
      localServerPort: 24_321,
      logStorageLimitMiB: 2_048,
      colorTheme: DEFAULT_DESKTOP_COLOR_THEME,
      remoteServerUnreachableFailureThreshold: 2
    });
    expect(store.update({ colorTheme: DEFAULT_DESKTOP_COLOR_THEME, localServerPort: 20_001, logStorageLimitMiB: 500, remoteServerUnreachableFailureThreshold: 3 }).localServerPort).toBe(20_001);
    expect(store.update({ colorTheme: DEFAULT_DESKTOP_COLOR_THEME, localServerPort: 60_000, logStorageLimitMiB: 500, remoteServerUnreachableFailureThreshold: 3 }).localServerPort).toBe(60_000);
    expect(() => store.update({ colorTheme: DEFAULT_DESKTOP_COLOR_THEME, localServerPort: 20_000, logStorageLimitMiB: 500, remoteServerUnreachableFailureThreshold: 3 })).toThrowError(/20001/u);
    expect(() => store.update({ colorTheme: DEFAULT_DESKTOP_COLOR_THEME, localServerPort: 60_001, logStorageLimitMiB: 500, remoteServerUnreachableFailureThreshold: 3 })).toThrowError(/60000/u);
    expect(() => store.update({ colorTheme: DEFAULT_DESKTOP_COLOR_THEME, localServerPort: 23_241.5, logStorageLimitMiB: 500, remoteServerUnreachableFailureThreshold: 3 })).toThrowError(/整数/u);
  });

  it("只接受白天和黑夜模式，并随系统设置一并持久化", () => {
    const path = join(tmpdir(), `scriverse-desktop-theme-settings-${process.pid}-${crypto.randomUUID()}`, "settings.json");
    const store = new DesktopSettingsStore(path);
    expect(store.update({ colorTheme: "dark", localServerPort: DEFAULT_LOCAL_SERVER_PORT, logStorageLimitMiB: 500, remoteServerUnreachableFailureThreshold: 3 }).colorTheme).toBe("dark");
    expect(new DesktopSettingsStore(path).get().colorTheme).toBe("dark");
    expect(() => store.update({ colorTheme: "auto", localServerPort: DEFAULT_LOCAL_SERVER_PORT, logStorageLimitMiB: 500, remoteServerUnreachableFailureThreshold: 3 })).toThrowError(/白天或黑夜/u);
  });

  it("仅接受五档日志空间上限并拒绝其他大小", () => {
    const path = join(tmpdir(), `scriverse-desktop-log-settings-${process.pid}-${crypto.randomUUID()}`, "settings.json");
    const store = new DesktopSettingsStore(path);
    for (const logStorageLimitMiB of DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS) {
      expect(store.update({ colorTheme: DEFAULT_DESKTOP_COLOR_THEME, localServerPort: DEFAULT_LOCAL_SERVER_PORT, logStorageLimitMiB, remoteServerUnreachableFailureThreshold: 3 }).logStorageLimitMiB).toBe(logStorageLimitMiB);
    }
    for (const invalid of [0, 499, 1_000, 4_096, 10_241, "500"]) {
      expect(() => store.update({ colorTheme: DEFAULT_DESKTOP_COLOR_THEME, localServerPort: DEFAULT_LOCAL_SERVER_PORT, logStorageLimitMiB: invalid, remoteServerUnreachableFailureThreshold: 3 })).toThrowError(
        /500 MB、1 GB、2 GB、5 GB 或 10 GB/u
      );
    }
    expect(() => store.update({ colorTheme: DEFAULT_DESKTOP_COLOR_THEME, localServerPort: DEFAULT_LOCAL_SERVER_PORT })).toThrowError(/设置请求无效/u);
  });

  it("支持设置远端 Server 不可达连续失败次数", () => {
    const path = join(tmpdir(), `scriverse-desktop-network-settings-${process.pid}-${crypto.randomUUID()}`, "settings.json");
    const store = new DesktopSettingsStore(path);
    expect(store.update({
      colorTheme: DEFAULT_DESKTOP_COLOR_THEME,
      localServerPort: DEFAULT_LOCAL_SERVER_PORT,
      logStorageLimitMiB: 500,
      remoteServerUnreachableFailureThreshold: 2
    }).remoteServerUnreachableFailureThreshold).toBe(2);
    expect(new DesktopSettingsStore(path).get().remoteServerUnreachableFailureThreshold).toBe(2);
    for (const invalid of [0, MAX_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD + 1, 1.5, "3"]) {
      expect(() => store.update({
        colorTheme: DEFAULT_DESKTOP_COLOR_THEME,
        localServerPort: DEFAULT_LOCAL_SERVER_PORT,
        logStorageLimitMiB: 500,
        remoteServerUnreachableFailureThreshold: invalid
      })).toThrowError(new RegExp(`${MIN_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD} 到 ${MAX_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD}`, "u"));
    }
  });

  it("已有端口设置在缺少日志上限时使用新的 500 MB 默认值", () => {
    const directory = join(tmpdir(), `scriverse-desktop-legacy-settings-${process.pid}-${crypto.randomUUID()}`);
    const path = join(directory, "settings.json");
    mkdirSync(directory, { recursive: true });
    const updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify({ version: 1, localServerPort: 24_321, updatedAt }));
    expect(new DesktopSettingsStore(path).get()).toEqual({
      localServerPort: 24_321,
      logStorageLimitMiB: 500,
      colorTheme: DEFAULT_DESKTOP_COLOR_THEME,
      remoteServerUnreachableFailureThreshold: DEFAULT_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD,
      updatedAt
    });
  });

  it("将旧版 20001 以下端口安全迁移回当前默认端口", () => {
    const directory = join(tmpdir(), `scriverse-desktop-legacy-port-${process.pid}-${crypto.randomUUID()}`);
    const path = join(directory, "settings.json");
    mkdirSync(directory, { recursive: true });
    const updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify({ version: 1, localServerPort: 10_000, logStorageLimitMiB: 500, updatedAt }));
    expect(new DesktopSettingsStore(path).get()).toEqual({
      localServerPort: DEFAULT_LOCAL_SERVER_PORT,
      logStorageLimitMiB: 500,
      colorTheme: DEFAULT_DESKTOP_COLOR_THEME,
      remoteServerUnreachableFailureThreshold: DEFAULT_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD,
      updatedAt
    });
  });

  it("从首选端口开始最多尝试 20 个连续端口", async () => {
    expect(localServerPortCandidates(24_321)).toEqual(Array.from(
      { length: LOCAL_SERVER_PORT_SCAN_COUNT },
      (_value, offset) => 24_321 + offset
    ));
    const canBind = vi.fn(async (port: number) => port >= 24_323);
    await expect(selectLocalServerPort(24_321, canBind)).resolves.toBe(24_323);
    expect(canBind).toHaveBeenCalledTimes(3);
    expect(localServerPortCandidates(59_990)).toEqual(Array.from({ length: 11 }, (_value, offset) => 59_990 + offset));
    expect(localServerPortCandidates(60_000)).toEqual([60_000]);
  });

  it("20 个端口都失败时只报告最初配置的端口", async () => {
    const canBind = vi.fn(async () => false);
    const error = await selectLocalServerPort(24_321, canBind).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LocalServerPortUnavailableError);
    expect(error.message).toContain("24321");
    expect(error.message).not.toContain("24322");
    expect(error.message).not.toContain("24340");
    expect(canBind).toHaveBeenCalledTimes(LOCAL_SERVER_PORT_SCAN_COUNT);
  });
});
