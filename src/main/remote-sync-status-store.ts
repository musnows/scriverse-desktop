import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import type { WorkspaceLeaveState } from "../shared/workspace-contract.js";
import { writeDesktopJsonAtomically } from "../shared/storage-manifest.js";

export const REMOTE_SYNC_STATUS_VERSION = 1;

export type RemoteSyncUserStatus = Pick<WorkspaceLeaveState, "pendingMutations" | "conflicts" | "rejected"> & {
  userId: string;
  updatedAt: string;
};

export type RemoteSyncStatusSummary = Pick<WorkspaceLeaveState, "pendingMutations" | "conflicts" | "rejected"> & {
  userCount: number;
  updatedAt: string | null;
};

type RemoteSyncStatusDocument = {
  version: typeof REMOTE_SYNC_STATUS_VERSION;
  profileId: string;
  origin: string;
  users: RemoteSyncUserStatus[];
  updatedAt: string;
};

export class RemoteSyncStatusStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteSyncStatusStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", `${label}包含未知字段`);
  }
}

function assertUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", `${label}无效`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) {
    throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", `${label}无效`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", `${label}无效`);
  }
  return value;
}

function statusPath(directory: string, profileId: string): string {
  return join(directory, `${assertUuid(profileId, "profile id")}.json`);
}

function emptySummary(): RemoteSyncStatusSummary {
  return { pendingMutations: 0, conflicts: 0, rejected: 0, userCount: 0, updatedAt: null };
}

export class RemoteSyncStatusStore {
  constructor(private readonly directory: string) {}

  private read(profile: RemoteWorkspaceProfile): RemoteSyncStatusDocument | null {
    const path = statusPath(this.directory, profile.id);
    if (!existsSync(path)) return null;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", "远端离线状态无法读取");
    }
    if (!isRecord(value)) throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", "远端离线状态格式无效");
    assertExactKeys(value, ["version", "profileId", "origin", "users", "updatedAt"], "远端离线状态");
    if (
      value.version !== REMOTE_SYNC_STATUS_VERSION
      || value.profileId !== profile.id
      || value.origin !== profile.origin
      || !Array.isArray(value.users)
      || value.users.length > 1_000
    ) throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", "远端离线状态身份无效");
    const users = value.users.map((entry): RemoteSyncUserStatus => {
      if (!isRecord(entry)) throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", "远端账户离线状态无效");
      assertExactKeys(entry, ["userId", "pendingMutations", "conflicts", "rejected", "updatedAt"], "远端账户离线状态");
      return {
        userId: assertUuid(entry.userId, "user id"),
        pendingMutations: count(entry.pendingMutations, "待同步数量"),
        conflicts: count(entry.conflicts, "冲突数量"),
        rejected: count(entry.rejected, "只读数量"),
        updatedAt: timestamp(entry.updatedAt, "账户状态时间")
      };
    });
    if (new Set(users.map((entry) => entry.userId)).size !== users.length) {
      throw new RemoteSyncStatusStoreError("REMOTE_SYNC_STATUS_INVALID", "远端离线状态包含重复账户");
    }
    return {
      version: REMOTE_SYNC_STATUS_VERSION,
      profileId: profile.id,
      origin: profile.origin,
      users,
      updatedAt: timestamp(value.updatedAt, "状态更新时间")
    };
  }

  user(profile: RemoteWorkspaceProfile, userId: string): RemoteSyncUserStatus | null {
    const id = assertUuid(userId, "user id");
    const entry = this.read(profile)?.users.find((candidate) => candidate.userId === id);
    return entry ? structuredClone(entry) : null;
  }

  update(profile: RemoteWorkspaceProfile, userId: string, state: WorkspaceLeaveState): RemoteSyncUserStatus {
    const id = assertUuid(userId, "user id");
    const document = this.read(profile) ?? {
      version: REMOTE_SYNC_STATUS_VERSION,
      profileId: profile.id,
      origin: profile.origin,
      users: [],
      updatedAt: new Date().toISOString()
    };
    const entry: RemoteSyncUserStatus = {
      userId: id,
      pendingMutations: count(state.pendingMutations, "待同步数量"),
      conflicts: count(state.conflicts, "冲突数量"),
      rejected: count(state.rejected, "只读数量"),
      updatedAt: new Date().toISOString()
    };
    const index = document.users.findIndex((candidate) => candidate.userId === id);
    if (index < 0) document.users.push(entry);
    else document.users[index] = entry;
    document.updatedAt = entry.updatedAt;
    writeDesktopJsonAtomically(statusPath(this.directory, profile.id), document);
    return structuredClone(entry);
  }

  summary(profile: RemoteWorkspaceProfile): RemoteSyncStatusSummary {
    const document = this.read(profile);
    if (!document) return emptySummary();
    return document.users.reduce<RemoteSyncStatusSummary>((summary, entry) => ({
      pendingMutations: summary.pendingMutations + entry.pendingMutations,
      conflicts: summary.conflicts + entry.conflicts,
      rejected: summary.rejected + entry.rejected,
      userCount: summary.userCount + 1,
      updatedAt: summary.updatedAt === null || entry.updatedAt > summary.updatedAt ? entry.updatedAt : summary.updatedAt
    }), emptySummary());
  }

  clear(profile: RemoteWorkspaceProfile): void {
    writeDesktopJsonAtomically(statusPath(this.directory, profile.id), {
      version: REMOTE_SYNC_STATUS_VERSION,
      profileId: profile.id,
      origin: profile.origin,
      users: [],
      updatedAt: new Date().toISOString()
    });
  }
}
