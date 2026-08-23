import { extname } from "node:path";

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const MAX_FILENAME_LENGTH = 180;

export function sanitizeDownloadFilename(input: string): string {
  const leaf = input.replaceAll("\\", "/").split("/").at(-1) ?? "";
  let sanitized = leaf
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/u, "")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === ".." || WINDOWS_DEVICE_NAME.test(sanitized)) {
    sanitized = "scriverse-download";
  }
  if (sanitized.length <= MAX_FILENAME_LENGTH) return sanitized;
  const extension = extname(sanitized).slice(0, 20);
  return `${sanitized.slice(0, MAX_FILENAME_LENGTH - extension.length)}${extension}`;
}
