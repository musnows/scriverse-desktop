export function desktopNetworkGuidanceMessage(online) {
  if (online) {
    return {
      title: "网络连接已恢复",
      description: "当前仍在离线工作区。可以关闭此提示并继续使用本机数据，也可以返回工作区选择页后重新进入，以恢复线上模式并同步数据。"
    };
  }
  return {
    title: "网络连接已断开",
    description: "已检测到设备没有可用的 Wi-Fi 或局域网连接。请返回工作区列表，然后重新进入当前工作区，以启用已下载的离线副本。即使稍后恢复联网，也仍需要返回工作区列表并重新进入工作区，才能恢复线上模式并同步数据。"
  };
}

function networkStatus(status) {
  if (!status || typeof status !== "object" || status.monitoring !== true || typeof status.online !== "boolean") return null;
  return status.online;
}

export function desktopNetworkGuidanceView(mode, status, dismissedWhileOnline = false) {
  if (mode !== "offline") return { visible: false, dismissedWhileOnline: false };
  const online = networkStatus(status);
  if (online !== true) return { visible: false, dismissedWhileOnline };
  if (dismissedWhileOnline) return { visible: false, dismissedWhileOnline: true };
  return {
    visible: true,
    dismissedWhileOnline: false,
    copy: desktopNetworkGuidanceMessage(true)
  };
}

export function installDesktopNetworkGuidance({ bridge = null, documentRef = globalThis.document, requestSwitch = () => Promise.resolve(), mode = "online" } = {}) {
  if (mode !== "offline" || !bridge || typeof bridge.getNetworkStatus !== "function" || !documentRef) return () => undefined;
  const toast = documentRef.querySelector("#desktop-network-guidance-toast");
  const title = documentRef.querySelector("#desktop-network-guidance-title");
  const description = documentRef.querySelector("#desktop-network-guidance-description");
  const switchButton = documentRef.querySelector("#desktop-network-guidance-switch");
  const dismissButton = documentRef.querySelector("#desktop-network-guidance-dismiss");
  if (!(toast instanceof HTMLElement) || !(title instanceof HTMLElement) || !(description instanceof HTMLElement) || !(switchButton instanceof HTMLButtonElement) || !(dismissButton instanceof HTMLButtonElement)) {
    return () => undefined;
  }

  let dismissedWhileOnline = false;
  let disposed = false;
  const applyStatus = (status) => {
    if (disposed) return;
    const view = desktopNetworkGuidanceView("offline", status, dismissedWhileOnline);
    dismissedWhileOnline = view.dismissedWhileOnline;
    if (!view.visible || !view.copy) {
      toast.hidden = true;
      return;
    }
    toast.hidden = false;
    title.textContent = view.copy.title;
    description.textContent = view.copy.description;
    dismissButton.focus({ preventScroll: true });
  };
  const handleSwitch = async () => {
    switchButton.disabled = true;
    try {
      await requestSwitch();
    } finally {
      switchButton.disabled = false;
    }
  };
  const handleDismiss = () => {
    dismissedWhileOnline = true;
    toast.hidden = true;
  };
  const unsubscribe = typeof bridge.onNetworkStatus === "function"
    ? bridge.onNetworkStatus(applyStatus)
    : () => undefined;
  switchButton.addEventListener("click", handleSwitch);
  dismissButton.addEventListener("click", handleDismiss);
  void bridge.getNetworkStatus().then((result) => {
    if (result?.ok === true) applyStatus(result.data);
  }).catch(() => undefined);
  return () => {
    disposed = true;
    switchButton.removeEventListener("click", handleSwitch);
    dismissButton.removeEventListener("click", handleDismiss);
    if (typeof unsubscribe === "function") unsubscribe();
  };
}
