import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import {
  FIXED_DENY_RULES,
  GUARD_ENV,
  SUBAGENT_MODEL_ENV,
  defaultHooksPath,
  guardHookCommand,
  guardStatus,
  sessionSettingsJson,
  type GuardStatus,
} from "./guard.js";
import { HANDOFF_JSON_SCHEMA, parseHandoff } from "./handoff-schema.js";
import { isolatedEnv, removeIsolatedEnv } from "./isolation.js";
import { loadPermissionRules, preflightWarnings } from "./preflight.js";
import { ProcessRunner } from "./process.js";
import type { ArtifactStore } from "./artifacts/store.js";
import type { RunResult } from "./run-result.js";
import { StreamLedger } from "./stream.js";
import { readDeniedCommands, readLastPlannerText } from "./transcript.js";

export const MAX_TURN_SECONDS = 900;

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
  structuredHandoff?: boolean;
  queueTimeoutMs?: number;
  onQueued?: (position: number) => void;
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

function effectiveTurnSeconds(timeoutSec: number | undefined): number {
  return Math.min(timeoutSec ?? MAX_TURN_SECONDS, MAX_TURN_SECONDS);
}

export function buildArgs(options: RunOptions): string[] {
  const turnSeconds = effectiveTurnSeconds(options.timeoutSec);
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--add-dir",
    options.workspace,
    "--print-timeout",
    `${turnSeconds}s`,
    "--mode",
    options.mode ?? "plan",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.autonomy === "sandbox") args.push("--sandbox");
  if (options.autonomy === "full") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--settings", sessionSettingsJson());
  }
  if (options.structuredHandoff) {
    args.push("--json-schema", JSON.stringify(HANDOFF_JSON_SCHEMA));
  }
  if (options.conversationId)
    args.push("--conversation", options.conversationId);
  return args;
}

const guardHookScriptPath = fileURLToPath(
  new URL("./guard-hook.js", import.meta.url),
);
let cachedGuardCheck: { hooksPath: string; status: GuardStatus } | undefined;

function checkGuardOnce(): GuardStatus {
  const hooksPath = defaultHooksPath();
  if (cachedGuardCheck?.hooksPath === hooksPath) {
    return cachedGuardCheck.status;
  }
  const status = guardStatus(
    hooksPath,
    guardHookCommand(process.execPath, guardHookScriptPath),
  );
  cachedGuardCheck = { hooksPath, status };
  return status;
}

function parseTerminatedTasks(
  stderr: string,
): Array<{ id: string; description: string }> | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const idx = line.indexOf("AGY_ERROR:");
    if (idx < 0) continue;
    try {
      const payload = record(
        JSON.parse(line.slice(idx + "AGY_ERROR:".length).trim()),
      );
      if (!Array.isArray(payload?.tasks)) continue;
      const tasks: Array<{ id: string; description: string }> = [];
      for (const item of payload.tasks) {
        const entry = record(item);
        if (
          typeof entry?.id === "string" &&
          typeof entry.description === "string"
        ) {
          tasks.push({ id: entry.id, description: entry.description });
        }
      }
      if (tasks.length > 0) return tasks;
    } catch {
      /* ignore malformed stderr line */
    }
  }
  return undefined;
}

function readWorkspaceChanges(
  workspace: string,
): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", workspace, "status", "--porcelain=v1", "--untracked-files=all"],
      { timeout: 10_000, encoding: "utf8" },
      (error, stdout) => {
        if (error || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        const lines = stdout
          .replace(/\r?\n$/, "")
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .slice(0, 50);
        resolve(lines.length > 0 ? lines : undefined);
      },
    );
  });
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

