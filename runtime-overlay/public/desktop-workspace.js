import { createDesktopSyncClient } from "./desktop-sync-client.js?v=20260823-desktop-sync-client-v7";
import { DESKTOP_BULK_DOWNLOAD_CONCURRENCY, createDesktopBulkDownloadRateLimiter } from "./desktop-request-rate-limiter.js?v=20260823-desktop-bulk-download-v1";
import { mergeEntitySnapshots } from "./three-way-merge.js?v=20260823-desktop-conflict-merge-v1";

function unwrapBridge(result) {
  if (result?.ok === true) return result.data;
  const error = new Error(result?.error?.message ?? "操作失败，请重试");
  error.code = result?.error?.code ?? "DESKTOP_BRIDGE_FAILED";
  throw error;
}

function element(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "尚未同步";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function workStatusLabel(work, summary) {
  if (summary.conflicts > 0) return `${summary.conflicts} 项冲突`;
  if (summary.rejected > 0 || work.status === "read-only") return "只读，等待处理";
  if (summary.pending + summary.syncing > 0) return `${summary.pending + summary.syncing} 项待同步`;
  if (work.status === "syncing") return "正在同步";
  if (work.status === "offline") return "离线可用";
  if (work.status === "error") return "同步异常";
  return "已同步";
}

function rescueFileName(work) {
  const title = String(work?.title ?? "scriverse-work")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80) || "scriverse-work";
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${title}-desktop-rescue-${timestamp}.json`;
}

function downloadRescueBundle(bundle) {
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = rescueFileName(bundle.work);
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

function externalUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "外部网站";
  }
}

export function installDesktopExternalUrlPrompt({ bridge = null, confirm = null, notify = () => undefined } = {}) {
  if (
    !bridge
    || typeof bridge.onExternalUrlRequest !== "function"
    || typeof bridge.openExternalUrl !== "function"
    || typeof confirm !== "function"
  ) return () => undefined;
  const unsubscribe = bridge.onExternalUrlRequest((request) => {
    if (!request || typeof request.requestId !== "string" || typeof request.url !== "string") return;
    void (async () => {
      const confirmed = await confirm(`即将打开外部网站：\n${externalUrlOrigin(request.url)}`, {
        title: "打开外部网站？",
        confirmLabel: "继续访问",
        cancelLabel: "取消"
      });
      const result = await bridge.openExternalUrl({ requestId: request.requestId, confirmed });
      if (result?.ok !== true) notify(result?.error?.message ?? "外部网站跳转失败", "error");
    })().catch((error) => notify(error?.message ?? "外部网站跳转失败", "error"));
  });
  return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
}

export class DesktopWorkspaceController {
  constructor({ bridge, profile, user, client }) {
    this.bridge = bridge;
    this.profile = profile;
    this.user = user;
    this.client = client;
    this.store = client.store;
    this.serverWorks = [];
  }

  async aggregateStatus() {
    const works = await this.store.listWorks();
    const summaries = await Promise.all(works.map(async (work) => ({
      work,
      summary: await this.store.statusSummary(work.workId)
    })));
    return summaries.reduce((total, item) => ({
      works: total.works + 1,
      pendingMutations: total.pendingMutations + item.summary.pending + item.summary.syncing,
      conflicts: total.conflicts + item.summary.conflicts,
      rejected: total.rejected + item.summary.rejected
    }), { works: 0, pendingMutations: 0, conflicts: 0, rejected: 0 });
  }

  async downloadWork(work, { scheduleRequest = null, confirmImages = true } = {}) {
    const stored = await this.client.downloadWork(work, { scheduleRequest });
    const workId = String(work?.id ?? "");
    if (!workId) return stored;
    await unwrapBridge(await this.bridge.shell.cacheWorkCover({ workId }));
    if (confirmImages) await unwrapBridge(await this.bridge.shell.cacheWorkImages({ workId }));
    return stored;
  }

  async setOfflineAccess(work, enabled, { scheduleRequest = null } = {}) {
    const operation = () => this.client.request(`/api/works/${encodeURIComponent(work.id)}/offline-access`, {
      method: "PATCH",
      body: { enabled: enabled === true }
    });
    const updated = typeof scheduleRequest === "function" ? await scheduleRequest(operation) : await operation();
    Object.assign(work, updated);
    return updated;
  }

  async downloadAllWorks(works, {
    onProgress = () => undefined,
    rateLimiterFactory = () => createDesktopBulkDownloadRateLimiter()
  } = {}) {
    const candidates = Array.isArray(works) ? works.filter((work) => typeof work?.id === "string" && work.id.length > 0) : [];
    const cachedWorkIds = new Set((await this.store.listWorks()).map((work) => work.workId));
    const queue = candidates.filter((work) => !cachedWorkIds.has(work.id));
    const limiter = rateLimiterFactory();
    const scheduleRequest = (task) => limiter.schedule(task);
    const result = {
      total: candidates.length,
      downloaded: 0,
      alreadyCached: candidates.length - queue.length,
      skipped: [],
      failed: []
    };
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const work = queue[cursor];
        cursor += 1;
        try {
          if (work.offlineAccessEnabled !== true) {
            if (!["admin", "owner"].includes(String(work.accessRole))) {
              result.skipped.push({ workId: work.id, title: String(work.title ?? "未命名作品"), reason: "offline-access-disabled" });
              await onProgress({ ...result, work });
              continue;
            }
            await this.setOfflineAccess(work, true, { scheduleRequest });
          }
          await this.downloadWork(work, { scheduleRequest, confirmImages: false });
          result.downloaded += 1;
        } catch (error) {
          result.failed.push({ workId: work.id, title: String(work.title ?? "未命名作品"), error });
        }
        await onProgress({ ...result, work });
      }
    };
    try {
      await Promise.all(Array.from(
        { length: Math.min(DESKTOP_BULK_DOWNLOAD_CONCURRENCY, queue.length) },
        () => worker()
      ));
      return result;
    } finally {
      limiter.dispose();
    }
  }

  async switchWorkspace() {
    return unwrapBridge(await this.bridge.shell.requestSwitch());
  }

  async reportDirty(dirty) {
    const summary = await this.aggregateStatus();
    return this.bridge.shell.reportLeaveState({
      dirty: dirty === true,
      activeAiRequests: 0,
      pendingMutations: summary.pendingMutations,
      conflicts: summary.conflicts,
      rejected: summary.rejected
    }).catch(() => undefined);
  }

  async openSyncCenter({ serverWorks = this.serverWorks, toast = () => undefined } = {}) {
    this.serverWorks = Array.isArray(serverWorks) ? serverWorks : [];
    const dialog = document.querySelector("#desktop-sync-dialog");
    if (!(dialog instanceof HTMLDialogElement)) return;
    dialog.showModal();
    await this.renderSyncCenter(toast);
  }

  async renderSyncCenter(toast = () => undefined) {
    const content = document.querySelector("#desktop-sync-list");
    const summaryOutput = document.querySelector("#desktop-sync-summary");
    if (!(content instanceof HTMLElement) || !(summaryOutput instanceof HTMLElement)) return;
    content.replaceChildren(element("p", "entity-history-empty", "正在读取离线副本……"));
    const cachedWorks = await this.store.listWorks();
    const cachedById = new Map(cachedWorks.map((work) => [work.workId, work]));
    const serverById = new Map(this.serverWorks.map((work) => [work.id, work]));
    const workIds = [...new Set([...serverById.keys(), ...cachedById.keys()])];
    const aggregate = await this.aggregateStatus();
    summaryOutput.textContent = `${aggregate.works} 部离线作品 · ${aggregate.pendingMutations} 项待同步 · ${aggregate.conflicts} 项冲突`;
    content.replaceChildren();
    if (workIds.length === 0) {
      content.append(element("p", "entity-history-empty", "尚未下载离线作品。请先由作品所有者开启离线访问，再下载副本。"));
      return;
    }
    for (const workId of workIds) {
      const serverWork = serverById.get(workId) ?? null;
      const cachedWork = cachedById.get(workId) ?? null;
      const summary = cachedWork
        ? await this.store.statusSummary(workId)
        : { pending: 0, syncing: 0, conflicts: 0, rejected: 0 };
      const row = element("article", "desktop-sync-row");
      row.dataset.workId = workId;
      const copy = element("div", "desktop-sync-row-copy");
      copy.append(
        element("strong", "", String(serverWork?.title ?? cachedWork?.title ?? "未命名作品")),
        element("small", "", cachedWork
          ? `${workStatusLabel(cachedWork, summary)} · 最近更新 ${formatTime(cachedWork.updatedAt)}`
          : serverWork?.offlineAccessEnabled
            ? "Server 已允许离线访问，尚未下载"
            : "Server 尚未允许离线访问")
      );
      const actions = element("div", "desktop-sync-row-actions");
      const canManage = Boolean(serverWork && ["admin", "owner"].includes(String(serverWork.accessRole)));
      if (canManage) {
        const toggle = element("button", "ghost-button", serverWork.offlineAccessEnabled ? "关闭离线访问" : "允许离线访问");
        toggle.type = "button";
        toggle.addEventListener("click", async () => {
          toggle.disabled = true;
          try {
            await this.setOfflineAccess(serverWork, !serverWork.offlineAccessEnabled);
            toast(serverWork.offlineAccessEnabled ? "已允许该作品离线访问" : "已关闭后续离线同步；本机副本不会被远程删除");
            await this.renderSyncCenter(toast);
          } catch (error) {
            toast(error.message, "error");
          } finally {
            toggle.disabled = false;
          }
        });
        actions.append(toggle);
      }
      if (!cachedWork && serverWork?.offlineAccessEnabled) {
        const download = element("button", "primary-button", "下载离线副本");
        download.type = "button";
        download.addEventListener("click", async () => {
          download.disabled = true;
          try {
            await this.downloadWork(serverWork);
            toast("离线副本已保存");
            await this.renderSyncCenter(toast);
          } catch (error) {
            toast(error.message, "error");
          } finally {
            download.disabled = false;
          }
        });
        actions.append(download);
      }
      if (cachedWork) {
        const sync = element("button", "primary-button", "立即同步");
        sync.type = "button";
        sync.disabled = navigator.onLine === false;
        sync.addEventListener("click", async () => {
          sync.disabled = true;
          try {
            await this.client.syncWork(workId);
            toast("离线变更已同步");
            await this.renderSyncCenter(toast);
          } catch (error) {
            toast(error.message, "error");
            await this.renderSyncCenter(toast);
          } finally {
            sync.disabled = navigator.onLine === false;
          }
        });
        actions.append(sync);
        if (summary.conflicts > 0) {
          const resolve = element("button", "ghost-button", `处理冲突（${summary.conflicts}）`);
          resolve.type = "button";
          resolve.addEventListener("click", async () => {
            const conflict = (await this.store.listConflicts(workId))[0];
            if (conflict) await this.openConflict(conflict, toast);
          });
          actions.append(resolve);
        }
        if (summary.pending + summary.syncing + summary.conflicts + summary.rejected > 0) {
          const rescue = element("button", "ghost-button", "导出救援包");
          rescue.type = "button";
          rescue.title = "导出可用于恢复作品的救援包";
          rescue.addEventListener("click", async () => {
            rescue.disabled = true;
            try {
              downloadRescueBundle(await this.store.createRescueBundle(workId));
              toast("救援包已开始下载");
            } catch (error) {
              toast(error.message, "error");
            } finally {
              rescue.disabled = false;
            }
          });
          actions.append(rescue);
        }
        if (serverWork?.offlineAccessEnabled) {
          const clean = summary.pending + summary.syncing + summary.conflicts + summary.rejected === 0;
          const update = element("button", "ghost-button", "重新下载副本");
          update.type = "button";
          update.disabled = !clean;
          update.title = clean ? "重新下载最新内容" : "请先处理待同步、冲突或只读项目";
          update.addEventListener("click", async () => {
            update.disabled = true;
            try {
              await this.downloadWork(serverWork);
              toast("离线副本已更新");
              await this.renderSyncCenter(toast);
            } catch (error) {
              toast(error.message, "error");
            } finally {
              update.disabled = false;
            }
          });
          actions.append(update);
        }
      }
      row.append(copy, actions);
      content.append(row);
    }
  }

  async openConflict(conflict, toast = () => undefined) {
    const dialog = document.querySelector("#desktop-conflict-dialog");
    const base = document.querySelector("#desktop-conflict-base");
    const local = document.querySelector("#desktop-conflict-local");
    const server = document.querySelector("#desktop-conflict-server");
    const final = document.querySelector("#desktop-conflict-final");
    const summary = document.querySelector("#desktop-conflict-summary");
    if (!(dialog instanceof HTMLDialogElement) || !(final instanceof HTMLTextAreaElement)) return;
    const merged = mergeEntitySnapshots(
      conflict.entityType,
      conflict.baseSnapshot,
      conflict.localSnapshot,
      conflict.serverSnapshot
    );
    const draft = conflict.unresolvedBlockCount === null ? merged.mergedSnapshot : conflict.mergeDraft;
    if (conflict.unresolvedBlockCount === null) {
      await this.store.saveMergeDraft(conflict.mutationId, draft, merged.unresolvedBlockCount);
    }
    base.textContent = JSON.stringify(conflict.baseSnapshot, null, 2);
    local.textContent = JSON.stringify(conflict.localSnapshot, null, 2);
    server.textContent = JSON.stringify(conflict.serverSnapshot, null, 2);
    final.value = JSON.stringify(draft, null, 2);
    summary.textContent = `${conflict.entityType === "chapter" ? "章节" : "设定"}冲突 · ${merged.unresolvedBlockCount} 处需要确认 · 最终内容可编辑`;
    dialog.dataset.mutationId = conflict.mutationId;
    const setFinal = (snapshot) => { final.value = JSON.stringify(snapshot, null, 2); };
    document.querySelector("#desktop-conflict-use-local").onclick = () => setFinal(conflict.localSnapshot);
    document.querySelector("#desktop-conflict-use-server").onclick = () => setFinal(conflict.serverSnapshot);
    document.querySelector("#desktop-conflict-use-merged").onclick = () => setFinal(merged.mergedSnapshot);
    document.querySelector("#desktop-conflict-resolve").onclick = async () => {
      const resolve = document.querySelector("#desktop-conflict-resolve");
      resolve.disabled = true;
      try {
        const snapshot = JSON.parse(final.value);
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("最终内容格式不正确");
        await this.store.saveMergeDraft(conflict.mutationId, snapshot, 0);
        await this.store.resolveConflict(conflict.mutationId, snapshot);
        dialog.close();
        toast("冲突已保存为新的待同步变更");
        if (navigator.onLine !== false) await this.client.syncWork(conflict.workId).catch(() => undefined);
        await this.renderSyncCenter(toast);
      } catch (error) {
        toast(error instanceof SyntaxError ? "无法识别最终内容" : error.message, "error");
      } finally {
        resolve.disabled = false;
      }
    };
    dialog.showModal();
    final.focus();
  }
}

export async function createDesktopWorkspaceController({
  user = null,
  bridge = globalThis.scriverseDesktopWorkspace,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!bridge?.shell) return null;
  const profile = unwrapBridge(await bridge.shell.getCapabilities());
  const authenticatedUser = user ?? profile.user;
  if (!authenticatedUser?.userId) {
    const error = new Error("请先在 Desktop 中登录");
    error.code = "REMOTE_LOGIN_REQUIRED";
    throw error;
  }
  if (profile.user?.userId && profile.user.userId !== authenticatedUser.userId) {
    const error = new Error("登录用户已变化，请重新进入工作区");
    error.code = "OFFLINE_USER_MISMATCH";
    throw error;
  }
  const client = await createDesktopSyncClient({ user: authenticatedUser, bridge, fetchImpl });
  if (!client) {
    const error = new Error("当前 Server 版本不支持离线同步，请升级后重试");
    error.code = "SYNC_PROTOCOL_INCOMPATIBLE";
    throw error;
  }
  void client.syncAll();
  return new DesktopWorkspaceController({ bridge, profile, user: authenticatedUser, client });
}
