import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const checks = readFileSync(join(root, ".github/workflows/desktop-checks.yml"), "utf8");
const release = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");
const forge = readFileSync(join(root, "forge.config.ts"), "utf8");

describe("Desktop 发布链路", () => {
  it("覆盖 macOS 双架构、Windows x64 和 Linux x64", () => {
    for (const value of ["macos-15", "macos-15-intel", "windows-2025", "ubuntu-24.04"]) {
      expect(checks).toContain(value);
      expect(release).toContain(value);
    }
    expect(checks).toContain("verify:package");
    expect(checks).toContain("verify:artifacts");
    expect(checks).toContain("repository: musnows/Scriverse");
  });

  it("正式发布强制签名、公证并只从 CI Secret 读取凭据", () => {
    expect(forge).toContain("SCRIVERSE_DESKTOP_RELEASE_BUILD");
    expect(forge).toContain("osxNotarize");
    expect(forge).toContain("windowsSign");
    expect(release).toContain("secrets.DESKTOP_APPLE_CERTIFICATE_BASE64");
    expect(release).toContain("secrets.DESKTOP_WINDOWS_CERTIFICATE_BASE64");
    expect(release).not.toMatch(/BEGIN (?:RSA )?PRIVATE KEY/u);
  });

  it("提交三平台原生图标", () => {
    for (const filename of ["icon.icns", "icon.ico", "icon-512.png"]) {
      const path = join(root, "assets", filename);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(1_000);
    }
  });
});
