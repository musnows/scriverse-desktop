import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { RemoteAuthUser } from "../shared/remote-auth-contract.js";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import {
  parseCancelLocalAiAgentRoundInput,
  parseCancelLocalAiCompletionInput,
  parseLocalAiAgentRoundInput,
  parseLocalAiCompletionRequestInput,
  type LocalAiAgentRoundInput,
  type LocalAiAgentRoundResult,
  type LocalAiCompletionRequestInput,
  type LocalAiCompletionResult,
  type LocalAiStreamEvent,
  type LocalAiWorkspaceCatalog
} from "../shared/local-ai-contract.js";
import {
  parseWorkspaceLeaveState,
  type WorkspaceLeaveState
} from "../shared/workspace-contract.js";
import { isRemoteWorkspaceShellUrl } from "./workspace-shell-protocol.js";

type IpcSuccess<T> = { ok: true; data: T };
type IpcFailure = { ok: false; error: { code: string; message: string } };
type IpcResult<T> = IpcSuccess<T> | IpcFailure;

const workspaceChannels = [
  "workspace:shell:get-capabilities",
  "workspace:shell:report-leave-state",
  "workspace:shell:request-switch",
  "workspace:shell:cache-work-cover",
  "workspace:shell:cache-work-images",
  "workspace:local-ai:catalog",
  "workspace:local-ai:complete",
  "workspace:local-ai:cancel",
  "workspace:local-ai:agent-round",
  "workspace:local-ai:agent-round-cancel"
] as const;
const aiStreamEventChannel = "workspace:local-ai:stream-event";

function ok<T>(data: T): IpcSuccess<T> {
  return { ok: true, data };
}

function errorResult(error: unknown): IpcFailure {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "DESKTOP_INTERNAL_ERROR";
    return {
      ok: false,
      error: {
        code,
        message: code === "DESKTOP_INTERNAL_ERROR" ? "Desktop 工作区操作失败" : error.message
      }
    };
  }
  return { ok: false, error: { code: "DESKTOP_INTERNAL_ERROR", message: "Desktop 工作区操作失败" } };
}

function parseWorkMediaInput(input: unknown): string {
  const candidate = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  if (
    !candidate
    || Object.keys(candidate).length !== 1
    || typeof candidate.workId !== "string"
    || !/^[A-Za-z0-9_-]{1,300}$/u.test(candidate.workId)
  ) {
    const error = new Error("作品图片缓存请求无效") as Error & { code: string };
    error.code = "WORK_MEDIA_INPUT_INVALID";
    throw error;
  }
  return candidate.workId;
}

function assertWorkspaceSender(
  event: IpcMainInvokeEvent,
  workspaceWindow: BrowserWindow,
  profile: RemoteWorkspaceProfile,
  activeProfileId: () => string | null
): void {
  if (
    workspaceWindow.isDestroyed()
    || event.sender.id !== workspaceWindow.webContents.id
    || event.sender.session !== workspaceWindow.webContents.session
    || !isRemoteWorkspaceShellUrl(event.senderFrame?.url ?? "", profile.id)
    || activeProfileId() !== profile.id
  ) {
    const error = new Error("已拒绝非当前远端工作区调用 Desktop 能力") as Error & { code: string };
    error.code = "WORKSPACE_SENDER_FORBIDDEN";
    throw error;
  }
}

