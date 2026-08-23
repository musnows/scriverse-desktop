import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  LOCAL_PROFILE_ID,
  LOCAL_PROFILE_PARTITION,
  MAX_REMOTE_PROFILES,
  PROFILE_STORE_VERSION,
  remotePartition,
  type LocalWorkspaceProfile,
  type ProfileStoreDocument,
  type RemoteCompatibility,
  type RemoteCapabilitySnapshot,
  type RemoteSyncProtocolCapability,
  type RemoteWorkspaceProfile,
  type WorkspaceProfile
} from "../shared/contracts.js";
import { normalizeProfileOrigin } from "../shared/profile-url.js";
import { writeDesktopJsonAtomically } from "../shared/storage-manifest.js";

export class ProfileStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProfileStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ProfileStoreError("PROFILE_STORE_INVALID", `${label} 包含未知字段`);
  }
}

function assertUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ProfileStoreError("PROFILE_STORE_INVALID", "profile id 无效");
  }
  return value;
}

function assertTimestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ProfileStoreError("PROFILE_STORE_INVALID", "profile 时间字段无效");
  }
  return value;
}

function assertName(value: unknown): string {
  if (typeof value !== "string") throw new ProfileStoreError("PROFILE_NAME_INVALID", "工作区名称无效");
  const name = value.trim();
  if (name.length === 0 || name.length > 80) {
    throw new ProfileStoreError("PROFILE_NAME_INVALID", "工作区名称长度必须在 1 到 80 个字符之间");
  }
  return name;
}

function parseProtocolRange(value: unknown): { min: number; max: number } | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new ProfileStoreError("PROFILE_STORE_INVALID", "协议范围无效");
  assertExactKeys(value, ["min", "max"], "协议范围");
  if (!Number.isInteger(value.min) || !Number.isInteger(value.max) || Number(value.min) < 1 || Number(value.max) < Number(value.min)) {
    throw new ProfileStoreError("PROFILE_STORE_INVALID", "协议范围无效");
  }
  return { min: Number(value.min), max: Number(value.max) };
}

function parseSyncProtocol(value: unknown): RemoteSyncProtocolCapability | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new ProfileStoreError("PROFILE_STORE_INVALID", "sync 协议能力无效");
  assertExactKeys(value, ["min", "max", "entityTypes", "maxMutationBytes"], "sync 协议能力");
  const range = parseProtocolRange({ min: value.min, max: value.max });
  if (
    !range
    || !Array.isArray(value.entityTypes)
    || value.entityTypes.length > 50
    || value.entityTypes.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{0,39}$/u.test(item))
    || new Set(value.entityTypes).size !== value.entityTypes.length
    || !Number.isInteger(value.maxMutationBytes)
    || Number(value.maxMutationBytes) < 1_024
    || Number(value.maxMutationBytes) > 16 * 1024 * 1024
  ) throw new ProfileStoreError("PROFILE_STORE_INVALID", "sync 协议能力无效");
  return {
    ...range,
    entityTypes: value.entityTypes as string[],
    maxMutationBytes: Number(value.maxMutationBytes)
  };
}

function parseCapabilities(value: unknown): RemoteCapabilitySnapshot | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new ProfileStoreError("PROFILE_STORE_INVALID", "Server 能力快照无效");
  assertExactKeys(value, ["checkedAt", "product", "serverVersion", "webAssetVersion", "shellProtocol", "syncProtocol", "minimumDesktopVersion", "compatibility"], "Server 能力快照");
  if (typeof value.product !== "string" || value.product.length > 80) {
    throw new ProfileStoreError("PROFILE_STORE_INVALID", "Server 产品标识无效");
  }
  const nullableVersion = (candidate: unknown): string | null => {
    if (candidate === null) return null;
    if (typeof candidate !== "string" || candidate.length > 80) throw new ProfileStoreError("PROFILE_STORE_INVALID", "Server 版本字段无效");
    return candidate;
  };
  const compatibilityValues: RemoteCompatibility[] = [
    "compatible",
    "online-only",
    "legacy-online-only",
    "desktop-upgrade-required",
    "shell-incompatible"
  ];
  if (!compatibilityValues.includes(value.compatibility as RemoteCompatibility)) {
    throw new ProfileStoreError("PROFILE_STORE_INVALID", "Server 兼容状态无效");
  }
  return {
    checkedAt: assertTimestamp(value.checkedAt) as string,
    product: value.product,
    serverVersion: nullableVersion(value.serverVersion),
    webAssetVersion: nullableVersion(value.webAssetVersion),
    shellProtocol: parseProtocolRange(value.shellProtocol),
    syncProtocol: parseSyncProtocol(value.syncProtocol),
    minimumDesktopVersion: nullableVersion(value.minimumDesktopVersion),
    compatibility: value.compatibility as RemoteCompatibility
  };
}

