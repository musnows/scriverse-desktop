import type { MakerOptions } from "@electron-forge/maker-base";
import { describe, expect, it } from "vitest";
import { MacDmgMaker } from "../../scripts/macos-dmg-maker.js";

describe("macOS disk image maker", () => {
  it.each(["../outside", "1.1.8/../../outside", "1.1.8.0;echo unsafe", null])(
    "rejects invalid artifact versions before touching the filesystem: %s", async (version) => {
      const maker = new MacDmgMaker({});
      await expect(maker.make({ packageJSON: { version } } as MakerOptions))
        .rejects.toThrow("Desktop disk image version is invalid");
    }
  );

  it("only supports macOS runners", () => {
    const maker = new MacDmgMaker({});
    expect(maker.defaultPlatforms).toEqual(["darwin"]);
    expect(maker.isSupportedOnCurrentPlatform()).toBe(process.platform === "darwin");
  });
});
