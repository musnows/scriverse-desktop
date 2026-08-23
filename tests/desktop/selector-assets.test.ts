import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SELECTOR_CSP, resolveSelectorAsset } from "../../src/shared/selector-assets.js";

describe("Selector app 协议资源", () => {
  it("只解析固定 host 下的白名单资源", () => {
    expect(resolveSelectorAsset("app://desktop/selector/index.html", "/trusted/renderer")).toEqual({
      path: join("/trusted/renderer", "selector", "index.html"),
      contentType: "text/html; charset=utf-8"
    });
    expect(resolveSelectorAsset("app://desktop/selector/selector.css", "/trusted/renderer")?.contentType).toBe("text/css; charset=utf-8");
    expect(resolveSelectorAsset("app://desktop/selector/icon.svg", "/trusted/renderer")).toEqual({
      path: join("/trusted/renderer", "selector", "icon.svg"),
      contentType: "image/svg+xml"
    });
    expect(resolveSelectorAsset("app://desktop/local-ai/index.html", "/trusted/renderer")).toEqual({
      path: join("/trusted/renderer", "local-ai", "index.html"),
      contentType: "text/html; charset=utf-8"
    });
    expect(resolveSelectorAsset("app://desktop/local-ai/ai-provider-config-view.js", "/trusted/renderer")?.contentType).toBe("text/javascript; charset=utf-8");
    expect(resolveSelectorAsset("app://evil/selector/index.html", "/trusted/renderer")).toBeNull();
    expect(resolveSelectorAsset("app://desktop/selector/index.html?path=/secret", "/trusted/renderer")).toBeNull();
    expect(resolveSelectorAsset("app://desktop/package.json", "/trusted/renderer")).toBeNull();
    expect(resolveSelectorAsset("app://desktop/local-ai/../../package.json", "/trusted/renderer")).toBeNull();
    expect(resolveSelectorAsset("file:///etc/passwd", "/trusted/renderer")).toBeNull();
  });

  it("选择器复用项目正式 Logo", () => {
    const selectorPage = readFileSync(join(process.cwd(), "src/renderer/selector/index.html"), "utf8");
    const copyScript = readFileSync(join(process.cwd(), "scripts/copy-renderer.mjs"), "utf8");
    expect(selectorPage).toContain('<img class="brand-mark" src="./icon.svg" alt="">');
    expect(selectorPage).not.toContain('<span class="brand-mark"');
    expect(copyScript).toContain('../src/renderer/');
    expect(copyScript).not.toContain('src/public');
  });

  it("使用禁止远程连接和内联脚本的 CSP", () => {
    expect(SELECTOR_CSP).toContain("default-src 'none'");
    expect(SELECTOR_CSP).toContain("connect-src 'none'");
    expect(SELECTOR_CSP).toContain("script-src 'self'");
    expect(SELECTOR_CSP).not.toContain("'unsafe-inline'");
  });
});
