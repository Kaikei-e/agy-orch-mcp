import { createHash } from "node:crypto";
import type { FailureClass, FailureDetail } from "../domain/failure.js";
import { computeFailureFingerprint as computeDomainFingerprint } from "../domain/failure.js";
import type { WorkerExecutionResult } from "../domain/execution.js";
import type { GateExecutionResult } from "../gates/gate-runner.js";

export type { FailureClass, FailureDetail };

export interface FailureClassificationInput {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  isTimeout?: boolean;
  isWorkerTimeout?: boolean;
  isGateTimeout?: boolean;
  deniedActions?: unknown[];
  failingTests?: string[];
  explicitFailureClass?: FailureClass;
}

/**
 * Classifies failure into FailureClass taxonomy per Phase 3-5 draft specification.
 */
export function classifyFailure(
  input: FailureClassificationInput,
): FailureClass {
  if (input.explicitFailureClass) {
    return input.explicitFailureClass;
  }

  if (input.isGateTimeout) {
    return "GATE_TIMEOUT";
  }

  if (input.isWorkerTimeout) {
    return "WORKER_TIMEOUT";
  }

  if (input.isTimeout) {
    return "WORKER_TIMEOUT";
  }

  if (input.deniedActions && input.deniedActions.length > 0) {
    return "POLICY_DENIED";
  }

  const combined = [input.error ?? "", input.stderr ?? "", input.stdout ?? ""]
    .join("\n")
    .toLowerCase();

  // Scope violation
  if (
    combined.includes("scope_violation") ||
    combined.includes("scope violation") ||
    combined.includes("outside task.owns") ||
    combined.includes("ownership violation")
  ) {
    return "SCOPE_VIOLATION";
  }

  // Policy denial & security checks
  if (
    combined.includes("permission denied") ||
    combined.includes("eacces") ||
    combined.includes("policy denied") ||
    combined.includes("policy_denied") ||
    combined.includes("dangerous-skip-permissions") ||
    combined.includes("unauthorized command") ||
    combined.includes("unauthorized access") ||
    combined.includes("unauthorized action") ||
    combined.includes("secret detected")
  ) {
    return "POLICY_DENIED";
  }

  // Patch conflict
  if (
    combined.includes("patch_conflict") ||
    combined.includes("patch conflict") ||
    combined.includes("merge conflict") ||
    combined.includes("patch does not apply") ||
    combined.includes("failed to apply patch")
  ) {
    return "PATCH_CONFLICT";
  }

  // Requirement ambiguity
  if (
    combined.includes("requirement_ambiguity") ||
    combined.includes("requirement ambiguity") ||
    combined.includes("ambiguous requirement") ||
    combined.includes("unclear requirement") ||
    combined.includes("needs clarification") ||
    combined.includes("conflicting requirements") ||
    combined.includes("underspecified")
  ) {
    return "REQUIREMENT_AMBIGUITY";
  }

  // Architecture decision
  if (
    combined.includes("architecture_decision") ||
    combined.includes("architecture decision") ||
    combined.includes("architectural decision") ||
    combined.includes("architectural choice") ||
    combined.includes("requires architectural")
  ) {
    return "ARCHITECTURE_DECISION";
  }

  // Rate limit
  if (
    combined.includes("rate limit") ||
    combined.includes("rate_limit") ||
    combined.includes("429") ||
    combined.includes("quota exceeded") ||
    combined.includes("resource_exhausted") ||
    combined.includes("resource has been exhausted") ||
    combined.includes("too many requests")
  ) {
    return "RATE_LIMIT";
  }

  // Transient infra
  if (
    combined.includes("econnreset") ||
    combined.includes("etimedout") ||
    combined.includes("enotfound") ||
    combined.includes("econnrefused") ||
    combined.includes("socket hang up") ||
    combined.includes("502") ||
    combined.includes("503") ||
    combined.includes("504") ||
    combined.includes("bad gateway") ||
    combined.includes("service unavailable") ||
    combined.includes("temporary failure in name resolution") ||
    combined.includes("transient_infra")
  ) {
    return "TRANSIENT_INFRA";
  }

  // Budget exhausted
  if (
    combined.includes("budget_exhausted") ||
    combined.includes("budget exhausted") ||
    combined.includes("worker call limit reached") ||
    combined.includes("max repair attempts")
  ) {
    return "BUDGET_EXHAUSTED";
  }

  // Explicit semantic failure keywords
  if (
    combined.includes("semantic_failure") ||
    combined.includes("semantic failure") ||
    combined.includes("acceptance criteria not met")
  ) {
    return "SEMANTIC_FAILURE";
  }

  // Deterministic test failure: failing test list provided or test failure keywords
  if (input.failingTests && input.failingTests.length > 0) {
    return "DETERMINISTIC_TEST_FAILURE";
  }

  if (
    combined.includes("test failed") ||
    combined.includes("tests failed") ||
    combined.includes("failing test") ||
    combined.includes("assertionerror") ||
    combined.includes("expect(") ||
    combined.includes("assertion failed") ||
    combined.includes("vitest") ||
    combined.includes("jest") ||
    combined.includes("node:test")
  ) {
    return "DETERMINISTIC_TEST_FAILURE";
  }

  // Internal error keywords
  if (
    combined.includes("spawn_error") ||
    combined.includes("internal_error") ||
    combined.includes("empty_response") ||
    combined.includes("invalid_output")
  ) {
    return "INTERNAL_ERROR";
  }

  // Non-zero exit code fallback
  if (
    input.exitCode !== null &&
    input.exitCode !== undefined &&
    input.exitCode !== 0
  ) {
    return "DETERMINISTIC_TEST_FAILURE";
  }

  return "INTERNAL_ERROR";
}