// agy tells the model not to rephrase a denied command, so a retry only
// succeeds when the follow-up names a concrete permitted alternative.
function deniedGuidance(commands: string[] | undefined): string {
  const listed = commands?.length
    ? ` Denied commands: ${commands.map((command) => `\`${command}\``).join(", ")}.`
    : "";
  return (
    `agy reported denied actions under headless permission handling.${listed} ` +
    "Review side effects with git status, then either continue this conversation stating the permitted alternative " +
    '(e.g. "X is unavailable; use Y instead"), or add the command prefix to permissions.allow ' +
    'in ~/.gemini/antigravity-cli/settings.json (e.g. "command(bun)") before retrying.'
  );
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
  const turnLimitSec = effectiveTurnSeconds(resolvedOptions.timeoutSec);

  let warnings: string[] = [];
  if (resolvedOptions.autonomy !== "full") {
    warnings = preflightWarnings(
      resolvedOptions.prompt,
      loadPermissionRules(),
      FIXED_DENY_RULES,
    );
    if (config.guard) {
      const status = checkGuardOnce();
      if (status !== "installed") {
        warnings.push(
          `agy-orch-mcp guard hook is ${status}; run \`agy-orch-mcp --install-guard\` to enable command guarding.`,
        );
      }
    }
  }

  let pendingRoot: string | undefined;
  let runRoot: string | undefined;
  if (config.envIsolation !== "off") {
    if (
      resolvedOptions.conversationId &&
      isSafePathSegment(resolvedOptions.conversationId)
    ) {
      runRoot = path.join(config.envRoot, resolvedOptions.conversationId);
    } else {
      pendingRoot = path.join(config.envRoot, `pending-${randomUUID()}`);
      runRoot = pendingRoot;
    }
  }

  const runnerEnv: Record<string, string> = {
    ...(config.envIsolation !== "off" && runRoot
      ? isolatedEnv(config.envIsolation, runRoot)
      : {}),
    ...(resolvedOptions.autonomy !== "full" && config.guard
      ? { [GUARD_ENV]: "1" }
      : {}),
    ...(config.subagentModel
      ? { [SUBAGENT_MODEL_ENV]: config.subagentModel }
      : {}),
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
  const startedAt = Date.now();

  const rawStdout: string[] = [];
  const rawStderr: string[] = [];

  const processResult = await runner.run({
    bin: config.bin,
    args: buildArgs(resolvedOptions),
    cwd: resolvedOptions.workspace,
    timeoutMs: (turnLimitSec + 60) * 1_000,
    maxBufferBytes: config.maxBufferBytes,
    maxArtifactBytes: 50 * 1024 * 1024,
    signal: resolvedOptions.signal,
    lockKey: resolvedOptions.conversationId?.toLowerCase(),
    ...(Object.keys(runnerEnv).length > 0 ? { env: runnerEnv } : {}),
    queueTimeoutMs: resolvedOptions.queueTimeoutMs,
    onQueued: resolvedOptions.onQueued,
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

  const turnSeconds = Math.round((Date.now() - startedAt) / 100) / 10;

  const ledger = new StreamLedger();
  for (const line of processResult.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      ledger.push(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }

  const parsed = parseAgyOutput(processResult.stdout);

  if (
    pendingRoot !== undefined &&
    parsed.conversationId &&
    isSafePathSegment(parsed.conversationId)
  ) {
    const targetRoot = path.join(config.envRoot, parsed.conversationId);
    if (existsSync(targetRoot)) {
      await removeIsolatedEnv(pendingRoot);
    } else {
      try {
        renameSync(pendingRoot, targetRoot);
      } catch {
        await removeIsolatedEnv(pendingRoot);
      }
    }
  }

  const verifiedCommands = ledger.commands();
  const verifiedOutputs =
    verifiedCommands.length > 0 ? verifiedCommands : undefined;

  const transcriptDenied =
    parsed.deniedActions?.length && parsed.conversationId
      ? readDeniedCommands(parsed.conversationId, startedAt)
      : [];
  const mergedDenied = [
    ...new Set([...ledger.deniedCommands(), ...transcriptDenied]),
  ];
  const deniedCommands = mergedDenied.length > 0 ? mergedDenied : undefined;

  const isTimeout =
    processResult.failure === "TIMEOUT" ||
    ledger.finishedReason() === "print_timeout";
  let status = isTimeout ? "TIMEOUT" : (processResult.failure ?? parsed.status);
  let error = isTimeout
    ? `Turn reached the ${turnLimitSec}-second cap. Resume with antigravity_continue using conversation_id; partial_response, verified_outputs and workspace_changes show where it stopped.`
    : (processResult.error ?? parsed.error);

  if (!processResult.failure && !isTimeout) {
    if (!parsed.parsed)
      error ??=
        "agy did not return a recognized result envelope. Check authentication, workspace trust, and CLI version.";
    else if (status === "SUCCESS" && parsed.deniedActions?.length) {
      status = "PERMISSION_DENIED";
      error ??= deniedGuidance(deniedCommands);
    } else if (status === "SUCCESS" && !parsed.response.trim()) {
      status = "EMPTY_RESPONSE";
      error ??=
        "agy reported success with an empty response. Review the conversation before retrying; the task may have had side effects.";
    }
    if (parsed.deniedActions?.length && status !== "PERMISSION_DENIED")
      error ??= deniedGuidance(deniedCommands);
    if (processResult.exitCode !== 0)
      error ??= `agy exited with code ${processResult.exitCode ?? "unknown"}`;
    if (status !== "SUCCESS") error ??= `agy ended with status ${status}`;
  }

  const resumable =
    status === "TIMEOUT" && parsed.conversationId ? true : undefined;
  const terminatedTasks =
    status === "TIMEOUT"
      ? parseTerminatedTasks(processResult.stderr)
      : undefined;

  let partialResponse: string | undefined;
  let workspaceChanges: string[] | undefined;
  if (
    status === "TIMEOUT" ||
    status === "PERMISSION_DENIED" ||
    status === "EMPTY_RESPONSE"
  ) {
    partialResponse = parsed.response.trim()
      ? parsed.response
      : parsed.conversationId
        ? readLastPlannerText(parsed.conversationId, startedAt)
        : undefined;
    workspaceChanges = await readWorkspaceChanges(resolvedOptions.workspace);
  }

  const turnTokens = ledger.turnTokens();
  const queueWaitSeconds =
    processResult.queuedMs !== undefined
      ? processResult.queuedMs / 1_000
      : undefined;

  let handoff: unknown;
  let handoffError: string | undefined;
  if (resolvedOptions.structuredHandoff && status === "SUCCESS") {
    const parsedHandoff = parseHandoff(parsed.response);
    handoff = parsedHandoff.handoff;
    handoffError = parsedHandoff.error;
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
    ...(resumable !== undefined ? { resumable } : {}),
    ...(terminatedTasks ? { terminatedTasks } : {}),
    deniedActions: parsed.deniedActions,
    ...(deniedCommands?.length ? { deniedCommands } : {}),
    ...(verifiedOutputs ? { verifiedOutputs } : {}),
    ...(partialResponse ? { partialResponse } : {}),
    ...(workspaceChanges ? { workspaceChanges } : {}),
    ...(warnings.length ? { preflightWarnings: warnings } : {}),
    ...(queueWaitSeconds !== undefined ? { queueWaitSeconds } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
    ...(handoffError ? { handoffError } : {}),
    usage: parsed.usage,
    durationSec: parsed.durationSec,
    turnSeconds,
    ...(turnTokens !== undefined ? { turnTokens } : {}),
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
