import type { Config } from "./config.js";
import { ProcessRunner } from "./process.js";

export interface RunOptions {
  prompt: string;
  workspace: string;
  model?: string;
  mode?: "plan" | "accept-edits";
  effort?: "low" | "medium" | "high";
  autonomy?: "safe" | "sandbox" | "full";
  timeoutSec?: number;
  conversationId?: string;
  continueLatest?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface RunResult {
  ok: boolean;
  status: string;
  response: string;
  exitCode: number | null;
  error?: string;
  conversationId?: string;
  deniedActions?: unknown[];
  usage?: Record<string, unknown>;
  durationSec?: number;
  stderr?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Accept only terminal envelopes; an init/log object must never hide a result. */
export function parseAgyOutput(
  stdout: string,
): Omit<RunResult, "ok" | "exitCode"> & { parsed: boolean } {
  const text = stdout.trim();
  let result: Record<string, unknown> | undefined;
  let conversationId: string | undefined;
  const accept = (value: unknown) => {
    const object = record(value);
    if (!object) return;
    conversationId = string(object.conversation_id) ?? conversationId;
    if (object.event !== undefined && object.event !== "result") return;
    const candidate = record(object.result) ?? object;
    if (typeof candidate.status !== "string") return;
    result = candidate;
    conversationId = string(candidate.conversation_id) ?? conversationId;
  };
  try {
    accept(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/)) {
      try {
        accept(JSON.parse(line));
      } catch {
        /* Ignore diagnostics between events. */
      }
    }
  }
  if (!result)
    return {
      parsed: false,
      status: text ? "INVALID_OUTPUT" : "EMPTY_RESPONSE",
      response: text,
      conversationId,
    };
  const r: Record<string, unknown> = result;
  return {
    parsed: true,
    status: String(r.status).toUpperCase(),
    response: string(r.response) ?? "",
    error:
      r.error == null
        ? undefined
        : typeof r.error === "string"
          ? r.error
          : JSON.stringify(r.error),
    conversationId,
    deniedActions: Array.isArray(r.denied_actions)
      ? r.denied_actions
      : undefined,
    usage: record(r.usage),
    durationSec:
      typeof r.duration_seconds === "number" &&
      Number.isFinite(r.duration_seconds)
        ? r.duration_seconds
        : undefined,
  };
}

export function buildArgs(options: RunOptions): string[] {
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--add-dir",
    options.workspace,
    "--print-timeout",
    `${options.timeoutSec ?? 300}s`,
    "--mode",
    options.mode ?? "plan",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.autonomy === "sandbox") args.push("--sandbox");
  if (options.autonomy === "full") args.push("--dangerously-skip-permissions");
  if (options.conversationId)
    args.push("--conversation", options.conversationId);
  else if (options.continueLatest) args.push("--continue");
  return args;
}

export async function runAgy(
  options: RunOptions,
  config: Config,
  runner: ProcessRunner,
): Promise<RunResult> {
  if (options.autonomy === "full" && !config.allowFullAutonomy) {
    return {
      ok: false,
      status: "POLICY_ERROR",
      response: "",
      exitCode: null,
      error:
        "full autonomy requires AGY_MCP_ALLOW_FULL_AUTONOMY=true in the server environment",
    };
  }
  const resolvedOptions: RunOptions = {
    ...options,
    model: options.model ?? config.defaultModel,
  };
  let pending = "";
  let lastProgress = 0;
  const processResult = await runner.run({
    bin: config.bin,
    args: buildArgs(resolvedOptions),
    cwd: resolvedOptions.workspace,
    timeoutMs: (resolvedOptions.timeoutSec ?? 300) * 1_000,
    maxBufferBytes: config.maxBufferBytes,
    signal: resolvedOptions.signal,
    // UUIDs are case-insensitive. Only implicit continuation needs exclusivity.
    lockKey: resolvedOptions.conversationId?.toLowerCase(),
    exclusive: Boolean(
      resolvedOptions.continueLatest && !resolvedOptions.conversationId,
    ),
    onStdout: (chunk) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const event = record(JSON.parse(line));
          if (
            event?.event === "step_update" &&
            Date.now() - lastProgress >= 1_000
          ) {
            lastProgress = Date.now();
            // Avoid forwarding prompts, tool arguments, or model reasoning in progress.
            resolvedOptions.onProgress?.("Antigravity is processing the task");
          }
        } catch {
          /* The final parser reports unrecognized output. */
        }
      }
    },
  });
  const parsed = parseAgyOutput(processResult.stdout);
  let status = processResult.failure ?? parsed.status;
  let error = processResult.error ?? parsed.error;
  if (!processResult.failure) {
    if (!parsed.parsed)
      error ??=
        "agy did not return a recognized result envelope. Check authentication, workspace trust, and CLI version.";
    else if (status === "SUCCESS" && parsed.deniedActions?.length) {
      status = "PERMISSION_DENIED";
      error ??=
        "agy reported denied actions. Review the requested permissions before retrying.";
    } else if (status === "SUCCESS" && !parsed.response.trim()) {
      status = "EMPTY_RESPONSE";
      error ??=
        "agy reported success with an empty response. Review the conversation before retrying; the task may have had side effects.";
    }
    if (parsed.deniedActions?.length && status !== "PERMISSION_DENIED")
      error ??=
        "agy reported denied actions. Review the requested permissions before retrying.";
    if (processResult.exitCode !== 0)
      error ??= `agy exited with code ${processResult.exitCode ?? "unknown"}`;
    if (status !== "SUCCESS") error ??= `agy ended with status ${status}`;
  }
  return {
    ok: processResult.exitCode === 0 && status === "SUCCESS" && !error,
    status,
    response: parsed.response,
    error,
    exitCode: processResult.exitCode,
    conversationId: parsed.conversationId,
    deniedActions: parsed.deniedActions,
    usage: parsed.usage,
    durationSec: parsed.durationSec,
    stderr: processResult.stderr,
  };
}

export async function listModels(
  config: Config,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<RunResult> {
  const result = await runner.run({
    bin: config.bin,
    args: ["models"],
    cwd: config.defaultWorkspace,
    timeoutMs: 30_000,
    maxBufferBytes: config.maxBufferBytes,
    signal,
  });
  const ok =
    !result.failure && result.exitCode === 0 && Boolean(result.stdout.trim());
  return {
    ok,
    status: result.failure ?? (ok ? "SUCCESS" : "ERROR"),
    response: result.stdout.trim(),
    exitCode: result.exitCode,
    stderr: result.stderr,
    error:
      result.error ??
      (ok
        ? undefined
        : "agy models failed or returned no models. Run agy interactively to check authentication."),
  };
}
