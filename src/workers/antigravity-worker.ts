import { type Config as BridgeConfig, type Config } from "../config.js";
import { runAgy, type RunOptions } from "../agy.js";
import { ProcessRunner } from "../process.js";
import type { RunResult } from "../run-result.js";
import type {
  WorkerAdapter,
  WorkerExecutionRequest,
  WorkerExecutionResult,
} from "./worker-adapter.js";
import { classifyFailure } from "./failure-classifier.js";
import { resolveWorkerModel } from "./routing-policy.js";

export type { BridgeConfig, Config };

/**
 * Normalizes CLI usage record into standard schema.
 */
function normalizeUsage(
  raw: Record<string, unknown> | undefined,
):
  | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  | undefined {
  if (!raw) return undefined;
  const inTok =
    typeof raw.input_tokens === "number"
      ? raw.input_tokens
      : typeof raw.inputTokens === "number"
        ? raw.inputTokens
        : undefined;
  const outTok =
    typeof raw.output_tokens === "number"
      ? raw.output_tokens
      : typeof raw.outputTokens === "number"
        ? raw.outputTokens
        : undefined;
  const totTok =
    typeof raw.total_tokens === "number"
      ? raw.total_tokens
      : typeof raw.totalTokens === "number"
        ? raw.totalTokens
        : undefined;

  const result: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  } = {};
  if (inTok !== undefined) result.input_tokens = inTok;
  if (outTok !== undefined) result.output_tokens = outTok;
  if (totTok !== undefined) {
    result.total_tokens = totTok;
  } else if (inTok !== undefined && outTok !== undefined) {
    result.total_tokens = inTok + outTok;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sumUsage(
  records: Array<{
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  }>,
):
  | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  | undefined {
  if (records.length === 0) return undefined;
  let hasIn = false;
  let hasOut = false;
  let hasTotal = false;
  let inSum = 0;
  let outSum = 0;
  let totalSum = 0;

  for (const r of records) {
    if (r.input_tokens !== undefined) {
      hasIn = true;
      inSum += r.input_tokens;
    }
    if (r.output_tokens !== undefined) {
      hasOut = true;
      outSum += r.output_tokens;
    }
    if (r.total_tokens !== undefined) {
      hasTotal = true;
      totalSum += r.total_tokens;
    }
  }

  const result: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  } = {};
  if (hasIn) result.input_tokens = inSum;
  if (hasOut) result.output_tokens = outSum;
  if (hasTotal) result.total_tokens = totalSum;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function buildResumePrompt(runResult: RunResult): string {
  const sections: string[] = [
    "Your previous turn was cut off by the 15-minute turn cap. Continue the same task in the same worktree.",
  ];

  const verified = (runResult.verifiedOutputs ?? []).slice(-10);
  if (verified.length > 0) {
    sections.push(
      verified
        .map((item) => `${item.status} exit=${item.exit_code} ${item.command}`)
        .join("\n"),
    );
  }

  const note = (runResult.partialResponse ?? "").slice(0, 1500);
  sections.push(`Last progress note:\n${note}`);

  const changes = (runResult.workspaceChanges ?? []).slice(0, 30);
  sections.push(`Uncommitted changes:\n${changes.join("\n")}`);

  sections.push(
    "Finish the remaining work in small verified steps, then end with your final summary.",
  );

  return sections.join("\n\n");
}

/**
 * Builds explicit worker prompt with objective, scope boundaries, exclusive owns,
 * acceptance criteria, repair failure context, and directives forbidding recursive orchestration.
 */
export function buildWorkerPrompt(request: WorkerExecutionRequest): string {
  const obj = (request.task.objective || "").trim();
  // Pass through mock CLI fixture tokens for deterministic integration testing
  if (
    obj === "hang" ||
    obj === "tree" ||
    obj === "overflow" ||
    obj === "denied" ||
    obj === "denied-hang" ||
    obj === "denied-empty" ||
    obj === "malformed" ||
    obj === "empty" ||
    obj === "large" ||
    obj === "error" ||
    obj === "stderr" ||
    obj === "nonzero" ||
    obj.startsWith("wait:")
  ) {
    return obj;
  }

  const parts: string[] = [];

  parts.push("# Task Execution Objective");
  parts.push(request.task.objective);

  parts.push("\n# Scope and File Boundaries");
  parts.push(`Include paths: ${request.task.scope.include.join(", ")}`);
  if (request.task.scope.exclude && request.task.scope.exclude.length > 0) {
    parts.push(`Exclude paths: ${request.task.scope.exclude.join(", ")}`);
  }

  parts.push("\n# Exclusive Write Ownership (CRITICAL)");
  parts.push(
    "You are ONLY permitted to edit or create files within the following owned paths:\n" +
      request.task.owns.map((o) => `  - ${o}`).join("\n") +
      "\nANY MODIFICATION OUTSIDE THESE PATHS WILL BE REJECTED AS A SCOPE VIOLATION.",
  );

  if (request.task.acceptance && request.task.acceptance.length > 0) {
    parts.push("\n# Acceptance Criteria");
    parts.push(request.task.acceptance.map((a) => `  - ${a}`).join("\n"));
  }

  if (request.failureContext && request.failureContext.trim()) {
    parts.push(
      "\n# Failure Context & Repair Evidence (from previous gate/worker attempt)",
    );
    parts.push(request.failureContext.trim());
    parts.push(
      "Diagnose and repair this failure without weakening tests or acceptance criteria.",
    );
  }

  parts.push("\n# Execution Directives");
  parts.push(
    "- Execute native tools directly to investigate, edit, and self-verify.",
  );
  parts.push(
    "- DO NOT recursively invoke agy-orch-mcp or orchestrate other agents.",
  );
  parts.push(
    "- DO NOT reverse delegate back to the host; complete the task self-contained.",
  );
  parts.push(
    "- Ensure all tests and acceptance criteria pass before concluding.",
  );

  return parts.join("\n");
}

/**
 * Worker implementation executing tasks via agy CLI and ProcessRunner.
 */
export class AntigravityWorker implements WorkerAdapter {
  constructor(
    private readonly config: BridgeConfig,
    private readonly runner: ProcessRunner = new ProcessRunner(
      config.maxConcurrent,
    ),
  ) {}

  async execute(
    request: WorkerExecutionRequest,
  ): Promise<WorkerExecutionResult> {
    if (request.signal?.aborted) {
      return {
        status: "cancelled",
        stdout: "",
        stderr: "",
        message: "Execution cancelled before start",
        turns: 0,
      };
    }

    const prompt = buildWorkerPrompt(request);
    const modelResolution = resolveWorkerModel(
      request.tier,
      this.config,
      request.task.worker?.model,
    );

    const timeoutSec = Math.max(1, Math.ceil(request.timeoutMs / 1000));

    let turns = 0;
    let currentPrompt = prompt;
    let currentConversationId: string | undefined;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const usageRecords: Array<{
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    }> = [];

    try {
      while (true) {
        turns++;
        const runOptions: RunOptions = {
          prompt: currentPrompt,
          workspace: request.workspace,
          model: modelResolution.model,
          effort: modelResolution.effort,
          mode: "accept-edits",
          autonomy: "safe",
          timeoutSec,
          conversationId: currentConversationId,
          signal: request.signal,
          runId: request.runId,
          traceId: request.traceId,
        };

        const runResult = await runAgy(runOptions, this.config, this.runner);
        stdoutChunks.push(runResult.rawStdout ?? runResult.response ?? "");
        stderrChunks.push(runResult.stderr ?? "");
        const turnUsage = normalizeUsage(runResult.usage);
        if (turnUsage) {
          usageRecords.push(turnUsage);
        }

        const rawStdout = stdoutChunks.join("");
        const rawStderr = stderrChunks.join("");
        const aggregatedUsage = sumUsage(usageRecords);
        const conversationId =
          runResult.conversationId ?? currentConversationId;

        if (request.signal?.aborted || runResult.status === "CANCELED") {
          return {
            status: "cancelled",
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: runResult.exitCode ?? undefined,
            conversationId,
            model: modelResolution.model,
            message: runResult.error || "Execution was cancelled",
            usage: aggregatedUsage,
            turns,
          };
        }

        if (
          (runResult.deniedActions && runResult.deniedActions.length > 0) ||
          runResult.status === "PERMISSION_DENIED" ||
          runResult.status === "POLICY_ERROR"
        ) {
          return {
            status: "failed",
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: runResult.exitCode ?? undefined,
            failureClass: "POLICY_DENIED",
            conversationId,
            model: modelResolution.model,
            message:
              runResult.error ||
              `Policy denied: agy reported ${runResult.deniedActions?.length ?? 1} denied action(s)`,
            usage: aggregatedUsage,
            turns,
          };
        }

        if (runResult.status === "TIMEOUT") {
          if (runResult.resumable === true && runResult.conversationId) {
            if (request.resume?.consume() === true) {
              currentConversationId = runResult.conversationId;
              currentPrompt = buildResumePrompt(runResult);
              continue;
            }
            const baseMsg =
              runResult.error || `Worker exceeded timeout of ${timeoutSec}s`;
            return {
              status: "failed",
              stdout: rawStdout,
              stderr: rawStderr,
              exitCode: runResult.exitCode ?? undefined,
              failureClass: "WORKER_TIMEOUT",
              conversationId,
              model: modelResolution.model,
              message: `${baseMsg}; resume budget exhausted after ${turns} turns`,
              usage: aggregatedUsage,
              turns,
            };
          }

          return {
            status: "failed",
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: runResult.exitCode ?? undefined,
            failureClass: "WORKER_TIMEOUT",
            conversationId,
            model: modelResolution.model,
            message:
              runResult.error || `Worker exceeded timeout of ${timeoutSec}s`,
            usage: aggregatedUsage,
            turns,
          };
        }

        if (runResult.status === "EMPTY_RESPONSE") {
          return {
            status: "failed",
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: runResult.exitCode ?? undefined,
            failureClass: "INTERNAL_ERROR",
            conversationId,
            model: modelResolution.model,
            message: runResult.error || "Worker returned empty response",
            usage: aggregatedUsage,
            turns,
          };
        }

        if (runResult.ok) {
          const respLower = (runResult.response || "").toLowerCase();
          const isAmbiguous =
            respLower.includes("requirements are ambiguous") ||
            respLower.includes("requirement ambiguity") ||
            respLower.includes("requirements are underspecified");
          const isArch =
            respLower.includes("architectural decision") ||
            respLower.includes("architectural choice");

          if (isAmbiguous) {
            return {
              status: "failed",
              stdout: rawStdout,
              stderr: rawStderr,
              exitCode: runResult.exitCode ?? undefined,
              failureClass: "REQUIREMENT_AMBIGUITY",
              conversationId,
              model: modelResolution.model,
              message:
                runResult.error ||
                "Worker output indicated REQUIREMENT_AMBIGUITY",
              usage: aggregatedUsage,
              turns,
            };
          }

          if (isArch) {
            return {
              status: "failed",
              stdout: rawStdout,
              stderr: rawStderr,
              exitCode: runResult.exitCode ?? undefined,
              failureClass: "ARCHITECTURE_DECISION",
              conversationId,
              model: modelResolution.model,
              message:
                runResult.error ||
                "Worker output indicated ARCHITECTURE_DECISION",
              usage: aggregatedUsage,
              turns,
            };
          }

          return {
            status: "succeeded",
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: runResult.exitCode ?? 0,
            conversationId,
            model: modelResolution.model,
            usage: aggregatedUsage,
            turns,
          };
        }

        const failureClass = classifyFailure({
          exitCode: runResult.exitCode,
          stdout: runResult.response,
          stderr: runResult.stderr,
          error: runResult.error,
          isWorkerTimeout: runResult.status === "TIMEOUT",
          deniedActions: runResult.deniedActions,
        });

        return {
          status: "failed",
          stdout: rawStdout,
          stderr: rawStderr,
          exitCode: runResult.exitCode ?? undefined,
          failureClass,
          conversationId,
          model: modelResolution.model,
          message:
            runResult.error || `Worker failed with status ${runResult.status}`,
          usage: aggregatedUsage,
          turns,
        };
      }
    } catch (err: unknown) {
      if (request.signal?.aborted) {
        return {
          status: "cancelled",
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          message: "Execution was cancelled",
          turns,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.length
          ? `${stderrChunks.join("")}\n${message}`
          : message,
        failureClass: "INTERNAL_ERROR",
        message,
        turns,
      };
    }
  }
}

/**
 * Required public factory: creates an Antigravity worker adapter conforming to WorkerAdapter interface.
 */
export function createAntigravityWorker(
  config: BridgeConfig,
  runnerOrOptions?: ProcessRunner | { runner?: ProcessRunner },
): WorkerAdapter {
  const runner =
    runnerOrOptions instanceof ProcessRunner
      ? runnerOrOptions
      : (runnerOrOptions?.runner ?? new ProcessRunner(config.maxConcurrent));
  return new AntigravityWorker(config, runner);
}
