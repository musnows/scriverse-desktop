import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { existsSync } from "node:fs";
import { join } from "node:path";

const desktopMainEntry = "build/main/main.js";
const desktopAssets = "assets";
const macSigningIdentity = process.env.APPLE_SIGN_IDENTITY?.trim() || null;
const macNotarization = process.env.APPLE_API_KEY?.trim()
  && process.env.APPLE_API_KEY_ID?.trim()
  && process.env.APPLE_API_ISSUER?.trim()
  ? {
      appleApiKey: process.env.APPLE_API_KEY.trim(),
      appleApiKeyId: process.env.APPLE_API_KEY_ID.trim(),
      appleApiIssuer: process.env.APPLE_API_ISSUER.trim()
    }
  : null;
const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE?.trim() || null;
const windowsCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD ?? null;
const releaseBuild = process.env.SCRIVERSE_DESKTOP_RELEASE_BUILD === "true";

if (releaseBuild && process.platform === "darwin" && (!macSigningIdentity || !macNotarization)) {
  throw new Error("macOS release builds require signing and notarization credentials");
}
if (releaseBuild && process.platform === "win32" && (!windowsCertificateFile || !windowsCertificatePassword)) {
  throw new Error("Windows release builds require signing credentials");
}

const packageIcon = process.platform === "darwin"
  ? `${desktopAssets}/icon.icns`
  : process.platform === "win32"
    ? `${desktopAssets}/icon.ico`
    : `${desktopAssets}/icon-512.png`;
const linuxMakerOptions = {
  name: "scriverse-desktop",
  productName: "Scriverse Desktop",
  genericName: "Long-form Fiction Workspace",
  description: "Local AI workspace for long-form fiction",
  productDescription: "Scriverse Desktop manages long-form fiction, settings, timelines, relationships and isolated AI-assisted writing workspaces.",
  bin: "Scriverse Desktop",
  icon: join(process.cwd(), desktopAssets, "icon-512.png"),
  categories: ["Office" as const],
  homepage: "https://scriverse.top/"
};

function assertTargetNativeDependencies(platform: string, arch: string): void {
  const target = platform === "win32" ? `win32-${arch}` : `${platform}-${arch}`;
  const packages = [`sharp-${target}`];
  if (platform === "darwin" || platform === "linux") packages.push(`sharp-libvips-${target}`);
  const missing = packages.filter((name) => !existsSync(join("node_modules", "@img", name, "package.json")));
  if (missing.length > 0) {
    throw new Error(`Desktop ${platform}/${arch} packaging requires native target dependencies: ${missing.join(", ")}. Run npm ci on a native target runner.`);
  }
}

const config: ForgeConfig = {
  outDir: "out",
  packagerConfig: {
    asar: {
      unpackDir: "node_modules/@img"
    },
    icon: packageIcon,
    osxSign: macSigningIdentity ? { identity: macSigningIdentity } : {
      identity: "-",
      identityValidation: false,
      preAutoEntitlements: false,
      optionsForFile: () => ({ hardenedRuntime: false })
    },
    ...(macNotarization ? { osxNotarize: macNotarization } : {}),
    ...(windowsCertificateFile && windowsCertificatePassword ? {
      windowsSign: {
        certificateFile: windowsCertificateFile,
        certificatePassword: windowsCertificatePassword,
        description: "Scriverse Desktop",
        website: "https://scriverse.top/"
      }
    } : {}),
    name: "Scriverse Desktop",
    executableName: "Scriverse Desktop",
    appBundleId: "top.scriverse.desktop",
    appCategoryType: "public.app-category.productivity",
    appCopyright: "Copyright musnows",
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true
      }
    },
    ignore: [
      /^\/.ai-docs(?:\/|$)/u,
      /^\/.data(?:\/|$)/u,
      /^\/.github(?:\/|$)/u,
      /^\/coverage(?:\/|$)/u,
      /^\/assets(?:\/|$)/u,
      /^\/runtime-overlay(?:\/|$)/u,
      /^\/scripts(?:\/|$)/u,
      /^\/src(?:\/|$)/u,
      /^\/tests(?:\/|$)/u,
      /^\/tsconfig(?:\.[^/]+)?\.json$/u,
      /^\/vitest\.config\.ts$/u
    ]
  },
  hooks: {
    prePackage: async (_forgeConfig, platform, arch) => {
      assertTargetNativeDependencies(String(platform), String(arch));
    },
    readPackageJson: async (_forgeConfig, packageJson) => ({
      ...packageJson,
      name: "scriverse-desktop",
      productName: "Scriverse Desktop",
      main: desktopMainEntry,
      private: true
    })
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {}
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux"],
      config: {}
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "ScriverseDesktop",
        ...(windowsCertificateFile && windowsCertificatePassword ? {
          certificateFile: windowsCertificateFile,
          certificatePassword: windowsCertificatePassword
        } : {})
      }
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: { options: linuxMakerOptions }
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: { options: linuxMakerOptions }
    }
  ],
  plugins: [
    { name: "@electron-forge/plugin-auto-unpack-natives", config: {} },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
};

export default config;
