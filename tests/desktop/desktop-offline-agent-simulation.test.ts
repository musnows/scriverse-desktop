import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { LocalAiClient } from "../../src/main/local-ai-client.js";
import type { LocalAiModelCredential } from "../../src/main/local-ai-provider-store.js";
import type { LocalAiAgentRoundResult, LocalAiStreamEvent } from "../../src/shared/local-ai-contract.js";
import {
  buildDesktopOfflineAgentCorpus,
  desktopOfflineChatToolDefinitions,
  desktopOfflineUserTurn,
  runDesktopOfflineAgentLoop
} from "../../runtime-overlay/public/desktop-local-ai-offline.js";

const MODEL_UUID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_UUID = "11111111-1111-4111-8111-111111111111";
const SIM_MODEL_ID = "qwen-sim";
const SECOND_CHAPTER_ID = "chapter-2";
const SECOND_CHAPTER_TITLE = "回声";

type LoopBody = {
  model?: string;
  stream?: boolean;
  tools?: Array<{ function?: { name?: string } }>;
  messages?: Array<{ role?: string; content?: string; tool_call_id?: string }>;
};

type ToolCallEvent = {
  type: string;
  delta?: string;
  toolCall?: {
    name?: string;
    status?: string;
    result?: unknown;
  };
};

