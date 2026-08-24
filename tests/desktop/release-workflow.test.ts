import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const checks = readFileSync(join(root, ".github/workflows/desktop-checks.yml"), "utf8");
const release = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");
const forge = readFileSync(join(root, "forge.config.ts"), "utf8");

describe("Desktop 发布链路", () => {
  it("覆盖 macOS、Windows 和 Linux 双架构", () => {
    for (const value of [
      "macos-15",
      "macos-15-intel",
      "windows-2025",
      "windows-11-vs2026-arm",
      "ubuntu-24.04",
      "ubuntu-24.04-arm"
    ]) {
      expect(checks).toContain(value);
      expect(release).toContain(value);
    }
    expect(checks).toContain("verify:package");
    expect(checks).toContain("verify:artifacts");
    expect(checks).toContain("repository: musnows/Scriverse");
    expect(checks).toContain('package_dir="out/scriverse-desktop-linux-${{ matrix.arch }}"');
    expect(checks).toContain('sudo chown root:root "$package_dir/chrome-sandbox"');
    expect(checks).toContain('sudo chmod 4755 "$package_dir/chrome-sandbox"');
    expect(release).toContain('package_dir="out/scriverse-desktop-linux-${{ matrix.arch }}"');
    expect(release).toContain('sudo chown root:root "$package_dir/chrome-sandbox"');
    expect(release).toContain('sudo chmod 4755 "$package_dir/chrome-sandbox"');
  });

  it("正式发布使用 macOS ad-hoc 签名和 Windows 临时自签证书", () => {
    expect(forge).toContain('identity: "-"');
    expect(forge).toContain("osxNotarize");
    expect(forge).toContain("windowsSign");
    expect(forge).not.toContain("release builds require signing");
    expect(release).toContain("New-SelfSignedCertificate");
    expect(release).not.toContain("Import-Certificate");
    expect(release).toContain("scriverse-desktop-darwin-${{ matrix.arch }}-$package_version.dmg");
    expect(release).toContain("scriverse-desktop-win32-${{ matrix.arch }}-$packageVersion-Setup.exe");
    expect(release).toContain("scriverse-desktop-win32-${{ matrix.arch }}-$packageVersion-full.nupkg");
    expect(release).toContain("scriverse-desktop-win32-${{ matrix.arch }}-$packageVersion-RELEASES");
    expect(release).toContain('codesign --verify --deep --strict "$app_path"');
    expect(release).toContain('grep -F "Signature=adhoc"');
    expect(release).toContain('if: ${{ always() && !cancelled() }}');
    expect(checks).toContain("SCRIVERSE_DESKTOP_GATE_SKIP_LOCAL_SERVER");
    expect(release).toContain("SCRIVERSE_DESKTOP_GATE_SKIP_LOCAL_SERVER");
    expect(release).not.toContain("secrets.DESKTOP_");
    expect(release).not.toContain("spctl --assess");
    expect(release).not.toContain("stapler validate");
    expect(release).toContain('app_path="out/scriverse-desktop-darwin-${{ matrix.arch }}/叙界.app"');
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
