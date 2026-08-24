import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_AI_MAX_RESPONSE_BYTES,
  LocalAiClient,
  localAiChatCompletionsUrl
} from "../../src/main/local-ai-client.js";
import type { LocalAiModelCredential } from "../../src/main/local-ai-provider-store.js";

const credential: LocalAiModelCredential = {
  provider: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "local/本机 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "openai-chat-completions",
    maxTokensParameter: "max_tokens",
    thinkingType: "enabled",
    concurrencyLimit: 10,
    rpmLimit: 10,
    analysisTimeoutSeconds: 45,
    note: "",
    status: "enabled",
    connectionStatus: "success",
    scope: "local",
    hasApiKey: true,
    apiKey: "local-secret",
    lastError: null,
    lastSuccessAt: "2026-08-23T00:00:00.000Z",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z"
  },
  model: {
    id: "22222222-2222-4222-8222-222222222222",
    providerId: "11111111-1111-4111-8111-111111111111",
    displayName: "Qwen 3 8B",
    modelId: "qwen3:8b",
    purposes: ["chat", "continue"],
    contextNote: "",
    contextWindow: 128_000,
    outputNote: "",
    preset: { temperature: 0.7, max_tokens: 2048 },
    thinkingEnabled: true,
    thinkingEffort: "default",
    multimodalEnabled: false,
    imageToolDefault: false,
    enabled: true,
    note: "",
    scope: "local",
    providerName: "local/本机 Ollama",
    providerStatus: "enabled",
    providerConnectionStatus: "success",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z"
  },
  systemPrompt: "本地规则 <只在本机>"
};

const input = {
  modelId: credential.model.id,
  remoteSystemPrompt: "远端规则",
  messages: [{ role: "user" as const, content: "继续这一段" }]
};

function streamResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      frames.forEach((frame) => controller.enqueue(encoder.encode(frame)));
      controller.close();
    }
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("Desktop 本地 AI 调用", () => {
  it("只向已保存的内网端点发送请求并在远端 Prompt 后追加本地 XML", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "本机生成结果" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = new LocalAiClient(fetchImpl);
    await expect(client.complete(credential, input)).resolves.toEqual({
      modelId: credential.model.id,
      model: credential.model.modelId,
      content: "本机生成结果",
      scope: "local"
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:11434/v1/chat/completions", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({ Accept: "text/event-stream", Authorization: "Bearer local-secret" })
    }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen3:8b",
      messages: [
        { role: "system", content: "远端规则\n\n<desktop_local_ai_prompt>\n本地规则 &lt;只在本机&gt;\n</desktop_local_ai_prompt>" },
        ...input.messages
      ],
      thinking: { type: "enabled" },
      stream: true,
      stream_options: { include_usage: true }
    });
  });

  it("逐块转发供应商流并汇总为标准完成响应", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      'data: {"id":"chatcmpl-1","model":"qwen3:8b","choices":[{"index":0,"delta":{"role":"assistant","content":"第一段"}}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"qwen3:8b","choices":[{"index":0,"delta":{"content":"，第二段"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"chatcmpl-1","model":"qwen3:8b","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n',
      "data: [DONE]\n\n"
    ]));
    const onEvent = vi.fn();
    await expect(new LocalAiClient(fetchImpl).complete(credential, input, undefined, onEvent)).resolves.toMatchObject({
      content: "第一段，第二段"
    });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "content-delta", delta: "第一段" },
      { type: "content-delta", delta: "，第二段" }
    ]);
  });

  it("在供应商流结束前立即交付已收到的内容", async () => {
    const encoder = new TextEncoder();
    let release: () => void = () => undefined;
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"先显示"}}]}\n\n'));
        release = () => {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"，再完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        };
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const onEvent = vi.fn();
    let settled = false;
    const completion = new LocalAiClient(fetchImpl).complete(credential, input, undefined, onEvent)
      .finally(() => { settled = true; });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: "content-delta", delta: "先显示" }));
    expect(settled).toBe(false);
    release();
    await expect(completion).resolves.toMatchObject({ content: "先显示，再完成" });
  });

  it("允许 Desktop 在用户停止生成时取消本地 HTTP 请求", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const completion = new LocalAiClient(fetchImpl).complete(credential, input, controller.signal);
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: "LOCAL_AI_CANCELLED" });
  });

  it("长分析使用供应商超时且普通请求保留交互超时", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "完成" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = new LocalAiClient(fetchImpl);

    await client.complete(credential, { ...input, taskType: "book-analysis" });
    expect(timeout).toHaveBeenLastCalledWith(45_000);
    await client.complete(credential, { ...input, taskType: "chat" });
    expect(timeout).toHaveBeenLastCalledWith(180_000);
    timeout.mockRestore();
  });

  it("拒绝超大响应并把连接失败转换为安全错误", async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-length": String(LOCAL_AI_MAX_RESPONSE_BYTES + 1) }
    }));
    await expect(new LocalAiClient(oversized).complete(credential, input)).rejects.toMatchObject({
      code: "LOCAL_AI_RESPONSE_TOO_LARGE"
    });
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connect ECONNREFUSED 127.0.0.1"));
    await expect(new LocalAiClient(failed).complete(credential, input)).rejects.toMatchObject({
      code: "LOCAL_AI_NETWORK_ERROR",
      message: "无法连接 AI 供应商 Base URL"
    });
  });

  it("只在固定路径下派生 chat completions 端点", () => {
    expect(localAiChatCompletionsUrl("http://192.168.1.20:12345")).toBe("http://192.168.1.20:12345/chat/completions");
    expect(localAiChatCompletionsUrl("http://192.168.1.20:12345/v1/chat/completions")).toBe("http://192.168.1.20:12345/v1/chat/completions");
  });
});
