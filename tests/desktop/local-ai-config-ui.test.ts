import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const html = readFileSync(join(root, "src/renderer/local-ai/index.html"), "utf8");
const css = readFileSync(join(root, "src/renderer/local-ai/local-ai.css"), "utf8");
const script = readFileSync(join(root, "src/renderer/local-ai/local-ai.js"), "utf8");
const sharedView = readFileSync(join(root, "src/renderer/local-ai/ai-provider-config-view.js"), "utf8");
const selectorIpc = readFileSync(join(root, "src/main/selector-ipc.ts"), "utf8");

describe("Desktop 本地 AI 配置界面", () => {
  it("从 Desktop 独立入口提供与 Server 相同的供应商和模型配置结构", () => {
    expect(html).toContain("<title>本地 AI 配置 - 叙界</title>");
    expect(html).not.toContain("Scriverse Desktop");
    expect(html).toContain("本地 AI 配置");
    expect(html).toContain("平台全局系统提示词");
    expect(html).toContain("模型供应商配置");
    expect(html).toContain('class="config-section platform-system-prompt-section"');
    expect(html).toContain('class="dialog"');
    expect(script).toContain("renderAiProviderConfigurationCards");
    expect(script).toContain("installExternalUrlPrompt");
    expect(script).toContain("window.scriverseDesktop?.external");
    expect(sharedView).toContain('provider-scope-badge ${provider.scope === "local" ? "is-local"');
    expect(script).toContain("{ showScope: false }");
    expect(html).not.toContain("本地模型");
    expect(script).not.toContain("本地模型");
    expect(script).not.toContain("本地助手");
    expect(sharedView).toContain("data-edit-provider");
    expect(sharedView).toContain("data-add-model");
  });

  it("本地配置允许局域网地址并只通过具名 Desktop bridge 写入", () => {
    expect(html).toContain("这里的配置只在当前设备使用");
    expect(script).toContain("http://127.0.0.1:11434/v1");
    expect(script).not.toContain("query 或 hash");
    expect(script).not.toContain("安全桥接");
    expect(script).toContain("bridge.createProvider");
    expect(script).toContain('field("analysisTimeoutSeconds", "分析请求超时（秒）"');
    expect(script).toContain("analysisTimeoutSeconds,");
    expect(sharedView).toContain("分析请求超时：${Number(provider.analysisTimeoutSeconds) || 300} 秒");
    expect(script).toContain("bridge.createModel");
    expect(script).toContain("bridge.updateSystemPrompt");
    expect(script).not.toContain("fetch(");
    expect(script).not.toContain("localStorage");
    expect(selectorIpc).toContain("LOCAL_AI_CONFIG_ENTRY_URL");
    expect(selectorIpc).toContain("parseCreateLocalAiProviderInput");
    expect(selectorIpc).toContain("parseCreateLocalAiModelInput");
  });

  it("供应商调用由 Desktop bridge 独立承载", () => {
    expect(script).toContain("bridge.testProvider");
    expect(script).toContain("bridge.updateProvider");
    expect(script).toContain("bridge.updateModel");
    expect(script).not.toContain("document.cookie");
  });

  it("窄屏保持单列且配置卡片复用 Server 样式", () => {
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("#local-ai-form-dialog { overflow: hidden;");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("grid-template-rows: auto minmax(0, 1fr) auto auto");
    expect(script).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
    expect(sharedView).toContain('provider.scope === "local" ? "本地" : "平台级"');
  });
});