/**
 * Normalizes stack traces or excerpts by stripping volatile details:
 * - Line and column numbers (:123:45, :123)
 * - Hexadecimal memory addresses / pointers (0x7ffe...)
 * - System-dependent absolute path prefixes up to standard root / folders
 * - Repeated whitespace
 */
export function normalizeStackTrace(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/\\/g, "/")
    .replace(
      /(?:[a-zA-Z]:)?(?:\/[a-zA-Z0-9_.-]+)*\/(src|test|lib|dist|node_modules)\//g,
      "$1/",
    )
    .replace(/:\d+(?::\d+)?\b/g, "")
    .replace(/\bline \d+(?:, col(?:umn)? \d+)?\b/gi, "line LINE")
    .replace(/0x[0-9a-fA-F]+/g, "0xADDR")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes file paths (Windows separators, relative dots, etc.)
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return "";
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(
      /^(?:[a-zA-Z]:)?(?:\/[a-zA-Z0-9_.-]+)*\/(src|test|lib|dist)\//,
      "$1/",
    )
    .trim();
}

export interface CoarseFingerprintComponents {
  failureClass: FailureClass;
  failingTests?: string[];
  errorCode?: string;
  outputExcerpt?: string;
  changedPaths?: string[];
}

export interface FineFingerprintComponents {
  failureClass: FailureClass;
  failingTests?: string[];
  errorCode?: string;
  outputExcerpt?: string;
  changedPaths?: string[];
}

/**
 * Computes coarse fingerprint:
 * Normalizes away line numbers, column numbers, volatile paths, hex addresses.
 * Slices and sorts failing test suites/names and normalized error code.
 * Ensures that if a repair attempt shifts line numbers but fails the same tests/root cause,
 * the coarse fingerprint matches!
 */
