import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDag, patternsOverlap } from "../dist/validation/dag.js";
import { validateBatchRequest } from "../dist/validation/schema.js";

test("patternsOverlap accurately identifies conflicting glob scopes", () => {
  assert.equal(patternsOverlap("src/**", "src/auth/token.ts"), true);
  assert.equal(patternsOverlap("src/auth/**", "src/auth/sub/**"), true);
  assert.equal(patternsOverlap("src/auth/**", "src/api/**"), false);
  assert.equal(patternsOverlap("src/auth/*", "src/auth/login.ts"), true);
  assert.equal(patternsOverlap("test/unit/**", "test/integration/**"), false);
  assert.equal(patternsOverlap("**", "any/file.ts"), true);
});

test("validateDag enforces task ID uniqueness and non-empty owns", () => {
  const result = validateDag([
    {
      id: "dup",
      objective: "First",
      scope: { include: ["src/**"] },
      owns: ["src/a.ts"],
    },
    {
      id: "dup",
      objective: "Second",
      scope: { include: ["src/**"] },
      owns: ["src/b.ts"],
    },
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Duplicate task ID")));

  const emptyOwns = validateDag([
    {
      id: "task1",
      objective: "First",
      scope: { include: ["src/**"] },
      owns: [],
    },
  ]);
  assert.equal(emptyOwns.valid, false);
  assert.ok(emptyOwns.errors.some((e) => e.includes('non-empty "owns"')));
});

test("validateDag detects dependency cycles and returns clear error", () => {
  const cycleResult = validateDag([
    {
      id: "taskA",
      objective: "A",
      after: ["taskB"],
      scope: { include: ["src/a/**"] },
      owns: ["src/a/**"],
    },
    {
      id: "taskB",
      objective: "B",
      after: ["taskA"],
      scope: { include: ["src/b/**"] },
      owns: ["src/b/**"],
    },
  ]);
  assert.equal(cycleResult.valid, false);
  assert.ok(cycleResult.errors.some((e) => e.includes("Cycle detected")));
});

test("validateDag computes deterministic topological ordering", () => {
  const tasks = [
    {
      id: "z-task",
      objective: "Z",
      scope: { include: ["src/z/**"] },
      owns: ["src/z/**"],
    },
    {
      id: "a-task",
      objective: "A",
      scope: { include: ["src/a/**"] },
      owns: ["src/a/**"],
    },
    {
      id: "dep-task",
      objective: "Dep",
      after: ["z-task", "a-task"],
      scope: { include: ["src/dep/**"] },
      owns: ["src/dep/**"],
    },
  ];

  const result1 = validateDag(tasks);
  assert.equal(result1.valid, true);
  // a-task and z-task have no deps, sorted alphabetically: a-task, then z-task, then dep-task
  assert.deepEqual(result1.sortedTaskIds, ["a-task", "z-task", "dep-task"]);
});

test("validateDag fails closed on overlapping owns between parallel tasks", () => {
  // taskA and taskB are independent (parallel), but both own src/shared/**
  const result = validateDag([
    {
      id: "taskA",
      objective: "A",
      scope: { include: ["src/**"] },
      owns: ["src/shared/**"],
    },
    {
      id: "taskB",
      objective: "B",
      scope: { include: ["src/**"] },
      owns: ["src/shared/utils.ts"],
    },
  ]);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.includes("conflicting ownership")),
    "Overlapping owns in parallel tasks must fail validation",
  );

  // If taskB is ordered AFTER taskA, ownership overlap is permitted because they are sequential!
  const sequentialResult = validateDag([
    {
      id: "taskA",
      objective: "A",
      scope: { include: ["src/**"] },
      owns: ["src/shared/**"],
    },
    {
      id: "taskB",
      objective: "B",
      after: ["taskA"],
      scope: { include: ["src/**"] },
      owns: ["src/shared/utils.ts"],
    },
  ]);
  assert.equal(sequentialResult.valid, true);
});

test("validateBatchRequest enforces schema rules, string limits, and DAG validity", () => {
  assert.throws(() => {
    validateBatchRequest({
      schema_version: "1",
      workspace: { root: "/tmp" },
      tasks: [],
    });
  }, /at least one task/);

  assert.throws(() => {
    validateBatchRequest({
      schema_version: "2", // invalid version
      workspace: { root: "/tmp" },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: { include: ["src/**"] },
          owns: ["src/**"],
        },
      ],
    });
  }, /Invalid BatchRequest/);
});

