import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const checks = readFileSync(join(root, ".github/workflows/desktop-checks.yml"), "utf8");
const developPackage = readFileSync(join(root, ".github/workflows/desktop-develop-package.yml"), "utf8");
const release = readFileSync(join(root, ".github/workflows/desktop-release.yml"), "utf8");
const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
const forge = readFileSync(join(root, "forge.config.ts"), "utf8");
const artifactVerifier = readFileSync(join(root, "scripts/verify-artifacts.mjs"), "utf8");

describe("Desktop 发布链路", () => {
  it("只为 main PR 自动检查并分别隔离 develop 人工打包与 Release 打包", () => {
    expect(checks).toContain("pull_request:");
    expect(checks).toContain("      - main");
    expect(checks).not.toContain("workflow_dispatch:");
    expect(checks).not.toContain("  push:");
    expect(checks).not.toContain("Package ${{ matrix.label }}");

    expect(developPackage).toContain("workflow_dispatch:");
    expect(developPackage).toContain("ref: develop");
    expect(developPackage).not.toContain("pull_request:");
    expect(developPackage).not.toContain("  push:");
    expect(developPackage).not.toContain("  release:");

    expect(release).toContain("  release:");
    expect(release).toContain("      - published");
    expect(release).not.toContain("workflow_dispatch:");
    expect(release).not.toContain("pull_request:");
    expect(release).not.toContain("  push:");
  });

  it("develop 人工打包和正式发布都覆盖三平台双架构", () => {
    for (const value of [
      "macos-15",
      "macos-15-intel",
      "windows-2025",
      "windows-11-vs2026-arm",
      "ubuntu-24.04",
      "ubuntu-24.04-arm"
    ]) {
      expect(developPackage).toContain(value);
      expect(release).toContain(value);
    }
    expect(developPackage).toContain("verify:package");
    expect(developPackage).toContain("verify:artifacts");
    expect(developPackage).toContain("repository: musnows/Scriverse");
    expect(developPackage).toContain('package_dir="out/scriverse-desktop-linux-${{ matrix.arch }}"');
    expect(developPackage).toContain('sudo chown root:root "$package_dir/chrome-sandbox"');
    expect(developPackage).toContain('sudo chmod 4755 "$package_dir/chrome-sandbox"');
    expect(release).toContain('package_dir="out/scriverse-desktop-linux-${{ matrix.arch }}"');
    expect(release).toContain('sudo chown root:root "$package_dir/chrome-sandbox"');
    expect(release).toContain('sudo chmod 4755 "$package_dir/chrome-sandbox"');
    for (const workflow of [developPackage, release]) {
      expect(workflow).toContain("scriverseServerVersion");
      expect(workflow).toContain('echo "ref=v$server_version" >> "$GITHUB_OUTPUT"');
      expect(workflow).toContain("ref: ${{ steps.scriverse-release.outputs.ref }}");
      expect(workflow).toContain('gh release view "${{ steps.scriverse-release.outputs.ref }}" --repo musnows/Scriverse');
      expect(workflow).not.toContain("SCRIVERSE_RUNTIME_REF");
    }
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
    expect(artifactVerifier).toContain('/(?:[\\\\/]|-)RELEASES$/u');
    expect(release).toContain('codesign --verify --deep --strict "$app_path"');
    expect(release).toContain('grep -F "Signature=adhoc"');
    expect(release).toContain('if: ${{ always() && !cancelled() }}');
    expect(developPackage).toContain("SCRIVERSE_DESKTOP_GATE_SKIP_LOCAL_SERVER");
    expect(release).toContain("SCRIVERSE_DESKTOP_GATE_SKIP_LOCAL_SERVER");
    expect(release).not.toContain("secrets.DESKTOP_");
    expect(release).not.toContain("spctl --assess");
    expect(release).not.toContain("stapler validate");
    expect(release).toContain('app_path="out/scriverse-desktop-darwin-${{ matrix.arch }}/叙界.app"');
    expect(release).not.toMatch(/BEGIN (?:RSA )?PRIVATE KEY/u);
  });

  it("记录 develop 开发、main 发版和 Server Release 能力对齐门禁", () => {
    expect(agents).toContain("`develop` 是唯一日常开发与功能集成分支");
    expect(agents).toContain("`main` 只用于发版");
    expect(agents).toContain("指向 `develop` 的 PR 不运行 GitHub CI");
    expect(agents).toContain("指向 `main` 的 PR 才运行 `Desktop checks`");
    expect(agents).toContain("Server Web 已有能力不能因进入 Desktop 而缺失、退化或使用不同逻辑");
    expect(agents).toContain("package.json.scriverseServerVersion");
  });

  it("提交三平台原生图标", () => {
    for (const filename of ["icon.icns", "icon.ico", "icon-512.png"]) {
      const path = join(root, "assets", filename);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(1_000);
    }
  });
});
