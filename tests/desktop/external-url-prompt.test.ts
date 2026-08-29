import { describe, expect, it } from "vitest";
import { installDesktopExternalUrlPrompt } from "../../runtime-overlay/public/desktop-workspace.js";

describe("Desktop 外部网站确认 Toast", () => {
  it("确认或取消后把用户选择交给主进程桥接", async () => {
    let listener: ((request: { requestId: string; url: string }) => void) | null = null;
    const responses: unknown[] = [];
    const bridge = {
      onExternalUrlRequest(next: (request: { requestId: string; url: string }) => void) {
        listener = next;
        return () => { listener = null; };
      },
      openExternalUrl(input: unknown) {
        responses.push(input);
        return Promise.resolve({ ok: true, data: null });
      }
    };
    const uninstall = installDesktopExternalUrlPrompt({
      bridge,
      confirm: () => Promise.resolve(true)
    });
    listener?.({ requestId: "request-1", url: "https://scriverse.top/docs" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(responses).toEqual([{ requestId: "request-1", confirmed: true }]);
    uninstall();
  });

  it("确认失败时通知页面且不把错误吞掉", async () => {
    let listener: ((request: { requestId: string; url: string }) => void) | null = null;
    const notices: unknown[] = [];
    const bridge = {
      onExternalUrlRequest(next: (request: { requestId: string; url: string }) => void) {
        listener = next;
        return () => { listener = null; };
      },
      openExternalUrl: () => Promise.resolve({ ok: false, error: { message: "外部网站跳转请求已失效" } })
    };
    const uninstall = installDesktopExternalUrlPrompt({
      bridge,
      confirm: () => Promise.resolve(false),
      notify: (message: string, type: string) => notices.push({ message, type })
    });
    listener?.({ requestId: "request-2", url: "https://scriverse.top/docs" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(notices).toEqual([{ message: "外部网站跳转请求已失效", type: "error" }]);
    uninstall();
  });
});
