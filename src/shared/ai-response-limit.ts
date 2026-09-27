export const AI_RESPONSE_MAX_BYTES_ENV = "SCRIVERSE_AI_RESPONSE_MAX_BYTES";

export function resolveAiResponseMaxBytes(environment: NodeJS.ProcessEnv = process.env): number | null {
  const raw = environment[AI_RESPONSE_MAX_BYTES_ENV]?.trim() ?? "";
  if (!/^\d+$/u.test(raw)) return null;
  const configured = Number(raw);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : null;
}

export function isAiResponseByteLimitExceeded(receivedBytes: number, maximumBytes: number | null): boolean {
  return maximumBytes !== null && receivedBytes > maximumBytes;
}
