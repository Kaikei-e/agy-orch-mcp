/**
 * DAG execution scheduler with greedy parallel dispatch,
 * worktree isolation, deterministic integration order,
 * bounded retry/repair, and artifact-only delivery.
 *
 * Integration order: topological depth as primary key,
 * task.id lexicographic as secondary key.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Config as BridgeConfig } from "../config.js";
import type {
  BatchRequestV1,
  BatchResponseV1,
  GateResultV1,
  GateSpecV1,
  RunManifestV1,
  TaskResultV1,
  TaskSpecV1,
} from "../domain/ir.js";
import type {
  WorkerAdapter,
  WorkerExecutionRequest,
  WorkerTier,
} from "../domain/execution.js";
import type { FailureClass } from "../domain/failure.js";
import { validateDag } from "../validation/dag.js";
import { resolveEffectiveBudget as resolveBudgetValidation } from "../validation/budget.js";
import type { ServerLimits, BudgetAdjustment } from "../domain/limits.js";
import { DEFAULT_SERVER_LIMITS } from "../domain/limits.js";
import { StateMachine } from "./state-machine.js";
import { BudgetTracker, budgetFromV1 } from "./budget.js";
import { CancellationManager } from "./cancellation.js";
import {
  classifyWorkerFailure,
  classifyGateFailure,
} from "../workers/failure-classifier.js";
import {
  resolveModel,
  canEscalateToReasoning,
  type ModelRoutingConfig,
  DEFAULT_ROUTING,
} from "../workers/routing-policy.js";
import { createAntigravityWorker } from "../workers/antigravity-worker.js";
import { buildRepairTaskSpec, findAffectedGateIds } from "./repair.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { GateRunner } from "../gates/gate-runner.js";
import type { OutputParser } from "../gates/output-parser.js";
import { GenericParser } from "../gates/parsers/generic.js";
import { VitestParser } from "../gates/parsers/vitest.js";
import { JestParser } from "../gates/parsers/jest.js";
import { GoTestParser } from "../gates/parsers/go-test.js";
import { NodeTapParser } from "../gates/parsers/tap.js";
import {
  GitRepository,
  WorktreeManager,
  PatchCollector,
  PatchIntegrator,
  OwnershipValidator,
} from "../workspace/index.js";
import { inspectPatchForSecrets } from "../artifacts/redaction.js";
import { createMetricsTracker, finalizeMetrics } from "../telemetry/metrics.js";
import { TelemetryLogger } from "../telemetry/events.js";
import {
  buildDeterministicDigest,
  estimateMinimalDigestTokens,
} from "../digest/deterministic.js";

export type { BridgeConfig };

export interface BatchRuntimeOptions {
  store: ArtifactStore;
  config: BridgeConfig;
  worker?: WorkerAdapter;
  signal?: AbortSignal;
}

export interface SchedulerOptions {
  request: BatchRequestV1;
  store: ArtifactStore;
  config: BridgeConfig;
  worker?: WorkerAdapter;
  gateRunner?: GateRunner;
  limits?: ServerLimits;
  routing?: ModelRoutingConfig;
  outputParser?: OutputParser;
  parentSignal?: AbortSignal;
  traceId?: string;
}

export interface SchedulerResult {
  response: BatchResponseV1;
  finalPatch: string;
}

/**
 * Compute topological depth of each task for deterministic integration ordering.
 * Depth = 1 + max(depth of predecessors), or 0 if no predecessors.
 */
function computeDepths(tasks: TaskSpecV1[]): Map<string, number> {
  const depths = new Map<string, number>();
  const taskMap = new Map<string, TaskSpecV1>();
  for (const t of tasks) taskMap.set(t.id, t);

  function depth(id: string): number {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const task = taskMap.get(id);
    if (!task || !task.after || task.after.length === 0) {
      depths.set(id, 0);
      return 0;
    }
    let maxDep = 0;
    for (const dep of task.after) {
      maxDep = Math.max(maxDep, depth(dep) + 1);
    }
    depths.set(id, maxDep);
    return maxDep;
  }

  for (const t of tasks) depth(t.id);
  return depths;
}

/**
 * Build deterministic canonical integration order:
 * Primary key: topological depth (ascending)
 * Secondary key: task.id lexicographic (ascending)
 */
function canonicalOrder(tasks: TaskSpecV1[]): string[] {
  const depths = computeDepths(tasks);
  return tasks
    .map((t) => t.id)
    .sort((a, b) => {
      const da = depths.get(a) ?? 0;
      const db = depths.get(b) ?? 0;
      if (da !== db) return da - db;
      return a.localeCompare(b);
    });
}

function selectParser(command: string[]): OutputParser {
  const cmdStr = command.join(" ").toLowerCase();
  if (cmdStr.includes("vitest")) return new VitestParser();
  if (cmdStr.includes("jest")) return new JestParser();
  if (cmdStr.includes("go test")) return new GoTestParser();
  if (cmdStr.includes("tap") || cmdStr.includes("--test"))
    return new NodeTapParser();
  return new GenericParser();
}

export class Scheduler {
  private readonly state: StateMachine;
  private readonly budget: BudgetTracker;
  private readonly cancellation: CancellationManager;
  private readonly metrics;
  private readonly sortedTaskIds: string[];
  private readonly canonicalTaskOrder: string[];
  private readonly dagResult;
  private readonly unresolved: BatchResponseV1["unresolved"] = [];
  private readonly traceId: string;
  private readonly runId: string;
  private readonly worker: WorkerAdapter;
  private readonly allTasksMap: Map<string, TaskSpecV1>;
  private readonly allGatesMap: Map<string, GateSpecV1>;
  private readonly gateRunner: GateRunner;
  private readonly routing: ModelRoutingConfig;
  private readonly startTime = Date.now();
  private readonly wallTimeMs: number;
  private readonly telemetry: TelemetryLogger;
  private readonly budgetAdjustments: BudgetAdjustment[];

