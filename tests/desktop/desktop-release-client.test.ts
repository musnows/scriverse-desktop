import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_RELEASE_API_URL, DESKTOP_RELEASE_MAX_BYTES, fetchDesktopUpdateRelease, parseDesktopUpdateRelease } from "../../src/main/desktop-release-client.js";

const root = "https://github.com/musnows/scriverse-desktop/releases";
const assetCdn = "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset?token=public";
function release(version = "1.2.0.2", arch = "x64", platform = "win32") {
  const name = platform === "darwin"
    ? `scriverse-desktop-macos-darwin-${arch}-${version}.dmg`
    : `scriverse-desktop-windows-win32-${arch}-${version}-Setup.exe`;
  return {
    tag_name: `v${version}`, draft: false, prerelease: false, html_url: `${root}/tag/v${version}`,
    assets: [{ name, state: "uploaded", size: 100, browser_download_url: `${root}/download/v${version}/${name}` }]
  };
}

function rateLimitFetch(version = "1.2.0.2", location = `${root}/tag/v${version}`, assetLocation = assetCdn, size = 100) {
  return vi.fn(async (_url: string, _init: RequestInit) => new Response(null))
    .mockResolvedValueOnce(new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } }))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: assetLocation } }))
    .mockResolvedValueOnce(new Response(null, { headers: { "content-length": String(size) } }));
}

afterEach(() => vi.useRealTimers());

describe("Desktop 正式版本检查", () => {
  it.each(["arm64", "x64"])("仅选择 macOS %s 对应的 DMG 安装包", (arch) => {
    const value = release("1.2.0.2", arch, "darwin");
    expect(parseDesktopUpdateRelease(value, "1.2.0.1", "darwin", arch)).toEqual({ version: "1.2.0.2", downloadUrl: value.assets[0].browser_download_url });
    expect(() => parseDesktopUpdateRelease(value, "1.2.0.1", "darwin", arch === "x64" ? "arm64" : "x64")).toThrow(/unavailable/u);
    expect(() => parseDesktopUpdateRelease(release("1.2.0.2", arch), "1.2.0.1", "darwin", arch)).toThrow(/unavailable/u);
  });

  it.each(["arm64", "x64", "ia32"])("仅选择 Windows %s 对应的安装包", (arch) => {
    const value = release("1.2.0.2", arch);
    expect(parseDesktopUpdateRelease(value, "1.2.0.1", "win32", arch)).toEqual({ version: "1.2.0.2", downloadUrl: value.assets[0].browser_download_url });
    expect(() => parseDesktopUpdateRelease(value, "1.2.0.1", "win32", arch === "x64" ? "arm64" : "x64")).toThrow(/unavailable/u);
  });

  it.each([["1.2.0.1", "1.2.0.10"], ["1.2.0.99", "1.2.1.0"], ["1.1.6", "1.2.0.0"]])("正确比较 %s 到 %s 的升级", (current, latest) => {
    expect(parseDesktopUpdateRelease(release(latest), current, "win32", "x64")?.version).toBe(latest);
  });

  it.each([["1.2.0.2", "1.2.0.2"], ["1.2.0.10", "1.2.0.2"], ["1.2.1.0", "1.2.0.99"], ["1.2.0", "1.2.0.0"]])("拒绝 %s 到 %s 的重复升级或降级", (current, latest) => {
    expect(parseDesktopUpdateRelease(release(latest), current, "win32", "x64")).toBeNull();
  });

  it.each(["draft", "prerelease"])("忽略 %s 发布", (field) => {
    expect(parseDesktopUpdateRelease({ ...release(), [field]: true }, "1.2.0.1", "win32", "x64")).toBeNull();
  });

  it.each(["1.2", "1.2.0.2.1", "1.2.0.2-beta.1", "01.2.0.2", "1.2.0.9007199254740992"])("拒绝不合法的正式版本 %s", (version) => {
    expect(() => parseDesktopUpdateRelease(release(version), "1.2.0.1", "win32", "x64")).toThrow(/version/u);
  });

  it.each(["http://github.com/file.exe", "https://evil.example/file.exe", `${root}/download/v1.2.0.2/../file.exe`])("拒绝受控仓库以外的安装包地址 %s", (url) => {
    const value = release();
    value.assets[0].browser_download_url = url;
    expect(() => parseDesktopUpdateRelease(value, "1.2.0.1", "win32", "x64")).toThrow(/installer is invalid/u);
  });

  it("拒绝未完成上传、空安装包和错误的仓库", () => {
    const value = release();
    expect(() => parseDesktopUpdateRelease({ ...value, assets: [{ ...value.assets[0], state: "new" }] }, "1.2.0.1", "win32", "x64")).toThrow();
    expect(() => parseDesktopUpdateRelease({ ...value, assets: [{ ...value.assets[0], size: 0 }] }, "1.2.0.1", "win32", "x64")).toThrow();
    expect(() => parseDesktopUpdateRelease({ ...value, html_url: "https://github.com/other/repo" }, "1.2.0.1", "win32", "x64")).toThrow(/repository/u);
    expect(() => parseDesktopUpdateRelease({ ...value, assets: [value.assets[0], value.assets[0]] }, "1.2.0.1", "win32", "x64")).toThrow(/unavailable/u);
  });

  it("从固定 API 读取受限响应且拒绝重定向", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(release())));
    expect(await fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "win32", arch: "x64", fetch })).toMatchObject({ version: "1.2.0.2" });
    expect(fetch).toHaveBeenCalledWith(DESKTOP_RELEASE_API_URL, expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });

  it("网络错误和不完整发布元数据不会被当作最新版本", async () => {
    await expect(fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch: async () => new Response("", { status: 403 }) })).rejects.toThrow(/status 403/u);
    await expect(fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch: async () => new Response("{") })).rejects.toThrow();
    expect(() => parseDesktopUpdateRelease({ ...release("1.2.0.2", "arm64", "darwin"), assets: [] }, "1.2.0.1", "darwin", "arm64")).toThrow(/unavailable/u);
  });

  it.each([true, false])("拒绝超出长度限制的响应，声明长度：%s", async (declared) => {
    const fetch = vi.fn(async () => new Response("x".repeat(DESKTOP_RELEASE_MAX_BYTES + 1), declared ? { headers: { "content-length": String(DESKTOP_RELEASE_MAX_BYTES + 1) } } : undefined));
    await expect(fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "win32", arch: "x64", fetch })).rejects.toThrow(/size limit/u);
  });

  it("超时中止网络请求", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const operation = fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "win32", arch: "x64", fetch });
    const expectation = expect(operation).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
  });
});

