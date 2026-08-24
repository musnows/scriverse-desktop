const bridge = window.scriverseDesktop;
const workspaceList = document.querySelector("#workspace-list");
const profileSummary = document.querySelector("#profile-summary");
const profileDialog = document.querySelector("#profile-dialog");
const profileForm = document.querySelector("#profile-form");
const profileName = document.querySelector("#profile-name");
const profileOrigin = document.querySelector("#profile-origin");
const originPreview = document.querySelector("#origin-preview");
const profileFormError = document.querySelector("#profile-form-error");
const profileSubmit = document.querySelector("#profile-submit");
const remoteLoginDialog = document.querySelector("#remote-login-dialog");
const remoteLoginForm = document.querySelector("#remote-login-form");
const remoteLoginTitle = document.querySelector("#remote-login-title");
const remoteLoginOrigin = document.querySelector("#remote-login-origin");
const remoteUsername = document.querySelector("#remote-username");
const remotePassword = document.querySelector("#remote-password");
const remoteCaptchaImage = document.querySelector("#remote-captcha-image");
const remoteCaptchaAnswer = document.querySelector("#remote-captcha-answer");
const remoteCaptchaRefresh = document.querySelector("#remote-captcha-refresh");
const remoteLoginError = document.querySelector("#remote-login-error");
const remoteLoginSubmit = document.querySelector("#remote-login-submit");
const localSetupDialog = document.querySelector("#local-setup-dialog");
const localSetupForm = document.querySelector("#local-setup-form");
const localUsername = document.querySelector("#local-username");
const localPassword = document.querySelector("#local-password");
const localPasswordConfirmation = document.querySelector("#local-password-confirmation");
const localSetupError = document.querySelector("#local-setup-error");
const localSetupSubmit = document.querySelector("#local-setup-submit");
const localLoginDialog = document.querySelector("#local-login-dialog");
const localLoginForm = document.querySelector("#local-login-form");
const localLoginUsername = document.querySelector("#local-login-username");
const localLoginPassword = document.querySelector("#local-login-password");
const localLoginError = document.querySelector("#local-login-error");
const localLoginSubmit = document.querySelector("#local-login-submit");
const systemSettingsDialog = document.querySelector("#system-settings-dialog");
const systemSettingsForm = document.querySelector("#system-settings-form");
const localServerPort = document.querySelector("#local-server-port");
const systemSettingsError = document.querySelector("#system-settings-error");
const systemSettingsSubmit = document.querySelector("#system-settings-submit");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteForm = document.querySelector("#delete-form");
const deleteMessage = document.querySelector("#delete-message");
const deleteError = document.querySelector("#delete-error");
const deleteSubmit = document.querySelector("#delete-submit");
const toast = document.querySelector("#toast");

const state = {
  profiles: [],
  profileStatuses: new Map(),
  localStatus: { phase: "stopped", setupRequired: null, errorCode: null },
  desktopSettings: null,
  editingId: null,
  editingDiscardUnsynced: false,
  deletingId: null,
  deletingDiscardUnsynced: false,
  remoteLoginProfileId: null,
  remoteCaptchaId: null,
  toastTimer: null
};

function requireElement(element, label) {
  if (!(element instanceof HTMLElement)) throw new Error(`Selector element missing: ${label}`);
  return element;
}

