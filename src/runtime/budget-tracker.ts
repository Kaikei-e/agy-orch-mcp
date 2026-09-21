import type { BudgetV1 } from "../domain/ir.js";
import type { ServerLimits } from "../domain/limits.js";

export class BudgetTracker {
  private readonly startTime: number;
  private readonly maxWorkerCalls: number;
  private readonly maxReplans: number;
  private readonly maxRepairAttemptsPerGate: number;
  private readonly maxParallelism: number;
  private readonly wallTimeMs: number;

  private workerCallsCount = 0;
  private replansCount = 0;
  private repairAttemptsByGate: Map<string, number> = new Map();

  constructor(
    taskCount: number,
    requestBudget: BudgetV1 | undefined,
    serverLimits: ServerLimits,
  ) {
    this.startTime = Date.now();

    const reqMaxWorker = requestBudget?.max_worker_calls ?? taskCount + 2;
    this.maxWorkerCalls = Math.min(reqMaxWorker, serverLimits.maxWorkerCalls);

    const reqMaxReplans = requestBudget?.max_replans ?? 1;
    this.maxReplans = Math.min(reqMaxReplans, serverLimits.maxReplans);

    const reqMaxRepair = requestBudget?.max_repair_attempts ?? 1;
    this.maxRepairAttemptsPerGate = Math.min(
      reqMaxRepair,
      serverLimits.maxRepairAttempts,
    );

    const reqMaxParallel =
      requestBudget?.max_parallelism ?? serverLimits.maxParallelism;
    this.maxParallelism = Math.min(reqMaxParallel, serverLimits.maxParallelism);

    const reqWallTime = requestBudget?.wall_time_ms ?? 30 * 60 * 1000;
    this.wallTimeMs = Math.min(reqWallTime, serverLimits.maxWallTimeMs);
  }

  public get parallelism(): number {
    return Math.max(1, this.maxParallelism);
  }

  public get totalWorkerCalls(): number {
    return this.workerCallsCount;
  }

  public get totalReplans(): number {
    return this.replansCount;
  }

  public isWallTimeExceeded(): boolean {
    return Date.now() - this.startTime > this.wallTimeMs;
  }

  public canExecuteWorkerCall(): boolean {
    if (this.isWallTimeExceeded()) return false;
    return this.workerCallsCount < this.maxWorkerCalls;
  }

  public consumeWorkerCall(): void {
    if (!this.canExecuteWorkerCall()) {
      throw new Error(
        `BUDGET_EXHAUSTED: Exceeded maximum allowed worker calls (${this.maxWorkerCalls})`,
      );
    }
    this.workerCallsCount++;
  }

  public canReplan(): boolean {
    if (this.isWallTimeExceeded()) return false;
    return this.replansCount < this.maxReplans;
  }

  public consumeReplan(): void {
    if (!this.canReplan()) {
      throw new Error(
        `BUDGET_EXHAUSTED: Exceeded maximum allowed replans (${this.maxReplans})`,
      );
    }
    this.replansCount++;
  }

  public canRepairGate(gateId: string): boolean {
    if (this.isWallTimeExceeded()) return false;
    if (!this.canExecuteWorkerCall()) return false;
    const current = this.repairAttemptsByGate.get(gateId) ?? 0;
    return current < this.maxRepairAttemptsPerGate;
  }

  public consumeRepair(gateId: string): void {
    if (!this.canRepairGate(gateId)) {
      throw new Error(
        `BUDGET_EXHAUSTED: Exceeded maximum allowed repair attempts for gate ${gateId} (${this.maxRepairAttemptsPerGate})`,
      );
    }
    const current = this.repairAttemptsByGate.get(gateId) ?? 0;
    this.repairAttemptsByGate.set(gateId, current + 1);
    this.consumeWorkerCall();
  }

  public getRepairAttempts(gateId: string): number {
    return this.repairAttemptsByGate.get(gateId) ?? 0;
  }
}
