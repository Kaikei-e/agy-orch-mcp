export type TaskStatus =
  | "pending"
  | "blocked"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "integrating"
  | "integrated"
  | "interrupted";

const VALID_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  pending: new Set(["blocked", "ready", "cancelled", "interrupted"]),
  blocked: new Set(["ready", "cancelled", "interrupted"]),
  ready: new Set(["running", "cancelled", "interrupted"]),
  running: new Set(["succeeded", "failed", "cancelled", "interrupted"]),
  succeeded: new Set(["integrating", "cancelled", "interrupted"]),
  integrating: new Set(["integrated", "failed", "cancelled", "interrupted"]),
  failed: new Set(["ready", "cancelled"]),
  cancelled: new Set(),
  integrated: new Set(),
  interrupted: new Set(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

export interface TaskSpecV1 {
  id: string;
  objective: string;
  after?: string[];
  scope: {
    include: string[];
    exclude?: string[];
  };
  owns: string[];
  acceptance?: string[];
  worker?: {
    tier?: "fast" | "reasoning";
    model?: string;
    timeout_ms?: number;
  };
}

export interface TaskResultV1 {
  id: string;
  status: TaskStatus;
  attempts: number;
  worker_tier: "fast" | "reasoning";
  changed_files: string[];
  stdout_artifact_id?: string;
  stderr_artifact_id?: string;
  patch_artifact_id?: string;
  error?: string;
}
