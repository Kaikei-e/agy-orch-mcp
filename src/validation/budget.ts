import type { BudgetV1 } from "../domain/ir.js";
import {
  DEFAULT_SERVER_LIMITS,
  type ServerLimits,
  type BudgetAdjustment,
} from "../domain/limits.js";

export function resolveEffectiveBudget(
  requested: BudgetV1 | undefined,
  taskCount: number,
  limits: ServerLimits = DEFAULT_SERVER_LIMITS,
): { effective: Required<BudgetV1>; adjustments: BudgetAdjustment[] } {
  const adjustments: BudgetAdjustment[] = [];

  const defaultWorkerCalls = Math.min(taskCount + 2, limits.maxWorkerCalls);
  const requestedWorkerCalls =
    requested?.max_worker_calls ?? defaultWorkerCalls;
  if (
    requested?.max_worker_calls !== undefined &&
    requested.max_worker_calls > limits.maxWorkerCalls
  ) {
    adjustments.push({
      field: "max_worker_calls",
      requested: requested.max_worker_calls,
      applied: limits.maxWorkerCalls,
    });
  }

  const requestedReplans = requested?.max_replans ?? 1;
  if (
    requested?.max_replans !== undefined &&
    requested.max_replans > limits.maxReplans
  ) {
    adjustments.push({
      field: "max_replans",
      requested: requested.max_replans,
      applied: limits.maxReplans,
    });
  }

  const requestedRepairs = requested?.max_repair_attempts ?? 1;
  if (
    requested?.max_repair_attempts !== undefined &&
    requested.max_repair_attempts > limits.maxRepairAttempts
  ) {
    adjustments.push({
      field: "max_repair_attempts",
      requested: requested.max_repair_attempts,
      applied: limits.maxRepairAttempts,
    });
  }

  const requestedParallelism =
    requested?.max_parallelism ?? limits.maxParallelism;
  if (
    requested?.max_parallelism !== undefined &&
    requested.max_parallelism > limits.maxParallelism
  ) {
    adjustments.push({
      field: "max_parallelism",
      requested: requested.max_parallelism,
      applied: limits.maxParallelism,
    });
  }

  const requestedWallTime = requested?.wall_time_ms ?? limits.maxWallTimeMs;
  if (
    requested?.wall_time_ms !== undefined &&
    requested.wall_time_ms > limits.maxWallTimeMs
  ) {
    adjustments.push({
      field: "wall_time_ms",
      requested: requested.wall_time_ms,
      applied: limits.maxWallTimeMs,
    });
  }

  const effective: Required<BudgetV1> = {
    max_worker_calls: Math.min(requestedWorkerCalls, limits.maxWorkerCalls),
    max_replans: Math.min(requestedReplans, limits.maxReplans),
    max_repair_attempts: Math.min(requestedRepairs, limits.maxRepairAttempts),
    max_parallelism: Math.min(requestedParallelism, limits.maxParallelism),
    wall_time_ms: Math.min(requestedWallTime, limits.maxWallTimeMs),
  };

  return { effective, adjustments };
}

export function validateTotalStringBytes(
  values: string[],
  maxBytes = DEFAULT_SERVER_LIMITS.maxTotalStringBytes,
): void {
  let total = 0;
  for (const s of values) {
    total += Buffer.byteLength(s, "utf8");
    if (total > maxBytes) {
      throw new Error(
        `Total input string payload (${total} bytes) exceeds limit of ${maxBytes} bytes`,
      );
    }
  }
}