describe("GitHub API 限流的公开发布页备用检查", () => {
  it.each([["darwin", "arm64"], ["darwin", "x64"], ["win32", "arm64"], ["win32", "x64"]] as const)("验证 %s/%s 安装包后返回固定仓库下载入口", async (platform, arch) => {
    const fetch = rateLimitFetch();
    const value = release("1.2.0.2", arch, platform);
    expect(await fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform, arch, fetch })).toEqual({ version: "1.2.0.2", downloadUrl: value.assets[0].browser_download_url });
    expect(fetch).toHaveBeenNthCalledWith(2, `${root}/latest`, expect.objectContaining({ method: "HEAD", redirect: "manual", credentials: "omit" }));
    expect(fetch).toHaveBeenNthCalledWith(3, value.assets[0].browser_download_url, expect.objectContaining({ method: "HEAD", redirect: "manual" }));
    expect(fetch).toHaveBeenNthCalledWith(4, assetCdn, expect.objectContaining({ method: "HEAD", redirect: "error" }));
  });

  it.each(["1.2.0.1", "1.1.9.0"])("备用源版本 %s 不触发重复升级或降级", async (version) => {
    const fetch = rateLimitFetch(version);
    expect(await fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["https://evil.example/releases/tag/v1.2.0.2", `${root}/tag/v1.2.0.2-beta.1`, `${root}/tag/v1.2.0.2?redirect=other`])("拒绝不可信或非正式的最新发布重定向 %s", async (location) => {
    const fetch = rateLimitFetch("1.2.0.2", location);
    await expect(fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["http://127.0.0.1/file", "https://evil.example/file", "https://release-assets.githubusercontent.com/other/file", "https://user:password@release-assets.githubusercontent.com/github-production-release-asset/file"])("拒绝不可信的安装包重定向 %s", async (location) => {
    const fetch = rateLimitFetch("1.2.0.2", `${root}/tag/v1.2.0.2`, location);
    await expect(fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch })).rejects.toThrow(/redirect/u);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([0, 2 * 1024 ** 3 + 1])("拒绝大小无效的安装包 %s", async (size) => {
    const fetch = rateLimitFetch("1.2.0.2", `${root}/tag/v1.2.0.2`, assetCdn, size);
    await expect(fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch })).rejects.toThrow(/unavailable/u);
  });

  it("HTTP 429 可以使用备用源，普通权限错误不能绕过", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `${root}/tag/v1.2.0.1` } }));
    expect(await fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch })).toBeNull();
    fetch.mockReset().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch })).rejects.toThrow(/status 403/u);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("备用源网络请求共享超时与中止信号", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })).mockResolvedValueOnce(new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    const operation = fetchDesktopUpdateRelease({ currentVersion: "1.2.0.1", platform: "darwin", arch: "arm64", fetch });
    const expectation = expect(operation).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
