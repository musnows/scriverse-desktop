import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import config from "../../forge.config.js";
import { windowsNsisBuilderConfiguration } from "../../scripts/windows-nsis-maker.js";

describe("Desktop Forge configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    [undefined, "icon-dev"],
    ["false", "icon-dev"],
    ["true", "icon"]
  ] as const)("selects matching native and installer icons for GITHUB_ACTIONS=%s", async (githubActions, iconName) => {
    vi.stubEnv("GITHUB_ACTIONS", githubActions);
    vi.resetModules();
    const { default: configured } = await import("../../forge.config.js");
    const extension = process.platform === "darwin" ? ".icns" : process.platform === "win32" ? ".ico" : "-512.png";
    expect(configured.packagerConfig?.icon).toBe(`assets/${iconName}${extension}`);
    const squirrel = configured.makers?.find((maker) => "name" in maker && maker.name === "@electron-forge/maker-squirrel");
    if (iconName === "icon-dev") {
      expect(squirrel).toMatchObject({ config: { setupIcon: expect.stringContaining("icon-dev.ico") } });
    } else {
      expect(squirrel && "config" in squirrel ? squirrel.config : null).not.toHaveProperty("setupIcon");
    }
    const linuxMaker = configured.makers?.find((maker) => "name" in maker && maker.name === "@electron-forge/maker-deb");
    expect(linuxMaker).toMatchObject({ config: { options: { icon: expect.stringContaining(`${iconName}-512.png`) } } });
    const nsis = windowsNsisBuilderConfiguration({ targetArch: "arm64", makeDir: "/workspace/out/make", projectDir: "/workspace" });
    expect(nsis.win?.icon).toBe(join("/workspace", "assets", `${iconName}.ico`));
    expect(nsis.nsis?.installerIcon).toBe(nsis.win?.icon);
    expect(nsis.nsis?.uninstallerIcon).toBe(nsis.win?.icon);
  });

  it("packages an ASAR app with supported platform makers and hardened fuses", () => {
    expect(config.packagerConfig?.asar).toMatchObject({ unpackDir: "node_modules/@img" });
    expect(config.packagerConfig).toMatchObject({
      name: process.platform === "win32" ? "Scriverse Desktop" : "scriverse-desktop",
      executableName: process.platform === "linux" ? "scriverse-desktop" : "Scriverse Desktop",
      appBundleId: "top.scriverse.desktop",
      extendInfo: {
        CFBundleDevelopmentRegion: "zh-Hans"
      },
      icon: expect.stringContaining("assets/icon")
    });
    expect(config.makers?.map((maker) => "name" in maker ? maker.name : "")).toEqual(expect.arrayContaining([
      "dmg",
      "zip",
      "@electron-forge/maker-squirrel",
      "nsis",
      "@electron-forge/maker-deb",
      "@electron-forge/maker-rpm"
    ]));
    expect(config.plugins).toHaveLength(2);
    expect(config.packagerConfig?.ignore?.some((pattern) => pattern.test("/runtime-overlay/web.patch"))).toBe(true);
    expect(config.packagerConfig?.extraResource).toEqual(expect.arrayContaining([expect.stringContaining("assets/app-update.yml")]));
  });

  it("mutates only the packaged manifest entry point", async () => {
    const sourceManifest = { name: "@musnows/scriverse-desktop", version: "0.1.0" };
    const hook = config.hooks?.readPackageJson;
    expect(hook).toBeTypeOf("function");
    const packaged = await hook?.({} as never, sourceManifest);
    expect(sourceManifest).not.toHaveProperty("main");
    expect(packaged).toMatchObject({
      name: "scriverse-desktop",
      productName: "叙界",
      main: "build/main/main.js",
      private: true
    });
  });

  it("fails before packaging when target sharp binaries are absent", async () => {
    const hook = config.hooks?.prePackage;
    const missingArch = process.arch === "arm64" ? "x64" : "arm64";
    await expect(hook?.({} as never, process.platform, missingArch)).rejects.toThrow(/native target dependencies/u);
    await expect(hook?.({} as never, process.platform, process.arch)).resolves.toBeUndefined();
  });

  it("keeps an English macOS package directory and renames only the app bundle", async () => {
    const hook = config.hooks?.postPackage;
    expect(hook).toBeTypeOf("function");
    expect(config.packagerConfig?.name).toBe(process.platform === "win32" ? "Scriverse Desktop" : "scriverse-desktop");
  });

  it("passes the localized app bundle name to macOS artifact makers", () => {
    const makers = config.makers ?? [];
    expect(makers.some((maker) => "name" in maker && maker.name === "dmg")).toBe(true);
    expect(makers.some((maker) => "name" in maker && maker.name === "zip")).toBe(true);
  });

  it("builds an assisted Windows installer that allows choosing the installation directory", () => {
    const nsis = windowsNsisBuilderConfiguration({
      targetArch: "arm64",
      makeDir: "/workspace/out/make",
      projectDir: "/workspace",
      certificateFile: "/certificate/desktop.pfx",
      certificatePassword: "secret"
    });
    expect(nsis.directories?.output).toBe("/workspace/out/make/nsis.windows/arm64");
    expect(nsis.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      artifactName: "scriverse-desktop-windows-win32-arm64-${version}-Setup.${ext}"
    });
    expect(nsis.publish).toMatchObject({
      provider: "generic",
      channel: "latest-arm64"
    });
    expect(nsis.win?.signtoolOptions).toMatchObject({
      certificateFile: "/certificate/desktop.pfx",
      signingHashAlgorithms: ["sha256"]
    });
  });
});
