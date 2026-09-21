import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { DEFAULT_SERVER_LIMITS } from "../dist/domain/limits.js";

function setupStore(t, limits = DEFAULT_SERVER_LIMITS) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-test-store-"));
  const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"), limits);
  t.after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
  return { store, tmpDir };
}

test("ArtifactStore initializes run manifest and computes accurate SHA-256 hashes", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "test-run-1";
  const manifest = store.initRun(runId, tmpDir);

  assert.equal(manifest.run_id, runId);
  assert.equal(manifest.status, "running");

  const content = "Test log line 1\nTest log line 2\n";
  const expectedHash = createHash("sha256").update(content).digest("hex");
  const expectedBytes = Buffer.byteLength(content, "utf8");

  const artifact = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "tasks/t1/attempt-001/stdout.log",
    content,
    taskId: "t1",
    attempt: 1,
  });

  assert.equal(artifact.sha256, expectedHash);
  assert.equal(artifact.byte_size, expectedBytes);

  // Check manifest was updated
  const reloaded = store.loadManifest(runId);
  assert.equal(reloaded?.artifacts.length, 1);
  assert.equal(reloaded?.artifacts[0].sha256, expectedHash);
});

test("ArtifactStore performs redaction BEFORE persisting to disk", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "test-run-secrets";
  store.initRun(runId, tmpDir);

  const rawContent =
    "Sensitive info: AIzaSyD-1234567890abcdefghijklmnopqrstuv in output";
  const artifact = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "stdout.log",
    content: rawContent,
  });

  assert.equal(artifact.has_secrets, true);

  // Inspect the actual file on disk
  const filePath = path.join(store.getRunDir(runId), artifact.relative_path);
  const onDisk = readFileSync(filePath, "utf8");
  assert.ok(
    !onDisk.includes("AIzaSyD-1234567890abcdefghijklmnopqrstuv"),
    "Disk file must not contain raw secret",
  );
  assert.ok(onDisk.includes("[REDACTED_GOOGLE_API_KEY]"));
});

test("ArtifactStore resolves logical selectors accurately", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "test-run-selectors";
  store.initRun(runId, tmpDir);

  store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "tasks/taskA/attempt-001/stdout.log",
    content: "attempt 1 output",
    taskId: "taskA",
    attempt: 1,
  });

  const latestTaskA = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "tasks/taskA/attempt-002/stdout.log",
    content: "attempt 2 output",
    taskId: "taskA",
    attempt: 2,
  });

  const gateStdout = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "gates/verify/attempt-001/stdout.log",
    content: "gate output",
    gateId: "verify",
    attempt: 1,
  });

  // Selector task:taskA:stdout must return latest attempt (attempt 2)
  const resolvedTask = store.resolveSelector(runId, "task:taskA:stdout");
  assert.equal(resolvedTask?.id, latestTaskA.id);

  // Selector gate:verify:stdout
  const resolvedGate = store.resolveSelector(runId, "gate:verify:stdout");
  assert.equal(resolvedGate?.id, gateStdout.id);

  // Selector manifest
  const resolvedManifest = store.resolveSelector(runId, "manifest");
  assert.equal(resolvedManifest?.kind, "manifest");
});

test("ArtifactStore enforces per-run storage budget cap", (t) => {
  const smallLimit = {
    ...DEFAULT_SERVER_LIMITS,
    maxArtifactBytesPerRun: 500, // 500 bytes max
  };
  const { store, tmpDir } = setupStore(t, smallLimit);
  const runId = "test-run-capped";
  store.initRun(runId, tmpDir);

  // Write 300 bytes - should succeed
  store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "out1.log",
    content: "a".repeat(300),
  });

  // Write another 300 bytes (total 600) - must throw budget exceeded
  assert.throws(() => {
    store.saveArtifact({
      runId,
      kind: "stdout",
      relativePath: "out2.log",
      content: "b".repeat(300),
    });
  }, /Artifact storage budget exceeded/);
});