function handle<T>(
  channel: typeof workspaceChannels[number],
  workspaceWindow: BrowserWindow,
  profile: RemoteWorkspaceProfile,
  activeProfileId: () => string | null,
  operation: (input: unknown) => T | Promise<T>
): void {
  ipcMain.handle(channel, async (event, input: unknown): Promise<IpcResult<T>> => {
    try {
      assertWorkspaceSender(event, workspaceWindow, profile, activeProfileId);
      return ok(await operation(input));
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function registerWorkspaceIpc(workspaceWindow: BrowserWindow, profile: RemoteWorkspaceProfile, options: {
  activeProfileId: () => string | null;
  getCachedUser: () => RemoteAuthUser | null;
  getConnectionMode: () => "online" | "offline" | null;
  getLocalAiCatalog: (userId: string) => LocalAiWorkspaceCatalog;
  completeLocalAi: (userId: string, input: LocalAiCompletionRequestInput, onEvent: (event: LocalAiStreamEvent) => void) => Promise<LocalAiCompletionResult>;
  cancelLocalAi: (userId: string, requestId: string) => boolean;
  completeLocalAiAgentRound: (userId: string, input: LocalAiAgentRoundInput, onEvent: (event: LocalAiStreamEvent) => void) => Promise<LocalAiAgentRoundResult>;
  cancelLocalAiAgentRound: (userId: string, requestId: string) => boolean;
  cacheWorkCover: (userId: string, workId: string) => Promise<boolean>;
  cacheWorkImages: (userId: string, workId: string) => Promise<unknown>;
  reportLeaveState: (state: WorkspaceLeaveState) => void;
  requestSwitch: () => Promise<void> | void;
}): () => void {
  const activeUserId = (): string => {
    const user = options.getCachedUser();
    if (!user?.userId) {
      const error = new Error("当前 Desktop 登录不可用于本地 AI") as Error & { code: string };
      error.code = "REMOTE_LOGIN_REQUIRED";
      throw error;
    }
    return user.userId;
  };
  handle("workspace:shell:get-capabilities", workspaceWindow, profile, options.activeProfileId, () => ({
    profileId: profile.id,
    profileName: profile.name,
    profileKind: "remote" as const,
    origin: profile.origin,
    capabilities: profile.capabilities,
    user: options.getCachedUser(),
    connectionMode: options.getConnectionMode()
  }));
  handle("workspace:shell:report-leave-state", workspaceWindow, profile, options.activeProfileId, (input) => {
    const state = parseWorkspaceLeaveState(input);
    options.reportLeaveState(state);
    return null;
  });
  handle("workspace:shell:request-switch", workspaceWindow, profile, options.activeProfileId, () => options.requestSwitch());
  handle("workspace:shell:cache-work-cover", workspaceWindow, profile, options.activeProfileId, (input) => (
    options.cacheWorkCover(activeUserId(), parseWorkMediaInput(input))
  ));
  handle("workspace:shell:cache-work-images", workspaceWindow, profile, options.activeProfileId, (input) => (
    options.cacheWorkImages(activeUserId(), parseWorkMediaInput(input))
  ));
  handle("workspace:local-ai:catalog", workspaceWindow, profile, options.activeProfileId, () => {
    return options.getLocalAiCatalog(activeUserId());
  });
  handle("workspace:local-ai:complete", workspaceWindow, profile, options.activeProfileId, (input) => {
    const parsed = parseLocalAiCompletionRequestInput(input);
    return options.completeLocalAi(activeUserId(), parsed, (event) => {
      if (!workspaceWindow.isDestroyed()) workspaceWindow.webContents.send(aiStreamEventChannel, { requestId: parsed.requestId, event });
    });
  });
  handle("workspace:local-ai:cancel", workspaceWindow, profile, options.activeProfileId, (input) => {
    return options.cancelLocalAi(activeUserId(), parseCancelLocalAiCompletionInput(input).requestId);
  });
  handle("workspace:local-ai:agent-round", workspaceWindow, profile, options.activeProfileId, (input) => {
    const parsed = parseLocalAiAgentRoundInput(input);
    return options.completeLocalAiAgentRound(activeUserId(), parsed, (event) => {
      if (!workspaceWindow.isDestroyed()) workspaceWindow.webContents.send(aiStreamEventChannel, { requestId: parsed.requestId, event });
    });
  });
  handle("workspace:local-ai:agent-round-cancel", workspaceWindow, profile, options.activeProfileId, (input) => {
    return options.cancelLocalAiAgentRound(activeUserId(), parseCancelLocalAiAgentRoundInput(input).requestId);
  });
  return () => workspaceChannels.forEach((channel) => ipcMain.removeHandler(channel));
}
