import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const selectorWindowSource = readFileSync(join(root, "src/main/selector-window.ts"), "utf8");
const promptSource = readFileSync(join(root, "src/renderer/external-url-prompt.js"), "utf8");

describe("Desktop Selector 外部网站跳转", () => {
  it("拦截 Selector 和本地 AI 配置页的顶层外链导航", () => {
    expect(selectorWindowSource).toContain("onExternalUrlRequest(window, details.url)");
    expect(selectorWindowSource).toContain("onExternalUrlRequest(window, url)");
    expect(selectorWindowSource).toContain('action: "deny"');
    expect(selectorWindowSource).not.toContain("webRequest.onBeforeRequest");
  });

  it("共用确认 Toast 并在确认后调用具名桥接方法", () => {
    expect(promptSource).toContain("external-url-confirmation");
    expect(promptSource).toContain("打开外部网站？");
    expect(promptSource).toContain("继续访问");
    expect(promptSource).toContain("bridge.openExternalUrl");
    expect(promptSource).not.toContain("innerHTML");
  });
});
