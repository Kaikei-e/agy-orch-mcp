/**
 * Atomic budget tracker with reservation semantics.
 *
 * Budget slots must be reserved BEFORE spawning a worker.
 * Wall-time enforcement is handled via a single AbortController
 * whose signal is propagated to all workers and gates.
 */
import type { BudgetV1 } from "../domain/ir.js";

export interface ResolvedBudget {
  maxWorkerCalls: number;
  maxReplans: number;
  maxRepairAttempts: number;
  maxParallelism: number;
  wallTimeMs: number;
}

export function budgetFromV1(b: Required<BudgetV1>): ResolvedBudget {
  return {
    maxWorkerCalls: b.max_worker_calls,
    maxReplans: b.max_replans,
    maxRepairAttempts: b.max_repair_attempts,
    maxParallelism: b.max_parallelism,
    wallTimeMs: b.wall_time_ms,
  };
}

export class BudgetTracker {
  private workerCallsUsed = 0;
  private replansUsed = 0;
  /** Per-gate repair attempts — keyed by gate ID, never reset by fingerprint changes */
  private repairAttemptsPerGate = new Map<string, number>();
  private activeSlots = 0;

  constructor(private readonly budget: ResolvedBudget) {}

  /** Returns a snapshot of current consumption. */
  snapshot(): {
    workerCalls: number;
    replans: number;
    activeSlots: number;
    repairAttempts: Map<string, number>;
  } {
    return {
      workerCalls: this.workerCallsUsed,
      replans: this.replansUsed,
      activeSlots: this.activeSlots,
      repairAttempts: new Map(this.repairAttemptsPerGate),
    };
  }

  get limits(): ResolvedBudget {
    return this.budget;
  }

  get workerCallsRemaining(): number {
    return this.budget.maxWorkerCalls - this.workerCallsUsed;
  }

  get replansRemaining(): number {
    return this.budget.maxReplans - this.replansUsed;
  }

  /** Atomically reserve one worker call slot. Returns false if budget exhausted. */
  reserveWorkerCall(): boolean {
    if (this.workerCallsUsed >= this.budget.maxWorkerCalls) return false;
    if (this.activeSlots >= this.budget.maxParallelism) return false;
    this.workerCallsUsed++;
    this.activeSlots++;
    return true;
  }

  /** Release an active worker slot after completion. */
  releaseSlot(): void {
    if (this.activeSlots > 0) this.activeSlots--;
  }

  /** Check if a parallelism slot is available without consuming worker call budget. */
  hasParallelismSlot(): boolean {
    return this.activeSlots < this.budget.maxParallelism;
  }

  /** Check if worker calls budget is available. */
  hasWorkerCallBudget(): boolean {
    return this.workerCallsUsed < this.budget.maxWorkerCalls;
  }

  /** Consume one replan. Returns false if exhausted. */
  consumeReplan(): boolean {
    if (this.replansUsed >= this.budget.maxReplans) return false;
    this.replansUsed++;
    return true;
  }

  /**
   * Consume one repair attempt for a gate.
   * Repair budgets are per-gate absolute counters that NEVER reset by fingerprint.
   * Returns false if the gate has exhausted its repair budget.
   */
  consumeRepairAttempt(gateId: string): boolean {
    const used = this.repairAttemptsPerGate.get(gateId) ?? 0;
    if (used >= this.budget.maxRepairAttempts) return false;
    this.repairAttemptsPerGate.set(gateId, used + 1);
    return true;
  }

  /** Get repair attempts consumed for a specific gate. */
  gateRepairAttempts(gateId: string): number {
    return this.repairAttemptsPerGate.get(gateId) ?? 0;
  }

  /** Check if any budget is exhausted. */
  isExhausted(): boolean {
    return this.workerCallsUsed >= this.budget.maxWorkerCalls;
  }
}
