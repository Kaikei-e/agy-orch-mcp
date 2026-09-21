import type { TaskSpecV1 } from "./ir.js";
import type { FailureClass } from "./failure.js";

export type WorkerTier = "fast" | "reasoning";

export interface WorkerExecutionRequest {
  task: TaskSpecV1;
  workspace: string;
  runId: string;
  traceId: string;
  attemptId: string;
  tier: WorkerTier;
  timeoutMs: number;
  signal?: AbortSignal;
  failureContext?: string;
}

export interface WorkerExecutionResult {
  status: "succeeded" | "failed" | "cancelled";
  stdout: string;
  stderr: string;
  exitCode?: number;
  failureClass?: FailureClass;
  message?: string;
  conversationId?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export interface WorkerAdapter {
  execute(request: WorkerExecutionRequest): Promise<WorkerExecutionResult>;
}
