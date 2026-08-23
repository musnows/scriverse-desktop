import { describe, expect, it } from "vitest";
import config from "../../forge.config.js";

describe("Desktop Forge configuration", () => {
  it("packages an ASAR app with supported platform makers and hardened fuses", () => {
    expect(config.packagerConfig?.asar).toMatchObject({ unpackDir: "node_modules/@img" });
    expect(config.packagerConfig).toMatchObject({
      name: "Scriverse Desktop",
      executableName: "Scriverse Desktop",
      appBundleId: "top.scriverse.desktop",
      icon: expect.stringContaining("assets/icon")
    });
    expect(config.makers?.map((maker) => "name" in maker ? maker.name : "")).toEqual(expect.arrayContaining([
      "@electron-forge/maker-dmg",
      "@electron-forge/maker-zip",
      "@electron-forge/maker-squirrel",
      "@electron-forge/maker-deb",
      "@electron-forge/maker-rpm"
    ]));
    expect(config.plugins).toHaveLength(2);
  });

  it("mutates only the packaged manifest entry point", async () => {
    const sourceManifest = { name: "@musnows/scriverse-desktop", version: "0.0.1" };
    const hook = config.hooks?.readPackageJson;
    expect(hook).toBeTypeOf("function");
    const packaged = await hook?.({} as never, sourceManifest);
    expect(sourceManifest).not.toHaveProperty("main");
    expect(packaged).toMatchObject({
      name: "scriverse-desktop",
      productName: "Scriverse Desktop",
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
});