function parseProfile(value: unknown): WorkspaceProfile {
  if (!isRecord(value)) throw new ProfileStoreError("PROFILE_STORE_INVALID", "profile 格式无效");
  assertExactKeys(value, ["id", "name", "kind", "origin", "partition", "createdAt", "lastUsedAt", "capabilities"], "profile");
  const name = assertName(value.name);
  const createdAt = assertTimestamp(value.createdAt) as string;
  const lastUsedAt = assertTimestamp(value.lastUsedAt, true);
  if (value.kind === "local") {
    if (value.id !== LOCAL_PROFILE_ID || value.origin !== null || value.partition !== LOCAL_PROFILE_PARTITION || value.capabilities !== null) {
      throw new ProfileStoreError("PROFILE_STORE_INVALID", "本地工作区 profile 无效");
    }
    return {
      id: LOCAL_PROFILE_ID,
      name,
      kind: "local",
      origin: null,
      partition: LOCAL_PROFILE_PARTITION,
      createdAt,
      lastUsedAt,
      capabilities: null
    };
  }
  if (value.kind !== "remote") throw new ProfileStoreError("PROFILE_STORE_INVALID", "profile 类型无效");
  const id = assertUuid(value.id);
  if (typeof value.origin !== "string") throw new ProfileStoreError("PROFILE_STORE_INVALID", "远端工作区 origin 无效");
  const origin = normalizeProfileOrigin(value.origin);
  if (value.partition !== remotePartition(id)) throw new ProfileStoreError("PROFILE_STORE_INVALID", "远端工作区 partition 无效");
  return {
    id,
    name,
    kind: "remote",
    origin,
    partition: remotePartition(id),
    createdAt,
    lastUsedAt,
    capabilities: parseCapabilities(value.capabilities)
  };
}

function cloneProfile<T extends WorkspaceProfile>(profile: T): T {
  return structuredClone(profile);
}

function defaultLocalProfile(now = new Date().toISOString()): LocalWorkspaceProfile {
  return {
    id: LOCAL_PROFILE_ID,
    name: "本地工作区",
    kind: "local",
    origin: null,
    partition: LOCAL_PROFILE_PARTITION,
    createdAt: now,
    lastUsedAt: null,
    capabilities: null
  };
}

export class ProfileStore {
  private document: ProfileStoreDocument;

  constructor(private readonly path: string) {
    this.document = this.read();
  }

  private read(): ProfileStoreDocument {
    if (!existsSync(this.path)) {
      const document: ProfileStoreDocument = { version: PROFILE_STORE_VERSION, profiles: [defaultLocalProfile()] };
      writeDesktopJsonAtomically(this.path, document);
      return document;
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    } catch {
      throw new ProfileStoreError("PROFILE_STORE_INVALID", "profiles.json 无法读取或不是有效 JSON");
    }
    if (!isRecord(value)) throw new ProfileStoreError("PROFILE_STORE_INVALID", "profiles.json 格式无效");
    assertExactKeys(value, ["version", "profiles"], "profiles.json");
    if (value.version !== PROFILE_STORE_VERSION || !Array.isArray(value.profiles)) {
      throw new ProfileStoreError("PROFILE_STORE_VERSION_UNSUPPORTED", "profiles.json 版本不受支持");
    }
    const profiles = value.profiles.map(parseProfile);
    if (profiles.length === 0 || profiles[0]?.kind !== "local" || profiles.filter((profile) => profile.kind === "local").length !== 1) {
      throw new ProfileStoreError("PROFILE_STORE_INVALID", "profiles.json 必须包含且仅包含一个本地工作区");
    }
    if (profiles.filter((profile) => profile.kind === "remote").length > MAX_REMOTE_PROFILES) {
      throw new ProfileStoreError("PROFILE_LIMIT_REACHED", "远端 Server 数量超过上限");
    }
    const ids = profiles.map((profile) => profile.id);
    const origins = profiles.filter((profile): profile is RemoteWorkspaceProfile => profile.kind === "remote").map((profile) => profile.origin);
    if (new Set(ids).size !== ids.length || new Set(origins).size !== origins.length) {
      throw new ProfileStoreError("PROFILE_STORE_INVALID", "profiles.json 存在重复 profile");
    }
    return { version: PROFILE_STORE_VERSION, profiles };
  }

