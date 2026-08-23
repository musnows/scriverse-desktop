import { describe, expect, it } from "vitest";
import {
  cloneSyncSnapshot,
  desktopSyncDatabaseName
} from "../../runtime-overlay/public/desktop-sync-store.js";

describe("Desktop 离线明文快照", () => {
  it("使用全新 v2 数据库并只复制原始对象", async () => {
    const profileId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";
    expect(desktopSyncDatabaseName(profileId, userId)).toBe(`scriverse-desktop-sync-v2-${profileId}-${userId}`);
    const source = { id: "chapter-1", content: "本机明文正文", nested: { versionNo: 2 } };
    const cloned = await cloneSyncSnapshot(source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned.nested).not.toBe(source.nested);
  });
});
