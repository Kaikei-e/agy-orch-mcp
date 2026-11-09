import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { loadConfig } from "../dist/config.js";
import { DEFAULT_SERVER_LIMITS } from "../dist/domain/limits.js";
import { ProcessRunner } from "../dist/process.js";
import { executeBatch } from "../dist/tools/antigravity-batch.js";
import { validateBatchRequest } from "../dist/validation/schema.js";
import { createAntigravityWorker } from "../dist/workers/antigravity-worker.js";
import { GitRepository } from "../dist/workspace/git-repository.js";

const batchFakeAgy = fileURLToPath(
  new URL("./fixtures/batch/fake-agy.mjs", import.meta.url),
);
await fs.chmod(batchFakeAgy, 0o755);

async function createTempRepo(t) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-batch-resume-"));
  const envDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-batch-env-"));
  t.after(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(envDir, { recursive: true, force: true });
    } catch {}
  });

  const repo = new GitRepository(tmpDir);
  await repo.exec(["init"]);
  await repo.exec(["config", "user.name", "Batch Worker"]);
  await repo.exec(["config", "user.email", "worker@example.com"]);

  await fs.writeFile(path.join(tmpDir, "README.md"), "# Batch Resume Test\n");
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "src", "index.js"),
    "console.log('init');\n",
  );
  await repo.exec(["add", "--all"]);
  await repo.exec(["commit", "-m", "Initial commit"]);

  const baseRev = await repo.getBaseRevision();
  const config = loadConfig({
    AGY_MCP_BIN: batchFakeAgy,
    AGY_MCP_DEFAULT_WORKSPACE: tmpDir,
    AGY_MCP_ENV_ROOT: envDir,
    AGY_ORCH_STORAGE_DIR: path.join(tmpDir, ".git", "agy-orch"),
  });
  const store = new ArtifactStore(
    tmpDir,
    config.storageDir,
    DEFAULT_SERVER_LIMITS,
  );

  return { tmpDir, repo, baseRev, config, store };
}

test("Schema: task worker.timeout_ms max is 900000 while gate timeout_ms max stays 3600000", () => {
  const validTask900k = validateBatchRequest({
    schema_version: "1",
    workspace: { root: "/tmp/repo" },
    tasks: [
      {
        id: "t1",
        objective: "Task at 900000ms cap",
        scope: { include: ["src/**"] },
        owns: ["src/a.js"],
        worker: { timeout_ms: 900_000 },
      },
    ],
    gates: [
      {
        id: "g1",
        after: ["t1"],
        command: ["node", "-v"],
        timeout_ms: 3_600_000,
      },
    ],
  });
  assert.equal(validTask900k.tasks[0].worker?.timeout_ms, 900_000);
  assert.equal(validTask900k.gates?.[0].timeout_ms, 3_600_000);

  assert.throws(
    () =>
      validateBatchRequest({
        schema_version: "1",
        workspace: { root: "/tmp/repo" },
        tasks: [
          {
            id: "t1",
            objective: "Task exceeding 900000ms cap",
            scope: { include: ["src/**"] },
            owns: ["src/a.js"],
            worker: { timeout_ms: 900_001 },
          },
        ],
      }),
    /Invalid BatchRequest.*timeout_ms/i,
  );
});

test("executeBatch: default task turn timeout is 900000ms (bounded by remaining wall time)", async (t) => {
  const { config, store, tmpDir, baseRev } = await createTempRepo(t);

  let observedTimeoutMs = 0;
  const worker = {
    async execute(req) {
      observedTimeoutMs = req.timeoutMs;
      await fs.writeFile(
        path.join(req.workspace, "src", "feature.js"),
        "export const ok = true;\n",
      );
      return {
        status: "succeeded",
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        turns: 1,
      };
    },
  };

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir, base_revision: baseRev },
      tasks: [
        {
          id: "t-default-timeout",
          objective: "Check default timeout",
          scope: { include: ["src/**"] },
          owns: ["src/feature.js"],
        },
      ],
    },
    { store, config, worker },
  );

  assert.equal(result.isError, false);
  assert.equal(observedTimeoutMs, 900_000);
});

