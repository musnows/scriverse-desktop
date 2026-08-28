import { describe, expect, it, vi } from "vitest";
import { isSquirrelWindowsInstallation } from "../../src/main/windows-installation.js";

describe("Windows installation detection", () => {
  it("recognizes an installed Squirrel application from its version directory and updater", () => {
    const fileExists = vi.fn(() => true);
    expect(isSquirrelWindowsInstallation({
      platform: "win32",
      executablePath: "/AppData/Local/ScriverseDesktop/app-0.1.9/Scriverse Desktop.exe",
      fileExists
    })).toBe(true);
    expect(fileExists).toHaveBeenCalledWith("/AppData/Local/ScriverseDesktop/Update.exe");
  });

  it("keeps NSIS and non-Windows packages out of the Squirrel update path", () => {
    const fileExists = vi.fn(() => true);
    expect(isSquirrelWindowsInstallation({
      platform: "win32",
      executablePath: "/Programs/Scriverse Desktop/Scriverse Desktop.exe",
      fileExists
    })).toBe(false);
    expect(isSquirrelWindowsInstallation({
      platform: "darwin",
      executablePath: "/Applications/叙界.app/Contents/MacOS/Scriverse Desktop",
      fileExists
    })).toBe(false);
    expect(fileExists).not.toHaveBeenCalled();
  });
});
