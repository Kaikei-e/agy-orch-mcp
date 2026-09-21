import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { trimStringToTokenBudget } from "../dist/digest/token-budget.js";
import {
  buildDeterministicDigest,
  estimateMinimalDigestTokens,
} from "../dist/digest/deterministic.js";
import { ArtifactStore } from "../dist/artifacts/store.js";
import {
  GitRepository,
  PatchCollector,
  PatchIntegrator,
  OwnershipValidator,
} from "../dist/workspace/index.js";
import { GateRunner } from "../dist/gates/index.js";

test("Finding 1: trimStringToTokenBudget executes safely in ESM without ReferenceError", () => {
  const longText =
    "Hello world! This is a test of the token budgeting system. ".repeat(20);
  const res = trimStringToTokenBudget(longText, 10);
  assert.equal(res.trimmed, true);
  assert.ok(res.text.includes("[TRUNCATED]"));
});

test("Finding 2: store.saveArtifact fails-closed with POLICY_DENIED on secret patch", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agy-test-secret-"));
  try {
    const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"));
    const runId = "run-sec-1";
    store.initRun(runId, tmpDir);

    const secretPatch = `--- a/config.json\n+++ b/config.json\n@@ -1 +1 @@\n-"old"\n+AKIAIOSFODNN7EXAMPLE1\n`;

    assert.throws(
      () => {
        store.saveArtifact({
          runId,
          kind: "patch",
          relativePath: "tasks/t1/patch.diff",
          content: secretPatch,
        });
      },
      (err) => {
        return (
          err instanceof Error &&
          (err.message.includes("POLICY_DENIED") ||
            err.code === "POLICY_DENIED")
        );
      },
    );

    // Ensure raw patch with secret was not written to disk
    const targetPath = path.join(
      tmpDir,
      "storage",
      "runs",
      runId,
      "tasks",
      "t1",
      "patch.diff",
    );
    assert.equal(
      fsSync.existsSync(targetPath),
      false,
      "Secret patch file must not exist on disk",
    );
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Finding 7 & Review 2: store.lockFile fails promptly on live owner with BUSY and reaps dead owner", () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agy-test-lock-"));
  try {
    const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"));
    const runId = "run-lock-1";
    store.initRun(runId, tmpDir);

    const manifestPath = path.join(
      tmpDir,
      "storage",
      "runs",
      runId,
      "manifest.json",
    );
    const lockPath = `${manifestPath}.lock`;

    // 1. Live owner: must fail promptly with BUSY instead of blocking for 3s
    const liveFd = fsSync.openSync(lockPath, "wx");
    fsSync.writeSync(liveFd, `${process.pid}\n${Date.now()}\n`);
    fsSync.closeSync(liveFd);

    const start = Date.now();
    assert.throws(
      () => {
        store.loadManifest(runId);
      },
      (err) => {
        return (
          err instanceof Error &&
          (err.code === "BUSY" || err.message.includes("BUSY"))
        );
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 200,
      `Live lock must fail promptly with BUSY, took ${elapsed}ms`,
    );

    // 2. Dead owner: simulate stale lock from dead PID (PID 99999999)
    const deadPid = 99999999;
    fsSync.writeFileSync(
      lockPath,
      `${deadPid}\n${Date.now() - 10000}\n`,
      "utf8",
    );

    // Must safely reap stale lock and succeed
    const manifest = store.loadManifest(runId);
    assert.ok(
      manifest,
      "Manifest must be loaded after reaping dead owner stale lock",
    );
    assert.equal(
      fsSync.existsSync(lockPath),
      false,
      "Lock must be released after loadManifest",
    );
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Finding 4: PatchCollector records both old and new paths on rename for ownership validation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-test-rename-"));
  try {
    const repo = new GitRepository(tmpDir);
    await repo.exec(["init"]);
    await repo.exec(["config", "user.name", "Test"]);
    await repo.exec(["config", "user.email", "test@example.com"]);

    await fs.mkdir(path.join(tmpDir, "secret"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "secret", "key.txt"), "secret-data\n");
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "base.txt"), "base-data\n");
    await repo.exec(["add", "--all"]);
    await repo.exec(["commit", "-m", "init"]);
    const baseRev = await repo.getBaseRevision();

    // Worker renames secret/key.txt -> src/key.txt
    await repo.exec(["mv", "secret/key.txt", "src/key.txt"]);

    const collector = new PatchCollector(tmpDir);
    const changed = await collector.getChangedPaths(baseRev);

    // Must contain both the deleted old path and the added new path
    const oldEntry = changed.find(
      (c) => c.path === "secret/key.txt" && c.status === "D",
    );
    const newEntry = changed.find((c) => c.path === "src/key.txt");
    assert.ok(oldEntry, "Must record deletion of oldPath on rename");
    assert.ok(newEntry, "Must record newPath on rename");

    // OwnershipValidator with owns: ["src/**"] must REJECT this rename because oldPath is not owned
    const validator = new OwnershipValidator(tmpDir, ["src/**"], ["src/**"]);
    const oldPathOwned = validator.isOwned(oldEntry.path);
    const newPathOwned = validator.isOwned(newEntry.path);
    assert.equal(newPathOwned, true);
    assert.equal(oldPathOwned, false, "secret/key.txt must NOT be owned");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Finding 5 & Review 1: PatchIntegrator clean precondition preserves pre-existing dirty bytes identically", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agy-test-dirty-precondition-"),
  );
  try {
    const repo = new GitRepository(tmpDir);
    await repo.exec(["init"]);
    await repo.exec(["config", "user.name", "Test"]);
    await repo.exec(["config", "user.email", "test@example.com"]);

    // Initial committed file
    await fs.writeFile(path.join(tmpDir, "committed.txt"), "committed\n");
    await repo.exec(["add", "--all"]);
    await repo.exec(["commit", "-m", "init"]);

    // Create pre-existing dirty workspace with 3 types of uncommitted bytes:
    // 1. Staged modification
    await fs.writeFile(
      path.join(tmpDir, "staged.txt"),
      "pre-existing staged data\n",
    );
    await repo.exec(["add", "staged.txt"]);
    const expectedStaged = await fs.readFile(
      path.join(tmpDir, "staged.txt"),
      "utf8",
    );

    // 2. Unstaged modification to committed file
    await fs.writeFile(
      path.join(tmpDir, "committed.txt"),
      "modified unstaged data\n",
    );
    const expectedUnstaged = await fs.readFile(
      path.join(tmpDir, "committed.txt"),
      "utf8",
    );

    // 3. Untracked file
    await fs.writeFile(
      path.join(tmpDir, "untracked.txt"),
      "pre-existing untracked data\n",
    );
    const expectedUntracked = await fs.readFile(
      path.join(tmpDir, "untracked.txt"),
      "utf8",
    );

    const integrator = new PatchIntegrator(tmpDir);

    // Any patch application attempt on dirty workspace MUST be refused before running git apply/reset/clean
    const patch = `--- a/committed.txt\n+++ b/committed.txt\n@@ -1 +1 @@\n-committed\n+new-committed\n`;
    await assert.rejects(integrator.applyPatch(patch), (err) => {
      return (
        err instanceof Error &&
        (err.code === "WORKSPACE_DIRTY" ||
          err.message.includes("WORKSPACE_DIRTY"))
      );
    });

    // Verify all pre-existing bytes remain 100% identical
    const actualStaged = await fs.readFile(
      path.join(tmpDir, "staged.txt"),
      "utf8",
    );
    const actualUnstaged = await fs.readFile(
      path.join(tmpDir, "committed.txt"),
      "utf8",
    );
    const actualUntracked = await fs.readFile(
      path.join(tmpDir, "untracked.txt"),
      "utf8",
    );

    assert.equal(
      actualStaged,
      expectedStaged,
      "Staged bytes must remain identical",
    );
    assert.equal(
      actualUnstaged,
      expectedUnstaged,
      "Unstaged bytes must remain identical",
    );
    assert.equal(
      actualUntracked,
      expectedUntracked,
      "Untracked bytes must remain identical",
    );

    // Verify no temporary patch artifacts were left on disk
    const files = await fs.readdir(tmpDir);
    assert.equal(
      files.some((f) => f.startsWith(".git-apply")),
      false,
      "No temp patch files must remain",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Finding 5: PatchIntegrator rolls back transactionally in dedicated clean worktree on conflict", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-test-conflict-"));
  try {
    const repo = new GitRepository(tmpDir);
    await repo.exec(["init"]);
    await repo.exec(["config", "user.name", "Test"]);
    await repo.exec(["config", "user.email", "test@example.com"]);
    await fs.writeFile(path.join(tmpDir, "file.txt"), "line1\nline2\nline3\n");
    await repo.exec(["add", "--all"]);
    await repo.exec(["commit", "-m", "init"]);

    const integrator = new PatchIntegrator(tmpDir);

    // Conflicting patch
    const conflictingPatch = `--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-completely different line1\n-completely different line2\n-completely different line3\n+modified\n`;

    await assert.rejects(
      integrator.applyPatch(conflictingPatch),
      /PATCH_CONFLICT/,
    );

    // Working directory must be clean (rolled back)
    const isDirty = await repo.checkDirty();
    assert.equal(
      isDirty,
      false,
      "Worktree must be clean after conflict rollback",
    );

    const content = await fs.readFile(path.join(tmpDir, "file.txt"), "utf8");
    assert.equal(
      content,
      "line1\nline2\nline3\n",
      "Content must be restored to original",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Finding 6: GateRunner reaps process group and handles hanging child stdout", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agy-test-gate-hang-"),
  );
  try {
    const runner = new GateRunner({
      allowedExecutables: ["node"],
      deniedExecutables: [],
      allowedEnvKeys: ["PATH"],
      maxOutputBytes: 1024 * 1024,
    });

    // Script that spawns a background grandchild keeping stdout pipe open
    const scriptPath = path.join(tmpDir, "hang.cjs");
    await fs.writeFile(
      scriptPath,
      `
      const { spawn } = require('child_process');
      const sub = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
      setTimeout(() => process.exit(0), 100);
    `,
    );

    const startTime = Date.now();
    const res = await runner.runGate(["node", scriptPath], tmpDir, 2000);
    const elapsed = Date.now() - startTime;

    // Must resolve cleanly within bounded time despite grandchild holding stdout
    assert.ok(elapsed < 2000, `Must not hang, took ${elapsed}ms`);
    assert.equal(res.exitCode, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Finding 8 & Review 3: buildDeterministicDigest preserves all 20 tasks and 10 gates with Unicode within hard token cap", () => {
  const tmpDir = fsSync.mkdtempSync(
    path.join(os.tmpdir(), "agy-test-digest-max-"),
  );
  try {
    const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"));
    const runId = "run-max-unicode";
    store.initRun(runId, tmpDir);

    // Maximum legal tasks (20) and gates (10) as defined in schema.ts
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: `task-${String(i + 1).padStart(2, "0")}`,
      status: i % 5 === 0 ? "failed" : "succeeded",
      attempts: 1,
      worker_tier: "fast",
      changed_files: [
        `src/機能/認証_${i + 1}.ts`,
        `test/機能/認証_${i + 1}.test.ts`,
        `docs/設計/認可_${i + 1}.md`,
        `extra/ファイル_${i + 1}.json`, // 4th file to test omitted_files_count
      ],
      error:
        i % 5 === 0
          ? `タスク ${i + 1} で例外が発生しました: 詳細なスタックトレース...`.repeat(
              5,
            )
          : undefined,
    }));

    const gates = Array.from({ length: 10 }, (_, i) => ({
      id: `gate-${String(i + 1).padStart(2, "0")}`,
      status: i === 0 ? "failed" : "passed",
      exit_code: i === 0 ? 1 : 0,
      duration_ms: 120 + i * 10,
      failing_tests:
        i === 0
          ? [
              "テストケース: 認証トークン失効の検証",
              "テストケース: パスワードリセット失敗の検証",
              "テストケース: 権限昇格拒否の検証",
              "テストケース: 4件目の省略対象テスト",
            ]
          : undefined,
    }));

    const unresolved = [
      {
        code: "DETERMINISTIC_TEST_FAILURE",
        message:
          "テストスイートゲート 01 で失敗が検出されました。ホストの確認が必要です。",
        task_id: "task-01",
        gate_id: "gate-01",
        host_decision_required: true,
      },
    ];

    const { response, humanContent } = buildDeterministicDigest(
      {
        runId,
        status: "failed",
        summary:
          "日本語サマリー: 20タスクと10ゲートの大規模実行結果です。複数のテストとファイルが処理されました。",
        tasks,
        gates,
        unresolved,
        metrics: {
          duration_ms: 15000,
          worker_calls: 20,
          retries: 1,
          escalations: 0,
          raw_output_bytes: 50000,
          digest_tokens_estimated: 0,
        },
        maxTokens: 2000, // Hard server limit
      },
      store,
    );

    // Crucial invariants:
    // 1. All 20 tasks and 10 gates MUST be preserved with their status & exit codes
    assert.equal(
      response.tasks.length,
      20,
      "All 20 task entries must be preserved",
    );
    assert.equal(
      response.gates.length,
      10,
      "All 10 gate entries must be preserved",
    );
    assert.equal(
      response.unresolved.length,
      1,
      "Unresolved decisions must be preserved",
    );

    // 2. Exact statuses and exit codes preserved
    assert.equal(response.gates[0].id, "gate-01");
    assert.equal(response.gates[0].status, "failed");
    assert.equal(response.gates[0].exit_code, 1);
    assert.equal(response.tasks[0].id, "task-01");
    assert.equal(response.tasks[0].status, "failed");

    // 3. Recovery pointer must be present and valid
    assert.ok(response.recovery_pointer, "Recovery pointer must be present");
    assert.equal(response.recovery_pointer.run_id, runId);

    // 4. Token count must strictly comply with the hard cap of 2000 tokens
    const payloadStr = JSON.stringify({
      structured: response,
      human: humanContent,
    });
    const bytes = Buffer.byteLength(payloadStr, "utf8");
    const estimatedTokens = Math.ceil(bytes / 2.5);
    assert.ok(
      estimatedTokens <= 2000,
      `Estimated tokens (${estimatedTokens}, ${bytes} bytes) must be <= 2000 hard token cap`,
    );
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Final 1: GateRunner abort signal handles pre-abort zero-spawn and running abort with process-group reap", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agy-test-gate-abort-"),
  );
  try {
    const runner = new GateRunner({
      allowedExecutables: ["node"],
      deniedExecutables: [],
      allowedEnvKeys: ["PATH"],
      maxOutputBytes: 1024 * 1024,
    });

    // 1. Pre-aborted signal: must return immediately with CANCELED without spawning
    const preAbortController = new AbortController();
    preAbortController.abort();
    const preStart = Date.now();
    const preRes = await runner.runGate(
      ["node", "-e", "process.exit(0)"],
      tmpDir,
      5000,
      undefined,
      undefined,
      preAbortController.signal,
    );
    const preElapsed = Date.now() - preStart;
    assert.ok(
      preElapsed < 100,
      `Pre-abort must settle immediately, took ${preElapsed}ms`,
    );
    assert.equal(preRes.exitCode, null);
    assert.equal(preRes.failure, "CANCELED");

    // 2. Running abort: stops long-running gate and grandchild within bounded time
    const runningController = new AbortController();
    const pidFile = path.join(tmpDir, "grandchild.pid");
    const scriptPath = path.join(tmpDir, "spawn-tree.cjs");
    await fs.writeFile(
      scriptPath,
      `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const sub = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: false });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(sub.pid));
      setInterval(() => {}, 1000);
    `,
    );

    const runStart = Date.now();
    const runPromise = runner.runGate(
      ["node", scriptPath],
      tmpDir,
      10000, // large timeout; abort will trigger early
      undefined,
      undefined,
      runningController.signal,
    );

    // Wait until child and grandchild start and write PID
    let grandchildPid;
    for (let i = 0; i < 50; i++) {
      try {
        const content = await fs.readFile(pidFile, "utf8");
        if (content.trim()) {
          grandchildPid = parseInt(content.trim(), 10);
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(grandchildPid, "Grandchild PID must be captured");

    // Abort while running
    runningController.abort();
    const runRes = await runPromise;
    const runElapsed = Date.now() - runStart;

    assert.ok(
      runElapsed < 2500,
      `Abort must stop process within bounded time, took ${runElapsed}ms`,
    );
    assert.equal(runRes.failure, "CANCELED");

    // Give kernel a brief moment to finish reaping process group
    await new Promise((r) => setTimeout(r, 100));

    // Verify grandchild is terminated
    let grandchildAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch (e) {
      if (e.code === "ESRCH") grandchildAlive = false;
    }
    assert.equal(
      grandchildAlive,
      false,
      "Grandchild process must be terminated after abort",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Final 2: PatchCollector diff commands ignore external diff drivers from git config and gitattributes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-test-extdiff-"));
  try {
    const repo = new GitRepository(tmpDir);
    await repo.exec(["init"]);
    await repo.exec(["config", "user.name", "Test"]);
    await repo.exec(["config", "user.email", "test@example.com"]);

    // Configure an external diff driver locally in the fixture repo that would fail
    // or corrupt the diff if invoked
    const fakeDriver = path.join(tmpDir, "fake-diff.sh");
    await fs.writeFile(
      fakeDriver,
      "#!/bin/sh\necho 'EXTERNAL_DIFF_POISON' >&2\nexit 1\n",
      { mode: 0o755 },
    );

    await repo.exec(["config", "diff.external", fakeDriver]);
    await repo.exec(["config", "diff.custom.command", fakeDriver]);
    await fs.writeFile(path.join(tmpDir, ".gitattributes"), "* diff=custom\n");

    // Create and commit base file
    await fs.writeFile(path.join(tmpDir, "tracked.txt"), "base content\n");
    await repo.exec(["add", "--all"]);
    await repo.exec(["commit", "-m", "initial"]);
    const baseRev = await repo.getBaseRevision();

    // Modify file
    await fs.writeFile(path.join(tmpDir, "tracked.txt"), "modified content\n");

    const collector = new PatchCollector(tmpDir);

    // Both getChangedPaths and collectPatch must succeed cleanly due to --no-ext-diff --no-textconv
    const changed = await collector.getChangedPaths(baseRev);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].path, "tracked.txt");

    const patch = await collector.collectPatch(baseRev);
    assert.ok(patch.includes("diff --git a/tracked.txt b/tracked.txt"));
    assert.ok(patch.includes("+modified content"));
    assert.ok(!patch.includes("EXTERNAL_DIFF_POISON"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Final 3: ArtifactStore lock reclamation verifies identity before unlinking and protects newly created locks", () => {
  const tmpDir = fsSync.mkdtempSync(
    path.join(os.tmpdir(), "agy-test-lock-race-"),
  );
  try {
    const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"));
    const runId = "run-lock-race";
    store.initRun(runId, tmpDir);

    const manifestPath = path.join(
      tmpDir,
      "storage",
      "runs",
      runId,
      "manifest.json",
    );
    const lockPath = `${manifestPath}.lock`;

    // 1. Newly created lock (<3000ms) with malformed/empty content: must NOT be unlinked
    fsSync.writeFileSync(lockPath, "", "utf8");
    assert.throws(
      () => {
        store.loadManifest(runId);
      },
      (err) => {
        return (
          err instanceof Error &&
          (err.code === "LOCK_FAILED" || err.message.includes("LOCK_FAILED"))
        );
      },
    );
    // Verify lock file was protected and NOT deleted
    assert.equal(
      fsSync.existsSync(lockPath),
      true,
      "Newly created lock (<3000ms) must not be deleted",
    );

    // Clean up empty lock
    fsSync.unlinkSync(lockPath);

    // 2. Dead PID reclamation: stale lock with dead PID (99999999) is successfully reaped
    fsSync.writeFileSync(lockPath, `99999999\n${Date.now() - 5000}\n`, "utf8");
    const manifest = store.loadManifest(runId);
    assert.ok(
      manifest,
      "Manifest successfully loaded after reaping dead PID lock",
    );
    assert.equal(
      fsSync.existsSync(lockPath),
      false,
      "Lock cleanly released after completion",
    );
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Final 4: Digest estimateMinimalDigestTokens calculates minimal skeleton, lower 800 succeeds for normal load, and throws CAPACITY_EXCEEDED when exceeded", () => {
  const tmpDir = fsSync.mkdtempSync(
    path.join(os.tmpdir(), "agy-test-digest-cap-"),
  );
  try {
    const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"));
    const runId = "run-cap-test";
    store.initRun(runId, tmpDir);

    // 1. Normal lower 800 budget test (1-2 tasks): must succeed cleanly within 800 tokens
    const normalTasks = [
      {
        id: "task-01",
        status: "succeeded",
        attempts: 1,
        worker_tier: "fast",
        changed_files: ["src/index.ts"],
      },
      {
        id: "task-02",
        status: "succeeded",
        attempts: 1,
        worker_tier: "fast",
        changed_files: ["test/index.test.ts"],
      },
    ];
    const normalGates = [
      {
        id: "gate-01",
        status: "passed",
        duration_ms: 250,
      },
    ];

    const normalDigest = buildDeterministicDigest(
      {
        runId,
        status: "succeeded",
        summary: "Normal execution completed successfully",
        tasks: normalTasks,
        gates: normalGates,
        metrics: {
          duration_ms: 500,
          worker_calls: 2,
          retries: 0,
          escalations: 0,
          raw_output_bytes: 1000,
          digest_tokens_estimated: 0,
        },
        maxTokens: 800,
      },
      store,
    );

    assert.equal(normalDigest.response.tasks.length, 2);
    assert.equal(normalDigest.response.gates.length, 1);
    const normalPayloadStr = JSON.stringify({
      structured: normalDigest.response,
      human: normalDigest.humanContent,
    });
    const normalTokens = Math.ceil(
      Buffer.byteLength(normalPayloadStr, "utf8") / 2.5,
    );
    assert.ok(
      normalTokens <= 800,
      `Normal payload tokens (${normalTokens}) must be <= 800`,
    );

    // 2. estimateMinimalDigestTokens helper verification on 20 tasks + 10 gates
    const maxTasks = Array.from({ length: 20 }, (_, i) => ({
      id: `task-${String(i + 1).padStart(2, "0")}`,
      status: "succeeded",
      attempts: 1,
      worker_tier: "fast",
      changed_files: [`file_${i}.ts`],
    }));
    const maxGates = Array.from({ length: 10 }, (_, i) => ({
      id: `gate-${String(i + 1).padStart(2, "0")}`,
      status: "passed",
      duration_ms: 100,
    }));

    const digestParams = {
      runId: "run-max-cap",
      status: "succeeded",
      summary: "20 tasks and 10 gates execution",
      tasks: maxTasks,
      gates: maxGates,
      metrics: {
        duration_ms: 5000,
        worker_calls: 20,
        retries: 0,
        escalations: 0,
        raw_output_bytes: 20000,
        digest_tokens_estimated: 0,
      },
    };

    const minTokens = estimateMinimalDigestTokens(digestParams);
    assert.ok(
      minTokens > 800,
      `Minimal skeleton of 20 tasks + 10 gates (${minTokens} tokens) must exceed 800`,
    );
    assert.ok(
      minTokens <= 2000,
      `Minimal skeleton of 20 tasks + 10 gates (${minTokens} tokens) must be <= 2000`,
    );

    // 3. When maxTokens is set to 800 on 20 tasks + 10 gates:
    // MUST NOT silently drop tasks or silently exceed budget;
    // MUST throw CAPACITY_EXCEEDED error with run_id and valid recovery_pointer
    store.initRun("run-max-cap", tmpDir);
    let caughtError;
    try {
      buildDeterministicDigest(
        {
          ...digestParams,
          maxTokens: 800,
        },
        store,
      );
    } catch (err) {
      caughtError = err;
    }

    assert.ok(
      caughtError,
      "Must throw error when minimal skeleton exceeds maxTokens",
    );
    assert.equal(caughtError.code, "CAPACITY_EXCEEDED");
    assert.equal(caughtError.run_id, "run-max-cap");
    assert.ok(
      caughtError.recovery_pointer,
      "Error must preserve recovery pointer",
    );
    assert.equal(caughtError.recovery_pointer.run_id, "run-max-cap");

    // 4. Verify full digest artifact was still persisted on disk for host retrieval
    const digestArtifact = store.resolveSelector("run-max-cap", "digest");
    assert.ok(digestArtifact, "Digest artifact must be registered in store");
    assert.equal(
      digestArtifact.id,
      caughtError.recovery_pointer.digest_artifact_id,
    );
    const slice = store.readArtifactSlice("run-max-cap", digestArtifact, {
      maxLines: 1000,
    });
    assert.ok(
      slice && slice.content,
      "Full facts must be retrievable via recovery pointer",
    );
    const fullSaved = JSON.parse(slice.content);
    assert.equal(fullSaved.tasks.length, 20);
    assert.equal(fullSaved.gates.length, 10);
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
});
