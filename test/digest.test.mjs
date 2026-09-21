import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { buildDeterministicDigest } from "../dist/digest/deterministic.js";
import {
  createMetricsTracker,
  finalizeMetrics,
} from "../dist/telemetry/metrics.js";

function setupStore(t) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-test-digest-"));
  const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"));
  t.after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
  return { store, tmpDir };
}

test("buildDeterministicDigest preserves recovery pointers and stores full facts in digest.json", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "digest-run-1";
  store.initRun(runId, tmpDir);

  const tracker = createMetricsTracker();
  tracker.workerCalls = 2;
  const metrics = finalizeMetrics(tracker, 100);

  const { response, humanContent } = buildDeterministicDigest(
    {
      runId,
      status: "succeeded",
      summary: "Batch execution completed successfully",
      tasks: [
        {
          id: "task1",
          status: "integrated",
          attempts: 1,
          worker_tier: "fast",
          changed_files: ["src/auth.ts"],
        },
      ],
      gates: [
        {
          id: "verify",
          status: "passed",
          duration_ms: 1500,
        },
      ],
      metrics,
    },
    store,
  );

  assert.equal(response.run_id, runId);
  assert.equal(response.status, "succeeded");
  assert.ok(response.recovery_pointer);
  assert.equal(response.recovery_pointer.run_id, runId);
  // removed;

  // Verify full digest was saved to disk as an artifact
  const digestArtifact = store.resolveSelector(runId, "digest");
  assert.ok(digestArtifact, "digest.json artifact must be registered in store");
  const slice = store.readArtifactSlice(runId, digestArtifact);
  const savedDigest = JSON.parse(slice.content);
  assert.equal(savedDigest.run_id, runId);
  assert.equal(savedDigest.tasks[0].id, "task1");
});

test("buildDeterministicDigest trims details to budget without dropping recovery pointer", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "digest-run-large";
  store.initRun(runId, tmpDir);

  const hugeErrorMessage = "Error stack trace: ".repeat(100);
  const { response } = buildDeterministicDigest(
    {
      runId,
      status: "failed",
      summary: "Some tasks encountered failures",
      tasks: [
        {
          id: "t1",
          status: "failed",
          attempts: 1,
          worker_tier: "fast",
          changed_files: [],
          error: hugeErrorMessage,
        },
      ],
      unresolved: [
        {
          code: "DETERMINISTIC_TEST_FAILURE",
          message: hugeErrorMessage,
          task_id: "t1",
          host_decision_required: false,
        },
      ],
      metrics: finalizeMetrics(createMetricsTracker(), 0),
      maxTokens: 300, // tight limit
    },
    store,
  );

  assert.equal(response.run_id, runId);
  assert.ok(response.recovery_pointer, "Recovery pointer must be preserved");
  // After progressive shedding, long errors and messages are truncated with [trimmed]
  assert.ok(
    response.tasks[0].error?.includes("[trimmed]") ||
      response.tasks[0].error?.includes("omitted"),
    "Error must be truncated or omitted",
  );
  assert.ok(
    response.unresolved[0].message.includes("[trimmed]"),
    "Message must be truncated",
  );
  // Total payload must fit budget
  const payloadStr = JSON.stringify({ structured: response, human: "" });
  const estimatedTokens = Math.ceil(
    Buffer.byteLength(payloadStr, "utf8") / 2.5,
  );
  assert.ok(
    estimatedTokens <= 2000,
    `Digest payload ${estimatedTokens} tokens must fit hard cap`,
  );
});
