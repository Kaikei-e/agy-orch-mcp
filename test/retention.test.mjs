import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { enforceRetentionAndRecovery } from "../dist/artifacts/retention.js";

function setupStore(t) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-test-retention-"));
  const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"));
  t.after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
  return { store, tmpDir };
}

test("enforceRetentionAndRecovery marks uncompleted running runs and tasks as interrupted for dead owners", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "crashed-run-1";
  const manifest = store.initRun(runId, tmpDir);
  const m = store.loadManifest(runId);
  m.owner_pid = 999999;
  m.tasks = {
    t1: { status: "running", attempts: 1 },
    t2: { status: "succeeded", attempts: 1 },
  };
  store.saveManifest(m);
  assert.equal(manifest.status, "running");

  // Run retention sweep (as on server restart)
  const result = enforceRetentionAndRecovery(store);

  assert.ok(result.interruptedRecovered.includes(runId));
  const reloaded = store.loadManifest(runId);
  assert.equal(
    reloaded?.status,
    "interrupted",
    "Crashed running status must become interrupted",
  );
  assert.equal(
    reloaded?.tasks.t1.status,
    "interrupted",
    "Running task of dead owner must become interrupted",
  );
  assert.equal(
    reloaded?.tasks.t2.status,
    "succeeded",
    "Already succeeded task must remain succeeded",
  );
});

test("enforceRetentionAndRecovery never touches live concurrent owner and never auto-spawns workers", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "live-run-1";
  const manifest = store.initRun(runId, tmpDir);
  const m = store.loadManifest(runId);
  m.owner_pid = process.pid; // live owner!
  m.tasks = {
    t1: { status: "running", attempts: 1 },
  };
  store.saveManifest(m);

  const result = enforceRetentionAndRecovery(store);

  // Live owner must NOT be interrupted
  assert.ok(!result.interruptedRecovered.includes(runId));
  const reloaded = store.loadManifest(runId);
  assert.equal(
    reloaded?.status,
    "running",
    "Live owner run must remain running",
  );
  assert.equal(
    reloaded?.tasks.t1.status,
    "running",
    "Live owner task must remain running",
  );
});

test("enforceRetentionAndRecovery cleans up old runs exceeding maxRuns", (t) => {
  const { store, tmpDir } = setupStore(t);

  for (let i = 1; i <= 5; i++) {
    const runId = `run-${i}`;
    const manifest = store.initRun(runId, tmpDir);
    manifest.status = "succeeded";
    store.saveManifest(manifest);
  }

  // Set policy to keep only 2 runs
  const result = enforceRetentionAndRecovery(store, {
    maxRuns: 2,
    maxAgeMs: 100_000,
  });

  assert.equal(result.deletedRuns.length, 3);
  assert.equal(result.sweptRuns, 5);
});

test("enforceRetentionAndRecovery protects pinned runs from deletion", (t) => {
  const { store, tmpDir } = setupStore(t);

  const pinnedRun = store.initRun("pinned-run", tmpDir);
  pinnedRun.status = "succeeded";
  pinnedRun.pinned = true;
  store.saveManifest(pinnedRun);

  const normalRun = store.initRun("normal-run", tmpDir);
  normalRun.status = "succeeded";
  store.saveManifest(normalRun);

  // Set policy to keep 0 runs
  const result = enforceRetentionAndRecovery(store, {
    maxRuns: 0,
    maxAgeMs: 0,
  });

  // Pinned run must NOT be deleted
  assert.ok(!result.deletedRuns.includes("pinned-run"));
  assert.ok(result.deletedRuns.includes("normal-run"));
  assert.ok(store.loadManifest("pinned-run"));
});
