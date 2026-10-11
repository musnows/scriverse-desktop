import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DESKTOP_DISPLAY_NAME } from "../src/shared/branding.js";

const executeFile = promisify(execFile);

export class MacDmgMaker extends MakerBase<Record<string, never>> {
  name = "dmg";

  defaultPlatforms: ForgePlatform[] = ["darwin"];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "darwin";
  }

  async make(options: MakerOptions): Promise<string[]> {
    const version: unknown = options.packageJSON.version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(version)) {
      throw new Error("Desktop disk image version is invalid");
    }
    if (!this.isSupportedOnCurrentPlatform()) throw new Error("macOS disk images require a macOS runner");
    const sourceBundle = join(options.dir, `${DESKTOP_DISPLAY_NAME}.app`);
    await access(sourceBundle);
    const destination = join(options.makeDir, "dmg", options.targetArch);
    await mkdir(destination, { recursive: true });
    const staging = await mkdtemp(join(dirname(options.makeDir), "dmg-stage-"));
    await executeFile("/usr/bin/ditto", [sourceBundle, join(staging, `${DESKTOP_DISPLAY_NAME}.app`)]);
    await symlink("/Applications", join(staging, "Applications"));
    const artifact = join(destination, `scriverse-desktop-${version}.dmg`);
    await executeFile("/usr/bin/hdiutil", [
      "create", "-ov", "-format", "UDZO", "-fs", "HFS+",
      "-volname", DESKTOP_DISPLAY_NAME, "-srcfolder", staging, artifact
    ], { maxBuffer: 4 * 1024 * 1024 });
    return [artifact];
  }
}
