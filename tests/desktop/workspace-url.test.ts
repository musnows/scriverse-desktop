import { describe, expect, it } from "vitest";
import { isAllowedWorkspaceNavigation, normalizeLocalWorkspaceOrigin } from "../../src/shared/workspace-url.js";

describe("Desktop 本地工作区导航", () => {
  it("只接受随机端口上的 IPv4 回环 origin", () => {
    expect(normalizeLocalWorkspaceOrigin("http://127.0.0.1:24321")).toBe("http://127.0.0.1:24321");
    expect(() => normalizeLocalWorkspaceOrigin("http://localhost:24321")).toThrowError(/origin/u);
    expect(() => normalizeLocalWorkspaceOrigin("https://127.0.0.1:24321")).toThrowError(/origin/u);
    expect(() => normalizeLocalWorkspaceOrigin("http://127.0.0.1:24321/path")).toThrowError(/origin/u);
  });

  it("允许同源页面路径并阻止跨源、凭据和非法 URL", () => {
    const origin = "http://127.0.0.1:24321";
    expect(isAllowedWorkspaceNavigation(`${origin}/works/one`, origin)).toBe(true);
    expect(isAllowedWorkspaceNavigation(`${origin}/?view=shelf#top`, origin)).toBe(true);
    expect(isAllowedWorkspaceNavigation("https://example.com", origin)).toBe(false);
    expect(isAllowedWorkspaceNavigation("http://user:pass@127.0.0.1:24321/", origin)).toBe(false);
    expect(isAllowedWorkspaceNavigation("not a URL", origin)).toBe(false);
  });
});