[
  [workspaceList, "workspace-list"],
  [profileSummary, "profile-summary"],
  [profileDialog, "profile-dialog"],
  [profileForm, "profile-form"],
  [profileName, "profile-name"],
  [profileOrigin, "profile-origin"],
  [originPreview, "origin-preview"],
  [profileFormError, "profile-form-error"],
  [profileSubmit, "profile-submit"],
  [remoteLoginDialog, "remote-login-dialog"],
  [remoteLoginForm, "remote-login-form"],
  [remoteLoginTitle, "remote-login-title"],
  [remoteLoginOrigin, "remote-login-origin"],
  [remoteUsername, "remote-username"],
  [remotePassword, "remote-password"],
  [remoteCaptchaImage, "remote-captcha-image"],
  [remoteCaptchaAnswer, "remote-captcha-answer"],
  [remoteCaptchaRefresh, "remote-captcha-refresh"],
  [remoteLoginError, "remote-login-error"],
  [remoteLoginSubmit, "remote-login-submit"],
  [localSetupDialog, "local-setup-dialog"],
  [localSetupForm, "local-setup-form"],
  [localUsername, "local-username"],
  [localPassword, "local-password"],
  [localPasswordConfirmation, "local-password-confirmation"],
  [localSetupError, "local-setup-error"],
  [localSetupSubmit, "local-setup-submit"],
  [localLoginDialog, "local-login-dialog"],
  [localLoginForm, "local-login-form"],
  [localLoginUsername, "local-login-username"],
  [localLoginPassword, "local-login-password"],
  [localLoginError, "local-login-error"],
  [localLoginSubmit, "local-login-submit"],
  [systemSettingsDialog, "system-settings-dialog"],
  [systemSettingsForm, "system-settings-form"],
  [localServerPort, "local-server-port"],
  [systemSettingsError, "system-settings-error"],
  [systemSettingsSubmit, "system-settings-submit"],
  [deleteDialog, "delete-dialog"],
  [deleteForm, "delete-form"],
  [deleteMessage, "delete-message"],
  [deleteError, "delete-error"],
  [deleteSubmit, "delete-submit"],
  [toast, "toast"]
].forEach(([element, label]) => requireElement(element, label));

function unwrap(result) {
  if (!result || result.ok !== true) {
    const error = new Error(result?.error?.message || "操作失败，请重试");
    error.code = result?.error?.code || "DESKTOP_BRIDGE_ERROR";
    throw error;
  }
  return result.data;
}

