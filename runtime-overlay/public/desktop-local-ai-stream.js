function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function jsonRecord(value, fallbackKey) {
  if (typeof value !== "string") return record(value) ?? {};
  try {
    const parsed = JSON.parse(value);
    return record(parsed) ?? { [fallbackKey]: parsed };
  } catch {
    return { [fallbackKey]: value };
  }
}

export function desktopProviderCompletedToolCalls(body, emittedIds = new Set(), calledAt = new Date().toISOString()) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const requestedCalls = new Map();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const value of message.tool_calls) {
      const toolCall = record(value);
      const id = typeof toolCall?.id === "string" ? toolCall.id : "";
      const fn = record(toolCall?.function);
      const name = typeof fn?.name === "string" ? fn.name : "";
      if (!id || !name) continue;
      requestedCalls.set(id, {
        id,
        name,
        arguments: jsonRecord(fn.arguments ?? {}, "value")
      });
    }
  }

  const completed = [];
  for (const message of messages) {
    if (message?.role !== "tool") continue;
    const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
    const requested = requestedCalls.get(id);
    if (!requested || emittedIds.has(id)) continue;
    const result = jsonRecord(message.content ?? {}, "output");
    emittedIds.add(id);
    completed.push({
      ...requested,
      calledAt,
      status: result.ok === false ? "failed" : "completed",
      result
    });
  }
  return completed;
}
