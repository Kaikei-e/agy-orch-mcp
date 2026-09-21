import test from "node:test";
import assert from "node:assert";
import { BudgetTracker } from "../dist/runtime/budget-tracker.js";
import { TaskStateMachine } from "../dist/runtime/state-machine.js";
import {
  computeFailureFingerprint,
  normalizeStackTrace,
} from "../dist/runtime/fingerprint.js";
import {
  buildRepairTaskSpec,
  findAffectedGateIds,
} from "../dist/runtime/repair.js";
import { DEFAULT_SERVER_LIMITS } from "../dist/domain/limits.js";

test("Runtime Budget and Repair Mechanics", async (t) => {
  await t.test(
    "BudgetTracker strictly bounds worker calls and repair attempts per gate",
    () => {
      const limits = {
        ...DEFAULT_SERVER_LIMITS,
        maxWorkerCalls: 4,
        maxRepairAttempts: 2,
      };
      const budget = new BudgetTracker(
        2,
        { max_worker_calls: 3, max_repair_attempts: 2 },
        limits,
      );

      assert.strictEqual(budget.canExecuteWorkerCall(), true);
      budget.consumeWorkerCall(); // 1
      budget.consumeWorkerCall(); // 2
      budget.consumeWorkerCall(); // 3
      assert.strictEqual(budget.canExecuteWorkerCall(), false);
      assert.throws(() => budget.consumeWorkerCall(), /BUDGET_EXHAUSTED/);

      // Gate repair budget
      const repairBudget = new BudgetTracker(
        2,
        { max_worker_calls: 10, max_repair_attempts: 2 },
        limits,
      );
      assert.strictEqual(repairBudget.canRepairGate("gate-1"), true);
      repairBudget.consumeRepair("gate-1"); // attempt 1
      assert.strictEqual(repairBudget.canRepairGate("gate-1"), true);
      repairBudget.consumeRepair("gate-1"); // attempt 2
      assert.strictEqual(repairBudget.canRepairGate("gate-1"), false);
      assert.throws(
        () => repairBudget.consumeRepair("gate-1"),
        /BUDGET_EXHAUSTED/,
      );

      // Another gate still has its own independent repair budget up to the limit
      assert.strictEqual(repairBudget.canRepairGate("gate-2"), true);
    },
  );

  await t.test(
    "TaskStateMachine validates legal and illegal transitions",
    () => {
      const sm = new TaskStateMachine("pending");
      assert.strictEqual(sm.status, "pending");

      assert.strictEqual(sm.canTransitionTo("ready"), true);
      assert.strictEqual(sm.canTransitionTo("integrated"), false);

      assert.throws(
        () => sm.transition("integrated"),
        /Invalid task state transition/,
      );

      sm.transition("ready");
      sm.transition("running");
      sm.transition("succeeded");
      sm.transition("integrating");
      sm.transition("integrated");
      assert.strictEqual(sm.status, "integrated");
    },
  );

  await t.test("Failure fingerprint normalizes line numbers and paths", () => {
    const trace1 =
      "Error at Object.<anonymous> (/home/user/project/src/calc.js:142:25)\n    at Module._compile (node:internal/modules/cjs/loader.js:123:10)";
    const trace2 =
      "Error at Object.<anonymous> (/tmp/other-path/src/calc.js:999:88)\n    at Module._compile (node:internal/modules/cjs/loader.js:456:77)";

    const fp1 = computeFailureFingerprint({
      failureClass: "DETERMINISTIC_TEST_FAILURE",
      errorCode: "1",
      failingTests: ["calcTest"],
      outputExcerpt: trace1,
    });

    const fp2 = computeFailureFingerprint({
      failureClass: "DETERMINISTIC_TEST_FAILURE",
      errorCode: "1",
      failingTests: ["calcTest"],
      outputExcerpt: trace2,
    });

    assert.strictEqual(
      fp1,
      fp2,
      "Fingerprints must be identical across varying line numbers and path prefixes",
    );
  });

  await t.test(
    "Repair task owns exactly the union of gate transitive closure without expansion",
    () => {
      const taskA = {
        id: "task-a",
        objective: "A",
        scope: { include: ["src/a/**"], exclude: ["src/a/secret/**"] },
        owns: ["src/a/file1.js"],
      };
      const taskB = {
        id: "task-b",
        objective: "B",
        after: ["task-a"],
        scope: { include: ["src/b/**"] },
        owns: ["src/b/file2.js"],
      };
      const taskC = {
        id: "task-c",
        objective: "C",
        scope: { include: ["src/c/**"] },
        owns: ["src/c/file3.js"],
      };

      const allTasks = new Map([
        ["task-a", taskA],
        ["task-b", taskB],
        ["task-c", taskC],
      ]);

      const gate = {
        id: "gate-verify-b",
        after: ["task-b"], // depends on B, which transitively depends on A (but not C!)
        command: ["npm", "test"],
      };

      const repairSpec = buildRepairTaskSpec(
        gate,
        { id: gate.id, status: "failed", exit_code: 1, duration_ms: 100 },
        1,
        allTasks,
        "fast",
      );

      // Check owns: must include file1.js and file2.js, but NOT file3.js
      assert.ok(repairSpec.owns.includes("src/a/file1.js"));
      assert.ok(repairSpec.owns.includes("src/b/file2.js"));
      assert.strictEqual(repairSpec.owns.includes("src/c/file3.js"), false);

      // Scope exclude must be preserved
      assert.ok(repairSpec.scope.exclude?.includes("src/a/secret/**"));

      // Gate command must be in acceptance
      assert.ok(repairSpec.acceptance?.includes("npm"));

      // Affected gates check
      const gate2 = {
        id: "gate-other",
        after: ["task-a"],
        command: ["npm", "test"],
      };
      const gate3 = {
        id: "gate-unrelated",
        after: ["task-c"],
        command: ["npm", "test"],
      };
      const affected = findAffectedGateIds(
        gate.id,
        [gate, gate2, gate3],
        allTasks,
      );

      assert.ok(affected.has("gate-verify-b"));
      assert.ok(affected.has("gate-other")); // Shares task-a dependency
      assert.strictEqual(affected.has("gate-unrelated"), false); // Unrelated, must not be affected
    },
  );

  await t.test(
    "Repair task permits union of owns across valid tasks without mutually excluding each other",
    () => {
      // Valid Task A: owns src/a/**, excludes src/b/**
      const taskA = {
        id: "task-a",
        objective: "Module A",
        scope: { include: ["src/**"], exclude: ["src/b/**"] },
        owns: ["src/a/**"],
      };
      // Valid Task B: owns src/b/**, excludes src/a/**
      const taskB = {
        id: "task-b",
        objective: "Module B",
        after: ["task-a"],
        scope: {
          include: ["src/**"],
          exclude: ["src/a/**", "docs/confidential/**"],
        },
        owns: ["src/b/**"],
      };

      const allTasks = new Map([
        ["task-a", taskA],
        ["task-b", taskB],
      ]);

      const gate = {
        id: "gate-integration",
        after: ["task-b"],
        command: ["npm", "test"],
      };

      const repairSpec = buildRepairTaskSpec(
        gate,
        { id: gate.id, status: "failed", exit_code: 1, duration_ms: 100 },
        1,
        allTasks,
        "fast",
      );

      // Repair task must own both src/a/** and src/b/**
      assert.ok(repairSpec.owns.includes("src/a/**"));
      assert.ok(repairSpec.owns.includes("src/b/**"));

      // Crucial: Task A's exclude ("src/b/**") and Task B's exclude ("src/a/**") MUST NOT be in repairSpec.scope.exclude!
      assert.strictEqual(
        repairSpec.scope.exclude?.includes("src/a/**") ?? false,
        false,
      );
      assert.strictEqual(
        repairSpec.scope.exclude?.includes("src/b/**") ?? false,
        false,
      );

      // Truly external excludes (docs/confidential/**) must be preserved!
      assert.ok(repairSpec.scope.exclude?.includes("docs/confidential/**"));

      // Acceptance must preserve exact gate command without modification
      assert.deepStrictEqual(repairSpec.acceptance, ["npm", "test"]);
    },
  );
});
