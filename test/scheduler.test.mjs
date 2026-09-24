import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { executeBatch } from "../dist/runtime/scheduler.js";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { GitRepository } from "../dist/workspace/git-repository.js";
import { DEFAULT_SERVER_LIMITS } from "../dist/domain/limits.js";
import {
  extractRuntimeMetrics,
  determineOutcome,
} from "../scripts/baseline.mjs";
import { executeFetch } from "../dist/tools/antigravity-fetch.js";

async function createTempRepo() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-orch-test-"));
  const repo = new GitRepository(tmpDir);
  await repo.exec(["init"]);
  await repo.exec(["config", "user.name", "Test Worker"]);
  await repo.exec(["config", "user.email", "worker@example.com"]);

  await fs.writeFile(path.join(tmpDir, "README.md"), "# Test Project\n");
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "src", "index.js"),
    "console.log('main');\n",
  );
  await repo.exec(["add", "--all"]);
  await repo.exec(["commit", "-m", "Initial commit"]);

  const baseRev = await repo.getBaseRevision();
  return { tmpDir, repo, baseRev };
}

function createConfig(tmpDir) {
  return {
    bin: "agy",
    defaultWorkspace: tmpDir,
    maxOutputChars: 40000,
    maxBufferBytes: 8388608,
    maxConcurrent: 4,
    allowFullAutonomy: false,
    storageDir: path.join(tmpDir, ".git", "agy-orch"),
    limits: DEFAULT_SERVER_LIMITS,
    enableFetch: true,
  };
}

