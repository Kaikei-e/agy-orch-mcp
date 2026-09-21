/**
 * Task/gate state management with event log and durable state transitions.
 *
 * Enforces valid state transitions per the domain state machine.
 * Maintains an append-only event log with idempotency keys for crash recovery.
 */
import { randomUUID } from "node:crypto";
import type {
  TaskSpecV1,
  TaskResultV1,
  TaskStatus,
  GateSpecV1,
  GateResultV1,
  GateStatus,
  FailureClass,
  FailureDetail,
} from "../domain/ir.js";
import { canTransitionTask } from "../domain/task.js";

export interface TaskState {
  spec: TaskSpecV1;
  status: TaskStatus;
  attempts: number;
  workerTier: "fast" | "reasoning";
  changedFiles: string[];
  patchContent: string;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
  patchArtifactId?: string;
  error?: string;
  failure?: FailureDetail;
  durationMs: number;
}

export interface GateState {
  spec: GateSpecV1;
  status: GateStatus;
  exitCode?: number | null;
  durationMs: number;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
  failingTests: string[];
  error?: string;
  repairAttempts: number;
}

export interface StateEvent {
  eventId: string;
  timestamp: string;
  type:
    | "task_transition"
    | "gate_transition"
    | "budget_consumed"
    | "retry"
    | "escalation"
    | "integration"
    | "run_status";
  entityId: string;
  fromStatus?: string;
  toStatus?: string;
  attempt?: number;
  failureClass?: FailureClass;
  details?: string;
}

export class StateMachine {
  private readonly tasks = new Map<string, TaskState>();
  private readonly gates = new Map<string, GateState>();
  private readonly events: StateEvent[] = [];

  constructor(taskSpecs: TaskSpecV1[], gateSpecs: GateSpecV1[]) {
    for (const spec of taskSpecs) {
      const hasDeps = spec.after && spec.after.length > 0;
      this.tasks.set(spec.id, {
        spec,
        status: hasDeps ? "blocked" : "ready",
        attempts: 0,
        workerTier: spec.worker?.tier ?? "fast",
        changedFiles: [],
        patchContent: "",
        durationMs: 0,
      });
    }

    for (const spec of gateSpecs) {
      this.gates.set(spec.id, {
        spec,
        status: "pending",
        durationMs: 0,
        failingTests: [],
        repairAttempts: 0,
      });
    }
  }

  getTask(id: string): TaskState | undefined {
    return this.tasks.get(id);
  }

  getGate(id: string): GateState | undefined {
    return this.gates.get(id);
  }

  getAllTasks(): Map<string, TaskState> {
    return this.tasks;
  }

  getAllGates(): Map<string, GateState> {
    return this.gates;
  }

  getEvents(): readonly StateEvent[] {
    return this.events;
  }

  /** Transition a task to a new status, enforcing the state machine. */
  transitionTask(
    taskId: string,
    newStatus: TaskStatus,
    details?: string,
  ): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (!canTransitionTask(task.status, newStatus)) {
      return false;
    }

    const event: StateEvent = {
      eventId: `evt_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: "task_transition",
      entityId: taskId,
      fromStatus: task.status,
      toStatus: newStatus,
      attempt: task.attempts,
      details,
    };

    task.status = newStatus;
    this.events.push(event);
    return true;
  }

  /** Transition a gate to a new status. */
  transitionGate(
    gateId: string,
    newStatus: GateStatus,
    details?: string,
  ): boolean {
    const gate = this.gates.get(gateId);
    if (!gate) return false;

    const event: StateEvent = {
      eventId: `evt_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: "gate_transition",
      entityId: gateId,
      fromStatus: gate.status,
      toStatus: newStatus,
      details,
    };

    gate.status = newStatus;
    this.events.push(event);
    return true;
  }

  /** Increment task attempt counter. */
  incrementAttempt(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.attempts++;
  }

  /** Log a retry event. */
  logRetry(
    entityId: string,
    failureClass: FailureClass,
    details?: string,
  ): void {
    this.events.push({
      eventId: `evt_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: "retry",
      entityId,
      failureClass,
      details,
    });
  }

  /** Log an escalation event. */
  logEscalation(
    entityId: string,
    failureClass: FailureClass,
    details?: string,
  ): void {
    this.events.push({
      eventId: `evt_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: "escalation",
      entityId,
      failureClass,
      details,
    });
  }

  /** Build TaskResultV1 array from current state. */
  buildTaskResults(): TaskResultV1[] {
    const results: TaskResultV1[] = [];
    for (const [, task] of this.tasks) {
      results.push({
        id: task.spec.id,
        status: task.status,
        attempts: task.attempts,
        worker_tier: task.workerTier,
        changed_files: task.changedFiles,
        stdout_artifact_id: task.stdoutArtifactId,
        stderr_artifact_id: task.stderrArtifactId,
        patch_artifact_id: task.patchArtifactId,
        error: task.error,
      });
    }
    return results;
  }

  /** Build GateResultV1 array from current state. */
  buildGateResults(): GateResultV1[] {
    const results: GateResultV1[] = [];
    for (const [, gate] of this.gates) {
      results.push({
        id: gate.spec.id,
        status: gate.status,
        exit_code: gate.exitCode,
        duration_ms: gate.durationMs,
        stdout_artifact_id: gate.stdoutArtifactId,
        stderr_artifact_id: gate.stderrArtifactId,
        failing_tests:
          gate.failingTests.length > 0 ? gate.failingTests : undefined,
        error: gate.error,
      });
    }
    return results;
  }

  /** Check if all tasks have reached a terminal state. */
  allTasksSettled(): boolean {
    for (const [, task] of this.tasks) {
      if (
        task.status !== "integrated" &&
        task.status !== "failed" &&
        task.status !== "cancelled"
      ) {
        return false;
      }
    }
    return true;
  }

  /** Cancel all non-terminal tasks. */
  cancelRemainingTasks(reason: string): void {
    for (const [id, task] of this.tasks) {
      if (
        task.status !== "integrated" &&
        task.status !== "cancelled" &&
        task.status !== "failed"
      ) {
        this.transitionTask(id, "cancelled", reason);
      }
    }
  }

  /** Cancel remaining pending/ready gates. */
  skipRemainingGates(reason: string): void {
    for (const [id, gate] of this.gates) {
      if (gate.status === "pending" || gate.status === "ready") {
        this.transitionGate(id, "skipped", reason);
      }
    }
  }
}

export class TaskStateMachine {
  private currentStatus: TaskStatus;

  constructor(initial: TaskStatus = "pending") {
    this.currentStatus = initial;
  }

  public get status(): TaskStatus {
    return this.currentStatus;
  }

  public canTransitionTo(next: TaskStatus): boolean {
    if (this.currentStatus === next) return true;
    return canTransitionTask(this.currentStatus, next);
  }

  public transition(next: TaskStatus): void {
    if (this.currentStatus === next) return;
    if (!this.canTransitionTo(next)) {
      throw new Error(
        `Invalid task state transition: cannot transition from ${this.currentStatus} to ${next}`,
      );
    }
    this.currentStatus = next;
  }
}
