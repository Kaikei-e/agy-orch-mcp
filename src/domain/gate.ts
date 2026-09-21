import type { FailureClass } from "./failure.js";

export type GateStatus =
  | "pending"
  | "ready"
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "skipped";

export interface GateSpecV1 {
  id: string;
  after: string[];
  command: string[]; // argv only, no shell
  cwd?: string;
  timeout_ms?: number;
  on_fail?: {
    repair_attempts?: number;
    escalate_when?: FailureClass[];
  };
}

export interface GateResultV1 {
  id: string;
  status: GateStatus;
  exit_code?: number | null;
  duration_ms: number;
  stdout_artifact_id?: string;
  stderr_artifact_id?: string;
  failing_tests?: string[];
  error?: string;
}
