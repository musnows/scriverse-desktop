import { isAbsolute } from "node:path";
import { parseLocalServerPort } from "../shared/desktop-settings-contract.js";

export const DESKTOP_DEVELOPMENT_MODE = "isolated";

export type DevelopmentIsolationOptions = {
  env: NodeJS.ProcessEnv;
  packaged: boolean;
  runtimeGateRequested: boolean;
};

export function resolveDevelopmentLocalServerPort(
  env: NodeJS.ProcessEnv = process.env,
  packaged = false
): number | null {
  if (packaged || env.SCRIVERSE_DESKTOP_DEV_MODE !== DESKTOP_DEVELOPMENT_MODE) return null;
  const value = env.SCRIVERSE_DESKTOP_DEV_PORT?.trim();
  if (!value) throw new Error("Isolated Desktop development requires SCRIVERSE_DESKTOP_DEV_PORT");
  return parseLocalServerPort(Number(value));
}

export function developmentIsolationError(options: DevelopmentIsolationOptions): string | null {
  if (options.packaged || options.runtimeGateRequested) return null;
  if (options.env.SCRIVERSE_DESKTOP_DEV_MODE !== DESKTOP_DEVELOPMENT_MODE) {
    return "Non-packaged Desktop startup requires SCRIVERSE_DESKTOP_DEV_MODE=isolated";
  }
  const dataDirectory = options.env.SCRIVERSE_DESKTOP_DATA_DIR?.trim();
  if (!dataDirectory || !isAbsolute(dataDirectory)) {
    return "Isolated Desktop development requires an absolute SCRIVERSE_DESKTOP_DATA_DIR";
  }
  try {
    resolveDevelopmentLocalServerPort(options.env, options.packaged);
  } catch {
    return "Isolated Desktop development requires a valid SCRIVERSE_DESKTOP_DEV_PORT";
  }
  return null;
}
