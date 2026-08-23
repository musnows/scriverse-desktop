import { describe, expect, it } from "vitest";
import { defaultDesktopRoot, expandDesktopPath, resolveDesktopPaths } from "../../src/main/app-paths.js";

describe("Desktop 路径", () => {
  it("按平台解析默认数据根目录", () => {
    expect(defaultDesktopRoot({ platform: "darwin", homeDirectory: "/Users/author" })).toBe("/Users/author/Library/Application Support/Scriverse Desktop/data");
    expect(defaultDesktopRoot({ platform: "win32", homeDirectory: "C:\\Users\\author", localAppData: "C:\\Users\\author\\AppData\\Local" })).toBe("C:\\Users\\author\\AppData\\Local\\Scriverse Desktop\\data");
    expect(defaultDesktopRoot({ platform: "linux", homeDirectory: "/home/author", xdgDataHome: "/data/author" })).toBe("/data/author/scriverse-desktop/data");
  });

  it("显式展开波浪号并生成隔离子路径", () => {
    const root = expandDesktopPath("~/Scriverse", "/Users/author");
    expect(root).toBe("/Users/author/Scriverse");
    expect(resolveDesktopPaths(root)).toMatchObject({
      root,
      profiles: "/Users/author/Scriverse/client-meta/profiles.json",
      remoteAuth: "/Users/author/Scriverse/client-meta/remote-auth",
      offlineKeys: "/Users/author/Scriverse/client-meta/offline-keys",
      localAiProviders: "/Users/author/Scriverse/client-meta/local-ai-providers",
      desktopSettings: "/Users/author/Scriverse/client-meta/desktop-settings.json",
      localRuntime: "/Users/author/Scriverse/local-vault/runtime",
      localVaultLock: "/Users/author/Scriverse/local-vault/desktop-vault.lock",
      browserSessions: "/Users/author/Scriverse/browser-sessions"
    });
  });
});