export function computeCoarseFingerprint(
  components: CoarseFingerprintComponents,
): string {
  const normClass = components.failureClass;
  const normCode = (components.errorCode ?? "").trim();
  const normTests = (components.failingTests ?? [])
    .map((t) => t.trim())
    .sort()
    .join(",");
  const normExcerpt = normalizeStackTrace(components.outputExcerpt ?? "");
  const normPaths = (components.changedPaths ?? [])
    .map(normalizePath)
    .sort()
    .join(",");

  const payload = `coarse|${normClass}|${normCode}|${normTests}|${normExcerpt}|${normPaths}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Computes fine fingerprint:
 * Preserves exact line numbers and excerpt details for fine-grained distinction.
 */
export function computeFineFingerprint(
  components: FineFingerprintComponents,
): string {
  const normClass = components.failureClass;
  const normCode = (components.errorCode ?? "").trim();
  const normTests = (components.failingTests ?? [])
    .map((t) => t.trim())
    .sort()
    .join(",");
  const rawExcerpt = (components.outputExcerpt ?? "").trim();
  const normPaths = (components.changedPaths ?? [])
    .map((p) => p.replace(/\\/g, "/").trim())
    .sort()
    .join(",");

  const payload = `fine|${normClass}|${normCode}|${normTests}|${rawExcerpt}|${normPaths}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export type WorkerFailureInput =
  | WorkerExecutionResult
  | {
      ok?: boolean;
      status?: string;
      exitCode?: number | null;
      error?: string;
      message?: string;
      stdout?: string;
      stderr?: string;
      failure?: string;
      durationMs?: number;
      conversationId?: string;
      usage?: Record<string, unknown>;
      failureClass?: FailureClass;
    };

/**
 * Legacy compatibility: Classifies worker failure into FailureDetail.
 */
export function classifyWorkerFailure(
  result: WorkerFailureInput,
  changedPaths?: string[],
  _owns?: string[],
): FailureDetail {
  const errMsg =
    result.message ??
    ("error" in result && typeof result.error === "string"
      ? result.error
      : undefined);

  const code =
    result.failureClass ??
    classifyFailure({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: errMsg,
    });

  const hostDecisionRequired =
    code === "POLICY_DENIED" ||
    code === "REQUIREMENT_AMBIGUITY" ||
    code === "ARCHITECTURE_DECISION" ||
    code === "SCOPE_VIOLATION" ||
    code === "PATCH_CONFLICT";

  return {
    code,
    message: errMsg ?? result.stderr ?? "Worker execution failed",
    hostDecisionRequired,
    fingerprint: computeCoarseFingerprint({
      failureClass: code,
      changedPaths,
      outputExcerpt: result.stderr || result.stdout,
    }),
  };
}

/**
 * Legacy compatibility: Classifies gate execution failure into FailureDetail.
 */
export function classifyGateFailure(
  result: GateExecutionResult,
  failingTests: string[],
): FailureDetail {
  let code: FailureClass;
  let hostDecisionRequired = false;

  if (result.failure === "GATE_TIMEOUT") {
    code = "GATE_TIMEOUT";
  } else if (result.failure === "POLICY_DENIED") {
    code = "POLICY_DENIED";
    hostDecisionRequired = true;
  } else if (
    result.failure === "SPAWN_ERROR" ||
    result.failure === "INTERNAL_ERROR"
  ) {
    code = "INTERNAL_ERROR";
  } else if (result.failure === "OUTPUT_LIMIT") {
    code = "INTERNAL_ERROR";
  } else if (failingTests.length > 0) {
    code = "DETERMINISTIC_TEST_FAILURE";
  } else if (result.exitCode !== 0) {
    code = "SEMANTIC_FAILURE";
  } else {
    code = "INTERNAL_ERROR";
  }

  return {
    code,
    message: result.error ?? `Gate failed with exit code ${result.exitCode}`,
    hostDecisionRequired,
    fingerprint: computeDomainFingerprint({
      failureClass: code,
      failingTests,
    }),
  };
}

/**
 * Legacy compatibility: Determines retry/escalation action for a failure.
 */
export type FailureAction =
  | { type: "retry_same_tier" }
  | { type: "escalate_to_reasoning" }
  | { type: "needs_host" }
  | { type: "stop" };

export function determineFailureAction(
  failure: FailureDetail,
  currentTier: "fast" | "reasoning",
  canEscalate: boolean,
  hasRetryBudget: boolean,
  hasRepairBudget: boolean,
  escalateWhen?: FailureClass[],
  previousFingerprint?: string,
): FailureAction {
  if (escalateWhen && escalateWhen.includes(failure.code)) {
    if (canEscalate && currentTier === "fast") {
      return { type: "escalate_to_reasoning" };
    }
    return { type: "needs_host" };
  }

  switch (failure.code) {
    case "TRANSIENT_INFRA":
    case "RATE_LIMIT":
      if (hasRetryBudget) return { type: "retry_same_tier" };
      return { type: "stop" };

    case "WORKER_TIMEOUT":
      if (hasRetryBudget) return { type: "retry_same_tier" };
      return { type: "needs_host" };

    case "GATE_TIMEOUT":
      return { type: "needs_host" };

    case "DETERMINISTIC_TEST_FAILURE":
      if (
        previousFingerprint &&
        previousFingerprint === failure.fingerprint &&
        canEscalate &&
        currentTier === "fast"
      ) {
        return { type: "escalate_to_reasoning" };
      }
      if (hasRepairBudget) return { type: "retry_same_tier" };
      return { type: "needs_host" };

    case "SEMANTIC_FAILURE":
      if (canEscalate && currentTier === "fast") {
        return { type: "escalate_to_reasoning" };
      }
      if (hasRetryBudget) return { type: "retry_same_tier" };
      return { type: "needs_host" };

    case "SCOPE_VIOLATION":
    case "REQUIREMENT_AMBIGUITY":
    case "ARCHITECTURE_DECISION":
    case "POLICY_DENIED":
    case "SECURITY_VIOLATION":
      return { type: "needs_host" };

    case "PATCH_CONFLICT":
      if (hasRetryBudget) return { type: "retry_same_tier" };
      return { type: "needs_host" };

    case "BUDGET_EXHAUSTED":
    case "INTERNAL_ERROR":
      return { type: "stop" };

    default:
      return { type: "stop" };
  }
}
