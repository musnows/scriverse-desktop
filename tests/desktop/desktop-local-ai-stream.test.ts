import { describe, expect, it } from "vitest";
import { desktopProviderCompletedToolCalls } from "../../runtime-overlay/public/desktop-local-ai-stream.js";

describe("Desktop provider stream progress", () => {
  it("emits completed tool calls before the next provider round and deduplicates them", () => {
    const emittedIds = new Set<string>();
    const body = {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-self", function: { name: "recall_self", arguments: "{\"characterId\":\"character-1\"}" } },
            { id: "call-story", function: { name: "recall_story", arguments: "{\"query\":\"盟友\"}" } }
          ]
        },
        { role: "tool", tool_call_id: "call-self", content: "{\"ok\":true,\"data\":{\"memories\":[]}}" },
        { role: "tool", tool_call_id: "call-story", content: "{\"ok\":false,\"error\":{\"code\":\"NOT_FOUND\"}}" }
      ]
    };

    expect(desktopProviderCompletedToolCalls(body, emittedIds, "2026-08-25T00:00:00.000Z")).toEqual([
      {
        id: "call-self",
        name: "recall_self",
        arguments: { characterId: "character-1" },
        calledAt: "2026-08-25T00:00:00.000Z",
        status: "completed",
        result: { ok: true, data: { memories: [] } }
      },
      {
        id: "call-story",
        name: "recall_story",
        arguments: { query: "盟友" },
        calledAt: "2026-08-25T00:00:00.000Z",
        status: "failed",
        result: { ok: false, error: { code: "NOT_FOUND" } }
      }
    ]);
    expect(desktopProviderCompletedToolCalls(body, emittedIds)).toEqual([]);
  });

  it("waits for a matching tool result and preserves non-JSON payloads", () => {
    const emittedIds = new Set<string>();
    const pendingBody = {
      messages: [{ role: "assistant", tool_calls: [{ id: "call-1", function: { name: "grep", arguments: "invalid" } }] }]
    };
    expect(desktopProviderCompletedToolCalls(pendingBody, emittedIds)).toEqual([]);

    const completedBody = {
      messages: [
        ...pendingBody.messages,
        { role: "tool", tool_call_id: "call-1", content: "plain result" }
      ]
    };
    expect(desktopProviderCompletedToolCalls(completedBody, emittedIds, "2026-08-25T00:00:00.000Z")).toEqual([
      expect.objectContaining({
        id: "call-1",
        name: "grep",
        arguments: { value: "invalid" },
        status: "completed",
        result: { output: "plain result" }
      })
    ]);
  });
});
