import { describe, expect, it, vi } from "vitest";
import { RemoteServerProbe } from "../../src/main/remote-server-probe.js";

const modernHealth = {
  data: {
    status: "ok",
    version: "0.8.7",
    product: "scriverse",
    serverVersion: "0.8.7",
    webAssetVersion: "0.8.7",
    shellProtocol: { min: 1, max: 1 },
    minimumDesktopVersion: "0.1.0",
    syncProtocol: {
      min: 1,
      max: 1,
      entityTypes: ["chapter", "setting"],
      maxMutationBytes: 2_500_000
    }
  }
};

describe("Desktop Server health 探测", () => {
  it("读取现代协议能力且请求不携带浏览器 Cookie", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(modernHealth), { status: 200 }));
    const result = await new RemoteServerProbe(fetchImpl).probe("https://server.example", "0.8.7");
    expect(result).toMatchObject({
      product: "scriverse",
      serverVersion: "0.8.7",
      webAssetVersion: "0.8.7",
      compatibility: "compatible",
      shellProtocol: { min: 1, max: 1 },
      syncProtocol: { entityTypes: ["chapter", "setting"], maxMutationBytes: 2_500_000 }
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://server.example/api/health", expect.objectContaining({
      credentials: "omit",
      redirect: "manual"
    }));
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Cookie");
  });

  it("把缺少 Desktop 字段的旧 Server 标为 legacy online only", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { status: "ok", version: "0.7.9" }
    }), { status: 200 }));
    await expect(new RemoteServerProbe(fetchImpl).probe("https://legacy.example", "0.8.7")).resolves.toMatchObject({
      serverVersion: "0.7.9",
      shellProtocol: null,
      syncProtocol: null,
      compatibility: "legacy-online-only"
    });
  });

  it("拒绝其他产品、公网 HTTP 与跨 origin 重定向", async () => {
    const mismatch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { ...modernHealth.data, product: "other" }
    }), { status: 200 }));
    await expect(new RemoteServerProbe(mismatch).probe("https://other.example", "0.8.7")).rejects.toMatchObject({
      code: "REMOTE_PRODUCT_MISMATCH"
    });

    const unused = vi.fn<typeof fetch>();
    await expect(new RemoteServerProbe(unused).probe("http://public.example", "0.8.7")).rejects.toMatchObject({
      code: "REMOTE_INSECURE_ORIGIN_FORBIDDEN"
    });
    expect(unused).not.toHaveBeenCalled();

    const redirect = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example/api/health" }
    }));
    await expect(new RemoteServerProbe(redirect).probe("https://server.example", "0.8.7")).rejects.toMatchObject({
      code: "REMOTE_PROBE_REDIRECT_FORBIDDEN"
    });
  });

  it("只跟随一次同 origin 重定向并限制 64 KiB", async () => {
    const redirect = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: "/health/desktop" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(modernHealth), { status: 200 }));
    await expect(new RemoteServerProbe(redirect).probe("https://server.example", "0.8.7")).resolves.toMatchObject({
      compatibility: "compatible"
    });
    expect(redirect.mock.calls[1]?.[0]).toBe("https://server.example/health/desktop");

    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response("x", {
      status: 200,
      headers: { "content-length": String(65 * 1024) }
    }));
    await expect(new RemoteServerProbe(oversized).probe("https://server.example", "0.8.7")).rejects.toMatchObject({
      code: "REMOTE_HEALTH_TOO_LARGE"
    });
  });
});
