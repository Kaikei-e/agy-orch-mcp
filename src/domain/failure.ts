export type FailureClass =
  | "TRANSIENT_INFRA"
  | "RATE_LIMIT"
  | "WORKER_TIMEOUT"
  | "GATE_TIMEOUT"
  | "DETERMINISTIC_TEST_FAILURE"
  | "SEMANTIC_FAILURE"
  | "SCOPE_VIOLATION"
  | "PATCH_CONFLICT"
  | "REQUIREMENT_AMBIGUITY"
  | "ARCHITECTURE_DECISION"
  | "POLICY_DENIED"
  | "BUDGET_EXHAUSTED"
  | "CAPACITY_EXCEEDED"
  | "SECURITY_VIOLATION"
  | "INTERNAL_ERROR";

export interface FailureDetail {
  code: FailureClass;
  message: string;
  taskId?: string;
  gateId?: string;
  attempt?: number;
  hostDecisionRequired: boolean;
  fingerprint?: string;
}

export function computeFailureFingerprint(params: {
  failureClass: FailureClass;
  errorCode?: string | number;
  failingTests?: string[];
  topStackFrames?: string[];
  changedPaths?: string[];
}): string {
  const parts = [
    params.failureClass,
    String(params.errorCode ?? ""),
    (params.failingTests ?? []).slice().sort().join(","),
    (params.topStackFrames ?? []).slice(0, 3).join(","),
    (params.changedPaths ?? []).slice().sort().join(","),
  ];
  let h = 0;
  const str = parts.join("|");
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return `fp_${Math.abs(h).toString(16)}`;
}
