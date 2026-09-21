import type { BudgetV1 } from "../domain/ir.js";
import { DEFAULT_SERVER_LIMITS, type ServerLimits } from "../domain/limits.js";

export function resolveEffectiveBudget(
  requested: BudgetV1 | undefined,
  taskCount: number,
  limits: ServerLimits = DEFAULT_SERVER_LIMITS,
): { effective: Required<BudgetV1>; errors: string[] } {
  const errors: string[] = [];

  const defaultWorkerCalls = Math.min(taskCount + 2, limits.maxWorkerCalls);
  const requestedWorkerCalls =
    requested?.max_worker_calls ?? defaultWorkerCalls;
  if (requestedWorkerCalls > limits.maxWorkerCalls) {
    errors.push(
      `max_worker_calls (${requestedWorkerCalls}) exceeds server limit (${limits.maxWorkerCalls})`,
    );
  }

  const requestedReplans = requested?.max_replans ?? 1;
  if (requestedReplans > limits.maxReplans) {
    errors.push(
      `max_replans (${requestedReplans}) exceeds server limit (${limits.maxReplans})`,
    );
  }

  const requestedRepairs = requested?.max_repair_attempts ?? 1;
  if (requestedRepairs > limits.maxRepairAttempts) {
    errors.push(
      `max_repair_attempts (${requestedRepairs}) exceeds server limit (${limits.maxRepairAttempts})`,
    );
  }

  const requestedParallelism =
    requested?.max_parallelism ?? limits.maxParallelism;
  if (requestedParallelism > limits.maxParallelism) {
    errors.push(
      `max_parallelism (${requestedParallelism}) exceeds server limit (${limits.maxParallelism})`,
    );
  }

  const requestedWallTime = requested?.wall_time_ms ?? limits.maxWallTimeMs;
  if (requestedWallTime > limits.maxWallTimeMs) {
    errors.push(
      `wall_time_ms (${requestedWallTime}) exceeds server limit (${limits.maxWallTimeMs})`,
    );
  }

  const effective: Required<BudgetV1> = {
    max_worker_calls: Math.min(requestedWorkerCalls, limits.maxWorkerCalls),
    max_replans: Math.min(requestedReplans, limits.maxReplans),
    max_repair_attempts: Math.min(requestedRepairs, limits.maxRepairAttempts),
    max_parallelism: Math.min(requestedParallelism, limits.maxParallelism),
    wall_time_ms: Math.min(requestedWallTime, limits.maxWallTimeMs),
  };

  return { effective, errors };
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
