import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { ProfileStore } from "./profile-store.js";
import {
  LOCAL_AI_CONFIG_ENTRY_URL,
  SELECTOR_ENTRY_URL,
  assertRemoteProfileDataDisposition,
  parseCreateRemoteProfileInput,
  parseProfileId,
  parseRemoveRemoteProfileInput,
  parseUpdateRemoteProfileInput,
  sortProfilesForSelector
} from "../shared/selector-contract.js";
import {
  parseCreateLocalAiModelInput,
  parseCreateLocalAiProviderInput,
  parseLocalAiSystemPromptInput,
  parseRemoveLocalAiModelInput,
  parseRemoveLocalAiProviderInput,
  parseUpdateLocalAiModelInput,
  parseUpdateLocalAiProviderInput,
  type LocalAiConfigurationSummary,
  type LocalAiModelInput,
  type LocalAiModelUpdateInput,
  type LocalAiProviderInput,
  type LocalAiProviderSummary,
  type LocalAiProviderUpdateInput
} from "../shared/local-ai-contract.js";
import type { LocalServerPublicStatus } from "../shared/local-server-contract.js";
import { parseLocalLoginInput, parseLocalSetupInput } from "../shared/local-server-contract.js";
import {
  parseRemoteLoginInput,
  type RemoteAuthUser,
  type RemoteLoginChallenge,
  type RemoteLoginInput,
  type RemoteProfileOpenResult
} from "../shared/remote-auth-contract.js";
import type { RemoteCapabilitySnapshot, RemoteWorkspaceProfile } from "../shared/contracts.js";
import { normalizeProfileOrigin } from "../shared/profile-url.js";
import type { RemoteSyncStatusSummary } from "./remote-sync-status-store.js";
import type { DesktopSettingsSummary } from "../shared/desktop-settings-contract.js";

type IpcSuccess<T> = { ok: true; data: T };
type IpcFailure = { ok: false; error: { code: string; message: string } };
type IpcResult<T> = IpcSuccess<T> | IpcFailure;

const channels = [
  "selector:profiles:list",
  "selector:profiles:status",
  "selector:profiles:create",
  "selector:profiles:update",
  "selector:profiles:remove",
  "selector:profiles:open",
  "selector:profiles:probe",
  "selector:local:get-status",
  "selector:local:setup",
  "selector:local:login",
  "selector:settings:get",
  "selector:settings:update",
  "selector:settings:open-logs",
  "selector:remote:refresh-captcha",
  "selector:remote:login",
  "selector:local-ai:configuration",
  "selector:local-ai:update-system-prompt",
  "selector:local-ai:create-provider",
  "selector:local-ai:update-provider",
  "selector:local-ai:remove-provider",
  "selector:local-ai:create-model",
  "selector:local-ai:update-model",
  "selector:local-ai:remove-model",
  "selector:local-ai:test-provider",
  "selector:local-ai:test-model",
  "selector:app:get-version",
  "selector:app:get-platform",
  "selector:app:request-quit",
  "selector:app:confirm-quit",
  "selector:shell:open-external-url"
] as const;

function errorResult(error: unknown): IpcFailure {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "DESKTOP_INTERNAL_ERROR";
    return {
      ok: false,
      error: {
        code,
        message: code === "DESKTOP_INTERNAL_ERROR" ? "Desktop 操作失败，请重试" : error.message
      }
    };
  }
  return { ok: false, error: { code: "DESKTOP_INTERNAL_ERROR", message: "Desktop 操作失败，请重试" } };
}

function ok<T>(data: T): IpcSuccess<T> {
  return { ok: true, data };
}

function assertSelectorSender(event: IpcMainInvokeEvent, selectorWindow: BrowserWindow, expectedUrl: string | readonly string[]): void {
  const expectedUrls = typeof expectedUrl === "string" ? [expectedUrl] : expectedUrl;
  if (
    selectorWindow.isDestroyed()
    || event.sender.id !== selectorWindow.webContents.id
    || !expectedUrls.includes(event.senderFrame?.url ?? "")
  ) {
    const error = new Error("已拒绝非 Selector 页面调用 Desktop 能力") as Error & { code: string };
    error.code = "SELECTOR_SENDER_FORBIDDEN";
    throw error;
  }
}

function assertRemoteCanOpen(capabilities: RemoteCapabilitySnapshot): void {
  if (capabilities.compatibility === "compatible" || capabilities.compatibility === "online-only") return;
  const error = new Error(
    capabilities.compatibility === "legacy-online-only"
      ? "该 Server 版本过旧，请升级后再使用 Desktop"
      : capabilities.compatibility === "desktop-upgrade-required"
        ? `当前 Desktop 版本过低，Server 要求至少 ${capabilities.minimumDesktopVersion ?? "更高版本"}`
        : "该 Server 版本与当前 Desktop 不兼容"
  ) as Error & { code: string };
  error.code = capabilities.compatibility === "legacy-online-only"
    ? "REMOTE_SERVER_DESKTOP_AUTH_REQUIRED"
    : capabilities.compatibility === "desktop-upgrade-required"
      ? "REMOTE_DESKTOP_UPGRADE_REQUIRED"
      : "REMOTE_SHELL_PROTOCOL_INCOMPATIBLE";
  throw error;
}

