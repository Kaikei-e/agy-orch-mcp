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
  maxWorkerCalls: 30,
  maxReplans: 2,
  maxRepairAttempts: 3,
  maxParallelism: 4,
  maxWallTimeMs: 1_800_000, // 30 mins
  maxArtifactBytesPerRun: 50 * 1024 * 1024, // 50MB
  maxDigestTokens: 2000,
  maxFetchBytes: 2 * 1024 * 1024, // 2MB
  maxFetchLines: 1000,
  maxTotalStringBytes: 512 * 1024, // 512KB for request strings
};

export function resolveEffectiveBudget(
  requested: BudgetV1,
  limits: ServerLimits,
): BudgetV1 {
  return {
    max_worker_calls: Math.min(
      requested.max_worker_calls ?? limits.maxWorkerCalls,
      limits.maxWorkerCalls,
    ),
    max_replans: Math.min(
      requested.max_replans ?? limits.maxReplans,
      limits.maxReplans,
    ),
    max_repair_attempts: Math.min(
      requested.max_repair_attempts ?? limits.maxRepairAttempts,
      limits.maxRepairAttempts,
    ),
    max_parallelism: Math.min(
      requested.max_parallelism ?? limits.maxParallelism,
      limits.maxParallelism,
    ),
    wall_time_ms: Math.min(
      requested.wall_time_ms ?? limits.maxWallTimeMs,
      limits.maxWallTimeMs,
    ),
  };
}
