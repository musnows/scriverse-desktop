import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopSettingsStore } from "../../src/main/desktop-settings-store.js";
import {
  DEFAULT_DESKTOP_LOG_STORAGE_LIMIT_MIB,
  DEFAULT_LOCAL_SERVER_PORT,
  DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS,
  LOCAL_SERVER_PORT_SCAN_COUNT,
  LocalServerPortUnavailableError,
  localServerPortCandidates,
  selectLocalServerPort
} from "../../src/shared/desktop-settings-contract.js";

describe("Desktop 系统设置与本地端口", () => {
  it("默认使用 20000 以上端口并持久化用户设置", () => {
    const path = join(tmpdir(), `scriverse-desktop-settings-${process.pid}-${crypto.randomUUID()}`, "settings.json");
    const store = new DesktopSettingsStore(path);
    expect(store.get()).toEqual({
      localServerPort: DEFAULT_LOCAL_SERVER_PORT,
      logStorageLimitMiB: DEFAULT_DESKTOP_LOG_STORAGE_LIMIT_MIB,
      updatedAt: null
    });
    const updated = store.update({ localServerPort: 24_321, logStorageLimitMiB: 2_048 });
    expect(updated).toMatchObject({ localServerPort: 24_321, logStorageLimitMiB: 2_048, updatedAt: expect.any(String) });
    expect(new DesktopSettingsStore(path).get()).toEqual(updated);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, localServerPort: 24_321, logStorageLimitMiB: 2_048 });
    expect(() => store.update({ localServerPort: 20_000, logStorageLimitMiB: 500 })).toThrowError(/20001/u);
  });

  it("仅接受五档日志空间上限并拒绝其他大小", () => {
    const path = join(tmpdir(), `scriverse-desktop-log-settings-${process.pid}-${crypto.randomUUID()}`, "settings.json");
    const store = new DesktopSettingsStore(path);
    for (const logStorageLimitMiB of DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS) {
      expect(store.update({ localServerPort: DEFAULT_LOCAL_SERVER_PORT, logStorageLimitMiB }).logStorageLimitMiB).toBe(logStorageLimitMiB);
    }
    for (const invalid of [0, 499, 1_000, 4_096, 10_241, "500"]) {
      expect(() => store.update({ localServerPort: DEFAULT_LOCAL_SERVER_PORT, logStorageLimitMiB: invalid })).toThrowError(
        /500 MB、1 GB、2 GB、5 GB 或 10 GB/u
      );
    }
    expect(() => store.update({ localServerPort: DEFAULT_LOCAL_SERVER_PORT })).toThrowError(/设置请求无效/u);
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
