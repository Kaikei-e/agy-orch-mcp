import type { ArtifactKind, ArtifactMetadata } from "./artifact.js";
import type { FailureClass } from "./failure.js";
import type { GateResultV1, GateSpecV1 } from "./gate.js";
import type { TaskResultV1, TaskSpecV1, TaskStatus } from "./task.js";
import type { BudgetAdjustment } from "./limits.js";

export * from "./artifact.js";
export * from "./failure.js";
export * from "./gate.js";
export * from "./limits.js";
export * from "./task.js";

export interface WorkspaceSpecV1 {
  root: string;
  base_revision?: string;
  dirty_policy?: "reject";
}

export interface BudgetV1 {
  max_worker_calls?: number;
  max_replans?: number;
  max_repair_attempts?: number;
  max_parallelism?: number;
  wall_time_ms?: number;
}

export interface ReturnOptionsV1 {
  mode?: "digest";
  max_tokens?: number;
  include_patch_stat?: boolean;
}

export interface BatchRequestV1 {
  schema_version: "1";
  workspace: WorkspaceSpecV1;
  tasks: TaskSpecV1[];
  gates?: GateSpecV1[];
  budget?: BudgetV1;
  budget_adjustments?: BudgetAdjustment[];
  return?: ReturnOptionsV1;
}

export interface BatchResponseV1 {
  schema_version: "1";
  run_id: string;
  status: "succeeded" | "partial" | "failed" | "needs_host";
  summary: string;
  tasks: TaskResultV1[];
  gates: GateResultV1[];
  budget_adjustments?: BudgetAdjustment[];
  unresolved: Array<{
    code: FailureClass;
    message: string;
    task_id?: string;
    gate_id?: string;
    host_decision_required: boolean;
  }>;
  artifacts: Array<{
    id: string;
    kind: ArtifactKind;
    byte_size: number;
    sha256: string;
  }>;
  metrics: {
    duration_ms: number;
    worker_calls: number;
    retries: number;
    escalations: number;
    raw_output_bytes: number;
    digest_tokens_estimated: number;
  };
  recovery_pointer?: {
    run_id: string;
    manifest_artifact_id: string;
    digest_artifact_id: string;
  };
}

export type ArtifactSelector =
  | `task:${string}:stdout`
  | `task:${string}:stderr`
  | `task:${string}:patch`
  | `gate:${string}:stdout`
  | `gate:${string}:stderr`
  | "manifest"
  | "digest"
  | "request"
  | "plan"
  | "events";

export interface FetchRequestV1 {
  schema_version: "1";
  run_id: string;
  artifact_id?: string;
  selector?: ArtifactSelector;
  start_line?: number;
  max_lines?: number;
  max_bytes?: number;
}

export interface FetchResponseV1 {
  schema_version: "1";
  run_id: string;
  artifact: {
    id: string;
    kind: ArtifactKind;
    byte_size: number;
    sha256: string;
    mime_type: string;
    is_binary: boolean;
    has_secrets: boolean;
  };
  range?: {
    start_line: number;
    lines_returned: number;
    total_lines: number;
    bytes_returned: number;
    truncated: boolean;
  };
  content?: string;
  notice?: string;
}

export interface RunManifestV1 {
  manifest_version: "1";
  run_id: string;
  server_version: string;
  schema_version: "1";
  artifact_layout_version: "1";
  created_at: string;
  updated_at: string;
  base_revision: string;
  status:
    | "running"
    | "succeeded"
    | "partial"
    | "failed"
    | "needs_host"
    | "interrupted"
    | "cancelled";
  workspace_root: string;
  artifacts: ArtifactMetadata[];
  tasks: Record<string, { status: TaskStatus; attempts: number }>;
  gates: Record<string, { status: string }>;
  metrics?: Record<string, unknown>;
  pinned?: boolean;
  owner_pid?: number;
  trace_id?: string;
}
