import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { RemoteAuthUser } from "../shared/remote-auth-contract.js";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import {
  parseCancelLocalAiCompletionInput,
  parseLocalAiCompletionRequestInput,
  type LocalAiCompletionRequestInput,
  type LocalAiCompletionResult,
  type LocalAiWorkspaceCatalog
} from "../shared/local-ai-contract.js";
import {
  parseWorkspaceLeaveState,
  type WorkspaceLeaveState
} from "../shared/workspace-contract.js";

type IpcSuccess<T> = { ok: true; data: T };
type IpcFailure = { ok: false; error: { code: string; message: string } };
type IpcResult<T> = IpcSuccess<T> | IpcFailure;

const workspaceChannels = [
  "workspace:shell:get-capabilities",
  "workspace:shell:report-leave-state",
  "workspace:shell:request-switch",
  "workspace:local-ai:catalog",
  "workspace:local-ai:complete",
  "workspace:local-ai:cancel"
] as const;

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

function assertWorkspaceSender(
  event: IpcMainInvokeEvent,
  workspaceWindow: BrowserWindow,
  profile: RemoteWorkspaceProfile,
  activeProfileId: () => string | null
): void {
  let senderOrigin = "";
  try {
    senderOrigin = new URL(event.senderFrame?.url ?? "").origin;
  } catch {
    senderOrigin = "";
  }
  if (
    workspaceWindow.isDestroyed()
    || event.sender.id !== workspaceWindow.webContents.id
    || event.sender.session !== workspaceWindow.webContents.session
    || senderOrigin !== profile.origin
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
  completeLocalAi: (userId: string, input: LocalAiCompletionRequestInput) => Promise<LocalAiCompletionResult>;
  cancelLocalAi: (userId: string, requestId: string) => boolean;
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
  handle("workspace:local-ai:catalog", workspaceWindow, profile, options.activeProfileId, () => {
    return options.getLocalAiCatalog(activeUserId());
  });
  handle("workspace:local-ai:complete", workspaceWindow, profile, options.activeProfileId, (input) => {
    return options.completeLocalAi(activeUserId(), parseLocalAiCompletionRequestInput(input));
  });
  handle("workspace:local-ai:cancel", workspaceWindow, profile, options.activeProfileId, (input) => {
    return options.cancelLocalAi(activeUserId(), parseCancelLocalAiCompletionInput(input).requestId);
  });
  return () => workspaceChannels.forEach((channel) => ipcMain.removeHandler(channel));
}
