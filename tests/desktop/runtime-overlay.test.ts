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
});
