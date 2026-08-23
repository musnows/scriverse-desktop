import type { ProtocolRange, RemoteCompatibility } from "./contracts.js";

export const DESKTOP_SHELL_PROTOCOL_RANGE = Object.freeze({ min: 1, max: 1 });
export const DESKTOP_SYNC_PROTOCOL_RANGE = Object.freeze({ min: 1, max: 1 });

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
};

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".").map((part) => /^\d+$/u.test(part) ? Number(part) : part) ?? []
  };
}

export function compareSemanticVersions(left: string, right: string): number | null {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) return leftVersion[key] < rightVersion[key] ? -1 : 1;
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    if (leftVersion.prerelease.length === rightVersion.prerelease.length) return 0;
    return leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart < rightPart ? -1 : 1;
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart.localeCompare(rightPart, "en-US") < 0 ? -1 : 1;
  }
  return 0;
}

export function protocolRangesIntersect(left: ProtocolRange, right: ProtocolRange): boolean {
  return Math.max(left.min, right.min) <= Math.min(left.max, right.max);
}

export function classifyRemoteCompatibility(input: {
  desktopVersion: string;
  minimumDesktopVersion: string | null;
  shellProtocol: ProtocolRange | null;
  syncProtocol: ProtocolRange | null;
}): RemoteCompatibility {
  if (input.minimumDesktopVersion) {
    const comparison = compareSemanticVersions(input.desktopVersion, input.minimumDesktopVersion);
    if (comparison === null || comparison < 0) return "desktop-upgrade-required";
  }
  if (!input.shellProtocol) return "legacy-online-only";
  if (!protocolRangesIntersect(input.shellProtocol, DESKTOP_SHELL_PROTOCOL_RANGE)) return "shell-incompatible";
  if (!input.syncProtocol || !protocolRangesIntersect(input.syncProtocol, DESKTOP_SYNC_PROTOCOL_RANGE)) return "online-only";
  return "compatible";
}
