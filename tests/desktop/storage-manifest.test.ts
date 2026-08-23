import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_LOCAL_VAULT_STORAGE_KIND,
  DESKTOP_ROOT_STORAGE_KIND,
  DesktopStorageError,
  initializeDesktopLocalVault,
  initializeDesktopStorageRoot,
  STORAGE_MANIFEST_FILENAME
} from "../../src/shared/storage-manifest.js";

function testDirectory(label: string): string {
  return join(tmpdir(), `scriverse-desktop-storage-${label}-${process.pid}-${crypto.randomUUID()}`);
}

describe("Desktop 存储清单", () => {
  it("创建配对的 Desktop 根目录和 local-vault", () => {
    const root = testDirectory("fresh");
    const rootManifest = initializeDesktopStorageRoot(root);
    const vaultManifest = initializeDesktopLocalVault(join(root, "local-vault"), rootManifest.desktopId);
    expect(rootManifest.kind).toBe(DESKTOP_ROOT_STORAGE_KIND);
    expect(vaultManifest).toMatchObject({
      kind: DESKTOP_LOCAL_VAULT_STORAGE_KIND,
      desktopId: rootManifest.desktopId
    });
    expect(initializeDesktopStorageRoot(root)).toEqual(rootManifest);
    expect(initializeDesktopLocalVault(join(root, "local-vault"), rootManifest.desktopId)).toEqual(vaultManifest);
  });

  it("拒绝 Server 数据目录和无清单的既有数据库", () => {
    const serverRoot = testDirectory("server-kind");
    mkdirSync(serverRoot, { recursive: true });
    writeFileSync(join(serverRoot, STORAGE_MANIFEST_FILENAME), JSON.stringify({
      kind: "scriverse-server-data",
      storageVersion: 1,
      serverId: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    }));
    expect(() => initializeDesktopStorageRoot(serverRoot)).toThrowError(DesktopStorageError);

    const root = testDirectory("unclaimed-vault");
    const rootManifest = initializeDesktopStorageRoot(root);
    const vault = join(root, "local-vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "novel.db"), "not-a-desktop-database");
    expect(() => initializeDesktopLocalVault(vault, rootManifest.desktopId)).toThrowError(/非空目录/u);
  });

  it("拒绝其他 Desktop 实例的 local-vault", () => {
    const root = testDirectory("foreign-vault");
    const rootManifest = initializeDesktopStorageRoot(root);
    const vault = join(root, "local-vault");
    initializeDesktopLocalVault(vault, rootManifest.desktopId);
    expect(() => initializeDesktopLocalVault(vault, crypto.randomUUID())).toThrowError(/当前 Scriverse Desktop/u);
  });
});
