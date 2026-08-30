import { describe, expect, it } from "vitest";
import { mergeDesktopLocalAiModels } from "../../runtime-overlay/public/desktop-local-ai-catalog.js";
import { modelOptionLabel } from "../../src/renderer/local-ai/model-config.js";

describe("Desktop 本地 AI 目录隔离", () => {
  it("本地和云端工作区都追加本地模型并固定 local 供应商前缀", () => {
    const localModel = { id: "local-model", scope: "local", providerName: "LM-Studio", displayName: "Qwen" };
    expect(mergeDesktopLocalAiModels([], [localModel])).toEqual([
      { ...localModel, providerName: "local/LM-Studio" }
    ]);
    const merged = mergeDesktopLocalAiModels(
      [{ id: "server-model", scope: "platform", providerName: "LM-Studio", displayName: "Cloud Qwen" }],
      [{ ...localModel, providerName: "local/LM-Studio" }]
    );
    expect(merged).toEqual([
      { id: "server-model", scope: "platform", providerName: "LM-Studio", displayName: "Cloud Qwen" },
      { ...localModel, providerName: "local/LM-Studio" }
    ]);
    expect(merged.map(modelOptionLabel)).toEqual([
      "LM-Studio · Cloud Qwen",
      "local/LM-Studio · Qwen"
    ]);
  });

  it("不修改 Server 模型目录且不允许本地模型覆盖同 id 的云端模型", () => {
    const serverModels = [{ id: "shared-model", scope: "platform", providerName: "Cloud", displayName: "Cloud Model" }];
    const localModels = [{ id: "shared-model", scope: "local", providerName: "Local", displayName: "Local Model" }];
    const result = mergeDesktopLocalAiModels(serverModels, localModels);
    expect(result).toEqual(serverModels);
    expect(result).not.toBe(serverModels);
    expect(serverModels).toEqual([{ id: "shared-model", scope: "platform", providerName: "Cloud", displayName: "Cloud Model" }]);
  });

  it("保留专用模型配置但不把 embedding 与 rerank 放入生成选择器", () => {
    const localModels = [
      { id: "chat", scope: "local", modelKind: "chat", providerName: "Local", displayName: "Chat" },
      { id: "embedding", scope: "local", modelKind: "embedding", providerName: "Local", displayName: "Embedding" },
      { id: "rerank", scope: "local", modelKind: "rerank", providerName: "Local", displayName: "Rerank" }
    ];
    expect(mergeDesktopLocalAiModels([], localModels).map((model) => model.id)).toEqual(["chat"]);
  });
});
