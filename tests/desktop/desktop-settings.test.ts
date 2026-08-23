import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopSettingsStore } from "../../src/main/desktop-settings-store.js";
import {
  DEFAULT_LOCAL_SERVER_PORT,
  LOCAL_SERVER_PORT_SCAN_COUNT,
  LocalServerPortUnavailableError,
  localServerPortCandidates,
  selectLocalServerPort
} from "../../src/shared/desktop-settings-contract.js";

describe("Desktop 系统设置与本地端口", () => {
  it("默认使用 20000 以上端口并持久化用户设置", () => {
    const path = join(tmpdir(), `scriverse-desktop-settings-${process.pid}-${crypto.randomUUID()}`, "settings.json");
    const store = new DesktopSettingsStore(path);
    expect(store.get()).toEqual({ localServerPort: DEFAULT_LOCAL_SERVER_PORT, updatedAt: null });
    const updated = store.update({ localServerPort: 24_321 });
    expect(updated).toMatchObject({ localServerPort: 24_321, updatedAt: expect.any(String) });
    expect(new DesktopSettingsStore(path).get()).toEqual(updated);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, localServerPort: 24_321 });
    expect(() => store.update({ localServerPort: 20_000 })).toThrowError(/20001/u);
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
