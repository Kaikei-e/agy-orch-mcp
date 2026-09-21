import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../dist/config.js";
import { ProcessRunner } from "../dist/process.js";
import { runAgy } from "../dist/agy.js";
import { toToolResult } from "../dist/result.js";
import {
  createAntigravityWorker,
  buildWorkerPrompt,
} from "../dist/workers/antigravity-worker.js";
import {
  classifyFailure,
  normalizeStackTrace,
  normalizePath,
  computeCoarseFingerprint,
  computeFineFingerprint,
} from "../dist/workers/failure-classifier.js";
import {
  decideRoutingAction,
  shouldEscalateToReasoning,
  resolveWorkerModel,
  selectInitialWorkerTier,
} from "../dist/workers/routing-policy.js";

// Test-only mock adapter helper
function createMockWorkerAdapter(handler) {
  return {
    execute(request) {
      return handler(request);
    },
  };
}

const fixtureAgy = fileURLToPath(
  new URL("./fixtures/agy.mjs", import.meta.url),
);

// Helper to create a base mock task spec
function createMockTask(overrides = {}) {
  return {
    id: "task-test-1",
    objective: "Implement user authentication tokens",
    scope: {
      include: ["src/auth/**", "test/auth/**"],
      exclude: ["src/auth/legacy/**"],
    },
    owns: ["src/auth/**", "test/auth/**"],
    acceptance: [
      "pnpm test test/auth passes with exit code 0",
      "Token rotation regression test is added",
    ],
    worker: {
      tier: "fast",
      timeout_ms: 30000,
    },
    ...overrides,
  };
}

// Helper to create a base worker execution request
function createMockExecutionRequest(overrides = {}) {
  const task = overrides.task ?? createMockTask();
  return {
    task,
    workspace: process.cwd(),
    runId: "run_test_123",
    traceId: "tr_test_456",
    attemptId: "att_test_1",
    tier: "fast",
    timeoutMs: 30000,
    ...overrides,
  };
}

test("Worker Adapter & Mock Adapter", async () => {
  const mockAdapter = createMockWorkerAdapter(async (req) => ({
    status: "succeeded",
    stdout: `Task ${req.task.id} finished`,
    stderr: "",
    exitCode: 0,
    model: "mock-model",
    usage: { total_tokens: 100 },
  }));

  const res = await mockAdapter.execute(createMockExecutionRequest());
  assert.equal(res.status, "succeeded");
  assert.equal(res.stdout, "Task task-test-1 finished");
  assert.equal(res.exitCode, 0);
  assert.equal(res.model, "mock-model");
  assert.equal(res.usage?.total_tokens, 100);
});

test("Antigravity Worker - Prompt Builder", () => {
  const req = createMockExecutionRequest({
    failureContext:
      "DETERMINISTIC_TEST_FAILURE: 1 failing test: auth-rotation.test.ts",
  });
  const prompt = buildWorkerPrompt(req);

  // Verifies objective is present
  assert.ok(prompt.includes("Implement user authentication tokens"));
  // Verifies scope include & exclude
  assert.ok(prompt.includes("src/auth/**, test/auth/**"));
  assert.ok(prompt.includes("src/auth/legacy/**"));
  // Verifies exclusive ownership
  assert.ok(prompt.includes("Exclusive Write Ownership"));
  assert.ok(
    prompt.includes("ANY MODIFICATION OUTSIDE THESE PATHS WILL BE REJECTED"),
  );
  // Verifies acceptance criteria
  assert.ok(prompt.includes("Token rotation regression test is added"));
  // Verifies failure context / repair evidence
  assert.ok(prompt.includes("auth-rotation.test.ts"));
  // Verifies anti-recursion & anti-reverse-delegation directives
  assert.ok(prompt.includes("DO NOT recursively invoke agy-orch-mcp"));
  assert.ok(prompt.includes("DO NOT reverse delegate back to the host"));
});

