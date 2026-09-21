import type { ArtifactStore } from "../artifacts/store.js";
import type {
  BatchResponseV1,
  FailureClass,
  GateResultV1,
  TaskResultV1,
} from "../domain/ir.js";
import { estimateTokenCount } from "./token-budget.js";

export interface BuildDigestParams {
  runId: string;
  status: BatchResponseV1["status"];
  summary: string;
  tasks: TaskResultV1[];
  gates?: GateResultV1[];
  unresolved?: Array<{
    code: FailureClass;
    message: string;
    task_id?: string;
    gate_id?: string;
    host_decision_required: boolean;
  }>;
  metrics: BatchResponseV1["metrics"];
  maxTokens?: number;
}

export function estimateMinimalDigestTokens(params: BuildDigestParams): number {
  const minimalTasks = params.tasks.map((t) => {
    const minT: Record<string, unknown> = {
      id: t.id ?? (t as any).task_id,
      status: t.status,
      attempts: t.attempts ?? 1,
      worker_tier: t.worker_tier ?? "fast",
      changed_files: [],
    };
    if (t.error) minT.error = "... (omitted)";
    return minT;
  });

  const minimalGates = (params.gates ?? []).map((g) => {
    const minG: Record<string, unknown> = {
      id: g.id ?? (g as any).gate_id,
      status: g.status,
      duration_ms: g.duration_ms ?? 0,
      failing_tests: [],
    };
    if (g.exit_code !== undefined) minG.exit_code = g.exit_code;
    if (g.error) minG.error = "... (omitted)";
    return minG;
  });

  const minimalUnresolved = (params.unresolved ?? []).slice(0, 2).map((u) => ({
    code: u.code,
    message:
      u.message.length > 30
        ? u.message.slice(0, 30) + "... [trimmed]"
        : u.message,
    ...(u.task_id ? { task_id: u.task_id } : {}),
    ...(u.gate_id ? { gate_id: u.gate_id } : {}),
    host_decision_required: u.host_decision_required,
  }));
  if ((params.unresolved ?? []).length > 2) {
    minimalUnresolved.push({
      code: "INTERNAL_ERROR",
      message: `... (${(params.unresolved ?? []).length - 2} more errors omitted)`,
      host_decision_required: true,
    });
  }

  const minimalResponse: BatchResponseV1 = {
    schema_version: "1",
    run_id: params.runId,
    status: params.status,
    summary: params.status,
    tasks: minimalTasks as any,
    gates: minimalGates as any,
    unresolved: minimalUnresolved as any,
    artifacts: [],
    metrics: { ...params.metrics },
    recovery_pointer: {
      run_id: params.runId,
      manifest_artifact_id: "manifest",
      digest_artifact_id: "art_digest_00000000",
    },
  };

  const humanContent = `[agy-orch-mcp] ${params.runId}: ${params.status}.`;
  return estimateTokenCount(
    JSON.stringify({
      content: [{ type: "text", text: humanContent }],
      structuredContent: minimalResponse,
      isError: params.status === "failed",
    }),
  );
}

