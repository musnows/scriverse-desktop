import type { WebContents } from "electron";

const MAX_RENDERER_LOG_MESSAGE_LENGTH = 20_000;

export function rendererConsoleLogLine(label: string, input: {
  level: "info" | "warning" | "error" | "debug";
  message: string;
  lineNumber: number;
  sourceId: string;
}): string | null {
  if (input.level !== "warning" && input.level !== "error") return null;
  const message = input.message.length <= MAX_RENDERER_LOG_MESSAGE_LENGTH
    ? input.message
    : `${input.message.slice(0, MAX_RENDERER_LOG_MESSAGE_LENGTH)} [truncated]`;
  const source = input.sourceId === "" ? "unknown" : input.sourceId;
  return `[renderer:${label}:${input.level}] ${message} (${source}:${input.lineNumber})\n`;
}

export function captureRendererConsole(webContents: WebContents, label: string): void {
  webContents.on("console-message", (details) => {
    const line = rendererConsoleLogLine(label, details);
    if (line) process.stderr.write(line);
  });
}
