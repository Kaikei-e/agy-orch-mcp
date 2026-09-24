import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { ProcessRunner } from "./process.js";
import type { ArtifactStore } from "./artifacts/store.js";

export interface RunOptions {
  prompt: string;
  workspace: string;
  model?: string;
  mode?: "plan" | "accept-edits";
  effort?: "low" | "medium" | "high";
  autonomy?: "safe" | "sandbox" | "full";
  timeoutSec?: number;
  conversationId?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  returnMode?: "raw" | "digest";
  traceId?: string;
  runId?: string;
  store?: ArtifactStore;
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
  rawStdout?: string;
  runId?: string;
  traceId?: string;
  recoveryPointer?: {
    run_id: string;
    manifest_artifact_id: string;
    digest_artifact_id: string;
  };
  artifacts?: Array<{
    id: string;
    kind: string;
    byte_size: number;
    sha256: string;
  }>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

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

  let runId = resolvedOptions.runId;
  const traceId = resolvedOptions.traceId ?? `tr_${randomUUID().slice(0, 8)}`;

  let recoveryPointer: RunResult["recoveryPointer"] = undefined;
  let artifacts: RunResult["artifacts"] = undefined;

  const wantsStore =
    resolvedOptions.store &&
    (resolvedOptions.returnMode === "digest" || resolvedOptions.runId);

  if (wantsStore) {
    runId ??= `run_${randomUUID().slice(0, 12)}`;
    try {
      resolvedOptions.store!.initRun(runId, resolvedOptions.workspace);
    } catch {
      // ignore
    }
  }

  let pending = "";
  let lastProgress = 0;

  const rawStdout: string[] = [];
  const rawStderr: string[] = [];

  const processResult = await runner.run({
    bin: config.bin,
    args: buildArgs(resolvedOptions),
    cwd: resolvedOptions.workspace,
    timeoutMs: (resolvedOptions.timeoutSec ?? 300) * 1_000,
    maxBufferBytes: config.maxBufferBytes,
    maxArtifactBytes: 50 * 1024 * 1024,
    signal: resolvedOptions.signal,
    lockKey: resolvedOptions.conversationId?.toLowerCase(),
    onStdout: (chunk) => {
      if (wantsStore) rawStdout.push(chunk);
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
            resolvedOptions.onProgress?.("Antigravity is processing the task");
          }
        } catch {
          /* ignore */
        }
      }
    },
    onStderr: (chunk) => {
      if (wantsStore) rawStderr.push(chunk);
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

  if (wantsStore && runId) {
    try {
      const stdoutArt = resolvedOptions.store!.saveArtifact({
        runId,
        kind: "stdout",
        relativePath: "stdout.log",
        content: rawStdout.join(""),
      });
      const stderrArt = resolvedOptions.store!.saveArtifact({
        runId,
        kind: "stderr",
        relativePath: "stderr.log",
        content: rawStderr.join(""),
      });
      artifacts = [
        {
          id: stdoutArt.id,
          kind: stdoutArt.kind,
          byte_size: stdoutArt.byte_size,
          sha256: stdoutArt.sha256,
        },
        {
          id: stderrArt.id,
          kind: stderrArt.kind,
          byte_size: stderrArt.byte_size,
          sha256: stderrArt.sha256,
        },
      ];

      const manifest = resolvedOptions.store!.loadManifest(runId);
      if (manifest) {
        manifest.status = status === "SUCCESS" ? "succeeded" : "failed";
        manifest.updated_at = new Date().toISOString();
        resolvedOptions.store!.saveManifest(manifest);
      }

      recoveryPointer = {
        run_id: runId,
        manifest_artifact_id: "manifest",
        digest_artifact_id: stdoutArt.id,
      };
    } catch {
      // ignore
    }
  }

  let finalResponse = parsed.response;
  if (resolvedOptions.returnMode === "digest" && runId) {
    const compactSummary =
      parsed.response.length > 500
        ? parsed.response.slice(0, 480) + "... [truncated in digest]"
        : parsed.response;

    let structuredContent;
    try {
      structuredContent = parsed.response
        ? JSON.parse(parsed.response)
        : undefined;
    } catch {
      structuredContent = undefined;
    }

    finalResponse = JSON.stringify({
      schema_version: "1",
      run_id: runId,
      trace_id: traceId,
      status: status === "SUCCESS" ? "succeeded" : "failed",
      summary: compactSummary || status,
      structured: structuredContent,
      raw_output_bytes: Buffer.byteLength(processResult.stdout, "utf8"),
      recovery_pointer: recoveryPointer,
      artifacts,
    });
  }

  return {
    ok: processResult.exitCode === 0 && status === "SUCCESS" && !error,
    status,
    response: finalResponse,
    rawStdout: processResult.stdout,
    error,
    exitCode: processResult.exitCode,
    conversationId: parsed.conversationId,
    deniedActions: parsed.deniedActions,
    usage: parsed.usage,
    durationSec: parsed.durationSec,
    stderr: processResult.stderr,
    runId,
    traceId,
    recoveryPointer,
    artifacts,
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
