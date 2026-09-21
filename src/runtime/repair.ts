import type { FailureClass } from "../domain/failure.js";
import type { GateResultV1, GateSpecV1 } from "../domain/gate.js";
import type { TaskSpecV1 } from "../domain/task.js";
import type { WorkerTier } from "../domain/execution.js";

/**
 * Computes the transitive closure of tasks that the given gate depends on.
 */
export function getTransitivePredecessorTaskIds(
  gate: GateSpecV1,
  allTasks: Map<string, TaskSpecV1>,
): Set<string> {
  const closure = new Set<string>();
  const queue = [...gate.after];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    const task = allTasks.get(id);
    if (task) {
      closure.add(id);
      if (task.after) {
        for (const pred of task.after) {
          if (!closure.has(pred)) queue.push(pred);
        }
      }
    }
  }

  return closure;
}

/**
 * Computes the union of owns and scopes from the transitive dependency closure
 * of the failed gate, strictly respecting scope.exclude.
 */
export function buildRepairTaskSpec(
  gate: GateSpecV1,
  gateResult: GateResultV1,
  attemptNumber: number,
  allTasks: Map<string, TaskSpecV1>,
  tier: WorkerTier,
): TaskSpecV1 {
  const predTaskIds = getTransitivePredecessorTaskIds(gate, allTasks);
  const ownsSet = new Set<string>();
  const includeSet = new Set<string>();
  const rawExcludeSet = new Set<string>();

  for (const taskId of predTaskIds) {
    const task = allTasks.get(taskId);
    if (!task) continue;
    for (const o of task.owns) ownsSet.add(o);
    for (const inc of task.scope.include) includeSet.add(inc);
    if (task.scope.exclude) {
      for (const exc of task.scope.exclude) rawExcludeSet.add(exc);
    }
  }

  // Filter raw excludes: an exclude must not forbid paths that are legitimately owned
  // by any task in the closure.
  const safeExcludeSet = new Set<string>();
  for (const exc of rawExcludeSet) {
    const isOwnedInClosure = Array.from(ownsSet).some((ownedPath) => {
      if (ownedPath === exc) return true;
      const cleanOwned = ownedPath.replace(/\*.*$/, "");
      const cleanExc = exc.replace(/\*.*$/, "");
      return cleanOwned.startsWith(cleanExc) || cleanExc.startsWith(cleanOwned);
    });
    if (!isOwnedInClosure) {
      safeExcludeSet.add(exc);
    }
  }

  const failingSummary = gateResult.failing_tests?.length
    ? `Failing tests: ${gateResult.failing_tests.join(", ")}`
    : `Exit code: ${gateResult.exit_code}`;

  return {
    id: `repair-${gate.id}-att${attemptNumber}`,
    objective: `Repair failures detected by gate "${gate.id}". ${failingSummary}. Fix the implementation without relaxing gate acceptance criteria or modifying test assertions inappropriately.`,
    after: Array.from(predTaskIds),
    scope: {
      include: Array.from(includeSet),
      exclude: safeExcludeSet.size > 0 ? Array.from(safeExcludeSet) : undefined,
    },
    owns: Array.from(ownsSet),
    acceptance: gate.command.slice(), // Exact gate command preserved; no arbitrary modification
    worker: {
      tier,
      timeout_ms: gate.timeout_ms ?? 120_000,
    },
  };
}

/**
 * Conservative gate invalidation: when a repair patch is integrated,
 * any gate whose transitive predecessor set overlaps with the modified files/tasks
 * must be invalidated (returned to un-passed state so it runs again).
 */
export function findAffectedGateIds(
  repairedGateId: string,
  allGates: GateSpecV1[],
  allTasks: Map<string, TaskSpecV1>,
): Set<string> {
  const affected = new Set<string>([repairedGateId]);
  const targetGate = allGates.find((g) => g.id === repairedGateId);
  if (!targetGate) return affected;

  const targetPreds = getTransitivePredecessorTaskIds(targetGate, allTasks);

  for (const otherGate of allGates) {
    if (otherGate.id === repairedGateId) continue;
    const otherPreds = getTransitivePredecessorTaskIds(otherGate, allTasks);
    // If otherGate shares dependencies with targetGate, invalidate it conservatively
    for (const p of targetPreds) {
      if (otherPreds.has(p)) {
        affected.add(otherGate.id);
        break;
      }
    }
  }

  return affected;
}

/**
 * Classifies failure into FailureClass according to draft taxonomy.
 */
export function classifyFailure(
  exitCode: number | null | undefined,
  stderr: string,
  isTimeout: boolean,
  failingTests?: string[],
): FailureClass {
  if (isTimeout) {
    return "GATE_TIMEOUT";
  }
  if (exitCode === 0) {
    return "INTERNAL_ERROR";
  }
  if (failingTests && failingTests.length > 0) {
    return "DETERMINISTIC_TEST_FAILURE";
  }
  const text = stderr.toLowerCase();
  if (
    text.includes("rate limit") ||
    text.includes("429") ||
    text.includes("quota exceeded")
  ) {
    return "RATE_LIMIT";
  }
  if (
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("enotfound") ||
    text.includes("socket hang up")
  ) {
    return "TRANSIENT_INFRA";
  }
  if (
    text.includes("permission denied") ||
    text.includes("eacces") ||
    text.includes("policy denied")
  ) {
    return "POLICY_DENIED";
  }
  return "DETERMINISTIC_TEST_FAILURE";
}
