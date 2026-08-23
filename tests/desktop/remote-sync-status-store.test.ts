import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RemoteSyncStatusStore,
  RemoteSyncStatusStoreError
} from "../../src/main/remote-sync-status-store.js";
import { remotePartition, type RemoteWorkspaceProfile } from "../../src/shared/contracts.js";

function fixture(): { directory: string; profile: RemoteWorkspaceProfile } {
  const directory = join(tmpdir(), `scriverse-sync-status-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const id = crypto.randomUUID();
  return {
    directory,
    profile: {
      id,
      name: "测试 Server",
      kind: "remote",
      origin: "https://server.example",
      partition: remotePartition(id),
      createdAt: "2026-08-23T00:00:00.000Z",
      lastUsedAt: null,
      capabilities: null
    }
  };
}

describe("Desktop 远端离线状态存储", () => {
  it("按 profile 和账户持久化并汇总全部未处理数据", () => {
    const { directory, profile } = fixture();
    const firstUserId = crypto.randomUUID();
    const secondUserId = crypto.randomUUID();
    const store = new RemoteSyncStatusStore(directory);
    store.update(profile, firstUserId, {
      dirty: false,
      activeAiRequests: 0,
      pendingMutations: 2,
      conflicts: 1,
      rejected: 3
    });
    store.update(profile, secondUserId, {
      dirty: true,
      activeAiRequests: 1,
      pendingMutations: 4,
      conflicts: 5,
      rejected: 6
    });
    expect(new RemoteSyncStatusStore(directory).user(profile, firstUserId)).toMatchObject({
      userId: firstUserId,
      pendingMutations: 2,
      conflicts: 1,
      rejected: 3
    });
    expect(store.summary(profile)).toMatchObject({
      pendingMutations: 6,
      conflicts: 6,
      rejected: 9,
      userCount: 2
    });
    const source = readFileSync(join(directory, `${profile.id}.json`), "utf8");
    expect(source).not.toContain("dirty");
    expect(source).not.toContain("activeAiRequests");
  });

  it("将已同步账户更新为零并拒绝跨 origin 或损坏状态", () => {
    const { directory, profile } = fixture();
    const userId = crypto.randomUUID();
    const store = new RemoteSyncStatusStore(directory);
    store.update(profile, userId, {
      dirty: false,
      activeAiRequests: 0,
      pendingMutations: 1,
      conflicts: 1,
      rejected: 1
    });
    store.update(profile, userId, {
      dirty: false,
      activeAiRequests: 0,
      pendingMutations: 0,
      conflicts: 0,
      rejected: 0
    });
    expect(store.summary(profile)).toMatchObject({ pendingMutations: 0, conflicts: 0, rejected: 0, userCount: 1 });
    expect(() => store.summary({ ...profile, origin: "https://other.example" })).toThrowError(RemoteSyncStatusStoreError);
    store.clear(profile);
    expect(store.summary(profile)).toEqual({ pendingMutations: 0, conflicts: 0, rejected: 0, userCount: 0, updatedAt: null });
  });
});
