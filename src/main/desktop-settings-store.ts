import { existsSync, readFileSync, statSync } from "node:fs";
import {
  DEFAULT_LOCAL_SERVER_PORT,
  DESKTOP_SETTINGS_VERSION,
  DesktopSettingsContractError,
  parseDesktopSettingsUpdate,
  parseLocalServerPort,
  type DesktopSettingsSummary
} from "../shared/desktop-settings-contract.js";
import { writeDesktopJsonAtomically } from "../shared/storage-manifest.js";

const MAX_SETTINGS_BYTES = 64 * 1024;

type DesktopSettingsDocument = {
  version: typeof DESKTOP_SETTINGS_VERSION;
  localServerPort: number;
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDocument(value: unknown): DesktopSettingsDocument {
  if (!isRecord(value) || Object.keys(value).toSorted().join(",") !== "localServerPort,updatedAt,version") {
    throw new DesktopSettingsContractError("DESKTOP_SETTINGS_INVALID", "Desktop 系统设置格式无效");
  }
  if (value.version !== DESKTOP_SETTINGS_VERSION || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new DesktopSettingsContractError("DESKTOP_SETTINGS_INVALID", "Desktop 系统设置版本或更新时间无效");
  }
  return {
    version: DESKTOP_SETTINGS_VERSION,
    localServerPort: parseLocalServerPort(value.localServerPort),
    updatedAt: value.updatedAt
  };
}

export class DesktopSettingsStore {
  private document: DesktopSettingsDocument | null = null;

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    if (statSync(path).size > MAX_SETTINGS_BYTES) {
      throw new DesktopSettingsContractError("DESKTOP_SETTINGS_INVALID", "Desktop 系统设置文件过大");
    }
    try {
      this.document = parseDocument(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof DesktopSettingsContractError) throw error;
      throw new DesktopSettingsContractError("DESKTOP_SETTINGS_INVALID", "Desktop 系统设置无法读取");
    }
  }

  get(): DesktopSettingsSummary {
    return {
      localServerPort: this.document?.localServerPort ?? DEFAULT_LOCAL_SERVER_PORT,
      updatedAt: this.document?.updatedAt ?? null
    };
  }

  update(value: unknown): DesktopSettingsSummary {
    const input = parseDesktopSettingsUpdate(value);
    this.document = {
      version: DESKTOP_SETTINGS_VERSION,
      localServerPort: input.localServerPort,
      updatedAt: new Date().toISOString()
    };
    writeDesktopJsonAtomically(this.path, this.document);
    return this.get();
  }
}
