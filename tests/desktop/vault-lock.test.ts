import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { acquireLocalVaultLock, LocalVaultLockError } from "../../src/main/vault-lock.js";

function paths(label: string): { directory: string; lockPath: string; databasePath: string } {
  const directory = join(tmpdir(), `scriverse-vault-lock-${label}-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return { directory, lockPath: join(directory, "desktop-vault.lock"), databasePath: join(directory, "novel.db") };
}

function staleLock(lockPath: string, desktopId: string): void {
  writeFileSync(lockPath, JSON.stringify({
    version: 1,
    desktopId,
    bootId: crypto.randomUUID(),
    pid: 2_147_483_647,
    startedAt: "2026-08-23T00:00:00.000Z"
  }));
}

describe("Desktop 本地 vault 单写锁", () => {
  it("持有锁时拒绝第二个进程并在释放后允许重新获取", () => {
    const target = paths("active");
    const desktopId = crypto.randomUUID();
    const first = acquireLocalVaultLock({ ...target, desktopId });
    expect(JSON.parse(readFileSync(target.lockPath, "utf8"))).toMatchObject({ desktopId, pid: process.pid });
    expect(() => acquireLocalVaultLock({ ...target, desktopId })).toThrowError(LocalVaultLockError);
    first.release();
    const second = acquireLocalVaultLock({ ...target, desktopId });
    expect(second.bootId).not.toBe(first.bootId);
    second.release();
  });

  it("仅在原进程不存在且 SQLite 可取得写锁时接管 stale lock", () => {
    const target = paths("stale");
    const desktopId = crypto.randomUUID();
    const database = new DatabaseSync(target.databasePath);
    database.exec("CREATE TABLE lock_test (value INTEGER); BEGIN IMMEDIATE;");
    staleLock(target.lockPath, desktopId);
    expect(() => acquireLocalVaultLock({ ...target, desktopId })).toThrowError(/数据库仍被其他进程占用/u);
    database.exec("ROLLBACK");
    database.close();
    const acquired = acquireLocalVaultLock({ ...target, desktopId });
    acquired.release();
  });

  it("损坏的 stale lock 不会被静默覆盖", () => {
    const target = paths("invalid");
    writeFileSync(target.lockPath, "not-json");
    expect(() => acquireLocalVaultLock({ ...target, desktopId: crypto.randomUUID() })).toThrowError(/锁文件损坏/u);
  });
});
