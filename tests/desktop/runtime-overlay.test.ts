import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop Web runtime overlay", () => {
  it("keeps Desktop Web modules outside the Scriverse runtime source", () => {
    const prepareSource = readFileSync(join(process.cwd(), "scripts/prepare-runtime.mjs"), "utf8");
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(prepareSource).not.toContain('"public/desktop-workspace.js",\n  "public/vendor');
    expect(prepareSource).toContain('gitApply("--check")');
    expect(prepareSource).toContain("cpSync(overlayPublic");
    expect(overlayPatch).toContain("diff --git a/public/app.js b/public/app.js");
    expect(overlayPatch).toContain("createDesktopWorkspaceController");
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-workspace.js"))).toBe(true);
    expect(existsSync(join(process.cwd(), "runtime-overlay/public/desktop-local-ai-offline.js"))).toBe(true);
  });

  it("merges local models into every workspace picker and marks them with a computer icon", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("loadDesktopLocalAiCatalog()");
    expect(overlayPatch).toContain("...localCatalog.models.filter");
    expect(overlayPatch).toContain("function aiModelLocalIconMarkup()");
    expect(overlayPatch).toContain('icon.setAttribute("aria-label", "Desktop 本地模型")');
    expect(overlayPatch).toContain("ai-model-option-image is-local");
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

  it("hides the online presence banner until more than one distinct user is present", () => {
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(overlayPatch).toContain("const groups = groupedPresenceParticipants();");
    expect(overlayPatch).toContain("if (!state.work || groups.length <= 1)");
    expect(overlayPatch).toContain('control.classList.add("hidden")');
    expect(overlayPatch).toContain('control.classList.remove("hidden")');
  });
});
