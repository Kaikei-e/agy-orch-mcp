import { createHash } from "node:crypto";
import type { FailureClass } from "../domain/failure.js";

export interface FingerprintComponents {
  failureClass: FailureClass;
  errorCode?: string;
  failingTests?: string[];
  outputExcerpt?: string;
}

/**
 * Strips line numbers, colons, absolute path prefixes, and memory addresses
 * from stack traces or error messages to yield stable fingerprints across runs.
 */
export function normalizeStackTrace(raw: string): string {
  if (!raw) return "";
  return (
    raw
      // Normalize Windows backslashes
      .replace(/\\/g, "/")
      // Strip absolute paths up to common patterns like node_modules or src
      .replace(
        /(?:\/[a-zA-Z0-9_.-]+)+\/(src|test|lib|dist|node_modules)\//g,
        "$1/",
      )
      // Strip line and column numbers (:123:45 or (file.js:12:34))
      .replace(/:\d+(?::\d+)?/g, "")
      // Strip hex pointers / memory addresses
      .replace(/0x[0-9a-fA-F]+/g, "0xADDR")
      // Trim extra spaces
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function computeFailureFingerprint(
  components: FingerprintComponents,
): string {
  const normClass = components.failureClass;
  const normCode = components.errorCode ? components.errorCode.trim() : "";
  const normTests = (components.failingTests ?? [])
    .map((t) => t.trim())
    .sort()
    .join(",");
  const normExcerpt = normalizeStackTrace(components.outputExcerpt ?? "");

  const payload = `${normClass}|${normCode}|${normTests}|${normExcerpt}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
