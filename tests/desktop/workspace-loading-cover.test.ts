import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const coverSource = readFileSync(join(root, "src/main/workspace-loading-cover.ts"), "utf8");
const localWindowSource = readFileSync(join(root, "src/main/workspace-window.ts"), "utf8");
const remoteWindowSource = readFileSync(join(root, "src/main/remote-workspace-window.ts"), "utf8");

describe("Desktop 工作区加载遮罩", () => {
  it("在最高层覆盖登录页并适配明暗主题", () => {
    expect(coverSource).toContain("z-index: 2147483647");
    expect(coverSource).toContain("scriverse-desktop-workspace-loading");
    expect(coverSource).toContain("@media (prefers-color-scheme: dark)");
    expect(coverSource).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("等待 Server Web 完成认证路由后移除且具有超时兜底", () => {
    expect(coverSource).toContain('!document.body.classList.contains("auth-pending")');
    expect(coverSource).toContain("const readinessTimeoutMs = 10_000");
    expect(coverSource).toContain("removeInsertedCSS(key)");
    expect(coverSource).toContain("executeJavaScript(workspaceReadyScript)");
  });

  it("本地和线上工作区都在显示窗口前安装遮罩", () => {
    for (const source of [localWindowSource, remoteWindowSource]) {
      expect(source).toContain("createWorkspaceLoadingCover(window)");
      expect(source).toContain("loadingCover.prepare()");
      expect(source.indexOf("loadingCover.prepare()")).toBeLessThan(source.indexOf("window.show()"));
      expect(source).toContain("loadingCover.revealWhenReady()");
      expect(source).toContain("loadingCover.dispose()");
    }
  });
});
