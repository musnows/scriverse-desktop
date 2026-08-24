import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerZIP } from "@electron-forge/maker-zip";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_DISPLAY_NAME } from "./src/shared/branding.js";

const desktopMainEntry = "build/main/main.js";
const desktopAssets = "assets";
const internalApplicationName = "Scriverse Desktop";
const packagedApplicationName = process.platform === "win32" ? internalApplicationName : "scriverse-desktop";
const packagedExecutableName = process.platform === "linux" ? "scriverse-desktop" : internalApplicationName;
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

class LocalizedMacDmgMaker extends MakerDMG {
  override make(options: Parameters<MakerDMG["make"]>[0]): Promise<string[]> {
    return super.make({ ...options, appName: DESKTOP_DISPLAY_NAME });
  }
}

class LocalizedMacZipMaker extends MakerZIP {
  override make(options: Parameters<MakerZIP["make"]>[0]): Promise<string[]> {
    return super.make({
      ...options,
      appName: options.targetPlatform === "darwin" ? DESKTOP_DISPLAY_NAME : options.appName
    });
  }
}

const packageIcon = process.platform === "darwin"
  ? `${desktopAssets}/icon.icns`
  : process.platform === "win32"
    ? `${desktopAssets}/icon.ico`
    : `${desktopAssets}/icon-512.png`;
const linuxMakerOptions = {
  name: "scriverse-desktop",
  productName: DESKTOP_DISPLAY_NAME,
  genericName: "Long-form Fiction Workspace",
  description: "Local AI workspace for long-form fiction",
  productDescription: "叙界 manages long-form fiction, settings, timelines, relationships and isolated AI-assisted writing workspaces.",
  bin: packagedExecutableName,
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
    ...(process.platform === "darwin" ? { extraResource: [join(process.cwd(), desktopAssets, "zh-Hans.lproj")] } : {}),
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
        description: DESKTOP_DISPLAY_NAME,
        website: "https://scriverse.top/"
      }
    } : {}),
    name: packagedApplicationName,
    executableName: packagedExecutableName,
    appBundleId: "top.scriverse.desktop",
    appCategoryType: "public.app-category.productivity",
    appCopyright: "Copyright musnows",
    extendInfo: {
      CFBundleDevelopmentRegion: "zh-Hans",
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
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== "darwin") return;
      for (const outputPath of packageResult.outputPaths) {
        const packagedBundle = join(outputPath, `${packagedApplicationName}.app`);
        const displayBundle = join(outputPath, `${DESKTOP_DISPLAY_NAME}.app`);
        if (!existsSync(packagedBundle)) {
          if (existsSync(displayBundle)) continue;
          throw new Error(`Packaged macOS application is missing: ${packagedBundle}`);
        }
        if (existsSync(displayBundle)) throw new Error(`Packaged macOS display application already exists: ${displayBundle}`);
        renameSync(packagedBundle, displayBundle);
      }
    },
    readPackageJson: async (_forgeConfig, packageJson) => ({
      ...packageJson,
      name: "scriverse-desktop",
      productName: DESKTOP_DISPLAY_NAME,
      main: desktopMainEntry,
      private: true
    })
  },
  makers: [
    new LocalizedMacDmgMaker({ name: "scriverse-desktop" }),
    new LocalizedMacZipMaker({}, ["darwin", "linux"]),
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
