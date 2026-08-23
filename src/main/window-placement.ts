import type { BrowserWindow, Rectangle } from "electron";

export type DesktopWindowPlacement = {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
};

export function captureWindowPlacement(window: BrowserWindow): DesktopWindowPlacement {
  return {
    bounds: window.getBounds(),
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen()
  };
}

export function applyWindowPlacement(window: BrowserWindow, placement: DesktopWindowPlacement): void {
  if (window.isFullScreen() && !placement.fullScreen) window.setFullScreen(false);
  if (window.isMaximized() && !placement.maximized) window.unmaximize();
  window.setBounds(placement.bounds, false);
  if (placement.maximized) window.maximize();
  if (placement.fullScreen) window.setFullScreen(true);
}