test("Antigravity Worker - Execution with Fixture CLI", async (t) => {
  const config = loadConfig({
    AGY_MCP_BIN: fixtureAgy,
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
  });
  const runner = new ProcessRunner(2);
  t.after(() => runner.close());

  const worker = createAntigravityWorker(config, runner);

  await t.test("Successful execution maps response and exit 0", async () => {
    const req = createMockExecutionRequest({
      task: createMockTask({ objective: "simple ok task" }),
    });
    const res = await worker.execute(req);

    assert.equal(res.status, "succeeded");
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.length > 0);
    assert.equal(typeof res.conversationId, "string");

    // Raw stdout fidelity: contains envelope metadata absent from parsed response
    assert.ok(res.stdout.includes('"duration_seconds":0.01'));
    assert.ok(res.stdout.includes('"event":"init"'));
    assert.ok(res.stdout.includes('"event":"result"'));
    // Trailing newline preserved
    assert.ok(res.stdout.endsWith("\n"));
  });

  await t.test(
    "Preserves denied actions as POLICY_DENIED even on exit 0",
    async () => {
      const req = createMockExecutionRequest({
        task: createMockTask({ objective: "denied" }),
      });
      const res = await worker.execute(req);

      assert.equal(res.status, "failed");
      assert.equal(res.failureClass, "POLICY_DENIED");
      assert.ok(
        res.message?.includes("Policy denied") ||
          res.message?.includes("denied action"),
      );

      // Preserves raw partial stdout with denied_actions metadata and trailing newline
      assert.ok(res.stdout.includes('"denied_actions"'));
      assert.ok(res.stdout.endsWith("\n"));
    },
  );

  await t.test("Handles CLI timeout as WORKER_TIMEOUT", async () => {
    const req = createMockExecutionRequest({
      task: createMockTask({ objective: "hang" }),
      timeoutMs: 300,
    });
    const res = await worker.execute(req);

    assert.equal(res.status, "failed");
    assert.equal(res.failureClass, "WORKER_TIMEOUT");
    assert.ok(
      res.message?.includes("timeout") || res.message?.includes("exceeded"),
    );

    // Partial output emitted before hang is preserved in rawStdout
    assert.ok(res.stdout.includes('"event":"init"'));
  });

  await t.test("Diagnostic stderr and exit code preservation", async () => {
    const req = createMockExecutionRequest({
      task: createMockTask({ objective: "stderr" }),
    });
    const res = await worker.execute(req);

    assert.equal(res.status, "failed");
    assert.equal(res.exitCode, 2);
    assert.ok(res.stderr.length >= 4000);
    assert.ok(res.stderr.includes("diagnostic "));
    assert.ok(res.stdout.includes('"duration_seconds":0.01'));
  });

  await t.test(
    "Raw stdout never leaks into legacy MCP toToolResult output",
    async () => {
      const runResult = await runAgy(
        {
          prompt: "simple ok task",
          workspace: process.cwd(),
        },
        config,
        runner,
      );

      // Verify runResult has rawStdout populated internally with full stream events
      assert.ok(
        typeof runResult.rawStdout === "string" &&
          runResult.rawStdout.length > 0,
      );
      assert.ok(runResult.rawStdout.includes('"duration_seconds":0.01'));
      assert.ok(runResult.rawStdout.includes('"event":"init"'));
      assert.ok(runResult.rawStdout.includes('"event":"step_update"'));

      // Verify toToolResult explicitly excludes rawStdout stream envelopes from both text and structuredContent
      const toolResult = toToolResult(runResult, 40_000);
      assert.equal(toolResult.structuredContent?.rawStdout, undefined);
      assert.ok(!toolResult.content[0].text.includes('"rawStdout"'));
      assert.ok(!toolResult.content[0].text.includes('"event":"init"'));
      assert.ok(!toolResult.content[0].text.includes('"event":"step_update"'));
    },
  );

  await t.test("Propagates pre-aborted cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const req = createMockExecutionRequest({
      signal: controller.signal,
    });
    const res = await worker.execute(req);

    assert.equal(res.status, "cancelled");
    assert.ok(
      res.message?.includes("cancelled") || res.message?.includes("aborted"),
    );
  });

  await t.test("Empty response classified as INTERNAL_ERROR", async () => {
    const req = createMockExecutionRequest({
      task: createMockTask({ objective: "empty" }),
    });
    const res = await worker.execute(req);

    assert.equal(res.status, "failed");
    assert.equal(res.failureClass, "INTERNAL_ERROR");
  });

  await t.test(
    "Explicit model override in task is passed through",
    async () => {
      const req = createMockExecutionRequest({
        task: createMockTask({
          worker: { tier: "reasoning", model: "custom-reasoning-model" },
        }),
        tier: "reasoning",
      });
      const res = await worker.execute(req);

      assert.equal(res.model, "custom-reasoning-model");
    },
  );
});

