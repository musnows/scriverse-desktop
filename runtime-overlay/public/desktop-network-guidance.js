export function desktopNetworkGuidanceMessage(online) {
  if (online) {
    return {
      title: "网络连接已恢复",
      description: "为恢复线上模式并同步数据，请仍然返回工作区列表，然后重新进入当前工作区。"
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

export function installDesktopNetworkGuidance({ bridge = null, documentRef = globalThis.document, requestSwitch = () => Promise.resolve() } = {}) {
  if (!bridge || typeof bridge.getNetworkStatus !== "function" || !documentRef) return () => undefined;
  const toast = documentRef.querySelector("#desktop-network-guidance-toast");
  const title = documentRef.querySelector("#desktop-network-guidance-title");
  const description = documentRef.querySelector("#desktop-network-guidance-description");
  const switchButton = documentRef.querySelector("#desktop-network-guidance-switch");
  if (!(toast instanceof HTMLElement) || !(title instanceof HTMLElement) || !(description instanceof HTMLElement) || !(switchButton instanceof HTMLButtonElement)) {
    return () => undefined;
  }

  let disconnected = false;
  let disposed = false;
  const applyStatus = (status) => {
    const online = networkStatus(status);
    if (online === null || disposed) return;
    if (!online) disconnected = true;
    if (!disconnected) return;
    const copy = desktopNetworkGuidanceMessage(online);
    toast.hidden = false;
    title.textContent = copy.title;
    description.textContent = copy.description;
    if (!online) switchButton.focus({ preventScroll: true });
  };
  const handleSwitch = async () => {
    switchButton.disabled = true;
    try {
      await requestSwitch();
    } finally {
      switchButton.disabled = false;
    }
  };
  const unsubscribe = typeof bridge.onNetworkStatus === "function"
    ? bridge.onNetworkStatus(applyStatus)
    : () => undefined;
  switchButton.addEventListener("click", handleSwitch);
  void bridge.getNetworkStatus().then((result) => {
    if (result?.ok === true) applyStatus(result.data);
  }).catch(() => undefined);
  return () => {
    disposed = true;
    switchButton.removeEventListener("click", handleSwitch);
    if (typeof unsubscribe === "function") unsubscribe();
  };
}
