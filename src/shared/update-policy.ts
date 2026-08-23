import type { WorkspaceLeaveState } from "./workspace-contract.js";

const UPDATE_SERVICE_ROOT = "https://update.electronjs.org/musnows/Scriverse";

export function desktopUpdateFeedUrl(platform: NodeJS.Platform, version: string): string | null {
  if (platform !== "darwin" && platform !== "win32") return null;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Desktop update version is invalid");
  return `${UPDATE_SERVICE_ROOT}/${platform}/v${version}`;
}

export function updateInstallDetail(state: WorkspaceLeaveState): string {
  const details = [
    state.dirty ? "页面仍有未保存内容" : null,
    state.activeAiRequests > 0 ? `${state.activeAiRequests} 个 AI 请求仍在进行` : null,
    state.pendingMutations > 0 ? `${state.pendingMutations} 项离线变更已安全写入待上传队列` : null,
    state.conflicts > 0 ? `${state.conflicts} 项同步冲突已保留` : null,
    state.rejected > 0 ? `${state.rejected} 项被 Server 拒绝的本机修改已保留` : null
  ].filter(Boolean);
  if (details.length === 0) return "重新启动会关闭当前工作区并安装新版本。";
  return `${details.join("；")}。重新启动前请确认未保存内容可以放弃；已持久化的待上传和冲突会在升级后保留。`;
}
