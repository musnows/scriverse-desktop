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
    expect(html).toContain("选择工作区");
    expect(html).toContain("新增 Server");
    expect(html).toContain('id="local-ai-config-button"');
    expect(html).toContain('id="system-settings-button"');
    expect(html).toContain('id="local-server-port"');
    expect(html).toContain('min="20001" max="65516"');
    expect(html).toContain("app://desktop/local-ai/index.html");
    expect(html).toContain("id=\"profile-dialog\"");
    expect(html).toContain("id=\"local-setup-dialog\"");
    expect(html).toContain("id=\"remote-login-dialog\"");
    expect(html).toContain("autocomplete=\"current-password\"");
    expect(html).not.toContain("不写入浏览器 Cookie");
    expect(html).toContain("autocomplete=\"new-password\"");
    expect(html).toContain("id=\"delete-dialog\"");
    expect(html).toContain("再次确认才会清除该 Server 的登录、Cookie、IndexedDB、缓存、离线密钥和本机副本");
    expect(html).toContain("aria-live=\"polite\"");
    expect(script).toContain('error.code === "PROFILE_UNSYNCED_DATA"');
    expect(script).toContain("永久删除本机离线数据");
    expect(script).toContain("永久更换并删除本机副本");
    expect(script).toContain("bridge.profiles.status(profile.id)");
    expect(script).toContain('window.addEventListener("focus", () => { void loadProfiles(); });');
    expect(script).toContain("bridge.settings.update({ localServerPort: Number(localServerPort.value) })");
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
