import { describe, expect, it } from "vitest";
import {
  normalizeExternalHttpUrl,
  parseExternalUrlResponse
} from "../../src/shared/external-url-contract.js";

describe("Desktop 外部网站跳转契约", () => {
  it("只接受没有凭据的 HTTP(S) 页面地址", () => {
    expect(normalizeExternalHttpUrl("https://scriverse.top/docs")).toBe("https://scriverse.top/docs");
    expect(normalizeExternalHttpUrl("http://example.test/path?q=1")).toBe("http://example.test/path?q=1");
    expect(normalizeExternalHttpUrl("data:image/png;base64,abc")).toBeNull();
    expect(normalizeExternalHttpUrl("blob:https://example.test/id")).toBeNull();
    expect(normalizeExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalHttpUrl("https://user:pass@example.test/")).toBeNull();
  });

  it("严格校验用户的确认响应", () => {
    const requestId = "123e4567-e89b-12d3-a456-426614174000";
    expect(parseExternalUrlResponse({ requestId, confirmed: true })).toEqual({ requestId, confirmed: true });
    expect(() => parseExternalUrlResponse({ requestId, confirmed: "true" })).toThrowError("外部网站跳转确认请求无效");
    expect(() => parseExternalUrlResponse({ requestId, confirmed: false, extra: true })).toThrowError("外部网站跳转确认请求无效");
  });
});
