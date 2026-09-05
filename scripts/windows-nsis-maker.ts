import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import { buildForge, type Configuration } from "app-builder-lib";
import { join } from "node:path";

import { DESKTOP_DISPLAY_NAME } from "../src/shared/branding.js";
import { windowsNsisUpdateChannel } from "../src/shared/update-policy.js";

const WINDOWS_EXECUTABLE_NAME = "Scriverse Desktop";
const WINDOWS_UPDATE_URL = "https://github.com/musnows/scriverse-desktop/releases/latest/download";

export type WindowsNsisMakerConfig = {
  certificateFile?: string | null;
  certificatePassword?: string | null;
};

export function windowsNsisBuilderConfiguration(options: {
  targetArch: string;
  makeDir: string;
  projectDir?: string;
  certificateFile?: string | null;
  certificatePassword?: string | null;
}): Configuration {
  const projectDir = options.projectDir ?? process.cwd();
  const certificateFile = options.certificateFile?.trim() || null;
  const certificatePassword = options.certificatePassword ?? null;
  return {
    appId: "top.scriverse.desktop",
    productName: DESKTOP_DISPLAY_NAME,
    copyright: "Copyright musnows",
    directories: {
      output: join(options.makeDir, "nsis.windows", options.targetArch),
      buildResources: join(projectDir, "assets")
    },
    win: {
      icon: join(projectDir, "assets", "icon.ico"),
      executableName: WINDOWS_EXECUTABLE_NAME,
      ...(certificateFile && certificatePassword !== null ? {
        signtoolOptions: {
          certificateFile,
          certificatePassword,
          signingHashAlgorithms: ["sha256"]
        }
      } : {})
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      artifactName: `scriverse-desktop-windows-win32-${options.targetArch}-\${version}-Setup.\${ext}`,
      installerIcon: join(projectDir, "assets", "icon.ico"),
      uninstallerIcon: join(projectDir, "assets", "icon.ico")
    },
    publish: {
      provider: "generic",
      url: WINDOWS_UPDATE_URL,
      channel: windowsNsisUpdateChannel(options.targetArch)
    }
  };
}

export class WindowsNsisMaker extends MakerBase<WindowsNsisMakerConfig> {
  name = "nsis";

  defaultPlatforms: ForgePlatform[] = ["win32"];

  isSupportedOnCurrentPlatform(): boolean {
    return true;
  }

  async make(options: MakerOptions): Promise<string[]> {
    return buildForge({ dir: options.dir }, {
      win: [`nsis:${options.targetArch}`],
      projectDir: process.cwd(),
      config: windowsNsisBuilderConfiguration({
        targetArch: options.targetArch,
        makeDir: options.makeDir,
        certificateFile: this.config.certificateFile,
        certificatePassword: this.config.certificatePassword
      })
    });
  }
}
