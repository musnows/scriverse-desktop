export const DESKTOP_SETTINGS_VERSION = 1;
export const DEFAULT_LOCAL_SERVER_PORT = 23_241;
export const MIN_LOCAL_SERVER_PORT = 20_001;
export const LOCAL_SERVER_PORT_SCAN_COUNT = 20;
export const MAX_LOCAL_SERVER_PORT = 65_535 - (LOCAL_SERVER_PORT_SCAN_COUNT - 1);

export type DesktopSettingsSummary = {
  localServerPort: number;
  updatedAt: string | null;
};

export class DesktopSettingsContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DesktopSettingsContractError";
  }
}

export class LocalServerPortUnavailableError extends Error {
  readonly code = "LOCAL_PORT_UNAVAILABLE";

  constructor(readonly preferredPort: number) {
    super(`本地工作区端口 ${preferredPort} 被占用，请在 Desktop 系统设置中修改端口号`);
    this.name = "LocalServerPortUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLocalServerPort(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < MIN_LOCAL_SERVER_PORT
    || value > MAX_LOCAL_SERVER_PORT
  ) {
    throw new DesktopSettingsContractError(
      "LOCAL_PORT_INVALID",
      `本地工作区端口必须是 ${MIN_LOCAL_SERVER_PORT} 到 ${MAX_LOCAL_SERVER_PORT} 之间的整数`
    );
  }
  return value;
}

export function parseDesktopSettingsUpdate(value: unknown): { localServerPort: number } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "localServerPort")) {
    throw new DesktopSettingsContractError("DESKTOP_SETTINGS_INVALID", "Desktop 系统设置请求无效");
  }
  return { localServerPort: parseLocalServerPort(value.localServerPort) };
}

export function localServerPortCandidates(preferredPort: number): number[] {
  const base = parseLocalServerPort(preferredPort);
  return Array.from({ length: LOCAL_SERVER_PORT_SCAN_COUNT }, (_value, offset) => base + offset);
}

export async function selectLocalServerPort(
  preferredPort: number,
  canBind: (port: number) => Promise<boolean>
): Promise<number> {
  for (const port of localServerPortCandidates(preferredPort)) {
    if (await canBind(port)) return port;
  }
  throw new LocalServerPortUnavailableError(preferredPort);
}
