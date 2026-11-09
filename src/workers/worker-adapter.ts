import type { TaskSpecV1 } from "../domain/ir.js";
import type { FailureClass } from "../domain/failure.js";
import type {
  WorkerTier,
  WorkerExecutionRequest as BaseWorkerExecutionRequest,
  WorkerExecutionResult as BaseWorkerExecutionResult,
} from "../domain/execution.js";

export interface WorkerExecutionRequest extends BaseWorkerExecutionRequest {
  resume?: {
    consume: () => boolean;
  };
}

export interface WorkerExecutionResult extends BaseWorkerExecutionResult {
  turns?: number;
}

export interface WorkerAdapter {
  execute(request: WorkerExecutionRequest): Promise<WorkerExecutionResult>;
}

export type { WorkerTier, TaskSpecV1, FailureClass };