test("validateBatchRequest correctly rejects owns overlapping with scope.exclude (both directions)", () => {
  // Finding regression test: owns: ["src/**"] vs exclude: ["src/secret/**"]
  assert.throws(() => {
    validateBatchRequest({
      schema_version: "1",
      workspace: { root: "/tmp" },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: {
            include: ["src/**"],
            exclude: ["src/secret/**"],
          },
          owns: ["src/**"],
        },
      ],
    });
  }, /overlaps with scope\.exclude/);

  // Direct overlap: owns: ["src/secret/**"] vs exclude: ["src/secret/**"]
  assert.throws(() => {
    validateBatchRequest({
      schema_version: "1",
      workspace: { root: "/tmp" },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: {
            include: ["src/**"],
            exclude: ["src/secret/**"],
          },
          owns: ["src/secret/**"],
        },
      ],
    });
  }, /overlaps with scope\.exclude/);

  // Non-overlapping: owns: ["src/auth/**"] vs exclude: ["src/secret/**"]
  assert.doesNotThrow(() => {
    validateBatchRequest({
      schema_version: "1",
      workspace: { root: "/tmp" },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: {
            include: ["src/**"],
            exclude: ["src/secret/**"],
          },
          owns: ["src/auth/**"],
        },
      ],
    });
  });
});

test("validateBatchRequest enforces owns is strictly contained within scope.include", () => {
  // owns is broader than scope.include -> rejected
  assert.throws(() => {
    validateBatchRequest({
      schema_version: "1",
      workspace: { root: "/tmp" },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: {
            include: ["src/auth/**"],
          },
          owns: ["src/**"],
        },
      ],
    });
  }, /not within scope\.include/);

  // owns single-level wildcard outside scope.include single-level
  assert.throws(() => {
    validateBatchRequest({
      schema_version: "1",
      workspace: { root: "/tmp" },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: {
            include: ["src/auth/*"],
          },
          owns: ["src/auth/nested/deep.ts"],
        },
      ],
    });
  }, /not within scope\.include/);

  // Valid containment
  assert.doesNotThrow(() => {
    validateBatchRequest({
      schema_version: "1",
      workspace: { root: "/tmp" },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: {
            include: ["src/auth/*"],
          },
          owns: ["src/auth/login.ts"],
        },
      ],
    });
  });
});

test("validateBatchRequest enforces server limits on tasks and budget", () => {
  const customLimits = {
    maxTasks: 2,
    maxGates: 1,
    maxWorkerCalls: 5,
    maxReplans: 1,
    maxRepairAttempts: 2,
    maxParallelism: 2,
    maxWallTimeMs: 60_000,
  };

  // Exceeds maxTasks
  assert.throws(() => {
    validateBatchRequest(
      {
        schema_version: "1",
        workspace: { root: "/tmp" },
        tasks: [
          {
            id: "t1",
            objective: "1",
            scope: { include: ["src/**"] },
            owns: ["src/a.ts"],
          },
          {
            id: "t2",
            objective: "2",
            scope: { include: ["src/**"] },
            owns: ["src/b.ts"],
          },
          {
            id: "t3",
            objective: "3",
            scope: { include: ["src/**"] },
            owns: ["src/c.ts"],
          },
        ],
      },
      customLimits,
    );
  }, /Task count \(3\) exceeds server limit \(2\)/);

  // Exceeds max_worker_calls
  assert.throws(() => {
    validateBatchRequest(
      {
        schema_version: "1",
        workspace: { root: "/tmp" },
        tasks: [
          {
            id: "t1",
            objective: "1",
            scope: { include: ["src/**"] },
            owns: ["src/a.ts"],
          },
        ],
        budget: {
          max_worker_calls: 10,
        },
      },
      customLimits,
    );
  }, /Requested max_worker_calls \(10\) exceeds server limit \(5\)/);

  // Exceeds max_parallelism
  assert.throws(() => {
    validateBatchRequest(
      {
        schema_version: "1",
        workspace: { root: "/tmp" },
        tasks: [
          {
            id: "t1",
            objective: "1",
            scope: { include: ["src/**"] },
            owns: ["src/a.ts"],
          },
        ],
        budget: {
          max_parallelism: 8,
        },
      },
      customLimits,
    );
  }, /Requested max_parallelism \(8\) exceeds server limit \(2\)/);
});