  private persist(): void {
    writeDesktopJsonAtomically(this.path, this.document);
  }

  list(): WorkspaceProfile[] {
    return this.document.profiles.map(cloneProfile);
  }

  get(id: string): WorkspaceProfile {
    const profile = this.document.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ProfileStoreError("PROFILE_NOT_FOUND", "工作区 profile 不存在");
    return cloneProfile(profile);
  }

  createRemote(input: { name: string; origin: string }): RemoteWorkspaceProfile {
    if (this.document.profiles.filter((profile) => profile.kind === "remote").length >= MAX_REMOTE_PROFILES) {
      throw new ProfileStoreError("PROFILE_LIMIT_REACHED", "远端 Server 数量已达到上限");
    }
    const origin = normalizeProfileOrigin(input.origin);
    if (this.document.profiles.some((profile) => profile.kind === "remote" && profile.origin === origin)) {
      throw new ProfileStoreError("PROFILE_ORIGIN_DUPLICATE", "该 Server 已经存在");
    }
    const id = randomUUID();
    const profile: RemoteWorkspaceProfile = {
      id,
      name: assertName(input.name),
      kind: "remote",
      origin,
      partition: remotePartition(id),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      capabilities: null
    };
    this.document.profiles.push(profile);
    this.persist();
    return cloneProfile(profile);
  }

  updateRemote(id: string, input: { name: string; origin: string }): RemoteWorkspaceProfile {
    const index = this.document.profiles.findIndex((profile) => profile.id === id && profile.kind === "remote");
    const existing = this.document.profiles[index];
    if (index < 0 || !existing || existing.kind !== "remote") throw new ProfileStoreError("PROFILE_NOT_FOUND", "远端工作区 profile 不存在");
    const origin = normalizeProfileOrigin(input.origin);
    if (this.document.profiles.some((profile) => profile.kind === "remote" && profile.id !== id && profile.origin === origin)) {
      throw new ProfileStoreError("PROFILE_ORIGIN_DUPLICATE", "该 Server 已经存在");
    }
    const nextId = origin === existing.origin ? existing.id : randomUUID();
    const updated: RemoteWorkspaceProfile = {
      ...existing,
      id: nextId,
      name: assertName(input.name),
      origin,
      partition: remotePartition(nextId),
      capabilities: origin === existing.origin ? existing.capabilities : null,
      lastUsedAt: origin === existing.origin ? existing.lastUsedAt : null
    };
    this.document.profiles[index] = updated;
    this.persist();
    return cloneProfile(updated);
  }

  updateCapabilities(id: string, capabilities: RemoteCapabilitySnapshot | null): RemoteWorkspaceProfile {
    const index = this.document.profiles.findIndex((profile) => profile.id === id && profile.kind === "remote");
    const existing = this.document.profiles[index];
    if (index < 0 || !existing || existing.kind !== "remote") throw new ProfileStoreError("PROFILE_NOT_FOUND", "远端工作区 profile 不存在");
    const updated: RemoteWorkspaceProfile = { ...existing, capabilities: parseCapabilities(capabilities) };
    this.document.profiles[index] = updated;
    this.persist();
    return cloneProfile(updated);
  }

  markUsed(id: string, usedAt = new Date().toISOString()): WorkspaceProfile {
    const index = this.document.profiles.findIndex((profile) => profile.id === id);
    const existing = this.document.profiles[index];
    if (index < 0 || !existing) throw new ProfileStoreError("PROFILE_NOT_FOUND", "工作区 profile 不存在");
    const updated = { ...existing, lastUsedAt: assertTimestamp(usedAt) as string } as WorkspaceProfile;
    this.document.profiles[index] = updated;
    this.persist();
    return cloneProfile(updated);
  }

  removeRemote(id: string): RemoteWorkspaceProfile {
    const index = this.document.profiles.findIndex((profile) => profile.id === id && profile.kind === "remote");
    const existing = this.document.profiles[index];
    if (index < 0 || !existing || existing.kind !== "remote") throw new ProfileStoreError("PROFILE_NOT_FOUND", "远端工作区 profile 不存在");
    this.document.profiles.splice(index, 1);
    this.persist();
    return cloneProfile(existing);
  }
}
