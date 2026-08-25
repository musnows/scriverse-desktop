import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  isRemoteWorkspaceShellUrl,
  registerBundledWorkspaceShell,
  remoteWorkspaceShellUrl,
  resolveWorkspaceShellAsset
} from "../../src/main/workspace-shell-protocol.js";
import { REMOTE_MEDIA_DOWNLOAD_HEADER } from "../../src/main/remote-media-cache.js";
import { remotePartition, type RemoteWorkspaceProfile } from "../../src/shared/contracts.js";

const profileId = "11111111-1111-4111-8111-111111111111";
const profile: RemoteWorkspaceProfile = {
  id: profileId,
  name: "测试 Server",
  kind: "remote",
  origin: "https://server.example",
  partition: remotePartition(profileId),
  createdAt: "2026-08-24T00:00:00.000Z",
  lastUsedAt: null,
  capabilities: null
};

describe("Desktop 远端工作区网页壳协议", () => {
  const shellUrl = remoteWorkspaceShellUrl(profileId);
  const publicRoot = "/app/dist/public";

  it("按 profile 隔离 app origin 并限制静态资源目录", () => {
    expect(shellUrl).toBe(`app://workspace-${profileId}/`);
    expect(isRemoteWorkspaceShellUrl(`${shellUrl}#view=shelf`, profileId)).toBe(true);
    expect(isRemoteWorkspaceShellUrl("app://workspace-22222222-2222-4222-8222-222222222222/", profileId)).toBe(false);
    expect(resolveWorkspaceShellAsset(shellUrl, profileId, publicRoot)).toEqual({
      path: "/app/dist/public/index.html",
      contentType: "text/html; charset=utf-8"
    });
    expect(resolveWorkspaceShellAsset(`${shellUrl}styles.css?v=1`, profileId, publicRoot)).toEqual({
      path: "/app/dist/public/styles.css",
      contentType: "text/css; charset=utf-8"
    });
  });

  it("拒绝 API、其他 profile、路径穿越和非法编码作为静态资源", () => {
    expect(resolveWorkspaceShellAsset(`${shellUrl}api/auth/session`, profileId, publicRoot)).toBeNull();
    expect(resolveWorkspaceShellAsset("app://workspace-22222222-2222-4222-8222-222222222222/app.js", profileId, publicRoot)).toBeNull();
    expect(resolveWorkspaceShellAsset(`${shellUrl}%2e%2e%2fsecret`, profileId, publicRoot)).toBeNull();
    expect(resolveWorkspaceShellAsset(`${shellUrl}%00secret`, profileId, publicRoot)).toBeNull();
    expect(resolveWorkspaceShellAsset(`${shellUrl}%E0%A4%A`, profileId, publicRoot)).toBeNull();
  });

  it("在线 API 只转发到精确 Server origin 并清除浏览器凭据", async () => {
    let handler: ((request: Request) => Response | Promise<Response>) | null = null;
    const fetchImpl = vi.fn(async () => Response.json({ data: { status: "ok" } }));
    const unhandle = vi.fn();
    const electronSession = {
      fetch: fetchImpl,
      protocol: {
        handle: vi.fn((_scheme: string, registered: typeof handler) => { handler = registered; }),
        unhandle
      }
    } as unknown as Session;
    const dispose = registerBundledWorkspaceShell(electronSession, profile, publicRoot, "online");
    expect(handler).not.toBeNull();
    const response = await handler!(new Request(`${shellUrl}api/health`, {
      headers: { Cookie: "browser=forbidden", Origin: shellUrl }
    }));
    expect(await response.json()).toEqual({ data: { status: "ok" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [target, init] = fetchImpl.mock.calls[0];
    expect(target).toBe("https://server.example/api/health");
    expect(new Headers(init?.headers).get("Cookie")).toBeNull();
    expect(new Headers(init?.headers).get("Origin")).toBe("https://server.example");
    expect(init).toMatchObject({ method: "GET", redirect: "manual", bypassCustomProtocolHandlers: true });
    dispose();
    expect(unhandle).toHaveBeenCalledWith("app");
  });

  it("离线模式不向 Server 转发 API", async () => {
    let handler: ((request: Request) => Response | Promise<Response>) | null = null;
    const fetchImpl = vi.fn();
    const electronSession = {
      fetch: fetchImpl,
      protocol: {
        handle: vi.fn((_scheme: string, registered: typeof handler) => { handler = registered; }),
        unhandle: vi.fn()
      }
    } as unknown as Session;
    registerBundledWorkspaceShell(electronSession, profile, publicRoot, "offline");
    const response = await handler!(new Request(`${shellUrl}api/health`));
    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("仅在确认后缓存作品图片，封面和当前登录用户头像自动缓存", async () => {
    let handler: ((request: Request) => Response | Promise<Response>) | null = null;
    const cachedResponse = vi.fn(async () => null);
    const cachePath = vi.fn(async () => ({ response: new Response("cached", { status: 200 }), downloaded: true }));
    const mediaCache = { cachedResponse, cachePath };
    const electronSession = {
      fetch: vi.fn(),
      protocol: {
        handle: vi.fn((_scheme: string, registered: typeof handler) => { handler = registered; }),
        unhandle: vi.fn()
      }
    } as unknown as Session;
    registerBundledWorkspaceShell(electronSession, profile, publicRoot, "online", mediaCache as never, "22222222-2222-4222-8222-222222222222");

    await handler!(new Request(`${shellUrl}api/works/work_1/cover?v=1`));
    await handler!(new Request(`${shellUrl}api/user-avatars/22222222-2222-4222-8222-222222222222?v=1`));
    await handler!(new Request(`${shellUrl}api/attachments/attachment_1/content`, {
      headers: { [REMOTE_MEDIA_DOWNLOAD_HEADER]: "1" }
    }));

    expect(cachePath).toHaveBeenCalledTimes(3);
    expect(cachePath).toHaveBeenNthCalledWith(1, electronSession, profile, "22222222-2222-4222-8222-222222222222", "/api/works/work_1/cover?v=1");
    expect(cachePath).toHaveBeenNthCalledWith(2, electronSession, profile, "22222222-2222-4222-8222-222222222222", "/api/user-avatars/22222222-2222-4222-8222-222222222222?v=1");
    expect(cachePath).toHaveBeenNthCalledWith(3, electronSession, profile, "22222222-2222-4222-8222-222222222222", "/api/attachments/attachment_1/content");
  });
});