test("executeBatch auto-resume: print_timeout on turn 1 resumes with --conversation on turn 2, integrates owned file, and counts 2 worker calls", async (t) => {
  const { config, store, tmpDir, baseRev } = await createTempRepo(t);
  const runner = new ProcessRunner(2);
  t.after(() => runner.close());

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir, base_revision: baseRev },
      tasks: [
        {
          id: "task-resume",
          objective: "Implement feature with PRINT_TIMEOUT_ONCE",
          scope: { include: ["src/**"] },
          owns: ["src/feature.js"],
        },
      ],
      budget: {
        max_worker_calls: 3,
      },
    },
    { store, config, runner },
  );

  assert.equal(result.isError, false);
  const batchResp = result.structuredContent;
  assert.equal(batchResp.status, "succeeded");
  assert.equal(batchResp.tasks[0].status, "integrated");
  assert.equal(batchResp.metrics.worker_calls, 2);

  const humanText = result.content[0].text;
  assert.match(humanText, /Worker calls: 2/);

  // Verify stdout artifact has both turns concatenated and resume prompt content
  const stdoutRef = store.resolveSelector(
    batchResp.run_id,
    "task:task-resume:stdout",
  );
  assert.ok(stdoutRef);
  const stdoutSlice = store.readArtifactSlice(batchResp.run_id, stdoutRef, {
    maxLines: 1000,
  });
  assert.match(stdoutSlice.content, /"finished_reason":"print_timeout"/);
  assert.match(
    stdoutSlice.content,
    /Your previous turn was cut off by the 15-minute turn cap\. Continue the same task in the same worktree\./,
  );
  assert.match(stdoutSlice.content, /completed exit=0 pnpm test/);
  assert.match(stdoutSlice.content, /Last progress note:/);
  assert.match(stdoutSlice.content, /Partial progress before 15-minute cap/);
  assert.match(stdoutSlice.content, /Uncommitted changes:/);
  assert.match(stdoutSlice.content, /src\/feature\.js/);
  assert.match(
    stdoutSlice.content,
    /Finish the remaining work in small verified steps, then end with your final summary\./,
  );

  // Verify stderr artifact preserved the AGY_ERROR line from turn 1
  const stderrRef = store.resolveSelector(
    batchResp.run_id,
    "task:task-resume:stderr",
  );
  assert.ok(stderrRef);
  const stderrSlice = store.readArtifactSlice(batchResp.run_id, stderrRef, {
    maxLines: 1000,
  });
  assert.match(stderrSlice.content, /AGY_ERROR:/);

  // Verify events.jsonl recorded a telemetry event for the resume
  const eventsRef = store.resolveSelector(batchResp.run_id, "events");
  assert.ok(eventsRef);
  const eventsSlice = store.readArtifactSlice(batchResp.run_id, eventsRef, {
    maxLines: 1000,
  });
  assert.match(eventsSlice.content, /"event_type":"budget_consumed"/);
});

test("executeBatch auto-resume: budget exhaustion (max_worker_calls 1) fails as WORKER_TIMEOUT with suffix", async (t) => {
  const { config, store, tmpDir, baseRev } = await createTempRepo(t);
  const runner = new ProcessRunner(2);
  t.after(() => runner.close());

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir, base_revision: baseRev },
      tasks: [
        {
          id: "task-exhaust",
          objective: "Implement feature with PRINT_TIMEOUT_ONCE",
          scope: { include: ["src/**"] },
          owns: ["src/feature.js"],
        },
      ],
      budget: {
        max_worker_calls: 1,
      },
    },
    { store, config, runner },
  );

  assert.equal(result.isError, true);
  const batchResp = result.structuredContent;
  assert.equal(batchResp.tasks[0].status, "failed");
  assert.equal(batchResp.tasks[0].failure_class, "WORKER_TIMEOUT");
  assert.match(
    batchResp.tasks[0].error,
    /; resume budget exhausted after 1 turns$/,
  );
  assert.equal(batchResp.unresolved[0].code, "WORKER_TIMEOUT");
  assert.match(
    batchResp.unresolved[0].message,
    /; resume budget exhausted after 1 turns$/,
  );
  assert.equal(batchResp.metrics.worker_calls, 1);
});

test("executeBatch auto-resume: wall-time deadline with < 60s remaining returns false from consume and fails as WORKER_TIMEOUT with suffix", async (t) => {
  const { config, store, tmpDir, baseRev } = await createTempRepo(t);
  const runner = new ProcessRunner(2);
  t.after(() => runner.close());

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir, base_revision: baseRev },
      tasks: [
        {
          id: "task-wall-cutoff",
          objective: "Implement feature with PRINT_TIMEOUT_ONCE",
          scope: { include: ["src/**"] },
          owns: ["src/feature.js"],
        },
      ],
      budget: {
        max_worker_calls: 5,
        wall_time_ms: 30_000,
      },
    },
    { store, config, runner },
  );

  assert.equal(result.isError, true);
  const batchResp = result.structuredContent;
  assert.equal(batchResp.tasks[0].status, "failed");
  assert.equal(batchResp.tasks[0].failure_class, "WORKER_TIMEOUT");
  assert.match(
    batchResp.tasks[0].error,
    /; resume budget exhausted after 1 turns$/,
  );
  assert.equal(batchResp.metrics.worker_calls, 1);
});

test("AntigravityWorker.execute: concatenates stdout/stderr, sums usage, and sets turns across resumes", async (t) => {
  const { config, tmpDir } = await createTempRepo(t);
  const runner = new ProcessRunner(2);
  t.after(() => runner.close());
  const worker = createAntigravityWorker(config, runner);

  let consumeCalls = 0;
  const res = await worker.execute({
    task: {
      id: "task-worker-resume",
      objective: "PRINT_TIMEOUT_ONCE",
      scope: { include: ["src/**"] },
      owns: ["src/feature.js"],
    },
    workspace: tmpDir,
    runId: "run_unit_1",
    traceId: "tr_unit_1",
    attemptId: "att_unit_1",
    tier: "fast",
    timeoutMs: 30_000,
    resume: {
      consume: () => {
        consumeCalls++;
        return true;
      },
    },
  });

  assert.equal(res.status, "succeeded");
  assert.equal(consumeCalls, 1);
  assert.equal(res.turns, 2);
  assert.equal(res.usage?.input_tokens, 18);
  assert.equal(res.usage?.output_tokens, 12);
  assert.equal(res.usage?.total_tokens, 30);
  assert.match(res.stdout, /"finished_reason":"print_timeout"/);
  assert.match(res.stdout, /"status":"SUCCESS"/);
  assert.match(res.stderr, /AGY_ERROR:/);
});
