import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop Web runtime overlay", () => {
  it("keeps Desktop Web modules outside the Scriverse runtime source", () => {
    const prepareSource = readFileSync(join(process.cwd(), "scripts/prepare-runtime.mjs"), "utf8");
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");
    const addedLines = overlayPatch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");
    const gitAttributes = readFileSync(join(process.cwd(), ".gitattributes"), "utf8");

    expect(prepareSource).not.toContain('"public/desktop-workspace.js",\n  "public/vendor');
    expect(prepareSource).toContain('gitApply("--check")');
    expect(prepareSource).toContain('"apply", "--recount"');
    expect(prepareSource).toContain("cpSync(overlayPublic");
    expect(prepareSource).toContain("standalone patch operator");
    expect(prepareSource).toContain('["--check", stagedApplicationPath]');
    expect(overlayPatch).toContain("diff --git a/public/app.js b/public/app.js");
    expect(overlayPatch).not.toMatch(/^\+\+$/mu);
    expect(overlayPatch).toContain("createDesktopWorkspaceController");
    expect(overlayPatch).toContain('createLatestAsyncQueue((options) => persistChapterOnce(options), mergeLatestChapterSaveRequest)');
    expect(overlayPatch).toContain("return chapterSaveQueue.request({ automatic: options.automatic === true });");
    expect(addedLines).not.toContain("return persistChapter({ automatic });");
    for (const id of [
      "desktop-sync-dialog",
      "desktop-sync-dialog-close",
      "desktop-sync-list",
      "desktop-sync-summary",
      "desktop-sync-refresh",
      "desktop-sync-switch",
      "desktop-conflict-dialog",
      "desktop-conflict-close",
      "desktop-conflict-base",
      "desktop-conflict-local",
      "desktop-conflict-server",
      "desktop-conflict-final",
      "desktop-conflict-use-local",
      "desktop-conflict-use-server",
      "desktop-conflict-use-merged",
      "desktop-conflict-cancel",
      "desktop-conflict-resolve"
    ]) {
      expect(overlayPatch).toContain(`id="${id}"`);
    }
    expect(gitAttributes).toContain("runtime-overlay/*.patch text eol=lf");
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-workspace.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-offline.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-catalog.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-stream.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/latest-async-queue.js"))).toBe(true);
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
    expect(overlayPatch).toContain('taskType: "chat"');
    expect(overlayPatch).toContain("messageId: completed.conversationMessage?.id");
    expect(overlayPatch).toContain('writingSuggestion: ["continue", "polish"].includes(completed.taskType) ? completed : null');
    expect(overlayPatch).not.toContain('if (taskType !== "chat" || desktopProviderModel)');
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

  it("releases relationship renderers when leaving the module", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("function disposeRelationshipRenderers({ invalidateRequest = true } = {})");
    expect(overlayPatch).toContain("state.relationshipMindMap = null;");
    expect(overlayPatch).toContain("state.relationshipExpandedMap = null;");
    expect(overlayPatch).toContain("state.relationshipGraph = null;");
    expect(overlayPatch).toContain("requestId !== relationshipRenderRequestId");
    expect(overlayPatch).toContain('state.module !== "relationships"');
    expect(overlayPatch).toContain("if (state.module !== module) return;");
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

    expect(overlayPatch).toContain("feature=admin-account-identity-v2");
    expect(overlayPatch).toContain("feature=presence-multiple-users-v1");
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

  it("updates Desktop workspace modules when media cache behavior changes", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain('desktop-workspace.js?v=20260829-desktop-external-url-v1');
    expect(overlayPatch).toContain('desktop-offline-api.js?v=20260825-desktop-media-cache-v1');
  });

  it("confirms external website navigation while leaving image resources alone", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");
    const workspace = readFileSync(join(process.cwd(), "runtime-overlay/public/desktop-workspace.js"), "utf8");

    expect(overlayPatch).toContain("installDesktopExternalUrlPrompt({ bridge: desktopShellBridge(), confirm: confirmToast, notify: toast });");
    expect(workspace).toContain("打开外部网站？");
    expect(workspace).toContain("继续访问");
    expect(workspace).toContain("bridge.openExternalUrl");
    expect(workspace).not.toContain("webRequest");
  });

  it("matches the smaller chapter title in the Desktop editor", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("feature=editor-toolbar-compact-v2");
    expect(overlayPatch).not.toContain("font-size: 25px; padding: 0;");
    expect(overlayPatch).not.toContain(".editor-actions { grid-area: actions; display: flex; align-items: center; gap: 8px; }");
    expect(overlayPatch).not.toContain(".editor-view .editor-actions > button { min-height: 32px; padding: 6px 10px; font-size: 11px; }");
  });

  it("keeps the Server blank-line behavior when applying the Desktop overlay", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");
    const addedLines = overlayPatch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");

    expect(addedLines).not.toContain("collapseChapterInputBlankLines");
    expect(overlayPatch).not.toContain("collapseChapterInputBlankLines");
    expect(overlayPatch).not.toContain("normalizeParagraphSpacing");
    expect(overlayPatch).toContain("本机已保存，等待同步");
    expect(overlayPatch).toContain("feature=editor-blank-lines-preserved-v1");
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

  it("preserves the Server single-user presence behavior", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("feature=presence-multiple-users-v1");
    expect(overlayPatch).not.toContain("function renderPresence()");
    expect(overlayPatch).not.toContain("if (!state.work || groups.length <= 1)");
  });
});
