import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), request: vi.fn() }));
vi.mock("electron", () => ({ net: mocks }));
import { fetchDesktopReleaseResponse } from "../../src/main/desktop-release-request.js";

let request: EventEmitter & { abort: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.clearAllMocks();
  request = Object.assign(new EventEmitter(), { abort: vi.fn(), end: vi.fn() });
  request.abort.mockImplementation(() => { request.emit("error", new Error("Redirect was cancelled")); request.emit("close"); });
  mocks.request.mockReturnValue(request);
});

describe("Electron 更新 HEAD 重定向适配", () => {
  it("读取重定向后终止请求，防止 Electron fetch 丢弃手动重定向响应", async () => {
    const controller = new AbortController();
    const operation = fetchDesktopReleaseResponse("https://github.com/example/latest", { method: "HEAD", redirect: "manual", signal: controller.signal });
    request.emit("redirect", 302, "HEAD", "https://github.com/example/tag/v1.2.0.2", {});
    const response = await operation;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://github.com/example/tag/v1.2.0.2");
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ redirect: "manual", credentials: "omit" }));
    expect(request.abort).toHaveBeenCalledOnce();
    controller.abort();
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it("读取 HEAD 响应状态与大小且不下载文件内容", async () => {
    const operation = fetchDesktopReleaseResponse("https://github.com/example/file", { method: "HEAD", redirect: "manual" });
    request.emit("response", { statusCode: 200, headers: { "content-length": "1234" } });
    const response = await operation;
    expect(response.headers.get("content-length")).toBe("1234");
    expect(response.body).toBeNull();
  });

  it("中止正在进行的请求并拒绝已经中止的请求", async () => {
    const controller = new AbortController();
    const operation = fetchDesktopReleaseResponse("https://github.com/example/latest", { method: "HEAD", redirect: "manual", signal: controller.signal });
    const expectation = expect(operation).rejects.toThrow(/aborted/u);
    controller.abort();
    await expectation;
    expect(request.abort).toHaveBeenCalledOnce();
    await expect(fetchDesktopReleaseResponse("https://github.com/example/latest", { method: "HEAD", redirect: "manual", signal: controller.signal })).rejects.toThrow(/aborted/u);
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it("网络错误不会挂起请求", async () => {
    const errorOperation = fetchDesktopReleaseResponse("https://github.com/example/latest", { method: "HEAD", redirect: "manual" });
    request.emit("error", new Error("network failed"));
    await expect(errorOperation).rejects.toThrow("network failed");
  });

  it("请求写入后的 close 不会提前拒绝尚未返回的响应", async () => {
    const operation = fetchDesktopReleaseResponse("https://github.com/example/latest", { method: "HEAD", redirect: "manual" });
    request.emit("close");
    request.emit("redirect", 302, "HEAD", "https://github.com/example/tag/v1.2.0.2", {});
    expect((await operation).status).toBe(302);
  });

  it("其他请求继续使用拒绝重定向的原生 fetch", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}"));
    const init: RequestInit = { redirect: "error", credentials: "omit" };
    await fetchDesktopReleaseResponse("https://api.github.com/example", init);
    expect(mocks.fetch).toHaveBeenCalledWith("https://api.github.com/example", init);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