function isRemoteConnectivityError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "REMOTE_PROBE_NETWORK_ERROR" || error.code === "REMOTE_PROBE_TIMEOUT");
}

function handle<T>(
  channel: typeof channels[number],
  selectorWindow: BrowserWindow,
  operation: (event: IpcMainInvokeEvent, input: unknown) => T | Promise<T>,
  expectedUrl: string | readonly string[] = SELECTOR_ENTRY_URL
): void {
  ipcMain.handle(channel, async (event, input: unknown): Promise<IpcResult<T>> => {
    try {
      assertSelectorSender(event, selectorWindow, expectedUrl);
      return ok(await operation(event, input));
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function registerSelectorIpc(selectorWindow: BrowserWindow, profileStore: ProfileStore, options: {
  desktopVersion: string;
  getLocalStatus: () => LocalServerPublicStatus;
  getDesktopSettings: () => DesktopSettingsSummary;
  updateDesktopSettings: (input: unknown) => DesktopSettingsSummary | Promise<DesktopSettingsSummary>;
  openLogs: () => boolean | Promise<boolean>;
  openLocal: () => Promise<{ status: "opened" | "setup-required" | "login-required"; mode?: "online" }>;
  setupLocal: (input: { username: string; password: string }) => Promise<unknown>;
  loginLocal: (input: { username: string; password: string }) => Promise<unknown>;
  openRemote: (profile: RemoteWorkspaceProfile) => Promise<RemoteProfileOpenResult>;
  refreshRemoteChallenge: (profile: RemoteWorkspaceProfile) => Promise<RemoteLoginChallenge>;
  loginRemote: (profile: RemoteWorkspaceProfile, input: RemoteLoginInput) => Promise<RemoteAuthUser>;
  forgetRemote: (profile: RemoteWorkspaceProfile) => Promise<void>;
  getRemoteSyncStatus: (profile: RemoteWorkspaceProfile) => RemoteSyncStatusSummary;
  probeRemote: (origin: string) => Promise<RemoteCapabilitySnapshot>;
  getLocalAiConfiguration: () => LocalAiConfigurationSummary;
  updateLocalAiSystemPrompt: (input: { systemPrompt: string }) => string;
  createLocalAiProvider: (input: LocalAiProviderInput) => LocalAiProviderSummary;
  updateLocalAiProvider: (input: LocalAiProviderUpdateInput) => LocalAiProviderSummary;
  removeLocalAiProvider: (providerId: string) => string;
  createLocalAiModel: (input: LocalAiModelInput) => unknown;
  updateLocalAiModel: (input: LocalAiModelUpdateInput) => unknown;
  removeLocalAiModel: (modelId: string) => string;
  testLocalAiProvider: (providerId: string) => Promise<unknown>;
  testLocalAiModel: (modelId: string) => Promise<unknown>;
  requestQuit: () => void;
  confirmQuit: () => void;
  openExternalUrl: (input: unknown) => Promise<null>;
}): () => void {
  handle("selector:profiles:list", selectorWindow, () => sortProfilesForSelector(profileStore.list()));
  handle("selector:profiles:status", selectorWindow, (_event, input) => {
    const profile = profileStore.get(parseProfileId(input));
    if (profile.kind !== "remote") throw new Error("远端工作区 profile 不存在");
    return options.getRemoteSyncStatus(profile);
  });
  handle("selector:profiles:create", selectorWindow, async (_event, input) => {
    const parsed = parseCreateRemoteProfileInput(input);
    const capabilities = await options.probeRemote(parsed.origin);
    const created = profileStore.createRemote(parsed);
    return profileStore.updateCapabilities(created.id, capabilities);
  });
  handle("selector:profiles:update", selectorWindow, async (_event, input) => {
    const parsed = parseUpdateRemoteProfileInput(input);
    const existing = profileStore.get(parsed.id);
    if (existing.kind !== "remote") throw new Error("远端工作区 profile 不存在");
    const nextOrigin = normalizeProfileOrigin(parsed.origin);
    if (nextOrigin !== existing.origin) {
      assertRemoteProfileDataDisposition(options.getRemoteSyncStatus(existing), parsed.discardUnsynced);
    }
    const capabilities = nextOrigin === existing.origin ? existing.capabilities : await options.probeRemote(nextOrigin);
    if (nextOrigin !== existing.origin) await options.forgetRemote(existing);
    const updated = profileStore.updateRemote(parsed.id, { name: parsed.name, origin: parsed.origin });
    if (updated.id === existing.id) return updated;
    const withCapabilities = profileStore.updateCapabilities(updated.id, capabilities);
    return withCapabilities;
  });
  handle("selector:profiles:remove", selectorWindow, async (_event, input) => {
    const parsed = parseRemoveRemoteProfileInput(input);
    const profile = profileStore.get(parsed.id);
    if (profile.kind !== "remote") throw new Error("远端工作区 profile 不存在");
    assertRemoteProfileDataDisposition(options.getRemoteSyncStatus(profile), parsed.discardUnsynced);
    await options.forgetRemote(profile);
    return profileStore.removeRemote(profile.id);
  });
  handle("selector:profiles:open", selectorWindow, async (_event, input) => {
    const id = parseProfileId(input);
    const profile = profileStore.get(id);
    if (profile.kind === "local") {
      const result = await options.openLocal();
      return { ...result, profile: result.status === "opened" ? profileStore.markUsed(id) : profile };
    }
    let checkedProfile = profile;
    try {
      const capabilities = await options.probeRemote(profile.origin);
      checkedProfile = profileStore.updateCapabilities(profile.id, capabilities);
      assertRemoteCanOpen(capabilities);
    } catch (error) {
      if (!isRemoteConnectivityError(error) || !profile.capabilities) throw error;
      assertRemoteCanOpen(profile.capabilities);
    }
    const result = await options.openRemote(checkedProfile);
    return { ...result, profile: result.status === "opened" ? profileStore.markUsed(id) : checkedProfile };
  });
  handle("selector:profiles:probe", selectorWindow, async (_event, input) => {
    const profile = profileStore.get(parseProfileId(input));
    if (profile.kind !== "remote") throw new Error("远端工作区 profile 不存在");
    return profileStore.updateCapabilities(profile.id, await options.probeRemote(profile.origin));
  });
  handle("selector:local:get-status", selectorWindow, () => options.getLocalStatus());
  handle("selector:local:setup", selectorWindow, (_event, input) => options.setupLocal(parseLocalSetupInput(input)));
  handle("selector:local:login", selectorWindow, (_event, input) => options.loginLocal(parseLocalLoginInput(input)));
  handle("selector:settings:get", selectorWindow, () => options.getDesktopSettings());
  handle("selector:settings:update", selectorWindow, (_event, input) => options.updateDesktopSettings(input));
  handle("selector:settings:open-logs", selectorWindow, () => options.openLogs());
  handle("selector:remote:refresh-captcha", selectorWindow, (_event, input) => {
    const profile = profileStore.get(parseProfileId(input));
    if (profile.kind !== "remote") throw new Error("远端工作区 profile 不存在");
    return options.refreshRemoteChallenge(profile);
  });
  handle("selector:remote:login", selectorWindow, async (_event, input) => {
    const parsed = parseRemoteLoginInput(input);
    const profile = profileStore.get(parsed.profileId);
    if (profile.kind !== "remote") throw new Error("远端工作区 profile 不存在");
    const user = await options.loginRemote(profile, parsed);
    profileStore.markUsed(profile.id);
    return user;
  });
  handle("selector:local-ai:configuration", selectorWindow, () => options.getLocalAiConfiguration(), LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:update-system-prompt", selectorWindow, (_event, input) => {
    return options.updateLocalAiSystemPrompt(parseLocalAiSystemPromptInput(input));
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:create-provider", selectorWindow, (_event, input) => {
    return options.createLocalAiProvider(parseCreateLocalAiProviderInput(input));
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:update-provider", selectorWindow, (_event, input) => {
    return options.updateLocalAiProvider(parseUpdateLocalAiProviderInput(input));
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:remove-provider", selectorWindow, (_event, input) => {
    return options.removeLocalAiProvider(parseRemoveLocalAiProviderInput(input).providerId);
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:create-model", selectorWindow, (_event, input) => {
    return options.createLocalAiModel(parseCreateLocalAiModelInput(input));
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:update-model", selectorWindow, (_event, input) => {
    return options.updateLocalAiModel(parseUpdateLocalAiModelInput(input));
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:remove-model", selectorWindow, (_event, input) => {
    return options.removeLocalAiModel(parseRemoveLocalAiModelInput(input).modelId);
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:test-provider", selectorWindow, (_event, input) => {
    return options.testLocalAiProvider(parseRemoveLocalAiProviderInput(input).providerId);
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:local-ai:test-model", selectorWindow, (_event, input) => {
    return options.testLocalAiModel(parseRemoveLocalAiModelInput(input).modelId);
  }, LOCAL_AI_CONFIG_ENTRY_URL);
  handle("selector:app:get-version", selectorWindow, () => options.desktopVersion);
  handle("selector:app:get-platform", selectorWindow, () => process.platform);
  handle("selector:app:request-quit", selectorWindow, () => {
    options.requestQuit();
    return null;
  });
  handle("selector:app:confirm-quit", selectorWindow, () => {
    options.confirmQuit();
    return null;
  });
  handle("selector:shell:open-external-url", selectorWindow, (_event, input) => options.openExternalUrl(input), [SELECTOR_ENTRY_URL, LOCAL_AI_CONFIG_ENTRY_URL]);
  return () => {
    channels.forEach((channel) => ipcMain.removeHandler(channel));
  };
}
