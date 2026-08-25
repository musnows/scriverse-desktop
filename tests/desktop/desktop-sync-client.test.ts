import { describe, expect, it } from "vitest";
import { DesktopSyncClient } from "../../runtime-overlay/public/desktop-sync-client.js";

function response(data, status = 200) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("Desktop 离线副本下载进度", () => {
  it("按快照条目数报告下载和保存阶段", async () => {
    const progress = [];
    const client = new DesktopSyncClient({
      bridge: { shell: { reportLeaveState: async () => undefined } },
      profile: { profileId: "profile-1" },
      user: { userId: "user-1" },
      pollIntervalMs: 0,
      store: {
        listWorks: async () => [],
        replaceSnapshot: async () => ({ workId: "work-1" }),
        close: () => undefined
      },
      fetchImpl: async (path, init) => {
        if (path === "/api/sync/works/work-1/snapshots" && init.method === "POST") {
          return response({ snapshotId: "snapshot-1", cutoffCursor: 8, itemCount: 3 });
        }
        if (path === "/api/sync/snapshots/snapshot-1/items?after=0&limit=100") {
          return response({ items: [{ sequence: 1 }, { sequence: 2 }], nextAfter: 2, hasMore: true });
        }
        if (path === "/api/sync/snapshots/snapshot-1/items?after=2&limit=100") {
          return response({ items: [{ sequence: 3 }], nextAfter: null, hasMore: false });
        }
        if (path === "/api/sync/snapshots/snapshot-1" && init.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${path}`);
      }
    });

    await client.downloadWork({ id: "work-1", offlineAccessEnabled: true }, {
      onProgress: (update) => progress.push(update)
    });

    expect(progress).toEqual([
      { phase: "downloading", completed: 0, total: 3 },
      { phase: "downloading", completed: 2, total: 3 },
      { phase: "downloading", completed: 3, total: 3 },
      { phase: "saving", completed: 3, total: 3 }
    ]);
    client.dispose();
  });
});
