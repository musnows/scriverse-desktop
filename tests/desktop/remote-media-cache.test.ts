import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";
import { formatRemoteMediaBytes, parseRemoteMediaRoute, RemoteMediaCache } from "../../src/main/remote-media-cache.js";
import { remotePartition, type RemoteWorkspaceProfile } from "../../src/shared/contracts.js";

function mediaFixture() {
  const id = randomUUID();
  const profile: RemoteWorkspaceProfile = {
    id,
    name: "测试 Server",
    kind: "remote",
    origin: "https://server.example",
    partition: remotePartition(id),
    createdAt: "2026-10-11T00:00:00.000Z",
    lastUsedAt: null,
    capabilities: null
  };
  const cache = new RemoteMediaCache(join(process.cwd(), ".ai-docs", "remote-media-cache-tests", id));
  return { profile, cache };
}

function mediaSession(fetchImpl: typeof fetch): Session {
  return { fetch: fetchImpl } as unknown as Session;
}

describe("Desktop 远端图片缓存路由", () => {
  it("只接受 Server 定义的封面、作品图片和用户头像地址", () => {
    expect(parseRemoteMediaRoute("/api/works/work_1/cover?v=2026-08-25")).toEqual({
      kind: "cover",
      path: "/api/works/work_1/cover?v=2026-08-25",
      key: "/api/works/work_1/cover?v=2026-08-25",
      subjectId: "work_1"
    });
    expect(parseRemoteMediaRoute("/api/attachments/attachment_1/content")).toMatchObject({
      kind: "attachment",
      subjectId: "attachment_1"
    });
    expect(parseRemoteMediaRoute("/api/characters/character_1/avatar?v=hash")).toMatchObject({
      kind: "character-avatar",
      subjectId: "character_1"
    });
    expect(parseRemoteMediaRoute("/api/user-avatars/22222222-2222-4222-8222-222222222222?v=hash")).toMatchObject({
      kind: "user-avatar",
      subjectId: "22222222-2222-4222-8222-222222222222"
    });
  });

  it("拒绝外部地址、路径穿越和非图片 API", () => {
    expect(parseRemoteMediaRoute("https://example.com/image.png")).toBeNull();
    expect(parseRemoteMediaRoute("/api/attachments/../secret/content")).toBeNull();
    expect(parseRemoteMediaRoute("/api/auth/session")).toBeNull();
    expect(parseRemoteMediaRoute("/api/user-avatars/not-a-user")).toBeNull();
  });

  it("以用户可读的单位显示图片磁盘占用估算", () => {
    expect(formatRemoteMediaBytes(0)).toBe("0 B");
    expect(formatRemoteMediaBytes(2_048)).toBe("2.00 KB");
    expect(formatRemoteMediaBytes(12 * 1024 * 1024)).toBe("12.0 MB");
  });
});

describe("Desktop 图片缓存模块权限", () => {
  it("角色模块不可读时仍列出并下载可读的作品图片", async () => {
    const { profile, cache } = mediaFixture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/characters")) {
        return Response.json({ error: { code: "WORK_MODULE_READ_DENIED" } }, { status: 403 });
      }
      if (path.endsWith("/attachments")) {
        return Response.json({ data: { items: [{ contentUrl: "/api/attachments/image_1/content", storedByteLength: 3 }], hasMore: false } });
      }
      if (path === "/api/attachments/image_1/content") {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      }
      return Response.json({ data: { title: "权限测试" } });
    });
    const session = mediaSession(fetchImpl);
    expect(await cache.describeWorkImages(session, profile, "work_1")).toMatchObject({ imageCount: 1, totalBytes: 3 });
    expect(await cache.downloadWorkImages(session, profile, "work_1")).toMatchObject({ imageCount: 1, downloadedCount: 1 });
    expect(await cache.describeWorkImages(session, profile, "work_1")).toMatchObject({ alreadyCachedCount: 1, additionalBytes: 0 });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("/avatar"))).toHaveLength(0);
  });

  it.each([
    [401, "AUTH_REQUIRED", "characters"],
    [403, "WORK_ACCESS_DENIED", "characters"],
    [500, "INTERNAL_ERROR", "characters"],
    [401, "WORK_MODULE_READ_DENIED", "characters"],
    [403, "WORK_MODULE_READ_DENIED", "work"]
  ])("保留 HTTP %s 的 %s 错误（%s）", async (status, code, target) => {
    const { profile, cache } = mediaFixture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (target === "work" || path.endsWith("/characters")) {
        return Response.json({ error: { code } }, { status });
      }
      return Response.json({ data: path.endsWith("/attachments") ? { items: [], hasMore: false } : { title: "权限测试" } });
    });
    await expect(cache.describeWorkImages(mediaSession(fetchImpl), profile, "work_1")).rejects.toMatchObject({
      code: target === "work" ? "WORK_MODULE_READ_DENIED" : "REMOTE_MEDIA_REQUEST_FAILED"
    });
  });

  it("作品图片模块不可读时仍估算可读的角色头像", async () => {
    const { profile, cache } = mediaFixture();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/attachments")) {
        return Response.json({ error: { code: "WORK_MODULE_READ_DENIED" } }, { status: 403 });
      }
      if (path.endsWith("/characters")) {
        return Response.json({ data: { items: [{ avatarUrl: "/api/characters/character_1/avatar" }], hasMore: false } });
      }
      if (path.endsWith("/avatar") && init?.method === "HEAD") {
        return new Response(null, { headers: { "content-type": "image/png", "content-length": "12" } });
      }
      return Response.json({ data: { title: "权限测试" } });
    });
    expect(await cache.describeWorkImages(mediaSession(fetchImpl), profile, "work_1")).toMatchObject({ imageCount: 1, totalBytes: 12 });
  });
});