function showToast(message, isError = false) {
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 4_200);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function formatLastUsed(value) {
  if (!value) return "尚未使用";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function profileStatus(profile) {
  if (profile.kind === "local") {
    if (state.localStatus.phase === "starting") return { label: "启动中", className: "starting" };
    if (state.localStatus.phase === "running") return { label: "运行中", className: "compatible" };
    if (state.localStatus.phase === "failed") return { label: "启动失败", className: "failed" };
    return { label: "本地", className: "idle" };
  }
  if (profile.capabilities?.compatibility === "compatible") return { label: "可用", className: "compatible" };
  if (profile.capabilities?.compatibility === "online-only") return { label: "仅在线使用", className: "warning" };
  if (profile.capabilities?.compatibility === "legacy-online-only") return { label: "Server 需升级", className: "warning" };
  if (profile.capabilities?.compatibility === "desktop-upgrade-required") return { label: "叙界需升级", className: "failed" };
  if (profile.capabilities?.compatibility === "shell-incompatible") return { label: "版本不兼容", className: "failed" };
  return { label: "未检测", className: "" };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detail(label, value) {
  const wrapper = document.createElement("div");
  wrapper.append(element("dt", "", label), element("dd", "", value));
  return wrapper;
}

function offlineStatusLabel(profile) {
  const status = state.profileStatuses.get(profile.id);
  if (!status) return "状态未知";
  const parts = [
    status.pendingMutations > 0 ? `${status.pendingMutations} 待同步` : null,
    status.conflicts > 0 ? `${status.conflicts} 冲突` : null,
    status.rejected > 0 ? `${status.rejected} 只读` : null
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "无待处理修改";
}

function renderProfile(profile) {
  const card = element("article", "workspace-card");
  card.dataset.kind = profile.kind;
  card.dataset.profileId = profile.id;
  const heading = element("div", "card-heading");
  const identity = document.createElement("div");
  identity.append(element("h3", "", profile.name));
  const origin = element("span", "profile-origin", profile.kind === "local" ? "仅存储在这台设备" : profile.origin);
  identity.append(origin);
  const status = profileStatus(profile);
  const badge = element("span", `status-badge ${status.className}`.trim(), status.label);
  heading.append(identity, badge);

  const details = element("dl", "card-details");
  details.append(
    detail("最近使用", formatLastUsed(profile.lastUsedAt)),
    detail("数据位置", profile.kind === "local" ? "这台设备" : "Server 与这台设备"),
    ...(profile.kind === "local" && state.desktopSettings
      ? [detail("本地端口", String(state.desktopSettings.localServerPort))]
      : []),
    ...(profile.kind === "remote" ? [detail("离线状态", offlineStatusLabel(profile))] : [])
  );

  const actions = element("div", "card-actions");
  if (profile.kind === "remote") {
    const removeButton = element("button", "ghost-button", "删除");
    removeButton.type = "button";
    removeButton.dataset.action = "remove";
    removeButton.dataset.profileId = profile.id;
    removeButton.setAttribute("aria-label", `删除 Server ${profile.name}`);
    const editButton = element("button", "ghost-button edit-button", "编辑");
    editButton.type = "button";
    editButton.dataset.action = "edit";
    editButton.dataset.profileId = profile.id;
    editButton.setAttribute("aria-label", `编辑 Server ${profile.name}`);
    const probeButton = element("button", "ghost-button", "检测");
    probeButton.type = "button";
    probeButton.dataset.action = "probe";
    probeButton.dataset.profileId = profile.id;
    probeButton.setAttribute("aria-label", `检测 Server ${profile.name}`);
    actions.append(removeButton, probeButton, editButton);
  }
  const openButton = element("button", "primary-button", profile.kind === "local" ? "进入本地工作区" : "选择 Server");
  openButton.type = "button";
  openButton.dataset.action = "open";
  openButton.dataset.profileId = profile.id;
  openButton.setAttribute("aria-label", `${openButton.textContent}：${profile.name}`);
  actions.append(openButton);
  card.append(heading, details, actions);
  return card;
}

function renderProfiles() {
  workspaceList.replaceChildren();
  state.profiles.forEach((profile) => workspaceList.append(renderProfile(profile)));
  const remoteCount = state.profiles.filter((profile) => profile.kind === "remote").length;
  profileSummary.textContent = `1 个本地工作区，${remoteCount} 个远端 Server`;
  workspaceList.setAttribute("aria-busy", "false");
}

async function loadProfiles() {
  workspaceList.setAttribute("aria-busy", "true");
  try {
    const [profilesResult, localStatusResult, settingsResult] = await Promise.all([
      bridge.profiles.list(),
      bridge.local.getStatus(),
      bridge.settings.get()
    ]);
    state.profiles = unwrap(profilesResult);
    state.localStatus = unwrap(localStatusResult);
    state.desktopSettings = unwrap(settingsResult);
    state.profileStatuses = new Map(await Promise.all(state.profiles
      .filter((profile) => profile.kind === "remote")
      .map(async (profile) => {
        try {
          return [profile.id, unwrap(await bridge.profiles.status(profile.id))];
        } catch {
          return [profile.id, null];
        }
      })));
    renderProfiles();
  } catch (error) {
    workspaceList.replaceChildren(element("p", "empty-state", error.message));
    profileSummary.textContent = "工作区读取失败";
    workspaceList.setAttribute("aria-busy", "false");
    showToast(error.message, true);
  }
}

function normalizedOrigin(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function updateOriginPreview() {
  const normalized = normalizedOrigin(profileOrigin.value);
  originPreview.classList.toggle("valid", Boolean(normalized));
  originPreview.classList.toggle("invalid", profileOrigin.value.trim() !== "" && !normalized);
  originPreview.textContent = normalized
    ? `将连接 ${normalized}`
    : profileOrigin.value.trim()
      ? "Server 地址格式不正确，请填写完整地址且不要附加页面路径。"
      : "例如 https://example.com；不要附加页面路径。";
}

function openProfileDialog(profile = null) {
  state.editingId = profile?.id || null;
  state.editingDiscardUnsynced = false;
  document.querySelector("#profile-dialog-title").textContent = profile ? "编辑 Server" : "新增 Server";
  document.querySelector("#profile-dialog-eyebrow").textContent = profile ? "修改远端工作区" : "远端工作区";
  profileSubmit.textContent = profile ? "保存修改" : "保存 Server";
  profileName.value = profile?.name || "";
  profileOrigin.value = profile?.origin || "";
  profileFormError.hidden = true;
  updateOriginPreview();
  profileDialog.showModal();
  window.setTimeout(() => profileName.focus(), 0);
}

function closeProfileDialog() {
  if (profileDialog.open) profileDialog.close();
  state.editingId = null;
  state.editingDiscardUnsynced = false;
  profileSubmit.textContent = "保存 Server";
}

function applyRemoteChallenge(challenge) {
  state.remoteCaptchaId = challenge.captchaId;
  remoteCaptchaImage.src = challenge.imageDataUrl;
  remoteCaptchaAnswer.value = "";
}

function openRemoteLoginDialog(profile, challenge) {
  state.remoteLoginProfileId = profile.id;
  remoteLoginForm.reset();
  remoteLoginTitle.textContent = `登录“${profile.name}”`;
  remoteLoginOrigin.textContent = profile.origin;
  remoteLoginError.hidden = true;
  applyRemoteChallenge(challenge);
  remoteLoginDialog.showModal();
  window.setTimeout(() => remoteUsername.focus(), 0);
}

function closeRemoteLoginDialog() {
  remotePassword.value = "";
  remoteCaptchaAnswer.value = "";
  remoteCaptchaImage.removeAttribute("src");
  state.remoteLoginProfileId = null;
  state.remoteCaptchaId = null;
  if (remoteLoginDialog.open) remoteLoginDialog.close();
}

async function refreshRemoteCaptcha() {
  if (!state.remoteLoginProfileId) return;
  setBusy(remoteCaptchaRefresh, true);
  try {
    applyRemoteChallenge(unwrap(await bridge.remote.refreshCaptcha(state.remoteLoginProfileId)));
    remoteLoginError.hidden = true;
    remoteCaptchaAnswer.focus();
  } catch (error) {
    remoteLoginError.textContent = error.message;
    remoteLoginError.hidden = false;
  } finally {
    setBusy(remoteCaptchaRefresh, false);
  }
}

function openLocalSetupDialog() {
  localSetupForm.reset();
  localSetupError.hidden = true;
  localSetupDialog.showModal();
  window.setTimeout(() => localUsername.focus(), 0);
}

function closeLocalSetupDialog() {
  localPassword.value = "";
  localPasswordConfirmation.value = "";
  if (localSetupDialog.open) localSetupDialog.close();
}

function openLocalLoginDialog() {
  localLoginForm.reset();
  localLoginError.hidden = true;
  localLoginDialog.showModal();
  window.setTimeout(() => localLoginUsername.focus(), 0);
}

function closeLocalLoginDialog() {
  localLoginPassword.value = "";
  if (localLoginDialog.open) localLoginDialog.close();
}

async function openSystemSettingsDialog() {
  systemSettingsError.hidden = true;
  try {
    state.desktopSettings = unwrap(await bridge.settings.get());
    localServerPort.value = String(state.desktopSettings.localServerPort);
    systemSettingsDialog.showModal();
    window.setTimeout(() => localServerPort.focus(), 0);
  } catch (error) {
    showToast(error.message, true);
  }
}

function closeSystemSettingsDialog() {
  systemSettingsError.hidden = true;
  if (systemSettingsDialog.open) systemSettingsDialog.close();
}

function openDeleteDialog(profile) {
  state.deletingId = profile.id;
  state.deletingDiscardUnsynced = false;
  const status = state.profileStatuses.get(profile.id);
  const offlineState = status && status.pendingMutations + status.conflicts + status.rejected > 0
    ? ` 本机仍有${offlineStatusLabel(profile)}；首次删除会被阻止，请先同步或导出救援包。`
    : "";
  deleteMessage.textContent = `将删除“${profile.name}”的 Server 配置（${profile.origin}）。${offlineState}`;
  deleteError.hidden = true;
  deleteSubmit.textContent = "删除 Server";
  deleteDialog.showModal();
  window.setTimeout(() => deleteSubmit.focus(), 0);
}

function closeDeleteDialog() {
  if (deleteDialog.open) deleteDialog.close();
  state.deletingId = null;
  state.deletingDiscardUnsynced = false;
  deleteSubmit.textContent = "删除 Server";
}

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  profileFormError.hidden = true;
  setBusy(profileSubmit, true);
  try {
    const input = { name: profileName.value, origin: profileOrigin.value };
    if (state.editingId) {
      unwrap(await bridge.profiles.update({ id: state.editingId, ...input, discardUnsynced: state.editingDiscardUnsynced }));
      showToast("Server 配置已更新");
    } else {
      unwrap(await bridge.profiles.create(input));
      showToast("Server 已添加");
    }
    closeProfileDialog();
    await loadProfiles();
  } catch (error) {
    profileFormError.textContent = error.message;
    profileFormError.hidden = false;
    if (error.code === "PROFILE_UNSYNCED_DATA") {
      state.editingDiscardUnsynced = true;
      profileSubmit.textContent = "永久更换并删除本机副本";
    }
  } finally {
    setBusy(profileSubmit, false);
  }
});

deleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.deletingId) return;
  deleteError.hidden = true;
  setBusy(deleteSubmit, true);
  try {
    unwrap(await bridge.profiles.remove({ id: state.deletingId, discardUnsynced: state.deletingDiscardUnsynced }));
    closeDeleteDialog();
    showToast("Server 配置已删除");
    await loadProfiles();
  } catch (error) {
    deleteError.textContent = error.message;
    deleteError.hidden = false;
    if (error.code === "PROFILE_UNSYNCED_DATA") {
      state.deletingDiscardUnsynced = true;
      deleteSubmit.textContent = "永久删除本机离线数据";
    }
  } finally {
    setBusy(deleteSubmit, false);
  }
});

remoteLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.remoteLoginProfileId || !state.remoteCaptchaId) return;
  remoteLoginError.hidden = true;
  setBusy(remoteLoginSubmit, true);
  try {
    unwrap(await bridge.remote.login({
      profileId: state.remoteLoginProfileId,
      username: remoteUsername.value,
      password: remotePassword.value,
      captchaId: state.remoteCaptchaId,
      captchaAnswer: remoteCaptchaAnswer.value
    }));
    closeRemoteLoginDialog();
    showToast("Server 登录成功，正在进入工作区");
    await loadProfiles();
  } catch (error) {
    remoteLoginError.textContent = error.message;
    remoteLoginError.hidden = false;
    if (error.code === "CAPTCHA_INVALID") await refreshRemoteCaptcha();
  } finally {
    remotePassword.value = "";
    setBusy(remoteLoginSubmit, false);
  }
});
remoteCaptchaRefresh.addEventListener("click", refreshRemoteCaptcha);

localSetupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  localSetupError.hidden = true;
  if (localPassword.value !== localPasswordConfirmation.value) {
    localSetupError.textContent = "两次输入的密码不一致";
    localSetupError.hidden = false;
    localPasswordConfirmation.focus();
    return;
  }
  setBusy(localSetupSubmit, true);
  try {
    unwrap(await bridge.local.setup({ username: localUsername.value, password: localPassword.value }));
    closeLocalSetupDialog();
    showToast("本地管理员已创建，正在进入工作区");
    await loadProfiles();
  } catch (error) {
    localSetupError.textContent = error.message;
    localSetupError.hidden = false;
  } finally {
    localPassword.value = "";
    localPasswordConfirmation.value = "";
    setBusy(localSetupSubmit, false);
  }
});

localLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  localLoginError.hidden = true;
  setBusy(localLoginSubmit, true);
  try {
    unwrap(await bridge.local.login({ username: localLoginUsername.value, password: localLoginPassword.value }));
    closeLocalLoginDialog();
    showToast("本地工作区登录成功，正在进入");
    await loadProfiles();
  } catch (error) {
    localLoginError.textContent = error.message;
    localLoginError.hidden = false;
  } finally {
    localLoginPassword.value = "";
    setBusy(localLoginSubmit, false);
  }
});

systemSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  systemSettingsError.hidden = true;
  setBusy(systemSettingsSubmit, true);
  try {
    state.desktopSettings = unwrap(await bridge.settings.update({ localServerPort: Number(localServerPort.value) }));
    closeSystemSettingsDialog();
    await loadProfiles();
    showToast(state.localStatus.phase === "running" ? "端口设置已保存，下次启动本地工作区时生效" : "端口设置已保存");
  } catch (error) {
    systemSettingsError.textContent = error.message;
    systemSettingsError.hidden = false;
  } finally {
    setBusy(systemSettingsSubmit, false);
  }
});

workspaceList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const profile = state.profiles.find((candidate) => candidate.id === button.dataset.profileId);
  if (!profile) return;
  if (button.dataset.action === "edit") {
    openProfileDialog(profile);
    return;
  }
  if (button.dataset.action === "remove") {
    openDeleteDialog(profile);
    return;
  }
  if (button.dataset.action === "probe") {
    setBusy(button, true);
    try {
      const checked = unwrap(await bridge.profiles.probe(profile.id));
      showToast(checked.capabilities?.compatibility === "compatible" ? "Server 可正常连接" : "Server 检测完成，请查看状态");
      await loadProfiles();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
    return;
  }
  if (button.dataset.action === "open") {
    setBusy(button, true);
    try {
      const openResult = unwrap(await bridge.profiles.open(profile.id));
      await loadProfiles();
      if (profile.kind === "local" && openResult.status === "setup-required") {
        showToast("本地服务已启动，请创建首位管理员");
        openLocalSetupDialog();
      } else if (profile.kind === "local" && openResult.status === "login-required") {
        showToast("请登录本地工作区");
        openLocalLoginDialog();
      } else if (profile.kind === "remote" && openResult.status === "login-required") {
        showToast("请直接登录该 Server");
        openRemoteLoginDialog(profile, openResult.challenge);
      } else {
        showToast(openResult.mode === "offline" ? `已离线打开“${profile.name}”` : `已选择“${profile.name}”`);
      }
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }
});

