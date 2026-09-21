/**
 * Batch tool handler for the MCP `antigravity_batch` tool.
 *
 * Consumes a BatchRequestV1, performs upfront schema/DAG validation,
 * resolves and canonicalizes workspace.root enforcing directory and allowedRoot boundaries,
 * delegates execution to executeBatch from the runtime scheduler using shared ProcessRunner,
 * and returns structuredContent with a compact human text digest.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ArtifactStore } from "../artifacts/store.js";
import { resolveWorkspace, type Config as BridgeConfig } from "../config.js";
import type { ProcessRunner } from "../process.js";
import type { WorkerAdapter } from "../domain/execution.js";
import type { BatchRequestV1, BatchResponseV1 } from "../domain/ir.js";
import { estimateMinimalDigestTokens } from "../digest/deterministic.js";
import { executeBatch as executeBatchRuntime } from "../runtime/scheduler.js";
import { validateBatchRequest } from "../validation/schema.js";
import { createAntigravityWorker } from "../workers/antigravity-worker.js";

export interface BatchToolOptions {
  store: ArtifactStore;
  config: BridgeConfig;
  runner?: ProcessRunner;
  worker?: WorkerAdapter;
  signal?: AbortSignal;
}

export async function executeBatchTool(
  rawArgs: unknown,
  options: BatchToolOptions,
): Promise<CallToolResult> {
  // 1. Upfront preflight validation: ensure invalid requests fail before any worker is created or spawned
  let request: BatchRequestV1;
  try {
    request = validateBatchRequest(rawArgs, options.config.limits);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }

  // 1b. Upfront preflight output capacity validation: reject impossible max_tokens before any worker, runner, or store side effects
  const requestedMaxTokens = request.return?.max_tokens;
  if (requestedMaxTokens !== undefined) {
    const minTokens = estimateMinimalDigestTokens({
      runId: "run_preflight",
      status: "failed",
      summary: "failed",
      tasks: request.tasks.map((t) => ({
        id: t.id,
        status: "failed",
        attempts: 1,
        worker_tier: t.worker?.tier ?? "fast",
        changed_files: [],
      })),
      gates: (request.gates ?? []).map((g) => ({
        id: g.id,
        status: "failed",
        duration_ms: 0,
        failing_tests: [],
        exit_code: 1,
      })),
      metrics: {
        duration_ms: 0,
        worker_calls: request.tasks.length,
        retries: 0,
        escalations: 0,
        raw_output_bytes: 0,
        digest_tokens_estimated: 0,
      },
      maxTokens: requestedMaxTokens,
    });

    if (minTokens > requestedMaxTokens) {
      return {
        content: [
          {
            type: "text",
            text: `CAPACITY_EXCEEDED: Requested max_tokens (${requestedMaxTokens}) is insufficient for minimal response skeleton (${minTokens} tokens required for ${request.tasks.length} tasks and ${(request.gates ?? []).length} gates).`,
          },
        ],
        isError: true,
      };
    }
  }

  // 2. Canonicalize workspace root and enforce directory & allowedRoot boundaries via resolveWorkspace
  try {
    request.workspace.root = resolveWorkspace(
      request.workspace.root,
      options.config,
    );
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }

  // 3. Abort check before runtime invocation
  if (options.signal?.aborted) {
    return {
      content: [
        {
          type: "text",
          text: "Batch execution cancelled before start",
        },
      ],
      isError: true,
    };
  }

  // 4. Resolve worker: use injected worker if provided; otherwise instantiate via shared runner preserving global concurrency
  let worker = options.worker;
  if (!worker) {
    if (!options.runner) {
      return {
        content: [
          {
            type: "text",
            text: "Shared ProcessRunner is required for batch worker execution",
          },
        ],
        isError: true,
      };
    }
    worker = createAntigravityWorker(options.config, options.runner);
  }

  try {
    const response: BatchResponseV1 = await executeBatchRuntime(request, {
      store: options.store,
      config: options.config,
      worker,
      signal: options.signal,
    });

    // Short text carrying run_id and status only; details reside in structuredContent
    const humanText = `[agy-orch-mcp] Batch ${response.run_id}: ${response.status}.`;

    return {
      content: [{ type: "text", text: humanText }],
      structuredContent: response as unknown as Record<string, unknown>,
      isError: response.status === "failed",
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Batch execution error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export { executeBatchTool as executeBatch };
