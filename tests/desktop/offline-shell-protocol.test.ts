import { describe, expect, it } from "vitest";
import { resolveOfflineShellAsset } from "../../src/main/offline-shell-protocol.js";

describe("Desktop 离线网页壳协议", () => {
  const origin = "https://server.example";
  const publicRoot = "/app/dist/public";

  it("将同源根路径和静态资源限制到签入的 public 目录", () => {
    expect(resolveOfflineShellAsset(`${origin}/`, origin, publicRoot)).toEqual({
      path: "/app/dist/public/index.html",
      contentType: "text/html; charset=utf-8"
    });
    expect(resolveOfflineShellAsset(`${origin}/styles.css?v=1`, origin, publicRoot)).toEqual({
      path: "/app/dist/public/styles.css",
      contentType: "text/css; charset=utf-8"
    });
  });

  it("拒绝 API、跨源、路径穿越和非法编码", () => {
    expect(resolveOfflineShellAsset(`${origin}/api/auth/session`, origin, publicRoot)).toBeNull();
    expect(resolveOfflineShellAsset("https://evil.example/app.js", origin, publicRoot)).toBeNull();
    expect(resolveOfflineShellAsset(`${origin}/%2e%2e%2fsecret`, origin, publicRoot)).toBeNull();
    expect(resolveOfflineShellAsset(`${origin}/%00secret`, origin, publicRoot)).toBeNull();
    expect(resolveOfflineShellAsset(`${origin}/%E0%A4%A`, origin, publicRoot)).toBeNull();
  });
});