document.querySelector("#add-profile-button").addEventListener("click", () => openProfileDialog());
document.querySelector("#system-settings-button").addEventListener("click", () => { void openSystemSettingsDialog(); });
document.querySelector("#refresh-button").addEventListener("click", loadProfiles);
window.addEventListener("focus", () => { void loadProfiles(); });
document.querySelector("#quit-button").addEventListener("click", async () => {
  try {
    unwrap(await bridge.app.quit());
  } catch (error) {
    showToast(error.message, true);
  }
});
document.querySelectorAll("[data-dialog-close]").forEach((button) => button.addEventListener("click", closeProfileDialog));
document.querySelectorAll("[data-remote-login-close]").forEach((button) => button.addEventListener("click", closeRemoteLoginDialog));
document.querySelectorAll("[data-local-setup-close]").forEach((button) => button.addEventListener("click", closeLocalSetupDialog));
document.querySelectorAll("[data-local-login-close]").forEach((button) => button.addEventListener("click", closeLocalLoginDialog));
document.querySelectorAll("[data-system-settings-close]").forEach((button) => button.addEventListener("click", closeSystemSettingsDialog));
document.querySelectorAll("[data-delete-close]").forEach((button) => button.addEventListener("click", closeDeleteDialog));
profileOrigin.addEventListener("input", updateOriginPreview);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (remoteLoginDialog.open) {
    event.preventDefault();
    closeRemoteLoginDialog();
    return;
  }
  if (localSetupDialog.open) {
    event.preventDefault();
    closeLocalSetupDialog();
    return;
  }
  if (localLoginDialog.open) {
    event.preventDefault();
    closeLocalLoginDialog();
    return;
  }
  if (systemSettingsDialog.open) {
    event.preventDefault();
    closeSystemSettingsDialog();
    return;
  }
  if (deleteDialog.open) {
    event.preventDefault();
    closeDeleteDialog();
    return;
  }
  if (profileDialog.open) {
    event.preventDefault();
    closeProfileDialog();
  }
});

async function initialize() {
  if (!bridge?.profiles || !bridge?.local || !bridge?.remote || !bridge?.settings || !bridge?.app) {
    workspaceList.replaceChildren(element("p", "empty-state", "叙界初始化失败，请重新打开应用。"));
    profileSummary.textContent = "工作区暂时不可用";
    workspaceList.setAttribute("aria-busy", "false");
    return;
  }
  try {
    const [version, platform] = await Promise.all([bridge.app.getVersion(), bridge.app.getPlatform()]);
    document.querySelector("#runtime-meta").textContent = `叙界 v${unwrap(version)} · ${unwrap(platform)}`;
  } catch {
    document.querySelector("#runtime-meta").textContent = "叙界 v—";
  }
  await loadProfiles();
}

void initialize();