export function buildDeterministicDigest(
  params: BuildDigestParams,
  store: ArtifactStore,
): { response: BatchResponseV1; humanContent: string } {
  const manifest = store.loadManifest(params.runId);
  const artifacts = (manifest?.artifacts ?? []).map((a) => ({
    id: a.id,
    kind: a.kind,
    byte_size: a.byte_size,
    sha256: a.sha256,
  }));

  const fullResponse: BatchResponseV1 = {
    schema_version: "1",
    run_id: params.runId,
    status: params.status,
    summary: params.summary,
    tasks: params.tasks,
    gates: params.gates ?? [],
    unresolved: params.unresolved ?? [],
    artifacts,
    metrics: { ...params.metrics },
    recovery_pointer: {
      run_id: params.runId,
      manifest_artifact_id: "manifest",
      digest_artifact_id: `art_digest_${params.runId}`,
    },
  };

  const digestArtifact = store.saveArtifact({
    runId: params.runId,
    kind: "digest",
    relativePath: "digest.json",
    content: JSON.stringify(fullResponse, null, 2),
    mimeType: "application/json",
  });

  fullResponse.recovery_pointer = {
    run_id: params.runId,
    manifest_artifact_id: "manifest",
    digest_artifact_id: digestArtifact.id,
  };

  const maxTokens = Math.min(2000, Math.max(100, params.maxTokens ?? 1400));

  const boundedResponse: BatchResponseV1 = {
    ...fullResponse,
    tasks: fullResponse.tasks.map((t) => ({ ...t })),
    gates: fullResponse.gates.map((g) => ({ ...g })),
    unresolved: fullResponse.unresolved.map((u) => ({ ...u })),
    artifacts: fullResponse.artifacts.map((a) => ({ ...a })),
    summary: fullResponse.summary,
  };

  const calculatePayload = (resp: BatchResponseV1, human: string) => {
    const mcpPayload = JSON.stringify({
      content: [{ type: "text", text: human }],
      structuredContent: resp,
      isError: resp.status === "failed",
    });
    const structuredPayload = JSON.stringify({ structured: resp, human });
    return mcpPayload.length >= structuredPayload.length
      ? mcpPayload
      : structuredPayload;
  };

  let humanContent = `[agy-orch-mcp] Batch ${params.runId}: ${params.status}.`;
  let totalPayloadTokens = estimateTokenCount(
    calculatePayload(boundedResponse, humanContent),
  );

  if (totalPayloadTokens > maxTokens) {
    // Stage 1: Truncate long error messages, summaries, and unresolved messages
    if (boundedResponse.summary.length > 200) {
      boundedResponse.summary =
        boundedResponse.summary.slice(0, 200) + "... (truncated)";
    }
    for (const u of boundedResponse.unresolved) {
      if (u.message.length > 100) {
        u.message = u.message.slice(0, 100) + "... [trimmed]";
      }
    }
    for (const t of boundedResponse.tasks) {
      if (t.error && t.error.length > 100) {
        t.error = t.error.slice(0, 100) + "... [trimmed]";
      }
    }
    // Trim failing_tests and changed_files to at most 3 items, recording omitted count
    for (const g of boundedResponse.gates) {
      if (g.failing_tests && g.failing_tests.length > 3) {
        const omitted = g.failing_tests.length - 3;
        g.failing_tests = g.failing_tests.slice(0, 3);
        (g as any).omitted_tests_count = omitted;
      }
    }
    for (const t of boundedResponse.tasks) {
      if (t.changed_files && t.changed_files.length > 3) {
        const omitted = t.changed_files.length - 3;
        t.changed_files = t.changed_files.slice(0, 3);
        (t as any).omitted_files_count = omitted;
      }
    }
    totalPayloadTokens = estimateTokenCount(
      calculatePayload(boundedResponse, humanContent),
    );
  }

  if (totalPayloadTokens > maxTokens) {
    // Stage 2: Prune artifacts list to at most 3 items (never drop task/gate entries)
    if (boundedResponse.artifacts.length > 3) {
      boundedResponse.artifacts = boundedResponse.artifacts.slice(-3);
    }
    totalPayloadTokens = estimateTokenCount(
      calculatePayload(boundedResponse, humanContent),
    );
  }

  if (totalPayloadTokens > maxTokens) {
    // Stage 3: Fully omit details lists while keeping omitted counts and all entries intact
    for (const t of boundedResponse.tasks) {
      if (t.error) {
        t.error = "... (omitted to save budget)";
      }
      if (t.changed_files && t.changed_files.length > 0) {
        (t as any).omitted_files_count =
          ((t as any).omitted_files_count ?? 0) + t.changed_files.length;
        t.changed_files = [];
      }
    }
    for (const g of boundedResponse.gates) {
      if (g.failing_tests && g.failing_tests.length > 0) {
        (g as any).omitted_tests_count =
          ((g as any).omitted_tests_count ?? 0) + g.failing_tests.length;
        g.failing_tests = [];
      }
    }
    for (const u of boundedResponse.unresolved) {
      if (u.message.length > 60) {
        u.message = u.message.slice(0, 60) + "... [trimmed]";
      }
    }
    totalPayloadTokens = estimateTokenCount(
      calculatePayload(boundedResponse, humanContent),
    );
  }

  if (totalPayloadTokens > maxTokens) {
    // Stage 4: Extreme budget - strip non-essential artifact metadata and shorten human content
    boundedResponse.artifacts = [];
    if (boundedResponse.summary.length > 80) {
      boundedResponse.summary =
        boundedResponse.summary.slice(0, 80) + "... [trimmed]";
    }
    humanContent = `[agy-orch-mcp] Batch ${boundedResponse.run_id}: ${boundedResponse.status}.`;
    totalPayloadTokens = estimateTokenCount(
      calculatePayload(boundedResponse, humanContent),
    );
  }

  if (totalPayloadTokens > maxTokens) {
    // Stage 5: Hard cap enforcement - preserve all tasks/gates with status & exit codes, compact strings
    for (const t of boundedResponse.tasks) {
      delete (t as any).stdout_artifact_id;
      delete (t as any).stderr_artifact_id;
      delete (t as any).patch_artifact_id;
      if (t.error) {
        t.error = "... (omitted)";
      }
      t.changed_files = [];
      delete (t as any).omitted_files_count;
    }
    for (const g of boundedResponse.gates) {
      delete (g as any).stdout_artifact_id;
      delete (g as any).stderr_artifact_id;
      if (g.error) {
        g.error = "... (omitted)";
      }
      g.failing_tests = [];
      delete (g as any).omitted_tests_count;
    }
    // Aggregate unresolved if many
    if (boundedResponse.unresolved.length > 2) {
      const omitted = boundedResponse.unresolved.length - 2;
      const firstTwo = boundedResponse.unresolved.slice(0, 2);
      boundedResponse.unresolved = [
        ...firstTwo.map((u) => ({
          ...u,
          message:
            u.message.length > 30
              ? u.message.slice(0, 30) + "... [trimmed]"
              : u.message,
        })),
        {
          code: "INTERNAL_ERROR",
          message: `... (${omitted} more errors omitted; see digest)`,
          host_decision_required: true,
        },
      ];
    } else {
      for (const u of boundedResponse.unresolved) {
        u.message =
          u.message.length > 30
            ? u.message.slice(0, 30) + "... [trimmed]"
            : u.message;
      }
    }
    boundedResponse.summary = boundedResponse.status;
    humanContent = `[agy-orch-mcp] ${boundedResponse.run_id}: ${boundedResponse.status}.`;
    totalPayloadTokens = estimateTokenCount(
      calculatePayload(boundedResponse, humanContent),
    );
  }

  if (totalPayloadTokens > maxTokens) {
    const err = new Error(
      `CAPACITY_EXCEEDED: Minimal digest skeleton (${totalPayloadTokens} tokens) exceeds budget limit (${maxTokens} tokens) for run ${params.runId}`,
    ) as Error & {
      code: string;
      run_id: string;
      recovery_pointer: BatchResponseV1["recovery_pointer"];
      estimated_tokens: number;
      max_tokens: number;
    };
    err.code = "CAPACITY_EXCEEDED";
    err.run_id = params.runId;
    err.recovery_pointer = fullResponse.recovery_pointer;
    err.estimated_tokens = totalPayloadTokens;
    err.max_tokens = maxTokens;
    throw err;
  }

  boundedResponse.metrics.digest_tokens_estimated = totalPayloadTokens;

  return { response: boundedResponse, humanContent };
}
