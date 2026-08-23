import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  parseCancelLocalAiCompletionInput,
  parseLocalAiCompletionRequestInput,
  type LocalAiCompletionRequestInput,
  type LocalAiCompletionResult,
  type LocalAiWorkspaceCatalog
} from "../shared/local-ai-contract.js";

type IpcSuccess<T> = { ok: true; data: T };
type IpcFailure = { ok: false; error: { code: string; message: string } };
type IpcResult<T> = IpcSuccess<T> | IpcFailure;

const localWorkspaceChannels = [
  "local-workspace:shell:get-capabilities",
  "local-workspace:shell:request-switch",
  "local-workspace:shell:logout",
  "local-workspace:local-ai:catalog",
  "local-workspace:local-ai:complete",
  "local-workspace:local-ai:cancel"
] as const;

function errorResult(error: unknown): IpcFailure {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "DESKTOP_INTERNAL_ERROR";
    return {
      ok: false,
      error: {
        code,
        message: code === "DESKTOP_INTERNAL_ERROR" ? "Desktop 本地 AI 操作失败" : error.message
      }
    };
  }
  return { ok: false, error: { code: "DESKTOP_INTERNAL_ERROR", message: "Desktop 本地 AI 操作失败" } };
}

function assertLocalWorkspaceSender(
  event: IpcMainInvokeEvent,
  workspaceWindow: BrowserWindow,
  origin: string,
  isActive: () => boolean
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
    || senderOrigin !== origin
    || !isActive()
  ) {
    const error = new Error("已拒绝非当前本地工作区调用 Desktop 本地 AI") as Error & { code: string };
    error.code = "LOCAL_WORKSPACE_SENDER_FORBIDDEN";
    throw error;
  }
}

function handle<T>(
  channel: typeof localWorkspaceChannels[number],
  workspaceWindow: BrowserWindow,
  origin: string,
  isActive: () => boolean,
  operation: (input: unknown) => T | Promise<T>
): void {
  ipcMain.handle(channel, async (event, input: unknown): Promise<IpcResult<T>> => {
    try {
      assertLocalWorkspaceSender(event, workspaceWindow, origin, isActive);
      return { ok: true, data: await operation(input) };
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function registerLocalWorkspaceIpc(workspaceWindow: BrowserWindow, origin: string, options: {
  isActive: () => boolean;
  getWorkspaceIdentity: () => { profileId: string; profileName: string; profileKind: "local" };
  requestSwitch: () => Promise<void> | void;
  logout: () => Promise<void> | void;
  getLocalAiCatalog: () => LocalAiWorkspaceCatalog;
  completeLocalAi: (input: LocalAiCompletionRequestInput) => Promise<LocalAiCompletionResult>;
  cancelLocalAi: (requestId: string) => boolean;
}): () => void {
  handle("local-workspace:shell:get-capabilities", workspaceWindow, origin, options.isActive, () => options.getWorkspaceIdentity());
  handle("local-workspace:shell:request-switch", workspaceWindow, origin, options.isActive, () => options.requestSwitch());
  handle("local-workspace:shell:logout", workspaceWindow, origin, options.isActive, () => options.logout());
  handle("local-workspace:local-ai:catalog", workspaceWindow, origin, options.isActive, () => options.getLocalAiCatalog());
  handle("local-workspace:local-ai:complete", workspaceWindow, origin, options.isActive, (input) => {
    return options.completeLocalAi(parseLocalAiCompletionRequestInput(input));
  });
  handle("local-workspace:local-ai:cancel", workspaceWindow, origin, options.isActive, (input) => {
    return options.cancelLocalAi(parseCancelLocalAiCompletionInput(input).requestId);
  });
  return () => localWorkspaceChannels.forEach((channel) => ipcMain.removeHandler(channel));
}
