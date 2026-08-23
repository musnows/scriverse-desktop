import { describe, expect, it } from "vitest";
import { remoteRequestHeaders, remoteResponseHeaders } from "../../src/shared/remote-session-headers.js";

describe("Desktop 远端 Session 请求头策略", () => {
  it("精确 origin 注入 Bearer 并剥离所有浏览器 Cookie", () => {
    const token = `scrvd_${"a".repeat(43)}`;
    expect(remoteRequestHeaders({ Cookie: "legacy=1", authorization: "Bearer attacker", Accept: "application/json" },
      "https://server.example/api/works", "https://server.example", token)).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    });
    expect(remoteRequestHeaders({ Cookie: "legacy=1", Authorization: "Bearer stale" },
      "https://cdn.example/asset.js", "https://server.example", token)).toEqual({});
  });

  it("拒绝 Server 通过响应重新写入认证 Cookie", () => {
    expect(remoteResponseHeaders({
      "Content-Type": ["application/json"],
      "Set-Cookie": ["scriverse_session=forbidden; HttpOnly"],
      "set-cookie2": ["legacy=forbidden"]
    })).toEqual({ "Content-Type": ["application/json"] });
  });
});
