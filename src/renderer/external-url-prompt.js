function externalUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "外部网站";
  }
}

function element(tag, className, text = null) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

export function installExternalUrlPrompt({ bridge, toast, notify = () => undefined } = {}) {
  if (
    !bridge
    || typeof bridge.onExternalUrlRequest !== "function"
    || typeof bridge.openExternalUrl !== "function"
    || !(toast instanceof HTMLElement)
  ) return () => undefined;

  let timeout = null;
  let active = false;

  const hide = () => {
    window.clearTimeout(timeout);
    timeout = null;
    active = false;
    toast.replaceChildren();
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.removeAttribute("aria-label");
    toast.hidden = true;
  };

  const unsubscribe = bridge.onExternalUrlRequest((request) => {
    if (!request || typeof request.requestId !== "string" || typeof request.url !== "string") return;
    hide();
    active = true;
    toast.className = "toast external-url-confirmation";
    toast.setAttribute("role", "alertdialog");
    toast.setAttribute("aria-label", "打开外部网站？");
    const title = element("strong", "", "打开外部网站？");
    const detail = element("p", "", `即将打开外部网站：\n${externalUrlOrigin(request.url)}`);
    const actions = element("div", "toast-confirmation-actions");
    const cancel = element("button", "ghost-button", "取消");
    cancel.type = "button";
    const confirm = element("button", "primary-button", "继续访问");
    confirm.type = "button";
    actions.append(cancel, confirm);
    toast.append(title, detail, actions);
    toast.hidden = false;

    const respond = async (confirmed) => {
      if (!active) return;
      active = false;
      window.clearTimeout(timeout);
      timeout = null;
      toast.replaceChildren();
      toast.className = "toast";
      toast.setAttribute("role", "status");
      toast.removeAttribute("aria-label");
      toast.hidden = true;
      try {
        const result = await bridge.openExternalUrl({ requestId: request.requestId, confirmed });
        if (result?.ok !== true) notify(result?.error?.message ?? "外部网站跳转失败", true);
      } catch (error) {
        notify(error?.message ?? "外部网站跳转失败", true);
      }
    };
    cancel.addEventListener("click", () => { void respond(false); }, { once: true });
    confirm.addEventListener("click", () => { void respond(true); }, { once: true });
    timeout = window.setTimeout(() => { void respond(false); }, 30_000);
    cancel.focus();
  });

  return () => {
    unsubscribe?.();
    hide();
  };
}
