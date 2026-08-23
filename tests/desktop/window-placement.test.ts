import type { BrowserWindow, Rectangle } from "electron";
import { describe, expect, it, vi } from "vitest";
import { applyWindowPlacement, captureWindowPlacement } from "../../src/main/window-placement.js";

function mockWindow(input: { bounds: Rectangle; maximized?: boolean; fullScreen?: boolean }) {
  let maximized = input.maximized === true;
  let fullScreen = input.fullScreen === true;
  return {
    getBounds: vi.fn(() => ({ ...input.bounds })),
    isMaximized: vi.fn(() => maximized),
    isFullScreen: vi.fn(() => fullScreen),
    setBounds: vi.fn(),
    maximize: vi.fn(() => { maximized = true; }),
    unmaximize: vi.fn(() => { maximized = false; }),
    setFullScreen: vi.fn((value: boolean) => { fullScreen = value; })
  } as unknown as BrowserWindow;
}

describe("Desktop 窗口位置继承", () => {
  it("捕获并应用同一显示器上的窗口位置与显示状态", () => {
    const bounds = { x: 2_100, y: 80, width: 1_240, height: 800 };
    const source = mockWindow({ bounds, maximized: true });
    const target = mockWindow({ bounds: { x: 10, y: 10, width: 800, height: 600 }, fullScreen: true });

    const placement = captureWindowPlacement(source);
    applyWindowPlacement(target, placement);

    expect(placement).toEqual({ bounds, maximized: true, fullScreen: false });
    expect(target.setFullScreen).toHaveBeenCalledWith(false);
    expect(target.setBounds).toHaveBeenCalledWith(bounds, false);
    expect(target.maximize).toHaveBeenCalledOnce();
  });
});
