export const MAX_CLIPBOARD_TEXT_LENGTH = 1_000_000;

export function parseClipboardText(input: unknown): string {
  if (typeof input !== "string" || input.length > MAX_CLIPBOARD_TEXT_LENGTH) {
    const error = new Error("剪贴板内容无效") as Error & { code: string };
    error.code = "CLIPBOARD_TEXT_INVALID";
    throw error;
  }
  return input;
}
