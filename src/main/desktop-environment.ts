import { app } from "electron";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultDesktopRoot, expandDesktopPath, resolveDesktopPaths, type DesktopPaths } from "./app-paths.js";
import { initializeDesktopLocalVault, initializeDesktopStorageRoot } from "../shared/storage-manifest.js";

export type DesktopEnvironment = {
  paths: DesktopPaths;
  desktopId: string;
};

function preparePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

export function initializeDesktopEnvironment(): DesktopEnvironment {
  const root = process.env.SCRIVERSE_DESKTOP_DATA_DIR
    ? expandDesktopPath(process.env.SCRIVERSE_DESKTOP_DATA_DIR)
    : defaultDesktopRoot();
  const paths = resolveDesktopPaths(root);
  const rootManifest = initializeDesktopStorageRoot(paths.root);
  initializeDesktopLocalVault(paths.localVault, rootManifest.desktopId);
  [
    paths.clientMeta,
    paths.syncStatus,
    paths.remoteAuth,
    paths.localAiProviders,
    paths.localRuntime,
    paths.browserSessions,
    paths.logs,
    paths.crashDumps,
    join(paths.clientMeta, "electron")
  ].forEach(preparePrivateDirectory);
  app.setPath("userData", join(paths.clientMeta, "electron"));
  app.setPath("sessionData", paths.browserSessions);
  app.setPath("crashDumps", paths.crashDumps);
  app.setAppLogsPath(paths.logs);
  return { paths, desktopId: rootManifest.desktopId };
}
