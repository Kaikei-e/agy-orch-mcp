import type { GateSpecV1 } from "../domain/gate.js";
import type { TaskSpecV1 } from "../domain/task.js";

export interface DagValidationResult {
  valid: boolean;
  errors: string[];
  sortedTaskIds: string[];
  sortedGateIds: string[];
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
}

export function patternsOverlap(p1: string, p2: string): boolean {
  let norm1 = normalizePattern(p1);
  let norm2 = normalizePattern(p2);

  if (norm1.endsWith("/")) norm1 = norm1 + "**";
  if (norm2.endsWith("/")) norm2 = norm2 + "**";

  if (norm1 === norm2) return true;
  if (norm1 === "**" || norm1 === "*" || norm2 === "**" || norm2 === "*")
    return true;

  const clean1 = norm1.replace(/\/?\*\*?$/, "");
  const clean2 = norm2.replace(/\/?\*\*?$/, "");

  if (clean1 === clean2) return true;
  if (clean1 === "" || clean2 === "") return true;

  if (clean1.startsWith(`${clean2}/`) || clean2.startsWith(`${clean1}/`)) {
    return true;
  }

  return false;
}

export function validateDag(
  tasks: TaskSpecV1[],
  gates: GateSpecV1[] = [],
): DagValidationResult {
  const errors: string[] = [];
  const taskMap = new Map<string, TaskSpecV1>();
  const gateMap = new Map<string, GateSpecV1>();
  const allIds = new Set<string>();

  // 1. Uniqueness
  for (const task of tasks) {
    if (allIds.has(task.id)) {
      errors.push(`Duplicate task ID: "${task.id}"`);
    }
    allIds.add(task.id);
    taskMap.set(task.id, task);

    if (!task.owns || task.owns.length === 0) {
      errors.push(`Task "${task.id}" must specify a non-empty "owns" array`);
    }
  }

  for (const gate of gates) {
    if (allIds.has(gate.id)) {
      errors.push(`Duplicate ID between task and gate: "${gate.id}"`);
    }
    allIds.add(gate.id);
    gateMap.set(gate.id, gate);
  }

  // 2. Dependency reference validity
  for (const task of tasks) {
    for (const dep of task.after ?? []) {
      if (!taskMap.has(dep)) {
        errors.push(`Task "${task.id}" depends on non-existent task "${dep}"`);
      }
    }
  }

  for (const gate of gates) {
    for (const dep of gate.after ?? []) {
      if (!allIds.has(dep)) {
        errors.push(
          `Gate "${gate.id}" depends on non-existent task or gate "${dep}"`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, sortedTaskIds: [], sortedGateIds: [] };
  }

  // 3. Cycle detection and topological sort for tasks (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adj.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.after ?? []) {
      adj.get(dep)!.push(task.id);
      inDegree.set(task.id, inDegree.get(task.id)! + 1);
    }
  }

  // Priority queue / deterministic sort by lexicographical ID
  const zeroQueue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) zeroQueue.push(id);
  }
  zeroQueue.sort();

  const sortedTaskIds: string[] = [];
  while (zeroQueue.length > 0) {
    const current = zeroQueue.shift()!;
    sortedTaskIds.push(current);

    const neighbors = (adj.get(current) ?? []).slice().sort();
    for (const neighbor of neighbors) {
      const newDeg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        zeroQueue.push(neighbor);
        zeroQueue.sort();
      }
    }
  }

  if (sortedTaskIds.length !== tasks.length) {
    errors.push("Cycle detected in task dependencies");
    return { valid: false, errors, sortedTaskIds: [], sortedGateIds: [] };
  }

  // 4. Reachability for parallel ownership conflict detection
  const reachable = new Map<string, Set<string>>();
  for (const task of tasks) {
    reachable.set(task.id, new Set<string>());
  }

  // Fill reachability in reverse topological order
  for (let i = sortedTaskIds.length - 1; i >= 0; i--) {
    const id = sortedTaskIds[i];
    if (!id) continue;
    const set = reachable.get(id);
    if (!set) continue;
    for (const next of adj.get(id) ?? []) {
      set.add(next);
      for (const trans of reachable.get(next) ?? []) {
        set.add(trans);
      }
    }
  }

  function canReach(from: string, to: string): boolean {
    return reachable.get(from)?.has(to) ?? false;
  }

  // Check parallel tasks for overlapping ownership
  for (let i = 0; i < tasks.length; i++) {
    const taskA = tasks[i];
    if (!taskA) continue;
    for (let j = i + 1; j < tasks.length; j++) {
      const taskB = tasks[j];
      if (!taskB) continue;
      const isOrdered =
        canReach(taskA.id, taskB.id) || canReach(taskB.id, taskA.id);
      if (!isOrdered) {
        // Parallel candidates! Must not overlap in owns
        for (const ownA of taskA.owns) {
          for (const ownB of taskB.owns) {
            if (patternsOverlap(ownA, ownB)) {
              errors.push(
                `Parallel tasks "${taskA.id}" and "${taskB.id}" have conflicting ownership: "${ownA}" overlaps with "${ownB}"`,
              );
            }
          }
        }
      }
    }
  }

  // 5. Gate cycle detection and topological ordering
  const gateInDegree = new Map<string, number>();
  const gateAdj = new Map<string, string[]>();
  for (const gate of gates) {
    gateInDegree.set(gate.id, 0);
    gateAdj.set(gate.id, []);
  }

  for (const gate of gates) {
    for (const dep of gate.after ?? []) {
      if (gateMap.has(dep)) {
        gateAdj.get(dep)!.push(gate.id);
        gateInDegree.set(gate.id, gateInDegree.get(gate.id)! + 1);
      }
    }
  }

  const zeroGates: string[] = [];
  for (const [id, deg] of gateInDegree.entries()) {
    if (deg === 0) zeroGates.push(id);
  }
  zeroGates.sort();

  const sortedGateIds: string[] = [];
  while (zeroGates.length > 0) {
    const current = zeroGates.shift()!;
    sortedGateIds.push(current);

    for (const neighbor of (gateAdj.get(current) ?? []).slice().sort()) {
      const newDeg = gateInDegree.get(neighbor)! - 1;
      gateInDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        zeroGates.push(neighbor);
        zeroGates.sort();
      }
    }
  }

  if (sortedGateIds.length !== gates.length) {
    errors.push("Cycle detected in gate dependencies");
  }

  return {
    valid: errors.length === 0,
    errors,
    sortedTaskIds,
    sortedGateIds,
  };
}
