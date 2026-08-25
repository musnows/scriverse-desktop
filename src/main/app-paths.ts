import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";

export type DesktopPaths = {
  root: string;
  clientMeta: string;
  profiles: string;
  windowState: string;
  syncStatus: string;
  remoteAuth: string;
  localAuth: string;
  localAiProviders: string;
  desktopMasterKey: string;
  desktopSettings: string;
  remoteMedia: string;
  localVault: string;
  localRuntime: string;
  localVaultLock: string;
  browserSessions: string;
  logs: string;
  crashDumps: string;
};

export type DefaultDesktopRootOptions = {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  localAppData?: string;
  xdgDataHome?: string;
};

export function expandDesktopPath(input: string, homeDirectory = homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error("Desktop 数据目录不能为空");
  const expanded = trimmed === "~"
    ? homeDirectory
    : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? join(homeDirectory, trimmed.slice(2))
      : trimmed;
  return normalize(isAbsolute(expanded) ? expanded : resolve(expanded));
}

export function defaultDesktopRoot(options: DefaultDesktopRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  if (platform === "darwin") return posix.join(homeDirectory, "Library", "Application Support", "Scriverse Desktop", "data");
  if (platform === "win32") {
    return win32.join(options.localAppData ?? win32.join(homeDirectory, "AppData", "Local"), "Scriverse Desktop", "data");
  }
  return posix.join(options.xdgDataHome ?? posix.join(homeDirectory, ".local", "share"), "scriverse-desktop", "data");
}

export function resolveDesktopPaths(rootInput: string): DesktopPaths {
  const root = expandDesktopPath(rootInput);
  const clientMeta = join(root, "client-meta");
  const localVault = join(root, "local-vault");
  return {
    root,
    clientMeta,
    profiles: join(clientMeta, "profiles.json"),
    windowState: join(clientMeta, "window-state.json"),
    syncStatus: join(clientMeta, "sync-status"),
    remoteAuth: join(clientMeta, "remote-auth"),
    localAuth: join(clientMeta, "local-auth.json"),
    localAiProviders: join(clientMeta, "local-ai-providers"),
    desktopMasterKey: join(clientMeta, "master.key"),
    desktopSettings: join(clientMeta, "desktop-settings.json"),
    remoteMedia: join(root, "remote-media"),
    localVault,
    localRuntime: join(localVault, "runtime"),
    localVaultLock: join(localVault, "desktop-vault.lock"),
    browserSessions: join(root, "browser-sessions-v2"),
    logs: join(root, "logs"),
    crashDumps: join(root, "crash-dumps")
  };
}
