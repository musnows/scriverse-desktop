import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop Web runtime overlay", () => {
  it("keeps Desktop Web modules outside the Scriverse runtime source", () => {
    const prepareSource = readFileSync(join(process.cwd(), "scripts/prepare-runtime.mjs"), "utf8");
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(prepareSource).not.toContain('"public/desktop-workspace.js",\n  "public/vendor');
    expect(prepareSource).toContain('gitApply("--check")');
    expect(prepareSource).toContain('"apply", "--recount"');
    expect(prepareSource).toContain("cpSync(overlayPublic");
    expect(overlayPatch).toContain("diff --git a/public/app.js b/public/app.js");
    expect(overlayPatch).toContain("createDesktopWorkspaceController");
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-workspace.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-offline.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-catalog.js"))).toBe(true);
  });

  it("merges local models into every workspace picker and marks them with a local badge", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("loadDesktopLocalAiCatalog()");
    expect(overlayPatch).toContain('import { mergeDesktopLocalAiModels } from "/desktop-local-ai-catalog.js');
    expect(overlayPatch).toContain("applyAiModels(mergeDesktopLocalAiModels(models, localCatalog.models))");
    expect(overlayPatch).toContain("bridge.completeAgentRound({");
    expect(overlayPatch).toContain("runtimeModel: desktopLocalAiRuntimeModel(model)");
    expect(overlayPatch).toContain("/desktop-local-ai/runs/");
    expect(overlayPatch).not.toContain("/desktop-local-ai/prepare");
    expect(overlayPatch).toContain("+      modelId: model.id,\n+      taskType,\n+      remoteSystemPrompt: desktopOfflineLocalAiSystemPrompt(context),");
    expect(overlayPatch).toContain('scope.className = "ai-model-option-scope is-local"');
    expect(overlayPatch).toContain('scope.textContent = "本地"');
    expect(overlayPatch).not.toContain("function aiModelLocalIconMarkup()");
    expect(overlayPatch).not.toContain('icon.setAttribute("aria-label", "Desktop 本地模型")');
    expect(overlayPatch).not.toContain("ai-model-option-image.is-local");
    expect(overlayPatch.match(/feature=desktop-local-model-badge-only-v1/g)).toHaveLength(2);
  });

  it("shows the active workspace in the header and footer with a settings switch action", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain('id="desktop-switch-button"');
    expect(overlayPatch).toContain('<div class="settings-detail-actions">');
    expect(overlayPatch).toContain('id="desktop-switch-button" class="ghost-button settings-parent-button hidden"');
    expect(overlayPatch).not.toContain('id="desktop-switch-button" class="settings-hub-card');
    expect(overlayPatch).not.toContain("desktop-switch-menu-button");
    expect(overlayPatch).toContain("desktopShellBridge()?.requestSwitch()");
    expect(overlayPatch).toContain("当前工作区：${name}");
    expect(overlayPatch).toContain("data-desktop-workspace-name");
    expect(overlayPatch).toContain("workspaceName ? `${workspaceName} · Scriverse Desktop`");
  });

  it("preserves the upstream system administrator account identity UI", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("feature=admin-account-identity-v2&feature=ai-provider-analysis-timeout-v1&feature=task-detail-failure-orange-v1&feature=desktop-same-workspace-v1");
    expect(overlayPatch.match(/feature=task-detail-failure-orange-v1/g)).toHaveLength(4);
    expect(overlayPatch).not.toContain('-          <button id="account-button"');
    expect(overlayPatch).not.toContain("-  const isSystemAdmin = session.user.isSystemAdmin === true;");
  });

  it("keeps offline snapshots plaintext and returns local logout to Selector", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");
    const syncStore = readFileSync(join(process.cwd(), "runtime-overlay/public/desktop-sync-store.js"), "utf8");

    expect(overlayPatch).toContain("globalThis.scriverseDesktopLocalShell?.logout");
    expect(overlayPatch).not.toContain("AES-GCM");
    expect(overlayPatch).not.toContain("加密离线副本");
    expect(syncStore).toContain("return structuredClone(snapshot)");
    expect(syncStore).not.toContain("subtle.encrypt");
    expect(syncStore).not.toContain("subtle.decrypt");
  });

  it("keeps implementation details out of user-facing Desktop copy", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");
    const addedLines = overlayPatch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");

    expect(addedLines).not.toContain("30 RPM");
    expect(addedLines).not.toContain("并发 3");
    expect(addedLines).not.toContain("最终 JSON");
    expect(addedLines).not.toContain("浏览器 Cookie");
    expect(addedLines).not.toContain("Bearer 会话");
    expect(addedLines).not.toContain("本地推理");
    expect(addedLines).not.toContain("不经过 Server 供应商");
    expect(addedLines).not.toContain("未运行 Server 一致性守卫");
    expect(addedLines).toContain('<div class="message-meta"></div>');
  });

  it("hides the online presence banner until more than one distinct user is present", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("const groups = groupedPresenceParticipants();");
    expect(overlayPatch).toContain("if (!state.work || groups.length <= 1)");
    expect(overlayPatch).toContain('control.classList.add("hidden")');
    expect(overlayPatch).toContain('control.classList.remove("hidden")');
  });
});