  constructor(private readonly opts: SchedulerOptions) {
    this.traceId = opts.traceId ?? `tr_${randomUUID().slice(0, 8)}`;
    this.runId = `run_${randomUUID().slice(0, 12)}`;
    this.metrics = createMetricsTracker();
    this.telemetry = new TelemetryLogger(opts.store);

    // Worker resolution: fallback to static factory
    this.worker = opts.worker ?? createAntigravityWorker(opts.config);

    // Gate runner initialization
    this.gateRunner =
      opts.gateRunner ??
      new GateRunner({
        allowedExecutables: ["*"],
        deniedExecutables: [],
        allowedEnvKeys: ["PATH", "HOME", "NODE_ENV", "LANG", "LC_ALL"],
        maxOutputBytes: 10 * 1024 * 1024,
      });

    // Model routing configuration wired to BridgeConfig
    this.routing = opts.routing ?? {
      tiers: {
        fast: { model: opts.config.fastModel ?? opts.config.defaultModel },
        reasoning: { model: opts.config.reasoningModel },
      },
    };

    // Validate DAG before anything
    this.dagResult = validateDag(opts.request.tasks, opts.request.gates ?? []);

    // Resolve effective budget
    const limits = opts.limits ?? opts.config.limits ?? DEFAULT_SERVER_LIMITS;
    const { effective, adjustments } = resolveBudgetValidation(
      opts.request.budget,
      opts.request.tasks.length,
      limits,
    );
    this.budgetAdjustments =
      opts.request.budget_adjustments &&
      opts.request.budget_adjustments.length > 0
        ? opts.request.budget_adjustments
        : adjustments;
    this.budget = new BudgetTracker(budgetFromV1(effective));
    this.wallTimeMs = effective.wall_time_ms;

    // Wall-time cancellation
    this.cancellation = new CancellationManager(
      effective.wall_time_ms,
      opts.parentSignal,
    );

    // State machine
    this.state = new StateMachine(opts.request.tasks, opts.request.gates ?? []);

    this.allTasksMap = new Map(opts.request.tasks.map((t) => [t.id, t]));
    this.allGatesMap = new Map(
      (opts.request.gates ?? []).map((g) => [g.id, g]),
    );

    this.sortedTaskIds = this.dagResult.sortedTaskIds;
    this.canonicalTaskOrder = canonicalOrder(opts.request.tasks);
  }

  private checkpointManifest(status?: RunManifestV1["status"]): void {
    try {
      const manifest = this.opts.store.loadManifest(this.runId);
      if (manifest) {
        if (status) manifest.status = status;
        manifest.updated_at = new Date().toISOString();
        for (const [id, t] of this.state.getAllTasks()) {
          manifest.tasks[id] = {
            status: t.status,
            attempts: t.attempts,
          };
        }
        for (const [id, g] of this.state.getAllGates()) {
          manifest.gates[id] = {
            status: g.status,
          };
        }
        this.opts.store.saveManifest(manifest);
      }
    } catch {
      // Non-fatal manifest checkpoint
    }
  }

  private getRemainingWallTimeMs(): number {
    const elapsed = Date.now() - this.startTime;
    return Math.max(0, this.wallTimeMs - elapsed);
  }

