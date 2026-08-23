import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore, ProfileStoreError } from "../../src/main/profile-store.js";
import { LOCAL_PROFILE_ID, LOCAL_PROFILE_PARTITION } from "../../src/shared/contracts.js";

function profilePath(label: string): string {
  const directory = join(tmpdir(), `scriverse-profile-store-${label}-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return join(directory, "profiles.json");
}

describe("Desktop profile 存储", () => {
  it("持久化本地和多个远端 profile", () => {
    const path = profilePath("persist");
    const store = new ProfileStore(path);
    expect(store.list()[0]).toMatchObject({ id: LOCAL_PROFILE_ID, partition: LOCAL_PROFILE_PARTITION, kind: "local" });
    const first = store.createRemote({ name: "主 Server", origin: "https://example.com/" });
    const second = store.createRemote({ name: "局域网", origin: "http://192.168.1.20:13210" });
    expect(first.partition).toBe(`persist:scriverse-remote-${first.id}`);
    expect(new ProfileStore(path).list()).toEqual([store.get(LOCAL_PROFILE_ID), first, second]);
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("password");
  });

  it("改名保留 partition，修改 origin 创建新 partition", () => {
    const path = profilePath("update");
    const store = new ProfileStore(path);
    const created = store.createRemote({ name: "旧名称", origin: "https://one.example" });
    const renamed = store.updateRemote(created.id, { name: "新名称", origin: created.origin });
    expect(renamed).toMatchObject({ id: created.id, partition: created.partition, name: "新名称" });
    const moved = store.updateRemote(created.id, { name: "新 Server", origin: "https://two.example" });
    expect(moved.id).not.toBe(created.id);
    expect(moved.partition).not.toBe(created.partition);
    expect(moved.capabilities).toBeNull();
  });

  it("拒绝重复 origin、非法名称和删除本地 profile", () => {
    const store = new ProfileStore(profilePath("validation"));
    store.createRemote({ name: "Server A", origin: "https://example.com" });
    expect(() => store.createRemote({ name: "Server B", origin: "https://EXAMPLE.com/" })).toThrowError(/已经存在/u);
    expect(() => store.createRemote({ name: " ", origin: "https://other.example" })).toThrowError(ProfileStoreError);
    expect(() => store.removeRemote(LOCAL_PROFILE_ID)).toThrowError(ProfileStoreError);
  });

  it("返回副本并持久化最近使用时间", () => {
    const path = profilePath("copy");
    const store = new ProfileStore(path);
    const listed = store.list();
    listed[0]!.name = "外部篡改";
    expect(store.get(LOCAL_PROFILE_ID).name).toBe("本地工作区");
    expect(store.markUsed(LOCAL_PROFILE_ID, "2026-08-23T00:00:00.000Z").lastUsedAt).toBe("2026-08-23T00:00:00.000Z");
    expect(new ProfileStore(path).get(LOCAL_PROFILE_ID).lastUsedAt).toBe("2026-08-23T00:00:00.000Z");
  });

  it("严格持久化 Server 协议能力与兼容结论", () => {
    const path = profilePath("capabilities");
    const store = new ProfileStore(path);
    const profile = store.createRemote({ name: "Server", origin: "https://server.example" });
    const updated = store.updateCapabilities(profile.id, {
      checkedAt: "2026-08-23T00:00:00.000Z",
      product: "scriverse",
      serverVersion: "0.8.7",
      webAssetVersion: "0.8.7",
      shellProtocol: { min: 1, max: 1 },
      syncProtocol: { min: 1, max: 1, entityTypes: ["chapter", "setting"], maxMutationBytes: 2_500_000 },
      minimumDesktopVersion: "0.1.0",
      compatibility: "compatible"
    });
    expect(updated.capabilities?.syncProtocol?.entityTypes).toEqual(["chapter", "setting"]);
    expect(new ProfileStore(path).get(profile.id)).toEqual(updated);
  });
});
