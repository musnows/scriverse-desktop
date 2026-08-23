import { describe, expect, it } from "vitest";
import { isLoopbackOrigin, normalizeProfileOrigin, ProfileUrlError } from "../../src/shared/profile-url.js";

describe("远端 profile URL", () => {
  it("规范化 HTTP(S) origin", () => {
    expect(normalizeProfileOrigin(" HTTPS://Example.COM:443/ ")).toBe("https://example.com");
    expect(normalizeProfileOrigin("http://[::1]:13210/")).toBe("http://[::1]:13210");
    expect(isLoopbackOrigin("http://127.0.0.2:13210")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:13210")).toBe(true);
    expect(isLoopbackOrigin("https://example.com")).toBe(false);
  });

  it.each([
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/api",
    "https://example.com/?token=secret",
    "https://example.com/#workspace"
  ])("拒绝非 origin 输入 %s", (input) => {
    expect(() => normalizeProfileOrigin(input)).toThrowError(ProfileUrlError);
  });
});