test("Failure Classifier - Taxonomy Classification", () => {
  // Explicit override takes precedence
  assert.equal(
    classifyFailure({
      explicitFailureClass: "SEMANTIC_FAILURE",
      stdout: "rate limit exceeded",
    }),
    "SEMANTIC_FAILURE",
  );

  // Timeouts
  assert.equal(classifyFailure({ isGateTimeout: true }), "GATE_TIMEOUT");
  assert.equal(classifyFailure({ isWorkerTimeout: true }), "WORKER_TIMEOUT");
  assert.equal(classifyFailure({ isTimeout: true }), "WORKER_TIMEOUT");

  // Denied actions
  assert.equal(
    classifyFailure({ deniedActions: [{ tool: "write_to_file" }] }),
    "POLICY_DENIED",
  );

  // Policy denied keywords
  assert.equal(
    classifyFailure({
      stderr: "EACCES: permission denied, open '/etc/shadow'",
    }),
    "POLICY_DENIED",
  );
  assert.equal(
    classifyFailure({ stderr: "Error: Secret detected in patch payload" }),
    "POLICY_DENIED",
  );

  // Scope violation
  assert.equal(
    classifyFailure({
      stderr:
        "SCOPE_VIOLATION: Task modified src/unauthorized.ts which is outside task.owns",
    }),
    "SCOPE_VIOLATION",
  );

  // Patch conflict
  assert.equal(
    classifyFailure({
      stderr:
        "error: patch failed: src/auth.ts:15\nerror: patch_conflict: merge conflict detected",
    }),
    "PATCH_CONFLICT",
  );

  // Requirement ambiguity
  assert.equal(
    classifyFailure({
      stdout:
        "I cannot proceed because the requirements are ambiguous and underspecified.",
    }),
    "REQUIREMENT_AMBIGUITY",
  );
  assert.equal(
    classifyFailure({
      error: "Requirement ambiguity: conflicting instructions provided",
    }),
    "REQUIREMENT_AMBIGUITY",
  );

  // Architecture decision
  assert.equal(
    classifyFailure({
      stdout:
        "This requires an architectural decision between REST and GraphQL schemas.",
    }),
    "ARCHITECTURE_DECISION",
  );

  // Rate limit
  assert.equal(
    classifyFailure({ stderr: "HTTP 429 Too Many Requests: quota exceeded" }),
    "RATE_LIMIT",
  );
  assert.equal(
    classifyFailure({ stderr: "Resource has been exhausted (rate_limit)" }),
    "RATE_LIMIT",
  );

  // Transient infra
  assert.equal(
    classifyFailure({ stderr: "fetch failed: ECONNRESET: socket hang up" }),
    "TRANSIENT_INFRA",
  );
  assert.equal(
    classifyFailure({ stderr: "503 Service Unavailable: bad gateway" }),
    "TRANSIENT_INFRA",
  );

  // Budget exhausted
  assert.equal(
    classifyFailure({ stderr: "BUDGET_EXHAUSTED: Worker call limit reached" }),
    "BUDGET_EXHAUSTED",
  );

  // Semantic failure
  assert.equal(
    classifyFailure({
      stderr:
        "SEMANTIC_FAILURE: Implementation satisfies types but acceptance criteria not met",
    }),
    "SEMANTIC_FAILURE",
  );

  // Deterministic test failure (failing tests array)
  assert.equal(
    classifyFailure({ failingTests: ["auth-test.ts"] }),
    "DETERMINISTIC_TEST_FAILURE",
  );

  // Deterministic test failure (test failure keywords)
  assert.equal(
    classifyFailure({
      stderr:
        "AssertionError: expected false to be true\n  at test/auth.test.ts:42",
    }),
    "DETERMINISTIC_TEST_FAILURE",
  );

  // Internal error
  assert.equal(
    classifyFailure({ error: "spawn_error: agy binary not found" }),
    "INTERNAL_ERROR",
  );

  // Non-zero exit code fallback
  assert.equal(
    classifyFailure({ exitCode: 1, stderr: "general build error" }),
    "DETERMINISTIC_TEST_FAILURE",
  );
});

