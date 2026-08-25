import { describe, expect, it } from "vitest";
import { formatRemoteMediaBytes, parseRemoteMediaRoute } from "../../src/main/remote-media-cache.js";

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