function credentialFor(baseUrl: string): LocalAiModelCredential {
  return {
    provider: {
      id: PROVIDER_UUID,
      name: "local/模拟供应商",
      baseUrl,
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
      id: MODEL_UUID,
      providerId: PROVIDER_UUID,
      displayName: "Qwen Sim",
      modelId: SIM_MODEL_ID,
      modelKind: "chat",
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
      providerName: "local/模拟供应商",
      providerStatus: "enabled",
      providerConnectionStatus: "success",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z"
    },
    systemPrompt: "本地规则 <只在本机>"
  };
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatChunk(id: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return sse({
    id,
    object: "chat.completion.chunk",
    created: 1_758_000_000,
    model: SIM_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  });
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeSse(response: ServerResponse, frames: string[]): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "close"
  });
  for (const frame of frames) response.write(frame);
  response.end();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("simulation server did not bind an IPv4 port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("offline agent web chat simulation", () => {
  it("streams thinking and a grep tool call through LocalAiClient into the web chat loop", async () => {
    const userTurn = desktopOfflineUserTurn({
      markup: "续写 <ai_reference kind=\"character\" id=\"character-1\">林夏</ai_reference>",
      text: "续写 林夏",
      citations: [{
        chapterId: SECOND_CHAPTER_ID,
        chapterTitle: SECOND_CHAPTER_TITLE,
        startLine: 1,
        endLine: 1,
        text: "海面上没有林夏。"
      }],
      scope: { characterIds: ["character-1"] }
    });
    expect(userTurn.content).toContain("<ai_reference");
    expect(userTurn.content).not.toBe("续写 林夏");
    expect(userTurn.citations).toEqual([{
      chapterId: SECOND_CHAPTER_ID,
      chapterTitle: SECOND_CHAPTER_TITLE,
      startLine: 1,
      endLine: 1,
      text: "海面上没有林夏。"
    }]);
    expect(userTurn.metadata.mentionCharacterIds).toEqual(["character-1"]);

    const corpus = buildDesktopOfflineAgentCorpus({
      work: { workId: "work-sim", summary: { id: "work-sim", title: "长夜", description: "一部小说" } },
      entities: [
        { entityType: "volume", snapshot: { id: "volume-1", title: "第一卷", sortOrder: 1 } },
        { entityType: "chapter", snapshot: { id: "chapter-1", volumeId: "volume-1", title: "启程", chapterType: "正文", sortOrder: 1, content: "天色将明。" } },
        { entityType: "chapter", snapshot: { id: SECOND_CHAPTER_ID, volumeId: "volume-1", title: SECOND_CHAPTER_TITLE, chapterType: "正文", sortOrder: 2, content: "海面上没有林夏。" } }
      ]
    });
    const httpBodies: LoopBody[] = [];
    const server = createServer(async (request, response) => {
      const raw = await readRequestBody(request);
      const body = JSON.parse(raw) as LoopBody;
      httpBodies.push(body);
      if (httpBodies.length === 1) {
        writeSse(response, [
          chatChunk("chatcmpl-sim-1", { role: "assistant", reasoning_content: "先检索" }, null),
          chatChunk("chatcmpl-sim-1", { reasoning_content: "正文。" }, null),
          chatChunk("chatcmpl-sim-1", {
            tool_calls: [{
              index: 0,
              id: "call-grep-1",
              type: "function",
              function: { name: "grep", arguments: "" }
            }]
          }, null),
          chatChunk("chatcmpl-sim-1", {
            tool_calls: [{
              index: 0,
              function: { arguments: "{\"keyword\":\"林夏\"}" }
            }]
          }, "tool_calls"),
          "data: [DONE]\n\n"
        ]);
        return;
      }
      writeSse(response, [
        chatChunk("chatcmpl-sim-2", { role: "assistant", content: "章节标题是" }, null),
        chatChunk("chatcmpl-sim-2", { content: "回声" }, "stop"),
        "data: [DONE]\n\n"
      ]);
    });

    try {
      const port = await listen(server);
      const credential = credentialFor(`http://127.0.0.1:${port}/v1`);
      const client = new LocalAiClient();
      const loopBodies: LoopBody[] = [];
      const events: ToolCallEvent[] = [];
      const result = await runDesktopOfflineAgentLoop({
        protocol: "openai-chat-completions",
        modelId: SIM_MODEL_ID,
        tools: desktopOfflineChatToolDefinitions(corpus),
        corpus,
        now: () => "2026-09-29T00:00:00.000Z",
        messages: [{ role: "user", content: userTurn.modelContent }],
        onEvent: (event: ToolCallEvent) => events.push(event),
        completeRound: async (body: LoopBody, onEvent: (event: LocalAiStreamEvent) => void): Promise<LocalAiAgentRoundResult> => {
          loopBodies.push(structuredClone(body));
          return client.completeAgentRound(credential, {
            requestId: `desktop-offline-sim-${loopBodies.length}`,
            modelId: credential.model.id,
            taskType: "chat",
            purpose: "generation",
            body: body as Record<string, unknown>,
            timeoutMs: 30_000
          }, undefined, onEvent);
        }
      });

      expect(loopBodies[0]?.stream).not.toBe(true);
      expect(loopBodies[0]?.tools?.map((tool) => tool.function?.name)).toContain("grep");
      expect(httpBodies[0]?.stream).toBe(true);
      expect(httpBodies[0]?.model).toBe(SIM_MODEL_ID);
      expect(httpBodies[0]?.tools?.map((tool) => tool.function?.name)).toContain("grep");

      const toolMessage = httpBodies[1]?.messages?.find((message) => message.role === "tool");
      expect(toolMessage?.content ?? "").toContain(SECOND_CHAPTER_ID);
      expect(toolMessage?.content ?? "").toContain(SECOND_CHAPTER_TITLE);
      expect(loopBodies[1]?.stream).not.toBe(true);

      expect(events.some((event) => event.type === "reasoning-delta" && (event.delta ?? "").length > 0)).toBe(true);
      const toolEvent = events.find((event) => event.type === "tool-call");
      expect(toolEvent?.toolCall?.name).toBe("grep");
      expect(toolEvent?.toolCall?.status).toBe("completed");
      expect(JSON.stringify(toolEvent?.toolCall?.result ?? {})).toContain(SECOND_CHAPTER_ID);
      expect(JSON.stringify(toolEvent?.toolCall?.result ?? {})).toContain(SECOND_CHAPTER_TITLE);
      expect(result.content).toContain("回声");
      expect(result.processSteps.map((step: { type: string }) => step.type)).toEqual(expect.arrayContaining(["thinking", "tool"]));
    } finally {
      await closeServer(server);
    }
  });
});
