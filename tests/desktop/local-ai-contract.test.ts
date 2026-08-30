import { describe, expect, it } from "vitest";
import {
  localAiProviderDisplayName,
  localAiProviderStoredName,
  localAiPromptXml,
  mergeRemoteAndLocalAiPrompt,
  normalizeLocalAiBaseUrl,
  parseCreateLocalAiModelInput,
  parseCreateLocalAiProviderInput,
  parseLocalAiCompletionInput,
  parseLocalAiCompletionRequestInput
} from "../../src/shared/local-ai-contract.js";

describe("Desktop 本地 AI 输入契约", () => {
  it("明确允许回环和局域网 Base URL", () => {
    expect(normalizeLocalAiBaseUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeLocalAiBaseUrl("http://192.168.1.20:12345/v1")).toBe("http://192.168.1.20:12345/v1");
    expect(normalizeLocalAiBaseUrl("http://[::1]:11434/v1")).toBe("http://[::1]:11434/v1");
  });

  it("仍拒绝非 HTTP(S)、内嵌凭据、query、hash 和未知字段", () => {
    for (const baseUrl of [
      "file:///tmp/model",
      "ftp://127.0.0.1/model",
      "http://user:pass@127.0.0.1:11434/v1",
      "http://127.0.0.1:11434/v1?token=secret",
      "http://127.0.0.1:11434/v1#fragment"
    ]) expect(() => normalizeLocalAiBaseUrl(baseUrl)).toThrow();
    expect(() => parseCreateLocalAiProviderInput({
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      origin: "remote"
    })).toThrowError(/未知/u);
  });

  it("供应商分析超时默认 300 秒并限制在 30–3600 秒", () => {
    const base = {
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: ""
    };
    expect(parseCreateLocalAiProviderInput(base).analysisTimeoutSeconds).toBe(300);
    expect(() => parseCreateLocalAiProviderInput({ ...base, analysisTimeoutSeconds: 29 })).toThrowError(/分析请求超时/u);
    expect(parseCreateLocalAiProviderInput({ ...base, analysisTimeoutSeconds: 3_600 }).analysisTimeoutSeconds).toBe(3_600);
  });

  it("接受 Server 的全部供应商协议并校验 Google Vertex 凭据与官方地址", () => {
    for (const protocol of ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const) {
      expect(parseCreateLocalAiProviderInput({
        name: protocol,
        baseUrl: "http://127.0.0.1:12345/v1",
        apiKey: "",
        protocol
      }).protocol).toBe(protocol);
    }
    const serviceAccount = JSON.stringify({
      type: "service_account",
      client_email: "desktop@example.iam.gserviceaccount.com",
      private_key: "test-private-key",
      project_id: "desktop"
    });
    expect(parseCreateLocalAiProviderInput({
      name: "Vertex",
      baseUrl: "https://aiplatform.googleapis.com/v1/projects/desktop/locations/global/endpoints/openapi",
      apiKey: serviceAccount,
      protocol: "google-vertex"
    }).protocol).toBe("google-vertex");
    expect(() => parseCreateLocalAiProviderInput({
      name: "Vertex",
      baseUrl: "https://vertex-proxy.example/v1",
      apiKey: serviceAccount,
      protocol: "google-vertex"
    })).toThrowError(/官方区域/u);
    expect(() => parseCreateLocalAiProviderInput({
      name: "Vertex",
      baseUrl: "https://aiplatform.googleapis.com/v1/projects/desktop/locations/global/endpoints/openapi",
      apiKey: "{}",
      protocol: "google-vertex"
    })).toThrowError(/service_account/u);
  });

  it("区分 chat、embedding 与 rerank 模型并清除专用模型聊天能力", () => {
    const base = {
      providerId: "11111111-1111-4111-8111-111111111111",
      displayName: "向量模型",
      modelId: "embedding-local",
      modelKind: "embedding",
      purposes: ["chat"],
      contextNote: "",
      contextWindow: 128_000,
      outputNote: "",
      preset: { temperature: 0.7, max_tokens: 2048 },
      thinkingEnabled: false,
      thinkingEffort: "default",
      multimodalEnabled: false,
      imageToolDefault: false,
      enabled: true,
      note: ""
    };
    expect(parseCreateLocalAiModelInput(base)).toMatchObject({ modelKind: "embedding", purposes: [], multimodalEnabled: false });
    expect(parseCreateLocalAiModelInput({ ...base, modelKind: "rerank" })).toMatchObject({ modelKind: "rerank", purposes: [] });
    expect(() => parseCreateLocalAiModelInput({ ...base, multimodalEnabled: true })).toThrowError(/不能启用聊天或多模态/u);
  });

  it("固定使用 local 前缀展示供应商且保存时不会重复前缀", () => {
    expect(localAiProviderStoredName("local/LM-Studio")).toBe("LM-Studio");
    expect(localAiProviderDisplayName("LM-Studio")).toBe("local/LM-Studio");
    expect(localAiProviderDisplayName("LOCAL/LM-Studio")).toBe("local/LM-Studio");
    expect(parseCreateLocalAiProviderInput({
      name: "local/LM-Studio",
      baseUrl: "http://127.0.0.1:12345/v1",
      apiKey: ""
    }).name).toBe("LM-Studio");
    expect(() => parseCreateLocalAiProviderInput({
      name: "local/",
      baseUrl: "http://127.0.0.1:12345/v1",
      apiKey: ""
    })).toThrowError(/不能只包含 local 前缀/u);
  });

  it("Desktop 本地 AI 请求只能引用已保存的 model id", () => {
    const input = parseLocalAiCompletionInput({
      modelId: "11111111-1111-4111-8111-111111111111",
      taskType: "book-analysis",
      remoteSystemPrompt: "远端规则",
      messages: [{ role: "user", content: "继续这一段" }]
    });
    expect(input).toMatchObject({ taskType: "book-analysis", remoteSystemPrompt: "远端规则" });
    expect(() => parseLocalAiCompletionInput({
      ...input,
      baseUrl: "http://127.0.0.1:11434/v1"
    })).toThrowError(/未知/u);
    expect(() => parseLocalAiCompletionInput({ ...input, taskType: "unsupported" })).toThrowError(/任务类型/u);
    expect(parseLocalAiCompletionRequestInput({
      requestId: "22222222-2222-4222-8222-222222222222",
      ...input
    })).toMatchObject({ requestId: "22222222-2222-4222-8222-222222222222" });
  });

  it("把本地 Prompt 作为 XML 追加在远端 Prompt 后并转义内容", () => {
    expect(localAiPromptXml("本地 <规则> & 约束")).toBe(
      "<desktop_local_ai_prompt>\n本地 &lt;规则&gt; &amp; 约束\n</desktop_local_ai_prompt>"
    );
    expect(mergeRemoteAndLocalAiPrompt("远端 Prompt", "本地 Prompt")).toBe(
      "远端 Prompt\n\n<desktop_local_ai_prompt>\n本地 Prompt\n</desktop_local_ai_prompt>"
    );
    expect(mergeRemoteAndLocalAiPrompt("", "本地 Prompt")).toBe(
      "<desktop_local_ai_prompt>\n本地 Prompt\n</desktop_local_ai_prompt>"
    );
  });
});
