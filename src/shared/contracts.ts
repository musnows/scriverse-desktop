export const PROFILE_STORE_VERSION = 1;
export const MAX_REMOTE_PROFILES = 100;
export const LOCAL_PROFILE_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_PROFILE_PARTITION = "persist:scriverse-local";

export type ProtocolRange = {
  min: number;
  max: number;
};

export type RemoteSyncProtocolCapability = ProtocolRange & {
  entityTypes: string[];
  maxMutationBytes: number;
};

export type RemoteCompatibility =
  | "compatible"
  | "online-only"
  | "legacy-online-only"
  | "desktop-upgrade-required"
  | "shell-incompatible";

export type RemoteCapabilitySnapshot = {
  checkedAt: string;
  product: string;
  serverVersion: string | null;
  webAssetVersion: string | null;
  shellProtocol: ProtocolRange | null;
  syncProtocol: RemoteSyncProtocolCapability | null;
  minimumDesktopVersion: string | null;
  compatibility: RemoteCompatibility;
};

export type LocalWorkspaceProfile = {
  id: typeof LOCAL_PROFILE_ID;
  name: string;
  kind: "local";
  origin: null;
  partition: typeof LOCAL_PROFILE_PARTITION;
  createdAt: string;
  lastUsedAt: string | null;
  capabilities: null;
};

export type RemoteWorkspaceProfile = {
  id: string;
  name: string;
  kind: "remote";
  origin: string;
  partition: string;
  createdAt: string;
  lastUsedAt: string | null;
  capabilities: RemoteCapabilitySnapshot | null;
};

export type WorkspaceProfile = LocalWorkspaceProfile | RemoteWorkspaceProfile;

export type ProfileStoreDocument = {
  version: typeof PROFILE_STORE_VERSION;
  profiles: WorkspaceProfile[];
};

export function remotePartition(profileId: string): string {
  return `persist:scriverse-remote-${profileId}`;
}
