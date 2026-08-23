import type { WorkspaceProfile } from "./contracts.js";

export const SELECTOR_ENTRY_URL = "app://desktop/selector/index.html";
export const LOCAL_AI_CONFIG_ENTRY_URL = "app://desktop/local-ai/index.html";

export class SelectorContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SelectorContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new SelectorContractError("SELECTOR_INPUT_INVALID", "请求包含未知字段");
  }
}

function assertName(value: unknown): string {
  if (typeof value !== "string") throw new SelectorContractError("PROFILE_NAME_INVALID", "工作区名称无效");
  const name = value.trim();
  if (name.length === 0 || name.length > 80) {
    throw new SelectorContractError("PROFILE_NAME_INVALID", "工作区名称长度必须在 1 到 80 个字符之间");
  }
  return name;
}

function assertOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new SelectorContractError("PROFILE_URL_INVALID", "Server URL 长度必须在 1 到 2048 个字符之间");
  }
  return value;
}

export function parseCreateRemoteProfileInput(value: unknown): { name: string; origin: string } {
  if (!isRecord(value)) throw new SelectorContractError("SELECTOR_INPUT_INVALID", "新增 Server 请求无效");
  assertExactKeys(value, ["name", "origin"]);
  return { name: assertName(value.name), origin: assertOrigin(value.origin) };
}

export function parseUpdateRemoteProfileInput(value: unknown): { id: string; name: string; origin: string; discardUnsynced: boolean } {
  if (!isRecord(value)) throw new SelectorContractError("SELECTOR_INPUT_INVALID", "修改 Server 请求无效");
  assertExactKeys(value, ["id", "name", "origin", "discardUnsynced"]);
  if (typeof value.discardUnsynced !== "boolean") throw new SelectorContractError("SELECTOR_INPUT_INVALID", "修改 Server 的离线数据确认无效");
  return {
    id: parseProfileId(value.id),
    name: assertName(value.name),
    origin: assertOrigin(value.origin),
    discardUnsynced: value.discardUnsynced
  };
}

export function parseRemoveRemoteProfileInput(value: unknown): { id: string; discardUnsynced: boolean } {
  if (!isRecord(value)) throw new SelectorContractError("SELECTOR_INPUT_INVALID", "删除 Server 请求无效");
  assertExactKeys(value, ["id", "discardUnsynced"]);
  if (typeof value.discardUnsynced !== "boolean") throw new SelectorContractError("SELECTOR_INPUT_INVALID", "删除 Server 的离线数据确认无效");
  return { id: parseProfileId(value.id), discardUnsynced: value.discardUnsynced };
}

export function assertRemoteProfileDataDisposition(
  status: { pendingMutations: number; conflicts: number; rejected: number },
  discardUnsynced: boolean
): void {
  const counts = [status.pendingMutations, status.conflicts, status.rejected];
  if (counts.some((count) => !Number.isInteger(count) || count < 0 || count > 1_000_000)) {
    throw new SelectorContractError("SELECTOR_INPUT_INVALID", "Server 本机离线状态无效");
  }
  const unsynced = status.pendingMutations + status.conflicts + status.rejected;
  if (unsynced === 0 || discardUnsynced) return;
  const details = [
    status.pendingMutations > 0 ? `${status.pendingMutations} 项待同步` : null,
    status.conflicts > 0 ? `${status.conflicts} 项冲突` : null,
    status.rejected > 0 ? `${status.rejected} 项只读修改` : null
  ].filter(Boolean).join("、");
  throw new SelectorContractError(
    "PROFILE_UNSYNCED_DATA",
    `此 Server 的本机离线数据仍有${details}。请先进入同步中心完成同步或导出救援包；再次确认才会永久删除本机副本。`
  );
}

export function parseProfileId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new SelectorContractError("PROFILE_ID_INVALID", "工作区 profile id 无效");
  }
  return value;
}

export function sortProfilesForSelector(profiles: readonly WorkspaceProfile[]): WorkspaceProfile[] {
  return profiles.toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "local" ? -1 : 1;
    if (left.kind === "local" || right.kind === "local") return 0;
    if (left.lastUsedAt !== right.lastUsedAt) {
      if (left.lastUsedAt === null) return 1;
      if (right.lastUsedAt === null) return -1;
      return right.lastUsedAt.localeCompare(left.lastUsedAt);
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
}
