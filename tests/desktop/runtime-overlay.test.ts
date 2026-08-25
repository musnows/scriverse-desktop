import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop Web runtime overlay", () => {
  it("keeps Desktop Web modules outside the Scriverse runtime source", () => {
    const prepareSource = readFileSync(join(process.cwd(), "scripts/prepare-runtime.mjs"), "utf8");
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");
    const gitAttributes = readFileSync(join(process.cwd(), ".gitattributes"), "utf8");

    expect(prepareSource).not.toContain('"public/desktop-workspace.js",\n  "public/vendor');
    expect(prepareSource).toContain('gitApply("--check")');
    expect(prepareSource).toContain('"apply", "--recount"');
    expect(prepareSource).toContain("cpSync(overlayPublic");
    expect(overlayPatch).toContain("diff --git a/public/app.js b/public/app.js");
    expect(overlayPatch).toContain("createDesktopWorkspaceController");
    expect(gitAttributes).toContain("runtime-overlay/*.patch text eol=lf");
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-workspace.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-offline.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-catalog.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-stream.js"))).toBe(true);
  });

  it("merges local models into every workspace picker and marks them with a local badge", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("loadDesktopLocalAiCatalog()");
    expect(overlayPatch).toContain('import { mergeDesktopLocalAiModels } from "/desktop-local-ai-catalog.js');
    expect(overlayPatch).toContain("applyAiModels(mergeDesktopLocalAiModels(models, localCatalog.models))");
    expect(overlayPatch).toContain("[relationshipCharacters, taskModels, taskDefaults, localCatalog] = await Promise.all");
    expect(overlayPatch).toContain("mergeDesktopLocalAiModels(taskModels, localCatalog.models)");
    expect(overlayPatch).toContain("desktopAiModelOptionLabel(model)");
    expect(overlayPatch).toContain('return model?.scope === "local" ? `本地 · ${label}` : label;');
    expect(overlayPatch).toContain("bridge.completeAgentRound({");
    expect(overlayPatch).toContain("runtimeModel: desktopProviderRuntimeModel(model)");
    expect(overlayPatch).toContain("/desktop-local-ai/runs/");
    expect(overlayPatch).not.toContain("/desktop-local-ai/prepare");
    expect(overlayPatch).toContain("remoteSystemPrompt: desktopOfflineLocalAiSystemPrompt(context)");
    expect(overlayPatch).toContain("messages: desktopOfflineLocalAiMessages(history, instruction)");
    expect(overlayPatch).toContain('scope.className = "ai-model-option-scope is-local"');
    expect(overlayPatch).toContain('scope.textContent = "本地"');
    expect(overlayPatch).not.toContain("function aiModelLocalIconMarkup()");
    expect(overlayPatch).not.toContain('icon.setAttribute("aria-label", "Desktop 本地模型")');
    expect(overlayPatch).not.toContain("ai-model-option-image.is-local");
    expect(overlayPatch.match(/feature=desktop-local-model-badge-only-v1/g)).toHaveLength(2);
  });

  it("uses the normal assistant stream UI and keeps local scope only in the model-list badge", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");
    const addedLines = overlayPatch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");

    expect(overlayPatch).toContain("desktopProviderChatResponse");
    expect(overlayPatch).toContain("completeWithDesktopProvider");
    expect(overlayPatch).toContain("bridge.completeAgentRound({");
    expect(overlayPatch).toContain("if (forwardEvents) onProviderEvent(event, generationRound)");
    expect(overlayPatch).toContain("desktopProviderCompletedToolCalls(completion?.body, emittedToolCallIds)");
    expect(overlayPatch).toContain('onProviderEvent({ type: "tool-call", toolCall }, Math.max(1, generationRound))');
    expect(overlayPatch).toContain('emit("tool_call", { ...event.toolCall, round })');
    expect(overlayPatch).toContain("async function streamChat(requestHolder, body, idempotencyKey, responseFactory = null)");
    expect(overlayPatch).toContain('eventName === "replace"');
    expect(overlayPatch).toContain("createDesktopProviderPendingMessage(tab)");
    expect(overlayPatch).toContain('emit("process_step", { id: "provider-thinking-1", type: "thinking", round: 1, content: "", append: false })');
    expect(overlayPatch).toContain('message.className = "assistant-message is-streaming"');
    expect(overlayPatch).toContain('data-testid="ai-stream-connection-seconds">0</span> 秒');
    const optimisticUserIndex = overlayPatch.indexOf('appendMessage("user", instruction, citations, null, desktopProviderUserMetadata, null, { tab })');
    const immediateShellIndex = overlayPatch.indexOf("createDesktopProviderPendingMessage(tab)", optimisticUserIndex);
    const persistenceIndex = overlayPatch.indexOf("{ modelId, ...desktopProviderUserMetadata }", optimisticUserIndex);
    const streamCallIndex = overlayPatch.indexOf("const streamed = await streamChat", immediateShellIndex);
    const placeholderReleaseIndex = overlayPatch.lastIndexOf("desktopProviderStreamMessage?.remove();", streamCallIndex);
    expect(optimisticUserIndex).toBeGreaterThan(-1);
    expect(immediateShellIndex).toBeGreaterThan(optimisticUserIndex);
    expect(persistenceIndex).toBeGreaterThan(immediateShellIndex);
    expect(placeholderReleaseIndex).toBeGreaterThan(persistenceIndex);
    expect(streamCallIndex).toBeGreaterThan(placeholderReleaseIndex);
    expect(overlayPatch).toContain("feature=desktop-provider-stream-v1");
    expect(overlayPatch).not.toContain("createDesktopLocalAiPendingMessage");
    expect(addedLines).not.toContain("本地模型");
    expect(addedLines).not.toContain("本地助手");
    expect(addedLines).not.toContain('formatAiMessageMeta(model.displayName, outputTokens, undefined, "本地"');
    expect(addedLines.match(/scope\.textContent = "本地"/gu)).toHaveLength(1);
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
    expect(overlayPatch).toContain("workspaceName ? `${workspaceName} · 叙界`");
  });

  it("keeps the loading cover until the initial shelf route is ready", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain('-  if (!session.csrfToken) document.body.classList.remove("auth-pending");');
    expect(overlayPatch).toContain("auth-pending 由 initializePage 路由完成后才移除");
    expect(overlayPatch).toContain("feature=desktop-route-ready-cover-v1");
  });

  it("shows remote offline download progress in the top bar and opens sync details", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain('id="desktop-sync-status-button"');
    expect(overlayPatch).toContain('class="topbar-icon-button desktop-sync-status-button hidden"');
    expect(overlayPatch).not.toContain('id="desktop-sync-status-label"');
    expect(overlayPatch).not.toContain("+.desktop-sync-status-button {");
    expect(overlayPatch).toContain("+.desktop-sync-status-icon {");
    expect(overlayPatch).toContain("下载中 ${desktopInitialOfflineDownloadProgress.completed}/${desktopInitialOfflineDownloadProgress.total}");
    expect(overlayPatch).toContain("已离线 ${aggregate.works} 部");
    expect(overlayPatch).toContain('$("#desktop-sync-status-button").addEventListener("click", () => { void openDesktopSyncCenter(); });');
    expect(overlayPatch).toContain('const serverWorks = desktopOfflineMode ? [] : await apiAllPages("/api/works", 100);');
    expect(overlayPatch.match(/feature=desktop-sync-status-v1/g)).toHaveLength(2);
    expect(overlayPatch.match(/feature=desktop-sync-icon-only-v1/g)).toHaveLength(2);
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
  });

  it("hides the online presence banner until more than one distinct user is present", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("const groups = groupedPresenceParticipants();");
    expect(overlayPatch).toContain("if (!state.work || groups.length <= 1)");
    expect(overlayPatch).toContain('control.classList.add("hidden")');
    expect(overlayPatch).toContain('control.classList.remove("hidden")');
  });
});
