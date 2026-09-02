import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSelectorAsset } from "../../src/shared/selector-assets.js";

const fontPackages = [
  ["noto-sans-sc", "Noto Sans SC Variable"],
  ["noto-serif-sc", "Noto Serif SC Variable"],
  ["jetbrains-mono", "JetBrains Mono Variable"],
  ["source-code-pro", "Source Code Pro Variable"]
] as const;

describe("Desktop embedded fonts", () => {
  it("includes redistributable font stylesheets, licenses, and font files", () => {
    const root = join(process.cwd(), "assets", "fonts");
    const stylesheet = readFileSync(join(process.cwd(), "assets", "desktop-fonts.css"), "utf8");

    for (const [directory, family] of fontPackages) {
      const fontRoot = join(root, directory);
      const fontStylesheet = readFileSync(join(fontRoot, "wght.css"), "utf8");
      const fontFiles = readdirSync(join(fontRoot, "files")).filter((file) => file.endsWith(".woff2"));

      expect(stylesheet).toContain(`./fonts/${directory}/wght.css`);
      expect(existsSync(join(fontRoot, "LICENSE"))).toBe(true);
      expect(fontStylesheet).toContain(`font-family: '${family}'`);
      expect(fontFiles.length).toBeGreaterThan(0);
    }
  });

  it("copies the embedded fonts into both Desktop renderer surfaces", () => {
    const copyRendererSource = readFileSync(join(process.cwd(), "scripts/copy-renderer.mjs"), "utf8");
    const prepareRuntimeSource = readFileSync(join(process.cwd(), "scripts/prepare-runtime.mjs"), "utf8");

    expect(copyRendererSource).toContain('new URL("../assets/fonts/", import.meta.url)');
    expect(copyRendererSource).toContain('new URL("desktop-fonts.css", target)');
    expect(prepareRuntimeSource).toContain('join(root, "assets", "fonts")');
    expect(prepareRuntimeSource).toContain('join(target, "public", "fonts")');
    expect(prepareRuntimeSource).toContain('join(target, "public", "desktop-fonts.css")');
  });

  it("serves bundled font assets from the Selector app protocol", () => {
    expect(resolveSelectorAsset("app://desktop/desktop-fonts.css", "/trusted/renderer")).toEqual({
      path: join("/trusted/renderer", "desktop-fonts.css"),
      contentType: "text/css; charset=utf-8"
    });
    expect(resolveSelectorAsset("app://desktop/fonts/noto-sans-sc/wght.css", "/trusted/renderer")?.contentType).toBe("text/css; charset=utf-8");
    expect(resolveSelectorAsset("app://desktop/fonts/noto-sans-sc/files/noto-sans-sc-4-wght-normal.woff2", "/trusted/renderer")?.contentType).toBe("font/woff2");
    expect(resolveSelectorAsset("app://desktop/fonts/noto-sans-sc/files/font.js", "/trusted/renderer")).toBeNull();
    expect(resolveSelectorAsset("app://desktop/fonts/../package.json", "/trusted/renderer")).toBeNull();
  });

  it("uses the bundled families in Desktop-owned pages and Web overlay settings", () => {
    const selectorCss = readFileSync(join(process.cwd(), "src/renderer/selector/selector.css"), "utf8");
    const localAiCss = readFileSync(join(process.cwd(), "src/renderer/local-ai/styles.css"), "utf8");
    const selectorPage = readFileSync(join(process.cwd(), "src/renderer/selector/index.html"), "utf8");
    const localAiPage = readFileSync(join(process.cwd(), "src/renderer/local-ai/index.html"), "utf8");
    const overlayPatch = readFileSync(join(process.cwd(), "runtime-overlay/web.patch"), "utf8");

    expect(selectorCss).toContain('"Noto Sans SC Variable"');
    expect(selectorCss).toContain('"JetBrains Mono Variable"');
    expect(localAiCss).toContain('"Noto Sans SC Variable"');
    expect(localAiCss).toContain('"JetBrains Mono Variable"');
    expect(selectorPage).toContain('<link rel="stylesheet" href="../desktop-fonts.css">');
    expect(localAiPage).toContain('<link rel="stylesheet" href="../desktop-fonts.css">');
    expect(overlayPatch).toContain('"Noto Sans SC Variable"');
    expect(overlayPatch).toContain('"Noto Serif SC Variable"');
    expect(overlayPatch).toContain('"JetBrains Mono Variable"');
    expect(overlayPatch).toContain('"Source Code Pro Variable"');
    expect(overlayPatch).toContain('Noto Sans SC（内置）');
    expect(overlayPatch).toContain('JetBrains Mono（内置）');
  });
});