test("Failure Classifier - Fingerprint Normalization", () => {
  const stack1 = `
    Error: Assertion failed: expected 200 to equal 401
        at /Users/developer/project/src/auth/token.ts:42:15
        at processTicksAndRejections (node:internal/process/task_queues:95:5)
        at async /Users/developer/project/test/auth/token.test.ts:88:7
        at 0x7fff5fbff430
  `;

  const stack2 = `
    Error: Assertion failed: expected 200 to equal 401
        at /var/runner/work/repo/src/auth/token.ts:52:20
        at processTicksAndRejections (node:internal/process/task_queues:95:5)
        at async /var/runner/work/repo/test/auth/token.test.ts:98:12
        at 0x7fffbeef1234
  `;

  // Normalization strips line/column numbers, hex addresses, and absolute path roots
  const norm1 = normalizeStackTrace(stack1);
  const norm2 = normalizeStackTrace(stack2);
  assert.equal(norm1, norm2);
  assert.ok(!norm1.includes(":42"));
  assert.ok(!norm1.includes(":52"));
  assert.ok(!norm1.includes("0x7fff"));

  // Path normalization
  assert.equal(
    normalizePath("C:\\repo\\src\\auth\\token.ts"),
    "src/auth/token.ts",
  );
  assert.equal(normalizePath("./src/auth/token.ts"), "src/auth/token.ts");

  // Coarse fingerprint matches across shifted line numbers, different platforms, and reordered test lists
  const coarse1 = computeCoarseFingerprint({
    failureClass: "DETERMINISTIC_TEST_FAILURE",
    errorCode: "ERR_ASSERTION",
    failingTests: ["test-b.ts", "test-a.ts"],
    outputExcerpt: stack1,
    changedPaths: ["src/auth/token.ts"],
  });

  const coarse2 = computeCoarseFingerprint({
    failureClass: "DETERMINISTIC_TEST_FAILURE",
    errorCode: "ERR_ASSERTION",
    failingTests: ["test-a.ts", "test-b.ts"],
    outputExcerpt: stack2,
    changedPaths: ["./src/auth/token.ts"],
  });

  assert.equal(coarse1, coarse2);

  // Fine fingerprint captures exact line numbers and differs
  const fine1 = computeFineFingerprint({
    failureClass: "DETERMINISTIC_TEST_FAILURE",
    errorCode: "ERR_ASSERTION",
    failingTests: ["test-a.ts"],
    outputExcerpt: stack1,
  });

  const fine2 = computeFineFingerprint({
    failureClass: "DETERMINISTIC_TEST_FAILURE",
    errorCode: "ERR_ASSERTION",
    failingTests: ["test-a.ts"],
    outputExcerpt: stack2,
  });

  assert.notEqual(fine1, fine2);
});

