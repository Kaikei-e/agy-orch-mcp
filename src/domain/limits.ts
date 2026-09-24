import type { BudgetV1 } from "./ir.js";

export interface ServerLimits {
  maxTasks: number;
  maxGates: number;
  maxWorkerCalls: number;
  maxReplans: number;
  maxRepairAttempts: number;
  maxParallelism: number;
  maxWallTimeMs: number;
  maxArtifactBytesPerRun: number;
  maxDigestTokens: number;
  maxFetchBytes: number;
  maxFetchLines: number;
  maxTotalStringBytes: number;
}

export const DEFAULT_SERVER_LIMITS: ServerLimits = {
  maxTasks: 20,
  maxGates: 10,
  maxWorkerCalls: 50,
  maxReplans: 2,
  maxRepairAttempts: 3,
  maxParallelism: 4,
  maxWallTimeMs: 7_200_000, // 2 hours
  maxArtifactBytesPerRun: 50 * 1024 * 1024, // 50MB
  maxDigestTokens: 2000,
  maxFetchBytes: 2 * 1024 * 1024, // 2MB
  maxFetchLines: 1000,
  maxTotalStringBytes: 512 * 1024, // 512KB for request strings
};

export interface BudgetAdjustment {
  field:
    | "max_worker_calls"
    | "max_replans"
    | "max_repair_attempts"
    | "max_parallelism"
    | "wall_time_ms";
  requested: number;
  applied: number;
}

export function resolveEffectiveBudget(
  requested: BudgetV1 | undefined,
  limits: ServerLimits,
): { effective: BudgetV1; adjustments: BudgetAdjustment[] } {
  const adjustments: BudgetAdjustment[] = [];
  if (!requested) {
    return { effective: {}, adjustments };
  }

  const effective: BudgetV1 = { ...requested };

  if (
    requested.max_worker_calls !== undefined &&
    requested.max_worker_calls > limits.maxWorkerCalls
  ) {
    adjustments.push({
      field: "max_worker_calls",
      requested: requested.max_worker_calls,
      applied: limits.maxWorkerCalls,
    });
    effective.max_worker_calls = limits.maxWorkerCalls;
  }

  if (
    requested.max_replans !== undefined &&
    requested.max_replans > limits.maxReplans
  ) {
    adjustments.push({
      field: "max_replans",
      requested: requested.max_replans,
      applied: limits.maxReplans,
    });
    effective.max_replans = limits.maxReplans;
  }

  if (
    requested.max_repair_attempts !== undefined &&
    requested.max_repair_attempts > limits.maxRepairAttempts
  ) {
    adjustments.push({
      field: "max_repair_attempts",
      requested: requested.max_repair_attempts,
      applied: limits.maxRepairAttempts,
    });
    effective.max_repair_attempts = limits.maxRepairAttempts;
  }

  if (
    requested.max_parallelism !== undefined &&
    requested.max_parallelism > limits.maxParallelism
  ) {
    adjustments.push({
      field: "max_parallelism",
      requested: requested.max_parallelism,
      applied: limits.maxParallelism,
    });
    effective.max_parallelism = limits.maxParallelism;
  }

  if (
    requested.wall_time_ms !== undefined &&
    requested.wall_time_ms > limits.maxWallTimeMs
  ) {
    adjustments.push({
      field: "wall_time_ms",
      requested: requested.wall_time_ms,
      applied: limits.maxWallTimeMs,
    });
    effective.wall_time_ms = limits.maxWallTimeMs;
  }

  return { effective, adjustments };
}
