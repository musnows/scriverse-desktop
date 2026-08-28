import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export function isSquirrelWindowsInstallation(options: {
  platform?: NodeJS.Platform;
  executablePath?: string;
  fileExists?: (path: string) => boolean;
} = {}): boolean {
  const platform = options.platform ?? process.platform;
  const executablePath = options.executablePath ?? process.execPath;
  const fileExists = options.fileExists ?? existsSync;
  const applicationDirectory = dirname(executablePath);
  return platform === "win32"
    && /^app-[0-9]/u.test(basename(applicationDirectory))
    && fileExists(resolve(applicationDirectory, "..", "Update.exe"));
}
