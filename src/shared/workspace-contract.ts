export const WORKSPACE_SHELL_PROTOCOL = 1;
export const WORKSPACE_SYNC_PROTOCOL = 1;

export type WorkspaceLeaveState = {
  dirty: boolean;
  activeAiRequests: number;
  pendingMutations: number;
  conflicts: number;
  rejected: number;
};

export class WorkspaceContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new WorkspaceContractError("WORKSPACE_INPUT_INVALID", `${label} 包含未知字段`);
  }
}

function assertUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new WorkspaceContractError("WORKSPACE_INPUT_INVALID", `${label} 无效`);
  }
  return value;
}

export function parseOfflineKeyRequest(value: unknown): { userId: string } {
  if (!isRecord(value)) throw new WorkspaceContractError("WORKSPACE_INPUT_INVALID", "离线密钥请求无效");
  assertExactKeys(value, ["userId"], "离线密钥请求");
  return { userId: assertUuid(value.userId, "user id") };
}

export function parseWorkspaceLeaveState(value: unknown): WorkspaceLeaveState {
  if (!isRecord(value)) throw new WorkspaceContractError("WORKSPACE_INPUT_INVALID", "工作区离开状态无效");
  assertExactKeys(value, ["dirty", "activeAiRequests", "pendingMutations", "conflicts", "rejected"], "工作区离开状态");
  const counts = [value.activeAiRequests, value.pendingMutations, value.conflicts, value.rejected];
  if (
    typeof value.dirty !== "boolean"
    || counts.some((count) => !Number.isInteger(count) || Number(count) < 0 || Number(count) > 1_000_000)
  ) throw new WorkspaceContractError("WORKSPACE_INPUT_INVALID", "工作区离开状态字段无效");
  return {
    dirty: value.dirty,
    activeAiRequests: Number(value.activeAiRequests),
    pendingMutations: Number(value.pendingMutations),
    conflicts: Number(value.conflicts),
    rejected: Number(value.rejected)
  };
}
