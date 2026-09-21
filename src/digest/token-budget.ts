import { StringDecoder } from "node:string_decoder";

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Conservative unicode estimator:
  // English text is ~4 bytes/token, CJK can be 2-3 bytes/token.
  // Using Buffer.byteLength / 2.5 is very conservative and safe.
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 2.5);
}

export function trimStringToTokenBudget(
  text: string,
  maxTokens: number,
): { text: string; trimmed: boolean } {
  if (!text) return { text, trimmed: false };
  const maxBytes = Math.floor(maxTokens * 2.5);
  const currentBytes = Buffer.byteLength(text, "utf8");
  if (currentBytes <= maxBytes) {
    return { text, trimmed: false };
  }

  // Safe unicode truncation
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - 50));
  let slice = decoder.write(buf);
  slice += "\n...[TRUNCATED]";
  return { text: slice, trimmed: true };
}
