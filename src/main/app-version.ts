import { readFileSync } from "node:fs";
import { join } from "node:path";

function readApplicationManifest(applicationRoot: string): unknown {
  try {
    return JSON.parse(readFileSync(join(applicationRoot, "package.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function resolveDesktopAppVersion(options: {
  packaged: boolean;
  packagedVersion: string;
  applicationRoot: string;
}): string {
  if (options.packaged) return options.packagedVersion;
  const packageJson = readApplicationManifest(options.applicationRoot);
  if (
    typeof packageJson === "object"
    && packageJson !== null
    && "version" in packageJson
    && typeof packageJson.version === "string"
    && packageJson.version.length > 0
    && packageJson.version.length <= 80
  ) return packageJson.version;
  // 开发环境缺少包元数据时回退到 Electron 提供的版本，避免阻止 Selector 启动。
  return options.packagedVersion;
}

export function resolveCompatibleServerVersion(applicationRoot: string): string {
  const packageJson = readApplicationManifest(applicationRoot);
  if (
    typeof packageJson === "object"
    && packageJson !== null
    && "scriverseServerVersion" in packageJson
    && typeof packageJson.scriverseServerVersion === "string"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.scriverseServerVersion)
  ) return packageJson.scriverseServerVersion;
  return "未知";
}