test("Routing Policy - Pure Routing Decisions", () => {
  // 1. INFRA and RATE_LIMIT retry at same tier within budget (never escalate)
  const infraDec = decideRoutingAction({
    failureClass: "TRANSIENT_INFRA",
    currentTier: "fast",
    attemptCount: 1,
  });
  assert.equal(infraDec.action, "retry_same_tier");
  assert.equal(infraDec.targetTier, "fast");
  assert.equal(infraDec.needsHost, false);

  const rateLimitDec = decideRoutingAction({
    failureClass: "RATE_LIMIT",
    currentTier: "fast",
    attemptCount: 1,
  });
  assert.equal(rateLimitDec.action, "retry_same_tier");
  assert.equal(rateLimitDec.targetTier, "fast");
  assert.equal(rateLimitDec.needsHost, false);

  // 2. SEMANTIC_FAILURE escalates to reasoning tier once
  const semanticFast = decideRoutingAction({
    failureClass: "SEMANTIC_FAILURE",
    currentTier: "fast",
    attemptCount: 1,
  });
  assert.equal(semanticFast.action, "escalate_reasoning");
  assert.equal(semanticFast.targetTier, "reasoning");
  assert.equal(semanticFast.needsHost, false);
  assert.equal(
    shouldEscalateToReasoning({
      failureClass: "SEMANTIC_FAILURE",
      currentTier: "fast",
    }),
    true,
  );

  // Repeated semantic failure already on reasoning tier hands off to host
  const semanticReasoning = decideRoutingAction({
    failureClass: "SEMANTIC_FAILURE",
    currentTier: "reasoning",
    attemptCount: 2,
  });
  assert.equal(semanticReasoning.action, "handoff_host");
  assert.equal(semanticReasoning.needsHost, true);

  // 3. DETERMINISTIC_TEST_FAILURE:
  // First failure retries at same tier (fast)
  const testFirst = decideRoutingAction({
    failureClass: "DETERMINISTIC_TEST_FAILURE",
    currentTier: "fast",
    attemptCount: 1,
    currentFingerprint: "fp_coarse_aaa",
  });
  assert.equal(testFirst.action, "retry_same_tier");
  assert.equal(testFirst.targetTier, "fast");
  assert.equal(testFirst.needsHost, false);

  // Different coarse fingerprint also retries at same tier (not escalating for distinct issues)
  const testDiffFp = decideRoutingAction({
    failureClass: "DETERMINISTIC_TEST_FAILURE",
    currentTier: "fast",
    attemptCount: 2,
    previousFingerprint: "fp_coarse_aaa",
    currentFingerprint: "fp_coarse_bbb",
  });
  assert.equal(testDiffFp.action, "retry_same_tier");
  assert.equal(testDiffFp.targetTier, "fast");
  assert.equal(testDiffFp.needsHost, false);

  // Repeated coarse fingerprint escalates to reasoning
  const testRepeatedFp = decideRoutingAction({
    failureClass: "DETERMINISTIC_TEST_FAILURE",
    currentTier: "fast",
    attemptCount: 2,
    previousFingerprint: "fp_coarse_aaa",
    currentFingerprint: "fp_coarse_aaa",
  });
  assert.equal(testRepeatedFp.action, "escalate_reasoning");
  assert.equal(testRepeatedFp.targetTier, "reasoning");
  assert.equal(testRepeatedFp.needsHost, false);

  // Repeated test failure on reasoning tier hands off to host
  const testRepeatedOnReasoning = decideRoutingAction({
    failureClass: "DETERMINISTIC_TEST_FAILURE",
    currentTier: "reasoning",
    attemptCount: 3,
    previousFingerprint: "fp_coarse_aaa",
    currentFingerprint: "fp_coarse_aaa",
  });
  assert.equal(testRepeatedOnReasoning.action, "handoff_host");
  assert.equal(testRepeatedOnReasoning.needsHost, true);

  // 4. Host handoff for ambiguity, architecture decision, scope violation, patch conflict
  assert.equal(
    decideRoutingAction({
      failureClass: "REQUIREMENT_AMBIGUITY",
      currentTier: "fast",
    }).action,
    "handoff_host",
  );
  assert.equal(
    decideRoutingAction({
      failureClass: "ARCHITECTURE_DECISION",
      currentTier: "fast",
    }).action,
    "handoff_host",
  );
  assert.equal(
    decideRoutingAction({
      failureClass: "SCOPE_VIOLATION",
      currentTier: "fast",
    }).action,
    "handoff_host",
  );
  assert.equal(
    decideRoutingAction({ failureClass: "PATCH_CONFLICT", currentTier: "fast" })
      .action,
    "handoff_host",
  );
  assert.equal(
    decideRoutingAction({ failureClass: "GATE_TIMEOUT", currentTier: "fast" })
      .action,
    "handoff_host",
  );
  assert.equal(
    decideRoutingAction({
      failureClass: "BUDGET_EXHAUSTED",
      currentTier: "fast",
    }).action,
    "handoff_host",
  );

  // 5. Fail-stop for policy denial & internal error
  assert.equal(
    decideRoutingAction({ failureClass: "POLICY_DENIED", currentTier: "fast" })
      .action,
    "fail_stop",
  );
  assert.equal(
    decideRoutingAction({ failureClass: "INTERNAL_ERROR", currentTier: "fast" })
      .action,
    "fail_stop",
  );
});

test("Routing Policy - Model Resolution & Tier Selection", () => {
  const config = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
    AGY_MCP_DEFAULT_MODEL: "default-gemini",
  });

  // Explicit task model overrides everything
  const explicit = resolveWorkerModel("reasoning", config, "custom-flash");
  assert.equal(explicit.model, "custom-flash");
  assert.equal(explicit.effort, "high");
  assert.equal(explicit.isExplicit, true);

  // Fast tier uses low effort
  const fastRes = resolveWorkerModel("fast", config);
  assert.equal(fastRes.model, "default-gemini");
  assert.equal(fastRes.effort, "low");
  assert.equal(fastRes.isExplicit, false);

  // Reasoning tier uses high effort and reports limitation notice when reasoningModel is absent
  const reasoningRes = resolveWorkerModel("reasoning", config);
  assert.equal(reasoningRes.model, "default-gemini");
  assert.equal(reasoningRes.effort, "high");
  assert.equal(reasoningRes.isExplicit, false);
  assert.ok(
    reasoningRes.limitationNotice?.includes("no reasoningModel configured"),
  );

  // Initial tier selection
  assert.equal(selectInitialWorkerTier(createMockTask()), "fast");
  assert.equal(
    selectInitialWorkerTier(createMockTask({ worker: { tier: "reasoning" } })),
    "reasoning",
  );
});
