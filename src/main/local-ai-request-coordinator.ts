import {
  parseLocalAiAgentRoundInput,
  parseLocalAiAgentRoundRequestId,
  parseLocalAiCompletionRequestInput,
  parseLocalAiRequestId,
  type LocalAiAgentRoundInput,
  type LocalAiAgentRoundResult,
  type LocalAiCompletionRequestInput,
  type LocalAiCompletionResult,
  type LocalAiWorkspaceCatalog
} from "../shared/local-ai-contract.js";
import { LocalAiClient } from "./local-ai-client.js";
import { LocalAiProviderStore } from "./local-ai-provider-store.js";

export class LocalAiRequestCoordinatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalAiRequestCoordinatorError";
  }
}

export class LocalAiRequestCoordinator {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly store: LocalAiProviderStore,
    private readonly client: LocalAiClient
  ) {}

  catalog(): LocalAiWorkspaceCatalog {
    return this.store.workspaceCatalog();
  }

  async complete(value: LocalAiCompletionRequestInput): Promise<LocalAiCompletionResult> {
    const input = parseLocalAiCompletionRequestInput(value);
    if (this.active.has(input.requestId)) {
      throw new LocalAiRequestCoordinatorError("LOCAL_AI_REQUEST_IN_PROGRESS", "相同本地 AI 请求正在处理中");
    }
    const controller = new AbortController();
    this.active.set(input.requestId, controller);
    try {
      const credential = this.store.credential(input.modelId);
      const { requestId: _requestId, ...completion } = input;
      return await this.client.complete(credential, completion, controller.signal);
    } finally {
      this.active.delete(input.requestId);
    }
  }

  async completeAgentRound(value: LocalAiAgentRoundInput): Promise<LocalAiAgentRoundResult> {
    const input = parseLocalAiAgentRoundInput(value);
    if (this.active.has(input.requestId)) {
      throw new LocalAiRequestCoordinatorError("LOCAL_AI_REQUEST_IN_PROGRESS", "相同本地 AI Agent 轮次正在处理中");
    }
    const controller = new AbortController();
    this.active.set(input.requestId, controller);
    try {
      return await this.client.completeAgentRound(this.store.credential(input.modelId), input, controller.signal);
    } finally {
      this.active.delete(input.requestId);
    }
  }

  cancel(requestIdValue: string): boolean {
    const requestId = parseLocalAiRequestId(requestIdValue);
    const controller = this.active.get(requestId);
    if (!controller) return false;
    controller.abort(new Error("Local AI request cancelled"));
    return true;
  }

  cancelAgentRound(requestIdValue: string): boolean {
    const requestId = parseLocalAiAgentRoundRequestId(requestIdValue);
    const controller = this.active.get(requestId);
    if (!controller) return false;
    controller.abort(new Error("Local AI Agent round cancelled"));
    return true;
  }

  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort(new Error("Local AI workspace closed"));
    this.active.clear();
  }
}
