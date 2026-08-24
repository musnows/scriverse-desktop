import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const html = readFileSync(join(root, "src/renderer/selector/index.html"), "utf8");
const css = readFileSync(join(root, "src/renderer/selector/selector.css"), "utf8");
const script = readFileSync(join(root, "src/renderer/selector/selector.js"), "utf8");
const preload = readFileSync(join(root, "src/preload/selector-preload.cts"), "utf8");

describe("Desktop Selector UI", () => {
  it("提供工作区列表、Server 表单和明确删除确认", () => {
    expect(html).toContain("<title>选择工作区 - 叙界</title>");
    expect(html).toContain('aria-label="叙界工作区选择页"');
    expect(html).toContain("<small>桌面端</small>");
    expect(html).not.toContain("Scriverse Desktop");
    expect(html).toContain("选择工作区");
    expect(html).toContain("新增 Server");
    expect(html).toContain('id="local-ai-config-button"');
    expect(html).toContain('id="system-settings-button"');
    expect(html).toContain('id="local-server-port"');
    expect(html).toContain('min="20001" max="65516"');
    expect(html).toContain("app://desktop/local-ai/index.html");
    expect(html).toContain("id=\"profile-dialog\"");
    expect(html).toContain("id=\"local-setup-dialog\"");
    expect(html).toContain("id=\"local-login-dialog\"");
    expect(html).toContain("id=\"remote-login-dialog\"");
    expect(html).toContain("autocomplete=\"current-password\"");
    expect(html).not.toContain("Bearer");
    expect(html).not.toContain("浏览器 Cookie");
    expect(html).not.toContain("安全进程通道");
    expect(html).not.toContain("127.0.0.1");
    expect(html).not.toContain("最多 20 个端口");
    expect(script).not.toContain("独立浏览器分区");
    expect(script).not.toContain("Desktop 安全桥接");
    expect(html).toContain("autocomplete=\"new-password\"");
    expect(html).toContain("id=\"delete-dialog\"");
    expect(html).toContain("该 Server 的登录状态和本机副本将一并清除");
    expect(html).toContain("aria-live=\"polite\"");
    expect(script).toContain('error.code === "PROFILE_UNSYNCED_DATA"');
    expect(script).toContain("永久删除本机离线数据");
    expect(script).toContain("永久更换并删除本机副本");
    expect(script).toContain("bridge.profiles.status(profile.id)");
    expect(script).toContain('window.addEventListener("focus", () => { void loadProfiles(); });');
    expect(script).toContain("bridge.settings.update({ localServerPort: Number(localServerPort.value) })");
    expect(script).toContain('return { label: "本地", className: "idle" };');
    expect(css).toContain(".status-badge.idle {");
    expect(css).not.toContain(".status-badge.local {");
  });

  it("使用 DOM textContent 渲染 profile 并覆盖窄屏", () => {
    expect(script).toContain("node.textContent = text");
    expect(script).not.toContain("innerHTML");
    expect(css).toContain("@media (max-width: 430px)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("width: min(184px, 100%); height: 60px");
    expect(css).not.toContain("width: min(260px, 100%)");
    expect(css).toContain("font-size: clamp(28px, 4vw, 38px)");
    expect(css).toContain("min-height: 38px; padding: 8px 14px; font-size: 11px");
  });

  it("preload 只暴露具名能力而不泄露通用 IPC", () => {
    expect(preload).toContain("contextBridge.exposeInMainWorld");
    expect(preload).toContain("selector:profiles:list");
    expect(preload).toContain("selector:profiles:status");
    expect(preload).toContain("selector:profiles:probe");
    expect(preload).toContain("selector:local:get-status");
    expect(preload).toContain("selector:local:setup");
    expect(preload).toContain("selector:local:login");
    expect(preload).toContain("selector:settings:get");
    expect(preload).toContain("selector:settings:update");
    expect(preload).toContain("selector:remote:refresh-captcha");
    expect(preload).toContain("selector:remote:login");
    expect(preload).toContain("localAi: Object.freeze");
    expect(preload).toContain("selector:local-ai:configuration");
    expect(preload).toContain("selector:local-ai:update-system-prompt");
    expect(preload).not.toContain("token");
    expect(preload).not.toContain("ipcRenderer: ipcRenderer");
    expect(preload).not.toContain("send: (");
  });
});
