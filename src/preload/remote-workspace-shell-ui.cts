export function ensureRemoteWorkspaceShellUi(
  documentRef: Document,
  profileName: string,
  requestSwitch: () => void | Promise<unknown>
): void {
  const label = `当前工作区：${profileName}`;
  const brandSubtitle = documentRef.querySelector<HTMLElement>("#home-button small");
  if (brandSubtitle && brandSubtitle.textContent !== label) brandSubtitle.textContent = label;

  documentRef.querySelectorAll<HTMLElement>("[data-product-footer] .product-footer-meta").forEach((meta) => {
    let workspace = meta.querySelector<HTMLElement>("[data-desktop-workspace-name]");
    if (!workspace) {
      const separator = documentRef.createElement("span");
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "·";
      workspace = documentRef.createElement("span");
      workspace.setAttribute("data-desktop-workspace-name", "");
      meta.append(separator, workspace);
    }
    if (workspace.textContent !== label) workspace.textContent = label;
  });

  const settingsHeader = documentRef.querySelector<HTMLElement>("#settings-hub-view .settings-hub-header");
  if (!settingsHeader) return;
  const returnButton = settingsHeader.querySelector<HTMLButtonElement>("#settings-return");
  let actions = settingsHeader.querySelector<HTMLElement>(".settings-detail-actions");
  if (!actions) {
    actions = documentRef.createElement("div");
    actions.className = "settings-detail-actions";
    settingsHeader.append(actions);
  }
  if (returnButton && returnButton.parentElement !== actions) actions.append(returnButton);
  returnButton?.classList.add("settings-parent-button");

  let switchButton = actions.querySelector<HTMLButtonElement>("#desktop-switch-button");
  if (!switchButton) {
    switchButton = documentRef.createElement("button");
    switchButton.id = "desktop-switch-button";
    switchButton.type = "button";
    switchButton.className = "ghost-button settings-parent-button";
    switchButton.textContent = "切换工作区";
    actions.prepend(switchButton);
  }
  switchButton.classList.remove("hidden");
  if (switchButton.dataset.desktopRemoteShellBound !== "true") {
    switchButton.dataset.desktopRemoteShellBound = "true";
    switchButton.addEventListener("click", () => {
      void requestSwitch();
    });
  }
}