  /**
   * Execute the batch request.
   * Returns the full BatchResponseV1 and the final binary patch.
   */
  async execute(): Promise<SchedulerResult> {
    const req = this.opts.request;

    // Pre-validation: DAG must be valid
    if (!this.dagResult.valid) {
      return this.buildErrorResponse(
        "failed",
        `DAG validation failed: ${this.dagResult.errors.join("; ")}`,
      );
    }

    // Preflight capacity validation before any worker, artifact, or worktree side effects
    const requestedMaxTokens = req.return?.max_tokens;
    if (requestedMaxTokens !== undefined) {
      const minTokens = estimateMinimalDigestTokens({
        runId: this.runId,
        status: "failed",
        summary: "failed",
        tasks: req.tasks.map((t) => ({
          id: t.id,
          status: "failed",
          attempts: 1,
          worker_tier: t.worker?.tier ?? "fast",
          changed_files: [],
        })),
        gates: (req.gates ?? []).map((g) => ({
          id: g.id,
          status: "failed",
          duration_ms: 0,
          failing_tests: [],
          exit_code: 1,
        })),
        metrics: {
          duration_ms: 0,
          worker_calls: req.tasks.length,
          retries: 0,
          escalations: 0,
          raw_output_bytes: 0,
          digest_tokens_estimated: 0,
        },
        maxTokens: requestedMaxTokens,
      });

      if (minTokens > requestedMaxTokens) {
        return this.buildErrorResponse(
          "failed",
          `CAPACITY_EXCEEDED: Requested max_tokens (${requestedMaxTokens}) is insufficient for minimal response skeleton (${minTokens} tokens required for ${req.tasks.length} tasks and ${(req.gates ?? []).length} gates).`,
          "CAPACITY_EXCEEDED",
        );
      }
    }

    const repo = new GitRepository(req.workspace.root);
    let baseRevision: string;
    try {
      const isDirty = await repo.checkDirty();
      if (isDirty) {
        return this.buildErrorResponse(
          "failed",
          `workspace has uncommitted changes; commit or stash, then retry (root: ${req.workspace.root}). dirty_policy: "reject" requires a clean repository.`,
          "POLICY_DENIED",
        );
      }
      const requestedRef = req.workspace.base_revision ?? "HEAD";
      baseRevision = await repo.getBaseRevision(requestedRef);
    } catch (err) {
      return this.buildErrorResponse(
        "failed",
        `Workspace error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Initialize artifact store run with resolved immutable commit SHA and traceId
    this.opts.store.initRun(
      this.runId,
      req.workspace.root,
      baseRevision,
      this.traceId,
    );

    // Persist normalized and redacted request.json
    try {
      this.opts.store.saveArtifact({
        id: "art_request",
        runId: this.runId,
        kind: "manifest",
        relativePath: "request.json",
        content: JSON.stringify(req, null, 2),
        mimeType: "application/json",
      });
    } catch {
      // Non-fatal request artifact persistence
    }

    // Persist execution plan.json
    try {
      this.opts.store.saveArtifact({
        id: "art_plan",
        runId: this.runId,
        kind: "plan",
        relativePath: "plan.json",
        content: JSON.stringify(
          {
            run_id: this.runId,
            trace_id: this.traceId,
            base_revision: baseRevision,
            canonical_task_order: this.canonicalTaskOrder,
            sorted_task_ids: this.sortedTaskIds,
            tasks: req.tasks.map((t) => ({
              id: t.id,
              objective: t.objective,
              after: t.after ?? [],
              owns: t.owns,
              worker: t.worker,
            })),
            gates: (req.gates ?? []).map((g) => ({
              id: g.id,
              after: g.after,
              command: g.command,
            })),
          },
          null,
          2,
        ),
        mimeType: "application/json",
      });
    } catch {
      // Non-fatal plan artifact persistence
    }

    // Emit run_start telemetry event
    this.telemetry.logEvent({
      trace_id: this.traceId,
      run_id: this.runId,
      timestamp: new Date().toISOString(),
      event_type: "run_start",
    });

    // Create worktree manager
    const worktreeManager = new WorktreeManager(
      repo,
      this.runId,
      this.opts.config.storageDir,
    );
    try {
      await worktreeManager.init();
    } catch (err) {
      return this.buildErrorResponse(
        "failed",
        `Worktree init error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Create integration worktree
    let integrationPath: string;
    try {
      integrationPath = await worktreeManager.createIntegrationWorktree(
        baseRevision,
        { signal: this.cancellation.signal },
      );
    } catch (err) {
      return this.buildErrorResponse(
        "failed",
        `Integration worktree error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const completedPatches = new Map<string, string>();
    const completedFiles = new Map<string, string[]>();
    const worktreePaths = new Map<string, string>();

    try {
      // ===== TASK EXECUTION PHASE =====
      await this.executeTaskPhase(
        worktreeManager,
        baseRevision,
        completedPatches,
        completedFiles,
        worktreePaths,
      );

      // ===== INTEGRATION PHASE =====
      if (this.cancellation.isAborted) {
        // Mark any task that completed execution but was not yet integrated as cancelled
        for (const [id, t] of this.state.getAllTasks()) {
          if (t.status === "succeeded" || t.status === "integrating") {
            try {
              this.state.transitionTask(
                id,
                "cancelled",
                "Cancelled before integration",
              );
            } catch {
              // ignore
            }
          }
        }
      } else {
        const integrator = new PatchIntegrator(integrationPath);
        for (const taskId of this.canonicalTaskOrder) {
          if (this.cancellation.isAborted) {
            for (const [id, t] of this.state.getAllTasks()) {
              if (t.status === "succeeded" || t.status === "integrating") {
                try {
                  this.state.transitionTask(
                    id,
                    "cancelled",
                    "Cancelled before integration",
                  );
                } catch {
                  // ignore
                }
              }
            }
            break;
          }

          const task = this.state.getTask(taskId);
          if (!task || task.status !== "succeeded") continue;

          const patch = completedPatches.get(taskId);
          if (!patch || !patch.trim()) {
            this.state.transitionTask(taskId, "integrating");
            this.state.transitionTask(taskId, "integrated", "empty patch");
            continue;
          }

          this.state.transitionTask(taskId, "integrating");
          try {
            await integrator.applyPatch(patch);
            await integrator.commitAsBaseline(`Integrate task ${taskId}`);
            this.state.transitionTask(taskId, "integrated");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.state.transitionTask(taskId, "failed", msg);
            task.error = msg;

            this.unresolved.push({
              code: "PATCH_CONFLICT",
              message: `Integration conflict for task ${taskId}: ${msg}`,
              task_id: taskId,
              host_decision_required: true,
            });

            this.cancelDependents(taskId);
          }
        }
      }

      // ===== GATE EXECUTION PHASE =====
      if (!this.cancellation.isAborted && this.state.getAllGates().size > 0) {
        await this.executeGatePhase(
          integrationPath,
          baseRevision,
          worktreeManager,
        );
      }

      // ===== FINAL PATCH & ARTIFACT DELIVERY =====
      // Partial result is allowed: collect patch of cleanly integrated tasks!
      let finalPatch = "";
      try {
        const patchCollector = new PatchCollector(integrationPath);
        finalPatch = await patchCollector.collectPatch(baseRevision, {
          signal: this.cancellation.signal,
        });
      } catch (err) {
        throw new Error(
          `Failed to collect final integration patch: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (finalPatch.trim()) {
        const secretCheck = inspectPatchForSecrets(finalPatch);
        if (!secretCheck.safe) {
          const secretMsg = `POLICY_DENIED: ${secretCheck.reason ?? "Secret detected in final patch."}`;
          this.unresolved.push({
            code: "POLICY_DENIED",
            message: secretMsg,
            host_decision_required: true,
          });
          throw new Error(secretMsg);
        }

        try {
          this.opts.store.saveArtifact({
            runId: this.runId,
            kind: "patch",
            relativePath: "integration/final.patch",
            content: finalPatch,
            mimeType: "text/x-diff",
          });
        } catch (saveErr) {
          const saveMsg = `STORAGE_ERROR: Failed to save final patch artifact: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`;
          throw new Error(saveMsg);
        }
      }

      // Overall status computation
      const overallStatus = this.computeOverallStatus();

      const taskResults: TaskResultV1[] = this.state.buildTaskResults();
      const gateResults: GateResultV1[] = this.state.buildGateResults();
      const finalizedMetrics = finalizeMetrics(this.metrics);

      const summary = this.buildSummary(overallStatus);

      // Deterministic Digest
      let digest;
      try {
        digest = buildDeterministicDigest(
          {
            runId: this.runId,
            status: overallStatus,
            summary,
            tasks: taskResults,
            gates: gateResults,
            budget_adjustments:
              this.budgetAdjustments.length > 0
                ? this.budgetAdjustments
                : undefined,
            unresolved: this.unresolved,
            metrics: finalizedMetrics,
            maxTokens: req.return?.max_tokens,
          },
          this.opts.store,
        );
      } catch (digestErr) {
        // Do not wrap CAPACITY_EXCEEDED as fake STORAGE_ERROR
        if (
          (digestErr as any)?.code === "CAPACITY_EXCEEDED" ||
          String(digestErr).includes("CAPACITY_EXCEEDED")
        ) {
          throw digestErr;
        }
        throw new Error(
          `STORAGE_ERROR: Failed to persist run digest: ${digestErr instanceof Error ? digestErr.message : String(digestErr)}`,
        );
      }

      // Terminal Manifest Update - must succeed to guarantee truthful artifact delivery
      try {
        const finalManifest = this.opts.store.loadManifest(this.runId);
        if (!finalManifest) {
          throw new Error(`Manifest not found for run ${this.runId}`);
        }
        finalManifest.status = overallStatus;
        finalManifest.updated_at = new Date().toISOString();
        for (const [id, t] of this.state.getAllTasks()) {
          finalManifest.tasks[id] = {
            status: t.status,
            attempts: t.attempts,
          };
        }
        for (const [id, g] of this.state.getAllGates()) {
          finalManifest.gates[id] = {
            status: g.status,
          };
        }
        this.opts.store.saveManifest(finalManifest);
      } catch (manifestErr) {
        throw new Error(
          `STORAGE_ERROR: Failed to update terminal manifest: ${manifestErr instanceof Error ? manifestErr.message : String(manifestErr)}`,
        );
      }

      try {
        this.telemetry.logEvent({
          trace_id: this.traceId,
          run_id: this.runId,
          timestamp: new Date().toISOString(),
          event_type: "run_finish",
          status: overallStatus,
          duration_ms: finalizedMetrics.duration_ms,
          metrics: {
            raw_output_bytes: finalizedMetrics.raw_output_bytes,
            digest_tokens_estimated: finalizedMetrics.digest_tokens_estimated,
            response_bytes: Buffer.byteLength(
              JSON.stringify(digest.response),
              "utf8",
            ),
          },
        });
      } catch {
        // Non-fatal telemetry failure
      }

      return {
        response: digest.response,
        finalPatch,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isCapacityExceeded =
        (err as any)?.code === "CAPACITY_EXCEEDED" ||
        errorMsg.includes("CAPACITY_EXCEEDED");
      const isPolicyDenied = errorMsg.includes("POLICY_DENIED");
      const failureCode: FailureClass = isCapacityExceeded
        ? "CAPACITY_EXCEEDED"
        : isPolicyDenied
          ? "POLICY_DENIED"
          : "INTERNAL_ERROR";

      if (!this.unresolved.some((u) => u.message === errorMsg)) {
        this.unresolved.push({
          code: failureCode,
          message: errorMsg,
          host_decision_required: true,
        });
      }

      const errorRecoveryPointer = (err as any)?.recovery_pointer;

      // Cancel any unintegrated or unfinished tasks
      for (const [id, t] of this.state.getAllTasks()) {
        if (
          t.status !== "integrated" &&
          t.status !== "failed" &&
          t.status !== "cancelled"
        ) {
          try {
            this.state.transitionTask(id, "cancelled", errorMsg);
          } catch {
            // ignore
          }
        }
      }

      const taskResults = this.state.buildTaskResults();
      const gateResults = this.state.buildGateResults();
      const finalizedMetrics = finalizeMetrics(this.metrics);

      // Terminal manifest update
      try {
        const manifest = this.opts.store.loadManifest(this.runId);
        if (manifest) {
          manifest.status = "failed";
          manifest.updated_at = new Date().toISOString();
          for (const [id, t] of this.state.getAllTasks()) {
            manifest.tasks[id] = {
              status: t.status,
              attempts: t.attempts,
            };
          }
          for (const [id, g] of this.state.getAllGates()) {
            manifest.gates[id] = {
              status: g.status,
            };
          }
          this.opts.store.saveManifest(manifest);
        }
      } catch {
        // ignore
      }

      // Return typed failed response with error info, preserving run_id and recovery pointers if available
      let response: BatchResponseV1;
      try {
        const digest = buildDeterministicDigest(
          {
            runId: this.runId,
            status: "failed",
            summary: `Execution failed: ${errorMsg}`,
            tasks: taskResults,
            gates: gateResults,
            unresolved: this.unresolved,
            metrics: finalizedMetrics,
            maxTokens: req.return?.max_tokens,
          },
          this.opts.store,
        );
        response = digest.response;
        if (errorRecoveryPointer) {
          response.recovery_pointer = errorRecoveryPointer;
        }
      } catch {
        // If store unavailable or digest fails, honestly return typed failed response without claiming success
        response = {
          schema_version: "1",
          run_id: this.runId,
          status: "failed",
          summary: `Execution failed (artifact store unavailable): ${errorMsg}`,
          tasks: taskResults,
          gates: gateResults,
          unresolved: this.unresolved,
          artifacts: [],
          metrics: finalizedMetrics,
          ...(errorRecoveryPointer
            ? { recovery_pointer: errorRecoveryPointer }
            : {}),
        };
      }

      try {
        this.telemetry.logEvent({
          trace_id: this.traceId,
          run_id: this.runId,
          timestamp: new Date().toISOString(),
          event_type: "run_finish",
          status: "failed",
          duration_ms: finalizedMetrics.duration_ms,
          metrics: {
            raw_output_bytes: finalizedMetrics.raw_output_bytes,
            digest_tokens_estimated: finalizedMetrics.digest_tokens_estimated,
            response_bytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
          },
        });
      } catch {
        // Non-fatal telemetry failure
      }

      return {
        response,
        finalPatch: "",
      };
    } finally {
      // Cleanup all active detached worktrees
      for (const [, wtPath] of worktreePaths) {
        try {
          await worktreeManager.removeWorktree(wtPath);
        } catch {
          // Non-fatal cleanup
        }
      }
      try {
        await worktreeManager.removeWorktree(integrationPath);
      } catch {
        // Non-fatal cleanup
      }
      this.cancellation.dispose();
    }
  }

  /**
   * Greedy task execution loop.
   * Tasks become ready as soon as all their predecessors have succeeded!
   */
  private async executeTaskPhase(
    worktreeManager: WorktreeManager,
    baseRevision: string,
    completedPatches: Map<string, string>,
    completedFiles: Map<string, string[]>,
    worktreePaths: Map<string, string>,
  ): Promise<void> {
    const running = new Map<string, Promise<void>>();

    const tick = async () => {
      if (this.cancellation.isAborted) {
        this.state.cancelRemainingTasks("run cancelled");
        return;
      }

      // Check which blocked tasks become ready
      for (const taskId of this.sortedTaskIds) {
        const task = this.state.getTask(taskId);
        if (!task) continue;

        if (task.status === "blocked") {
          const deps = task.spec.after ?? [];
          // Predecessors must have succeeded or integrated to unlock dependent task
          const allDepsSucceeded = deps.every((d) => {
            const dep = this.state.getTask(d);
            return (
              dep && (dep.status === "succeeded" || dep.status === "integrated")
            );
          });
          const anyDepFailed = deps.some((d) => {
            const dep = this.state.getTask(d);
            return (
              dep && (dep.status === "failed" || dep.status === "cancelled")
            );
          });

          if (anyDepFailed) {
            this.state.transitionTask(taskId, "cancelled", "dependency failed");
            continue;
          }

          if (allDepsSucceeded) {
            this.state.transitionTask(taskId, "ready");
          }
        }
      }

      // Launch ready tasks up to available slots
      for (const taskId of this.sortedTaskIds) {
        const task = this.state.getTask(taskId);
        if (!task || task.status !== "ready") continue;
        if (running.has(taskId)) continue;
        if (!this.budget.reserveWorkerCall()) break;

        const promise = this.executeTask(
          taskId,
          worktreeManager,
          baseRevision,
          completedPatches,
          completedFiles,
          worktreePaths,
        ).finally(() => {
          this.budget.releaseSlot();
          running.delete(taskId);
        });
        running.set(taskId, promise);
      }
    };

    // Main scheduler loop
    await tick();
    while (running.size > 0) {
      await Promise.race([...running.values()]);
      await tick();
    }
  }

  private async executeTask(
    taskId: string,
    worktreeManager: WorktreeManager,
    baseRevision: string,
    completedPatches: Map<string, string>,
    completedFiles: Map<string, string[]>,
    worktreePaths: Map<string, string>,
  ): Promise<void> {
    const task = this.state.getTask(taskId);
    if (!task) return;

    this.state.transitionTask(taskId, "running");
    this.state.incrementAttempt(taskId);
    this.metrics.workerCalls++;
    this.checkpointManifest();
    try {
      this.telemetry.logEvent({
        trace_id: this.traceId,
        run_id: this.runId,
        timestamp: new Date().toISOString(),
        event_type: "task_start",
        task_id: taskId,
        attempt: task.attempts,
      });
    } catch {}

    const worktreeId = `${taskId}_att${task.attempts}`;
    let worktreePath = "";
    try {
      // Create attempt-specific worktree so retry does not collide with previous attempt
      try {
        worktreePath = await worktreeManager.createDetachedWorktree(
          worktreeId,
          baseRevision,
        );
        worktreePaths.set(worktreeId, worktreePath);
      } catch (err) {
        task.error = err instanceof Error ? err.message : String(err);
        this.state.transitionTask(taskId, "failed", task.error);
        return;
      }

      // Apply transitive predecessor patches to create task baseline
      const allDeps = this.getTransitiveDeps(taskId);
      let taskBaseRevision = baseRevision;
      const integrator = new PatchIntegrator(worktreePath);
      for (const depId of this.canonicalTaskOrder) {
        if (!allDeps.has(depId)) continue;
        const patch = completedPatches.get(depId);
        if (patch && patch.trim()) {
          try {
            await integrator.applyPatch(patch);
            taskBaseRevision = await integrator.commitAsBaseline(
              `Predecessor baseline from ${depId} for task ${taskId}`,
            );
          } catch (err) {
            task.error = `Failed to apply predecessor patch from ${depId}: ${err instanceof Error ? err.message : String(err)}`;
            this.state.transitionTask(taskId, "failed", task.error);
            try {
              await worktreeManager.removeWorktree(worktreePath);
              worktreePaths.delete(worktreeId);
            } catch {
              // ignore
            }
            return;
          }
        }
      }

      // Wall-clock budget check
      const remainingWallMs = this.getRemainingWallTimeMs();
      if (remainingWallMs <= 0) {
        this.cancellation.abort("Global wall-time budget exhausted");
        task.error = "Global wall-time budget exhausted";
        this.state.transitionTask(taskId, "failed", task.error);
        try {
          await worktreeManager.removeWorktree(worktreePath);
          worktreePaths.delete(worktreeId);
        } catch {
          // ignore
        }
        return;
      }

      // Execute via worker adapter
      const childController = this.cancellation.createChild(taskId);
      const routing = this.opts.routing ?? DEFAULT_ROUTING;
      const model = resolveModel(
        task.workerTier,
        routing,
        task.spec.worker?.model,
      );

      const taskSpecWithResolvedModel: TaskSpecV1 = {
        ...task.spec,
        worker: {
          ...task.spec.worker,
          model: model ?? task.spec.worker?.model,
        },
      };

      const taskTimeoutMs = Math.min(
        task.spec.worker?.timeout_ms ?? 300_000,
        remainingWallMs,
      );

      const execReq: WorkerExecutionRequest = {
        task: taskSpecWithResolvedModel,
        workspace: worktreePath,
        runId: this.runId,
        traceId: this.traceId,
        attemptId: `att_${taskId}_${task.attempts}`,
        tier: task.workerTier,
        timeoutMs: taskTimeoutMs,
        signal: childController.signal,
      };

      let result;
      const startTime = Date.now();
      try {
        const execResult = await this.worker.execute(execReq);
        result = {
          ok: execResult.status === "succeeded",
          exitCode:
            execResult.exitCode ?? (execResult.status === "succeeded" ? 0 : 1),
          error: execResult.message,
          durationMs: Date.now() - startTime,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          conversationId: execResult.conversationId,
          usage: execResult.usage,
        };
      } catch (err) {
        result = {
          ok: false,
          exitCode: 1,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startTime,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
        };
      }

      task.durationMs = result.durationMs;

      // Save stdout/stderr artifacts
      try {
        const stdoutArt = this.opts.store.saveArtifact({
          runId: this.runId,
          kind: "stdout",
          relativePath: `tasks/${taskId}/attempt-${String(task.attempts).padStart(3, "0")}/stdout.log`,
          content: result.stdout,
          taskId,
          attempt: task.attempts,
        });
        task.stdoutArtifactId = stdoutArt.id;

        const stderrArt = this.opts.store.saveArtifact({
          runId: this.runId,
          kind: "stderr",
          relativePath: `tasks/${taskId}/attempt-${String(task.attempts).padStart(3, "0")}/stderr.log`,
          content: result.stderr,
          taskId,
          attempt: task.attempts,
        });
        task.stderrArtifactId = stderrArt.id;
      } catch {
        // Artifact save failure
      }

      this.metrics.rawOutputBytes +=
        Buffer.byteLength(result.stdout, "utf8") +
        Buffer.byteLength(result.stderr, "utf8");

      if (!result.ok) {
        // Clean temp worktree of failed attempt so retry starts fresh without leftovers
        try {
          await worktreeManager.removeWorktree(worktreePath);
          worktreePaths.delete(worktreeId);
        } catch {
          // ignore
        }

        const failure = classifyWorkerFailure(result);
        task.failure = failure;
        task.error = failure.message;
        this.state.transitionTask(taskId, "failed", failure.message);
        this.handleTaskFailure(taskId, failure);
        return;
      }

      // Collect patch
      try {
        const collector = new PatchCollector(worktreePath);
        const patch = await collector.collectPatch(taskBaseRevision);
        const changedPaths = await collector.getChangedPaths(taskBaseRevision);

        // Ownership validation
        const validator = new OwnershipValidator(
          worktreePath,
          task.spec.owns,
          task.spec.scope.include,
          task.spec.scope.exclude,
        );

        const violations: string[] = [];
        for (const change of changedPaths) {
          if (!validator.isOwned(change.path)) {
            violations.push(change.path);
          }
        }

        if (violations.length > 0) {
          task.error = `SCOPE_VIOLATION: Files outside owns boundary: ${violations.join(", ")}`;
          this.state.transitionTask(taskId, "failed", task.error);
          this.unresolved.push({
            code: "SCOPE_VIOLATION",
            message: task.error,
            task_id: taskId,
            host_decision_required: true,
          });
          try {
            await worktreeManager.removeWorktree(worktreePath);
            worktreePaths.delete(worktreeId);
          } catch {
            // ignore
          }
          return;
        }

        // Check patch for secrets (fail-closed)
        const secretCheck = inspectPatchForSecrets(patch);
        if (!secretCheck.safe) {
          task.error = `POLICY_DENIED: ${secretCheck.reason ?? "Secret detected in patch."}`;
          this.state.transitionTask(taskId, "failed", task.error);
          this.unresolved.push({
            code: "POLICY_DENIED",
            message: task.error,
            task_id: taskId,
            host_decision_required: true,
          });
          try {
            await worktreeManager.removeWorktree(worktreePath);
            worktreePaths.delete(worktreeId);
          } catch {
            // ignore
          }
          return;
        }

        task.patchContent = patch;
        task.changedFiles = changedPaths.map((c) => c.path);
        completedPatches.set(taskId, patch);
        completedFiles.set(taskId, task.changedFiles);

        // Save patch artifact
        const patchArt = this.opts.store.saveArtifact({
          runId: this.runId,
          kind: "patch",
          relativePath: `tasks/${taskId}/attempt-${String(task.attempts).padStart(3, "0")}/patch.diff`,
          content: patch,
          taskId,
          attempt: task.attempts,
          mimeType: "text/x-diff",
        });
        task.patchArtifactId = patchArt.id;

        this.state.transitionTask(taskId, "succeeded");
      } catch (err) {
        task.error = err instanceof Error ? err.message : String(err);
        this.state.transitionTask(taskId, "failed", task.error);
        try {
          await worktreeManager.removeWorktree(worktreePath);
          worktreePaths.delete(worktreeId);
        } catch {
          // ignore
        }
      }
    } finally {
      this.checkpointManifest();
      try {
        this.telemetry.logEvent({
          trace_id: this.traceId,
          run_id: this.runId,
          timestamp: new Date().toISOString(),
          event_type: "task_complete",
          task_id: taskId,
          attempt: task.attempts,
          status: task.status === "succeeded" ? "succeeded" : "failed",
          duration_ms: task.durationMs,
        });
      } catch {
        // Non-fatal telemetry failure
      }
    }
  }

  /** Compute transitive dependencies of a task. */
  private getTransitiveDeps(taskId: string): Set<string> {
    const result = new Set<string>();
    const stack = [...(this.state.getTask(taskId)?.spec.after ?? [])];
    while (stack.length > 0) {
      const depId = stack.pop()!;
      if (result.has(depId)) continue;
      result.add(depId);
      const dep = this.state.getTask(depId);
      if (dep?.spec.after) {
        stack.push(...dep.spec.after);
      }
    }
    return result;
  }

  private handleTaskFailure(
    taskId: string,
    failure: {
      code: any;
      message: string;
      hostDecisionRequired: boolean;
    },
  ): void {
    const task = this.state.getTask(taskId);
    if (!task) return;

    if (
      failure.code === "TRANSIENT_INFRA" ||
      failure.code === "RATE_LIMIT" ||
      failure.code === "WORKER_TIMEOUT"
    ) {
      if (this.budget.hasWorkerCallBudget()) {
        this.metrics.retries++;
        this.state.logRetry(taskId, failure.code, "same-tier retry");
        this.state.transitionTask(taskId, "ready", "retry");
        this.checkpointManifest();
        try {
          this.telemetry.logEvent({
            trace_id: this.traceId,
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            event_type: "retry",
            task_id: taskId,
            attempt: task.attempts,
            failure_class: failure.code,
          });
        } catch {
          // Non-fatal telemetry failure
        }
        return;
      }
    }

    if (failure.code === "SEMANTIC_FAILURE") {
      if (task.workerTier === "fast" && this.budget.hasWorkerCallBudget()) {
        // Forbid false tier escalation: require actual reasoningModel configuration
        if (!canEscalateToReasoning(this.routing)) {
          this.unresolved.push({
            code: failure.code,
            message: `${failure.message} (Cannot escalate to reasoning tier: reasoningModel not configured in BridgeConfig)`,
            task_id: taskId,
            host_decision_required: true,
          });
          this.cancelDependents(taskId);
          return;
        }
        this.metrics.escalations++;
        this.state.logEscalation(taskId, failure.code, "escalate to reasoning");
        task.workerTier = "reasoning";
        this.state.transitionTask(taskId, "ready", "escalated");
        this.checkpointManifest();
        try {
          this.telemetry.logEvent({
            trace_id: this.traceId,
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            event_type: "escalation",
            task_id: taskId,
            attempt: task.attempts,
            failure_class: failure.code,
          });
        } catch {
          // Non-fatal telemetry failure
        }
        return;
      }
    }

    this.unresolved.push({
      code: failure.code,
      message: failure.message,
      task_id: taskId,
      host_decision_required: failure.hostDecisionRequired,
    });
    this.cancelDependents(taskId);
  }

  /**
   * Deterministic Gates & Bounded Repair Loop.
   * Gates run serially on the final integration tree.
   * If a gate fails, a repair task is dynamically spawned with owns = closure(gate.after).
   * After repair integration, all affected gates are invalidated conservatively.
   */
  private async executeGatePhase(
    integrationPath: string,
    baseRevision: string,
    worktreeManager: WorktreeManager,
  ): Promise<void> {
    const gatesList = Array.from(this.allGatesMap.values());
    const pendingGateIds = new Set(this.dagResult.sortedGateIds);
    const gateFingerprints = new Map<string, string>();

    while (pendingGateIds.size > 0) {
      if (this.cancellation.isAborted) {
        this.state.skipRemainingGates("run cancelled");
        break;
      }

      const gateId = pendingGateIds.values().next().value;
      if (!gateId) break;
      pendingGateIds.delete(gateId);

      const gate = this.state.getGate(gateId);
      if (!gate) continue;

      // Check gate dependencies: all predecessor tasks must be integrated!
      const deps = gate.spec.after ?? [];
      const allDepsReady = deps.every((d) => {
        const task = this.state.getTask(d);
        if (task) return task.status === "integrated";
        const depGate = this.state.getGate(d);
        if (depGate) return depGate.status === "passed";
        return false;
      });

      if (!allDepsReady) {
        this.state.transitionGate(gateId, "skipped", "dependencies not met");
        continue;
      }

      this.state.transitionGate(gateId, "running");
      this.checkpointManifest();

      const cwd = gate.spec.cwd
        ? path.resolve(integrationPath, gate.spec.cwd)
        : integrationPath;

      const remainingWallMs = this.getRemainingWallTimeMs();
      if (remainingWallMs <= 0) {
        this.cancellation.abort("Global wall-time budget exhausted");
        this.state.skipRemainingGates("global wall-time budget exhausted");
        break;
      }

      const timeoutMs = Math.min(
        gate.spec.timeout_ms ?? 600_000,
        remainingWallMs,
      );
      const gateAtt = gate.repairAttempts + 1;
      try {
        this.telemetry.logEvent({
          trace_id: this.traceId,
          run_id: this.runId,
          timestamp: new Date().toISOString(),
          event_type: "gate_start",
          gate_id: gateId,
          attempt: gateAtt,
        });
      } catch {
        // Non-fatal telemetry failure
      }

      const gateResult = await this.gateRunner.runGate(
        gate.spec.command,
        cwd,
        timeoutMs,
        undefined,
        undefined,
        this.cancellation.signal,
      );

      gate.exitCode = gateResult.exitCode;
      gate.durationMs = gateResult.durationMs;

      // Save gate artifacts
      try {
        const stdoutArt = this.opts.store.saveArtifact({
          runId: this.runId,
          kind: "stdout",
          relativePath: `gates/${gateId}/attempt-${String(gateAtt).padStart(3, "0")}/stdout.log`,
          content: gateResult.stdout,
          gateId,
          attempt: gateAtt,
        });
        gate.stdoutArtifactId = stdoutArt.id;

        const stderrArt = this.opts.store.saveArtifact({
          runId: this.runId,
          kind: "stderr",
          relativePath: `gates/${gateId}/attempt-${String(gateAtt).padStart(3, "0")}/stderr.log`,
          content: gateResult.stderr,
          gateId,
          attempt: gateAtt,
        });
        gate.stderrArtifactId = stderrArt.id;
      } catch {
        // Artifact save failure
      }

      this.metrics.rawOutputBytes +=
        Buffer.byteLength(gateResult.stdout, "utf8") +
        Buffer.byteLength(gateResult.stderr, "utf8");

      // Parse output for failing tests
      const parser = this.opts.outputParser ?? selectParser(gate.spec.command);
      const parsed = parser.parse(gateResult.stdout, gateResult.stderr);
      gate.failingTests = parsed.failingTests;

      if (gateResult.exitCode === 0 && !gateResult.failure) {
        this.state.transitionGate(gateId, "passed");
        this.checkpointManifest();
        try {
          this.telemetry.logEvent({
            trace_id: this.traceId,
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            event_type: "gate_complete",
            gate_id: gateId,
            attempt: gateAtt,
            status: "passed",
            duration_ms: gateResult.durationMs,
          });
        } catch {
          // Non-fatal telemetry failure
        }
      } else if (
        gateResult.failure === "CANCELED" ||
        this.cancellation.isAborted
      ) {
        gate.error = gateResult.error ?? "Gate canceled by abort signal";
        this.state.transitionGate(gateId, "skipped", "run cancelled");
        this.checkpointManifest();
        try {
          this.telemetry.logEvent({
            trace_id: this.traceId,
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            event_type: "gate_complete",
            gate_id: gateId,
            attempt: gateAtt,
            status: "skipped",
            duration_ms: gateResult.durationMs,
          });
        } catch {
          // Non-fatal telemetry failure
        }
        this.state.skipRemainingGates("run cancelled");
        break;
      } else if (gateResult.failure === "GATE_TIMEOUT") {
        gate.error = gateResult.error ?? "Gate timed out";
        this.state.transitionGate(gateId, "timed_out");
        this.checkpointManifest();
        try {
          this.telemetry.logEvent({
            trace_id: this.traceId,
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            event_type: "gate_complete",
            gate_id: gateId,
            attempt: gateAtt,
            status: "failed",
            duration_ms: gateResult.durationMs,
          });
        } catch {
          // Non-fatal telemetry failure
        }
        this.unresolved.push({
          code: "GATE_TIMEOUT",
          message: `Gate ${gateId} timed out`,
          gate_id: gateId,
          host_decision_required: true,
        });
      } else {
        const gateFailure = classifyGateFailure(
          gateResult,
          parsed.failingTests,
        );
        gate.error = gateResult.error ?? gateFailure.message;
        this.state.transitionGate(gateId, "failed");
        this.checkpointManifest();
        try {
          this.telemetry.logEvent({
            trace_id: this.traceId,
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            event_type: "gate_complete",
            gate_id: gateId,
            attempt: gateAtt,
            status: "failed",
            duration_ms: gateResult.durationMs,
          });
        } catch {
          // Non-fatal telemetry failure
        }

        const prevFingerprint = gateFingerprints.get(gateId);
        if (gateFailure.fingerprint) {
          gateFingerprints.set(gateId, gateFailure.fingerprint);
        }

        // Check if repair can be executed
        if (
          this.budget.consumeRepairAttempt(gateId) &&
          this.budget.reserveWorkerCall()
        ) {
          this.metrics.retries++;
          gate.repairAttempts++;
          this.state.logRetry(gateId, gateFailure.code, "gate repair attempt");
          this.checkpointManifest();
          try {
            this.telemetry.logEvent({
              trace_id: this.traceId,
              run_id: this.runId,
              timestamp: new Date().toISOString(),
              event_type: "retry",
              gate_id: gateId,
              attempt: gate.repairAttempts,
              failure_class: gateFailure.code,
            });
          } catch {
            // Non-fatal telemetry failure
          }

          // Escalate tier if repeated fingerprint or semantic failure
          let repairTier: WorkerTier = "fast";
          if (
            gateFailure.code === "SEMANTIC_FAILURE" ||
            (prevFingerprint && prevFingerprint === gateFailure.fingerprint)
          ) {
            repairTier = "reasoning";
            this.metrics.escalations++;
            this.state.logEscalation(
              gateId,
              gateFailure.code,
              "escalate repair to reasoning",
            );
            this.checkpointManifest();
            try {
              this.telemetry.logEvent({
                trace_id: this.traceId,
                run_id: this.runId,
                timestamp: new Date().toISOString(),
                event_type: "escalation",
                gate_id: gateId,
                attempt: gate.repairAttempts,
                failure_class: gateFailure.code,
              });
            } catch {
              // Non-fatal telemetry failure
            }
          }

          const repairTaskSpec = buildRepairTaskSpec(
            gate.spec,
            {
              id: gate.spec.id,
              status: "failed",
              exit_code: gateResult.exitCode ?? undefined,
              duration_ms: gateResult.durationMs,
              failing_tests: parsed.failingTests,
            },
            gate.repairAttempts,
            this.allTasksMap,
            repairTier,
          );

          let repairWorktreePath = "";
          try {
            repairWorktreePath = await worktreeManager.createDetachedWorktree(
              repairTaskSpec.id,
              baseRevision,
            );

            // Apply all currently integrated patches onto repair worktree
            const collector = new PatchCollector(integrationPath);
            const currentFinalPatch =
              await collector.collectPatch(baseRevision);
            const repairIntegrator = new PatchIntegrator(repairWorktreePath);
            if (currentFinalPatch.trim()) {
              await repairIntegrator.applyPatch(currentFinalPatch);
            }
            const repairBaseRev = await repairIntegrator.commitAsBaseline(
              `Baseline for repair ${repairTaskSpec.id}`,
            );

            const repairReq: WorkerExecutionRequest = {
              task: repairTaskSpec,
              workspace: repairWorktreePath,
              runId: this.runId,
              traceId: this.traceId,
              attemptId: `att_${repairTaskSpec.id}`,
              tier: repairTier,
              timeoutMs: repairTaskSpec.worker?.timeout_ms ?? 120_000,
              signal: this.cancellation.signal,
              failureContext: `${gateFailure.code}: ${parsed.failingTests.join(", ") || gateResult.stderr}`,
            };

            const repairRes = await this.worker.execute(repairReq);

            if (repairRes.status === "succeeded") {
              const repairCollector = new PatchCollector(repairWorktreePath);
              const repairPatch =
                await repairCollector.collectPatch(repairBaseRev);
              const repairPaths =
                await repairCollector.getChangedPaths(repairBaseRev);

              // Validate repair ownership
              const repairValidator = new OwnershipValidator(
                integrationPath,
                repairTaskSpec.owns,
                repairTaskSpec.scope.include,
                repairTaskSpec.scope.exclude,
              );

              for (const cp of repairPaths) {
                if (!repairValidator.isOwned(cp.path)) {
                  throw new Error(
                    `SCOPE_VIOLATION: Repair modified ${cp.path} outside closure.`,
                  );
                }
              }

              // Apply repair patch to integration worktree
              const intIntegrator = new PatchIntegrator(integrationPath);
              await intIntegrator.applyPatch(repairPatch);
              await intIntegrator.commitAsBaseline(
                `Apply repair ${repairTaskSpec.id}`,
              );

              // Conservative Gate Invalidation
              const affectedGates = findAffectedGateIds(
                gateId,
                gatesList,
                this.allTasksMap,
              );
              for (const affId of affectedGates) {
                const affGate = this.state.getGate(affId);
                if (affGate) {
                  affGate.status = "pending";
                  pendingGateIds.add(affId);
                }
              }
            } else {
              this.unresolved.push({
                code: gateFailure.code,
                message: gateFailure.message,
                gate_id: gateId,
                host_decision_required: gateFailure.hostDecisionRequired,
              });
            }
          } catch {
            this.unresolved.push({
              code: gateFailure.code,
              message: gateFailure.message,
              gate_id: gateId,
              host_decision_required: gateFailure.hostDecisionRequired,
            });
          } finally {
            this.budget.releaseSlot();
            if (repairWorktreePath) {
              await worktreeManager
                .removeWorktree(repairWorktreePath)
                .catch(() => {});
            }
          }
        } else {
          this.unresolved.push({
            code: gateFailure.code,
            message: gateFailure.message,
            gate_id: gateId,
            host_decision_required: gateFailure.hostDecisionRequired,
          });
        }
      }
    }
  }

  private cancelDependents(failedTaskId: string): void {
    for (const [id, task] of this.state.getAllTasks()) {
      if (task.spec.after?.includes(failedTaskId)) {
        if (
          task.status !== "cancelled" &&
          task.status !== "integrated" &&
          task.status !== "failed"
        ) {
          this.state.transitionTask(
            id,
            "cancelled",
            `dependency ${failedTaskId} failed`,
          );
          this.cancelDependents(id);
        }
      }
    }
  }

  /**
   * Deterministic status evaluation:
   * "succeeded" requires EVERY task to be "integrated" and EVERY gate to be "passed".
   */
  private computeOverallStatus(): BatchResponseV1["status"] {
    let anyIntegrated = false;
    let anyFailed = false;
    let anyNeedsHost = false;
    let allTasksIntegrated = true;

    const tasks = this.state.getAllTasks();
    const gates = this.state.getAllGates();

    for (const [, task] of tasks) {
      if (task.status === "integrated") {
        anyIntegrated = true;
      } else {
        allTasksIntegrated = false;
      }
      if (
        task.status === "failed" ||
        task.status === "cancelled" ||
        task.status === "blocked"
      ) {
        anyFailed = true;
      }
    }

    for (const u of this.unresolved) {
      if (u.host_decision_required) anyNeedsHost = true;
    }

    let allGatesPassed = true;
    for (const [, gate] of gates) {
      if (gate.status !== "passed") {
        allGatesPassed = false;
      }
      if (gate.status === "failed" || gate.status === "timed_out") {
        anyFailed = true;
      }
    }

    if (this.cancellation.isAborted) return "failed";
    if (allTasksIntegrated && (gates.size === 0 || allGatesPassed))
      return "succeeded";
    if (!anyIntegrated && anyFailed) return "failed";
    if (anyNeedsHost) return "needs_host";
    if (anyIntegrated && anyFailed) return "partial";
    return "failed";
  }

  private buildSummary(status: BatchResponseV1["status"]): string {
    const tasks = this.state.getAllTasks();
    const gates = this.state.getAllGates();
    const integrated = [...tasks.values()].filter(
      (t) => t.status === "integrated",
    ).length;
    const failed = [...tasks.values()].filter(
      (t) => t.status === "failed",
    ).length;
    const cancelled = [...tasks.values()].filter(
      (t) => t.status === "cancelled",
    ).length;
    const gatesPassed = [...gates.values()].filter(
      (g) => g.status === "passed",
    ).length;
    const gatesFailed = [...gates.values()].filter(
      (g) => g.status === "failed" || g.status === "timed_out",
    ).length;

    return (
      `Run ${this.runId}: ${status}. ` +
      `Tasks: ${integrated}/${tasks.size} integrated, ${failed} failed, ${cancelled} cancelled. ` +
      `Gates: ${gatesPassed}/${gates.size} passed, ${gatesFailed} failed. ` +
      `Worker calls: ${this.metrics.workerCalls}, retries: ${this.metrics.retries}, escalations: ${this.metrics.escalations}.`
    );
  }

  private buildErrorResponse(
    status: BatchResponseV1["status"],
    message: string,
    failureCode?: FailureClass,
  ): SchedulerResult {
    this.cancellation.dispose();
    return {
      response: {
        schema_version: "1",
        run_id: this.runId,
        status,
        summary: message,
        tasks: this.state.buildTaskResults(),
        gates: this.state.buildGateResults(),
        budget_adjustments:
          this.budgetAdjustments && this.budgetAdjustments.length > 0
            ? this.budgetAdjustments
            : undefined,
        unresolved: [
          {
            code:
              failureCode ??
              (message.includes("unsupported")
                ? "POLICY_DENIED"
                : message.includes("CAPACITY_EXCEEDED")
                  ? "CAPACITY_EXCEEDED"
                  : "INTERNAL_ERROR"),
            message,
            host_decision_required: false,
          },
        ],
        artifacts: [],
        metrics: finalizeMetrics(this.metrics),
      },
      finalPatch: "",
    };
  }
}

/**
 * Public execution interface conforming to the shared contract.
 */
export async function executeBatch(
  request: BatchRequestV1,
  options: BatchRuntimeOptions,
): Promise<BatchResponseV1> {
  const worker = options.worker ?? createAntigravityWorker(options.config);

  const scheduler = new Scheduler({
    request,
    store: options.store,
    config: options.config,
    worker,
    limits: options.config.limits,
    parentSignal: options.signal,
  });

  const res = await scheduler.execute();
  return res.response;
}
