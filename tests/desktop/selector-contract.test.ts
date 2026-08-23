import { describe, expect, it } from "vitest";
import {
  assertRemoteProfileDataDisposition,
  parseCreateRemoteProfileInput,
  parseProfileId,
  parseRemoveRemoteProfileInput,
  parseUpdateRemoteProfileInput,
  sortProfilesForSelector
} from "../../src/shared/selector-contract.js";
import { LOCAL_PROFILE_ID, LOCAL_PROFILE_PARTITION, remotePartition, type WorkspaceProfile } from "../../src/shared/contracts.js";

function profiles(): WorkspaceProfile[] {
  return [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "从未使用",
      kind: "remote",
      origin: "https://unused.example",
      partition: remotePartition("11111111-1111-4111-8111-111111111111"),
      createdAt: "2026-08-20T00:00:00.000Z",
      lastUsedAt: null,
      capabilities: null
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "最近使用",
      kind: "remote",
      origin: "https://recent.example",
      partition: remotePartition("22222222-2222-4222-8222-222222222222"),
      createdAt: "2026-08-21T00:00:00.000Z",
      lastUsedAt: "2026-08-23T00:00:00.000Z",
      capabilities: null
    },
    {
      id: LOCAL_PROFILE_ID,
      name: "本地工作区",
      kind: "local",
      origin: null,
      partition: LOCAL_PROFILE_PARTITION,
      createdAt: "2026-08-19T00:00:00.000Z",
      lastUsedAt: null,
      capabilities: null
    }
  ];
}

describe("Selector IPC 输入契约", () => {
  it("严格解析新增和修改请求", () => {
    expect(parseCreateRemoteProfileInput({ name: " 主站 ", origin: "https://example.com" })).toEqual({
      name: "主站",
      origin: "https://example.com"
    });
    expect(parseUpdateRemoteProfileInput({
      id: "22222222-2222-4222-8222-222222222222",
      name: "新名称",
      origin: "https://example.com",
      discardUnsynced: false
    })).toMatchObject({ id: "22222222-2222-4222-8222-222222222222", name: "新名称", discardUnsynced: false });
    expect(parseRemoveRemoteProfileInput({
      id: "22222222-2222-4222-8222-222222222222",
      discardUnsynced: true
    })).toEqual({ id: "22222222-2222-4222-8222-222222222222", discardUnsynced: true });
    expect(() => parseRemoveRemoteProfileInput({ id: "22222222-2222-4222-8222-222222222222" })).toThrow();
    expect(() => parseCreateRemoteProfileInput({ name: "主站", origin: "https://example.com", password: "secret" })).toThrowError(/未知字段/u);
    expect(() => parseCreateRemoteProfileInput({ name: "x".repeat(81), origin: "https://example.com" })).toThrowError(/80/u);
    expect(() => parseProfileId("../../profiles.json")).toThrowError(/id 无效/u);
  });

  it("按本地、最近使用远端、其他远端排序且不修改输入", () => {
    const input = profiles();
    expect(sortProfilesForSelector(input).map((profile) => profile.name)).toEqual(["本地工作区", "最近使用", "从未使用"]);
    expect(input[0]?.name).toBe("从未使用");
  });

  it("有任一账户待同步、冲突或只读修改时要求二次确认", () => {
    const status = { pendingMutations: 2, conflicts: 3, rejected: 4 };
    expect(() => assertRemoteProfileDataDisposition(status, false)).toThrowError(
      expect.objectContaining({ code: "PROFILE_UNSYNCED_DATA" })
    );
    expect(() => assertRemoteProfileDataDisposition(status, true)).not.toThrow();
    expect(() => assertRemoteProfileDataDisposition({ pendingMutations: 0, conflicts: 0, rejected: 0 }, false)).not.toThrow();
    expect(() => assertRemoteProfileDataDisposition({ pendingMutations: -1, conflicts: 0, rejected: 0 }, true)).toThrow();
  });
});