test("Runtime Scheduler Suite", async (t) => {
  await t.test(
    "Parallel DAG execution with deterministic integration and clean source workspace",
    async () => {
      const { tmpDir, repo, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        let activeParallel = 0;
        let maxSeenParallel = 0;

        const mockWorker = {
          async execute(req) {
            activeParallel++;
            if (activeParallel > maxSeenParallel) {
              maxSeenParallel = activeParallel;
            }

            await new Promise((r) => setTimeout(r, 80));

            if (req.task.id === "task-a") {
              await fs.writeFile(
                path.join(req.workspace, "src", "a.js"),
                "export const a = 'a';\n",
              );
            } else if (req.task.id === "task-b") {
              await fs.writeFile(
                path.join(req.workspace, "src", "b.js"),
                "export const b = 'b';\n",
              );
            } else if (req.task.id === "task-c") {
              // Check that task-c has predecessor a's work in baseline
              const aExists = await fs
                .stat(path.join(req.workspace, "src", "a.js"))
                .then(() => true)
                .catch(() => false);
              assert.strictEqual(
                aExists,
                true,
                "task-c must see task-a files in its baseline",
              );

              // But NOT task-b
              const bExists = await fs
                .stat(path.join(req.workspace, "src", "b.js"))
                .then(() => true)
                .catch(() => false);
              assert.strictEqual(
                bExists,
                false,
                "task-c must NOT see unrelated task-b files in its baseline",
              );

              await fs.writeFile(
                path.join(req.workspace, "src", "c.js"),
                "export const c = 'c';\n",
              );
            }

            activeParallel--;
            return {
              status: "succeeded",
              stdout: `Task ${req.task.id} finished successfully`,
              stderr: "",
              exitCode: 0,
            };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "task-a",
              objective: "Implement module A",
              scope: { include: ["src/**"] },
              owns: ["src/a.js"],
            },
            {
              id: "task-b",
              objective: "Implement module B",
              scope: { include: ["src/**"] },
              owns: ["src/b.js"],
            },
            {
              id: "task-c",
              objective: "Implement module C depending on A",
              after: ["task-a"],
              scope: { include: ["src/**"] },
              owns: ["src/c.js"],
            },
          ],
          gates: [
            {
              id: "verify-all",
              after: ["task-a", "task-b", "task-c"],
              command: ["node", "-e", "process.exit(0)"],
            },
          ],
          budget: { max_parallelism: 2 },
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });

        assert.strictEqual(response.status, "succeeded");
        assert.strictEqual(response.tasks.length, 3);
        assert.strictEqual(response.gates.length, 1);
        assert.strictEqual(response.gates[0].status, "passed");

        // Verify that parallel overlap actually happened
        assert.ok(
          maxSeenParallel >= 2,
          `Expected parallel execution (seen: ${maxSeenParallel})`,
        );

        // Verify original workspace was untouched (artifact-only delivery)
        const aInSource = await fs
          .stat(path.join(tmpDir, "src", "a.js"))
          .then(() => true)
          .catch(() => false);
        const bInSource = await fs
          .stat(path.join(tmpDir, "src", "b.js"))
          .then(() => true)
          .catch(() => false);
        const cInSource = await fs
          .stat(path.join(tmpDir, "src", "c.js"))
          .then(() => true)
          .catch(() => false);
        assert.strictEqual(aInSource, false);
        assert.strictEqual(bInSource, false);
        assert.strictEqual(cInSource, false);

        // Verify final.patch artifact was stored
        const manifest = store.loadManifest(response.run_id);
        assert.ok(manifest);
        assert.strictEqual(
          manifest.status,
          "succeeded",
          "Manifest must have terminal status succeeded",
        );
        const finalPatchArtifact = manifest.artifacts.find(
          (a) =>
            a.kind === "patch" && a.relative_path === "integration/final.patch",
        );
        assert.ok(
          finalPatchArtifact,
          "integration/final.patch must be recorded in manifest",
        );

        // Verify dirty status remains clean in original repository
        const isDirty = await repo.checkDirty();
        assert.strictEqual(
          isDirty,
          false,
          "Source repository must remain completely clean",
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Dependent tasks actually execute and unlock greedy dispatch without wave barriers",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        const executedTasks = [];

        const mockWorker = {
          async execute(req) {
            executedTasks.push(req.task.id);
            await fs.writeFile(
              path.join(req.workspace, "src", `${req.task.id}.js`),
              `// ${req.task.id}\n`,
            );
            return {
              status: "succeeded",
              stdout: "done",
              stderr: "",
              exitCode: 0,
            };
          },
        };

        // Chain of dependencies: t1 -> t2 -> t3
        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "t1",
              objective: "Step 1",
              scope: { include: ["src/**"] },
              owns: ["src/t1.js"],
            },
            {
              id: "t2",
              objective: "Step 2",
              after: ["t1"],
              scope: { include: ["src/**"] },
              owns: ["src/t2.js"],
            },
            {
              id: "t3",
              objective: "Step 3",
              after: ["t2"],
              scope: { include: ["src/**"] },
              owns: ["src/t3.js"],
            },
          ],
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });

        assert.strictEqual(response.status, "succeeded");
        assert.deepStrictEqual(
          executedTasks,
          ["t1", "t2", "t3"],
          "Dependent tasks must execute sequentially upon predecessor completion",
        );
        assert.strictEqual(
          response.tasks.every(
            (t) => t.status === "integrated" || t.status === "succeeded",
          ),
          true,
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "No false succeeded: failed predecessor cancels descendants and results in failed",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        const mockWorker = {
          async execute(req) {
            if (req.task.id === "t1") {
              return {
                status: "failed",
                stdout: "",
                stderr: "fatal error",
                exitCode: 1,
              };
            }
            return {
              status: "succeeded",
              stdout: "ok",
              stderr: "",
              exitCode: 0,
            };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "t1",
              objective: "Fail",
              scope: { include: ["src/**"] },
              owns: ["src/t1.js"],
            },
            {
              id: "t2",
              objective: "Blocked",
              after: ["t1"],
              scope: { include: ["src/**"] },
              owns: ["src/t2.js"],
            },
          ],
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });

        assert.notStrictEqual(
          response.status,
          "succeeded",
          "Must NOT report succeeded when task fails",
        );
        assert.strictEqual(response.status, "failed");
        const t1 = response.tasks.find((t) => t.id === "t1");
        const t2 = response.tasks.find((t) => t.id === "t2");
        assert.strictEqual(t1.status, "failed");
        assert.strictEqual(t2.status, "cancelled");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Scope violation detection rejects patch and records failure",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        const mockWorker = {
          async execute(req) {
            await fs.writeFile(
              path.join(req.workspace, "src", "forbidden.js"),
              "illegal\n",
            );
            return {
              status: "succeeded",
              stdout: "Attempted illegal edit",
              stderr: "",
              exitCode: 0,
            };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "task-violator",
              objective: "Illegal edit",
              scope: { include: ["src/**"] },
              owns: ["src/allowed.js"],
            },
          ],
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });

        assert.strictEqual(response.status, "failed");
        assert.strictEqual(response.tasks[0].status, "failed");
        assert.match(response.tasks[0].error, /SCOPE_VIOLATION/);
        assert.strictEqual(response.unresolved.length, 1);
        assert.strictEqual(response.unresolved[0].code, "SCOPE_VIOLATION");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Dirty workspace is rejected with actionable error and snapshot policy is rejected by schema",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        // 1. Test dirty_policy: snapshot is rejected by schema validation
        const { validateBatchRequest } =
          await import("../dist/validation/schema.js");
        assert.throws(() => {
          validateBatchRequest({
            schema_version: "1",
            workspace: {
              root: tmpDir,
              base_revision: baseRev,
              dirty_policy: "snapshot",
            },
            tasks: [
              {
                id: "t1",
                objective: "Test",
                scope: { include: ["src/**"] },
                owns: ["src/t1.js"],
              },
            ],
          });
        }, /Invalid BatchRequest/);

        // 2. Test uncommitted dirty files are rejected with actionable fix guidance
        await fs.writeFile(path.join(tmpDir, "dirty.txt"), "dirty content\n");
        const dirtyReq = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "t1",
              objective: "Test",
              scope: { include: ["src/**"] },
              owns: ["src/t1.js"],
            },
          ],
        };
        const dirtyRes = await executeBatch(dirtyReq, {
          store,
          config,
          worker: {
            async execute() {
              return {};
            },
          },
        });
        assert.strictEqual(dirtyRes.status, "failed");
        assert.match(
          dirtyRes.summary,
          /workspace has uncommitted changes; commit or stash, then retry/,
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Deterministic tree hash regardless of completion order",
    async () => {
      const { tmpDir: dir1, baseRev: base1 } = await createTempRepo();
      const { tmpDir: dir2, baseRev: base2 } = await createTempRepo();

      try {
        const store1 = new ArtifactStore(
          dir1,
          path.join(dir1, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const store2 = new ArtifactStore(
          dir2,
          path.join(dir2, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config1 = createConfig(dir1);
        const config2 = createConfig(dir2);

        const workerRun1 = {
          async execute(req) {
            if (req.task.id === "task-x") {
              await new Promise((r) => setTimeout(r, 20));
              await fs.writeFile(
                path.join(req.workspace, "src", "x.js"),
                "x\n",
              );
            } else {
              await new Promise((r) => setTimeout(r, 120));
              await fs.writeFile(
                path.join(req.workspace, "src", "y.js"),
                "y\n",
              );
            }
            return { status: "succeeded", stdout: "ok", stderr: "" };
          },
        };

        const workerRun2 = {
          async execute(req) {
            if (req.task.id === "task-x") {
              await new Promise((r) => setTimeout(r, 120));
              await fs.writeFile(
                path.join(req.workspace, "src", "x.js"),
                "x\n",
              );
            } else {
              await new Promise((r) => setTimeout(r, 20));
              await fs.writeFile(
                path.join(req.workspace, "src", "y.js"),
                "y\n",
              );
            }
            return { status: "succeeded", stdout: "ok", stderr: "" };
          },
        };

        const makeReq = (root, base) => ({
          schema_version: "1",
          workspace: { root, base_revision: base, dirty_policy: "reject" },
          tasks: [
            {
              id: "task-x",
              objective: "X",
              scope: { include: ["src/**"] },
              owns: ["src/x.js"],
            },
            {
              id: "task-y",
              objective: "Y",
              scope: { include: ["src/**"] },
              owns: ["src/y.js"],
            },
          ],
        });

        const res1 = await executeBatch(makeReq(dir1, base1), {
          store: store1,
          config: config1,
          worker: workerRun1,
        });
        const res2 = await executeBatch(makeReq(dir2, base2), {
          store: store2,
          config: config2,
          worker: workerRun2,
        });

        assert.strictEqual(res1.status, "succeeded");
        assert.strictEqual(res2.status, "succeeded");

        const m1 = store1.loadManifest(res1.run_id);
        const m2 = store2.loadManifest(res2.run_id);
        const patch1Meta = m1.artifacts.find(
          (a) =>
            a.kind === "patch" && a.relative_path === "integration/final.patch",
        );
        const patch2Meta = m2.artifacts.find(
          (a) =>
            a.kind === "patch" && a.relative_path === "integration/final.patch",
        );

        assert.ok(patch1Meta && patch2Meta);
        assert.strictEqual(
          patch1Meta.sha256,
          patch2Meta.sha256,
          "Final patch hash must be strictly deterministic",
        );
      } finally {
        await fs.rm(dir1, { recursive: true, force: true });
        await fs.rm(dir2, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Gate failure triggers actual repair task, invalidates affected gates, and succeeds",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        let repairAttempted = false;
        const mockWorker = {
          async execute(req) {
            if (req.task.id === "task-initial") {
              // Write bug
              await fs.writeFile(
                path.join(req.workspace, "src", "calc.js"),
                "module.exports = 'wrong';\n",
              );
              return { status: "succeeded", stdout: "wrote wrong", stderr: "" };
            } else if (req.task.id.startsWith("repair-")) {
              repairAttempted = true;
              // Verify failureContext was supplied
              assert.ok(req.failureContext);
              // Fix bug
              await fs.writeFile(
                path.join(req.workspace, "src", "calc.js"),
                "module.exports = 'correct';\n",
              );
              return { status: "succeeded", stdout: "repaired", stderr: "" };
            }
            return { status: "succeeded", stdout: "", stderr: "" };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "task-initial",
              objective: "Initial calc",
              scope: { include: ["src/**"] },
              owns: ["src/calc.js"],
            },
          ],
          gates: [
            {
              id: "test-calc",
              after: ["task-initial"],
              command: [
                "node",
                "-e",
                "const val = require('./src/calc.js'); if (val !== 'correct') { console.error('calc error'); process.exit(1); }",
              ],
              timeout_ms: 10000,
            },
          ],
          budget: {
            max_worker_calls: 5,
            max_repair_attempts: 1,
          },
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });

        assert.strictEqual(
          repairAttempted,
          true,
          "Repair task must be executed",
        );
        assert.strictEqual(response.status, "succeeded");
        assert.strictEqual(response.gates[0].status, "passed");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Oversized digest respects max_tokens and preserves recovery pointer without malformed JSON",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        const mockWorker = {
          async execute(req) {
            await fs.writeFile(
              path.join(req.workspace, "src", "out.js"),
              "// ok\n",
            );
            // Generate large output to test truncation
            return {
              status: "succeeded",
              stdout: "X".repeat(50000),
              stderr: "",
            };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "t1",
              objective: "Big output",
              scope: { include: ["src/**"] },
              owns: ["src/out.js"],
            },
          ],
          return: { mode: "digest", max_tokens: 800 },
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });

        assert.strictEqual(response.status, "succeeded");
        assert.ok(response.recovery_pointer);
        assert.strictEqual(response.recovery_pointer.run_id, response.run_id);
        // Ensure JSON parseable and valid
        const serialized = JSON.stringify(response);
        assert.ok(JSON.parse(serialized));
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Global cancellation marks batch failed and aborts pending tasks",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        const abortController = new AbortController();

        const mockWorker = {
          async execute(req) {
            abortController.abort();
            await new Promise((r) => setTimeout(r, 40));
            return { status: "succeeded", stdout: "ok", stderr: "" };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "task-1",
              objective: "T1",
              scope: { include: ["src/**"] },
              owns: ["src/1.js"],
            },
            {
              id: "task-2",
              objective: "T2",
              after: ["task-1"],
              scope: { include: ["src/**"] },
              owns: ["src/2.js"],
            },
          ],
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
          signal: abortController.signal,
        });

        assert.strictEqual(response.status, "failed");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Patch secret detection (POLICY_DENIED) fails closed and does not save corrupted patch",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        const mockWorker = {
          async execute(req) {
            // Attempt to introduce a Google API key into the source file
            await fs.writeFile(
              path.join(req.workspace, "src", "api.js"),
              'const key = "AIzaSyD-1234567890abcdefghijklmnopqrstuv";\n',
            );
            return { status: "succeeded", stdout: "saved secret", stderr: "" };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "task-secret",
              objective: "Add API Key",
              scope: { include: ["src/**"] },
              owns: ["src/api.js"],
            },
          ],
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });

        assert.strictEqual(response.status, "failed");
        assert.strictEqual(response.tasks[0].status, "failed");
        assert.match(response.tasks[0].error, /POLICY_DENIED/);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Retry creates independent attempt worktree, discards attempt1 garbage, and preserves budgets",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();

      try {
        const store = new ArtifactStore(
          tmpDir,
          path.join(tmpDir, ".git", "agy-orch"),
          DEFAULT_SERVER_LIMITS,
        );
        const config = createConfig(tmpDir);

        let attemptsSeen = 0;
        const mockWorker = {
          async execute(req) {
            attemptsSeen++;
            const garbagePath = path.join(req.workspace, "garbage.tmp");
            if (attemptsSeen === 1) {
              // Attempt 1 writes garbage file and returns TRANSIENT_INFRA failure
              await fs.writeFile(garbagePath, "attempt 1 garbage payload");
              return {
                status: "failed",
                failureClass: "TRANSIENT_INFRA",
                message: "Network glitch: socket hang up",
                stdout: "transient network error",
                stderr: "socket hang up",
              };
            }

            // Attempt 2: assert garbage from attempt 1 is absent in fresh worktree!
            let garbageExists = false;
            try {
              await fs.access(garbagePath);
              garbageExists = true;
            } catch {
              garbageExists = false;
            }
            assert.strictEqual(
              garbageExists,
              false,
              "Attempt 2 must have a clean detached worktree without attempt 1 garbage",
            );

            // Write valid file within owns
            await fs.writeFile(
              path.join(req.workspace, "src", "index.js"),
              "console.log('retry success');\n",
            );
            return {
              status: "succeeded",
              stdout: "recovered and finished",
              stderr: "",
            };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          budget: {
            max_worker_calls: 3,
          },
          tasks: [
            {
              id: "task-retry-clean",
              objective: "Verify retry worktree cleanliness",
              scope: { include: ["src/**"] },
              owns: ["src/index.js"],
            },
          ],
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });

        assert.strictEqual(
          attemptsSeen,
          2,
          "Worker must have been called exactly 2 times",
        );
        assert.strictEqual(
          response.metrics.worker_calls,
          2,
          "Budget must record 2 worker calls",
        );
        assert.strictEqual(
          response.metrics.retries,
          1,
          "Metrics must record 1 retry",
        );
        assert.strictEqual(
          response.tasks[0].attempts,
          2,
          "Task attempts must equal 2",
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Manifest freezes immutable commit SHA even when base branch advances",
    async () => {
      const { tmpDir, repo, baseRev } = await createTempRepo();
      try {
        const store = new ArtifactStore(tmpDir);
        const config = createConfig(tmpDir);

        const mockWorker = {
          async execute(req) {
            await fs.writeFile(
              path.join(req.workspace, "src", "index.js"),
              "console.log('frozen sha');\n",
            );
            return { status: "succeeded", stdout: "ok", stderr: "" };
          },
        };

        // Pass symbolic 'HEAD' or branch name
        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: "HEAD",
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "task-sha-freeze",
              objective: "Verify frozen commit SHA",
              scope: { include: ["src/**"] },
              owns: ["src/index.js"],
            },
          ],
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });
        assert.strictEqual(response.status, "succeeded");

        const manifest = store.loadManifest(response.run_id);
        assert.ok(manifest, "Manifest must exist");
        // Must be full 40-character commit SHA, not 'HEAD'
        assert.match(
          manifest.base_revision,
          /^[0-9a-f]{40}$/,
          "base_revision must be resolved to 40-char commit SHA",
        );
        assert.strictEqual(
          manifest.base_revision,
          baseRev,
          "base_revision must match the initial commit SHA",
        );
        assert.ok(manifest.trace_id, "trace_id must be recorded on manifest");

        // Advance branch with a new commit in the source repository
        await fs.writeFile(
          path.join(tmpDir, "README.md"),
          "# Updated Project\n",
        );
        await repo.exec(["add", "--all"]);
        await repo.exec(["commit", "-m", "Advance base branch"]);
        const newRev = await repo.getBaseRevision();
        assert.notStrictEqual(newRev, baseRev, "Source branch has advanced");

        // Manifest base_revision must remain frozen to initial commit SHA
        const reloadedManifest = store.loadManifest(response.run_id);
        assert.strictEqual(
          reloadedManifest.base_revision,
          baseRev,
          "Manifest base_revision must remain immutable",
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    "Request, plan, events artifacts persist and are accessible via selectors, with secrets redacted and events consumable by baseline",
    async () => {
      const { tmpDir, baseRev } = await createTempRepo();
      try {
        const store = new ArtifactStore(tmpDir);
        const config = createConfig(tmpDir);

        const mockSecret = "sk-ant-api03-abcdef1234567890abcdef1234567890";
        const mockWorker = {
          async execute(req) {
            await fs.writeFile(
              path.join(req.workspace, "src", "index.js"),
              "console.log('telemetry and artifacts');\n",
            );
            return { status: "succeeded", stdout: "done", stderr: "" };
          },
        };

        const request = {
          schema_version: "1",
          workspace: {
            root: tmpDir,
            base_revision: baseRev,
            dirty_policy: "reject",
          },
          tasks: [
            {
              id: "task-artifacts-check",
              objective: `Process secret token: ${mockSecret}`,
              scope: { include: ["src/**"] },
              owns: ["src/index.js"],
            },
          ],
          gates: [
            {
              id: "gate-echo-check",
              after: ["task-artifacts-check"],
              command: ["node", "-e", "process.exit(0)"],
            },
          ],
        };

        const response = await executeBatch(request, {
          store,
          config,
          worker: mockWorker,
        });
        assert.strictEqual(response.status, "succeeded");

        // 1. Selector "request": must be accessible and sanitized (secrets redacted)
        const reqArt = store.resolveSelector(response.run_id, "request");
        assert.ok(reqArt, "request selector must resolve");
        const reqSlice = store.readArtifactSlice(response.run_id, reqArt);
        assert.ok(
          !reqSlice.content.includes(mockSecret),
          "request.json must not leak raw secret",
        );
        assert.ok(
          reqSlice.content.includes("[REDACTED_API_KEY]"),
          "request.json must contain redacted secret token",
        );

        // Fetch tool integration test for selector "request"
        const fetchResult = executeFetch(
          { schema_version: "1", run_id: response.run_id, selector: "request" },
          store,
        );
        assert.strictEqual(fetchResult.isError, false);
        assert.ok(
          fetchResult.structuredContent?.content?.includes(
            "[REDACTED_API_KEY]",
          ),
        );

        // 2. Selector "plan": must contain DAG plan
        const planArt = store.resolveSelector(response.run_id, "plan");
        assert.ok(planArt, "plan selector must resolve");
        const planSlice = store.readArtifactSlice(response.run_id, planArt);
        const parsedPlan = JSON.parse(planSlice.content);
        assert.strictEqual(parsedPlan.run_id, response.run_id);
        assert.strictEqual(parsedPlan.base_revision, baseRev);
        assert.deepStrictEqual(parsedPlan.sorted_task_ids, [
          "task-artifacts-check",
        ]);

        // 3. Selector "events": must contain events.jsonl
        const eventsArt = store.resolveSelector(response.run_id, "events");
        assert.ok(eventsArt, "events selector must resolve");
        const eventsSlice = store.readArtifactSlice(response.run_id, eventsArt);
        assert.ok(eventsSlice.content.includes("run_start"));
        assert.ok(eventsSlice.content.includes("task_start"));
        assert.ok(eventsSlice.content.includes("task_complete"));
        assert.ok(eventsSlice.content.includes("gate_start"));
        assert.ok(eventsSlice.content.includes("gate_complete"));
        assert.ok(eventsSlice.content.includes("run_finish"));

        // 4. Consumed by baseline.mjs
        const runtimeMetrics = extractRuntimeMetrics(
          eventsSlice.content,
          response.run_id,
        );
        assert.ok(
          runtimeMetrics,
          "baseline extractRuntimeMetrics must parse events",
        );
        assert.strictEqual(runtimeMetrics.runId, response.run_id);
        assert.strictEqual(runtimeMetrics.workerCalls, 1);
        assert.strictEqual(runtimeMetrics.gatesTotal, 1);
        assert.strictEqual(runtimeMetrics.gatesFirstPassCount, 1);
        assert.strictEqual(runtimeMetrics.gatesFinalPassCount, 1);
        assert.ok(runtimeMetrics.durationMs >= 0);

        const outcome = determineOutcome(eventsSlice.content, "req-1", {
          "req-1": response.run_id,
        });
        assert.strictEqual(outcome.outcome, "succeeded");
        assert.strictEqual(outcome.provenance.source, "events_jsonl");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
