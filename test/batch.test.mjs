import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { DEFAULT_SERVER_LIMITS } from "../dist/domain/limits.js";
import { executeBatch } from "../dist/tools/antigravity-batch.js";
import { GitRepository } from "../dist/workspace/git-repository.js";

async function createTempRepo(t) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-batch-unit-"));
  t.after(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const repo = new GitRepository(tmpDir);
  await repo.exec(["init"]);
  await repo.exec(["config", "user.name", "Batch Worker"]);
  await repo.exec(["config", "user.email", "worker@example.com"]);

  await fs.writeFile(path.join(tmpDir, "README.md"), "# Batch Test\n");
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "src", "index.js"),
    "console.log('init');\n",
  );
  await repo.exec(["add", "--all"]);
  await repo.exec(["commit", "-m", "Initial commit"]);

  const baseRev = await repo.getBaseRevision();
  const config = {
    bin: "agy",
    defaultWorkspace: tmpDir,
    maxOutputChars: 40000,
    maxBufferBytes: 8388608,
    maxConcurrent: 4,
    allowFullAutonomy: false,
    storageDir: path.join(tmpDir, ".git", "agy-orch"),
    limits: DEFAULT_SERVER_LIMITS,
    enableFetch: true,
    enableBatch: true,
    toolSurface: "all",
  };
  const store = new ArtifactStore(
    tmpDir,
    config.storageDir,
    DEFAULT_SERVER_LIMITS,
  );

  return { tmpDir, repo, baseRev, config, store };
}

test("executeBatch: invalid preflight rejects upfront without spawning worker", async (t) => {
  const { config, store, tmpDir } = await createTempRepo(t);

  let workerSpawned = false;
  const worker = {
    async execute() {
      workerSpawned = true;
      throw new Error("Worker should NEVER be invoked on preflight failure!");
    },
  };

  // Case 1: Schema error (empty tasks)
  const emptyTasksResult = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir },
      tasks: [],
    },
    { store, config, worker },
  );
  assert.equal(emptyTasksResult.isError, true);
  assert.equal(workerSpawned, false);
  assert.match(emptyTasksResult.content[0].text, /at least one task/);

  // Case 2: DAG cycle
  const cycleResult = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir },
      tasks: [
        {
          id: "a",
          objective: "A",
          after: ["b"],
          scope: { include: ["src/**"] },
          owns: ["src/a.ts"],
        },
        {
          id: "b",
          objective: "B",
          after: ["a"],
          scope: { include: ["src/**"] },
          owns: ["src/b.ts"],
        },
      ],
    },
    { store, config, worker },
  );
  assert.equal(cycleResult.isError, true);
  assert.equal(workerSpawned, false);
  assert.match(cycleResult.content[0].text, /Cycle detected/);

  // Case 3: Exclude overlap (known finding regression)
  const overlapResult = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: { include: ["src/**"], exclude: ["src/secret/**"] },
          owns: ["src/**"],
        },
      ],
    },
    { store, config, worker },
  );
  assert.equal(overlapResult.isError, true);
  assert.equal(workerSpawned, false);
  assert.match(overlapResult.content[0].text, /overlaps with scope\.exclude/);
});

test("executeBatch: rejects workspace root outside allowedRoot before runtime init or worker spawn", async (t) => {
  const { store, tmpDir } = await createTempRepo(t);

  const restrictedConfig = {
    bin: "agy",
    defaultWorkspace: tmpDir,
    allowedRoot: tmpDir,
    maxOutputChars: 40000,
    maxBufferBytes: 8388608,
    maxConcurrent: 4,
    allowFullAutonomy: false,
    storageDir: path.join(tmpDir, ".git", "agy-orch"),
    limits: DEFAULT_SERVER_LIMITS,
    enableFetch: true,
    enableBatch: true,
    toolSurface: "all",
  };

  let workerSpawned = false;
  const worker = {
    async execute() {
      workerSpawned = true;
      throw new Error("Worker must NOT spawn for unauthorized workspace!");
    },
  };

  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-outside-"));
  t.after(async () => {
    try {
      await fs.rm(outsideDir, { recursive: true, force: true });
    } catch {}
  });

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: outsideDir },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: { include: ["src/**"] },
          owns: ["src/index.js"],
        },
      ],
    },
    { store, config: restrictedConfig, worker },
  );

  assert.equal(result.isError, true);
  assert.equal(workerSpawned, false);
  assert.match(
    result.content[0].text,
    /Workspace is outside AGY_MCP_ALLOWED_ROOT/,
  );
});

test("executeBatch: rejects workspace escaping symlink before runtime init or worker spawn", async (t) => {
  const { store, tmpDir } = await createTempRepo(t);

  const restrictedConfig = {
    bin: "agy",
    defaultWorkspace: tmpDir,
    allowedRoot: tmpDir,
    maxOutputChars: 40000,
    maxBufferBytes: 8388608,
    maxConcurrent: 4,
    allowFullAutonomy: false,
    storageDir: path.join(tmpDir, ".git", "agy-orch"),
    limits: DEFAULT_SERVER_LIMITS,
    enableFetch: true,
    enableBatch: true,
    toolSurface: "all",
  };

  let workerSpawned = false;
  const worker = {
    async execute() {
      workerSpawned = true;
      throw new Error("Worker must NOT spawn for symlink-escaping workspace!");
    },
  };

  const outsideDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agy-outside-target-"),
  );
  t.after(async () => {
    try {
      await fs.rm(outsideDir, { recursive: true, force: true });
    } catch {}
  });

  const symlinkPath = path.join(tmpDir, "symlink-outside");
  await fs.symlink(outsideDir, symlinkPath, "dir");

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: symlinkPath },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: { include: ["src/**"] },
          owns: ["src/index.js"],
        },
      ],
    },
    { store, config: restrictedConfig, worker },
  );

  assert.equal(result.isError, true);
  assert.equal(workerSpawned, false);
  assert.match(
    result.content[0].text,
    /Workspace is outside AGY_MCP_ALLOWED_ROOT/,
  );
});

test("executeBatch: fails cleanly if neither worker nor shared ProcessRunner provided", async (t) => {
  const { config, store, tmpDir } = await createTempRepo(t);

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: { include: ["src/**"] },
          owns: ["src/index.js"],
        },
      ],
    },
    { store, config },
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Shared ProcessRunner is required/);
});

test("executeBatch: cancelled request before start returns error without spawning worker", async (t) => {
  const { config, store, tmpDir } = await createTempRepo(t);

  let workerSpawned = false;
  const worker = {
    async execute() {
      workerSpawned = true;
      throw new Error("Worker should not be invoked when cancelled!");
    },
  };

  const controller = new AbortController();
  controller.abort();

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir },
      tasks: [
        {
          id: "t1",
          objective: "test",
          scope: { include: ["src/**"] },
          owns: ["src/index.js"],
        },
      ],
    },
    { store, config, worker, signal: controller.signal },
  );

  assert.equal(result.isError, true);
  assert.equal(workerSpawned, false);
  assert.match(result.content[0].text, /cancelled before start/);
});

test("executeBatch: successful execution contract with structuredContent and compact digest", async (t) => {
  const { config, store, tmpDir, baseRev } = await createTempRepo(t);

  const worker = {
    async execute(req) {
      // Modify owned file in ephemeral worktree
      await fs.writeFile(
        path.join(req.workspace, "src", "feature.js"),
        "export const feature = 'done';\n",
      );
      return {
        status: "succeeded",
        stdout: "Feature implemented successfully",
        stderr: "",
        exitCode: 0,
      };
    },
  };

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir, base_revision: baseRev },
      tasks: [
        {
          id: "task-feat",
          objective: "Implement feature",
          scope: { include: ["src/**"] },
          owns: ["src/feature.js"],
        },
      ],
    },
    { store, config, worker },
  );

  assert.equal(result.isError, false);
  assert.ok(result.structuredContent);

  const batchResp = result.structuredContent;
  assert.equal(batchResp.schema_version, "1");
  assert.equal(batchResp.status, "succeeded");
  assert.ok(batchResp.run_id);
  assert.equal(batchResp.tasks.length, 1);
  assert.equal(batchResp.tasks[0].id, "task-feat");
  assert.equal(batchResp.tasks[0].status, "integrated");

  // Compact human text verification
  const humanText = result.content[0].text;
  assert.match(humanText, /\[agy-orch-mcp\] Batch run_/);
  assert.match(humanText, /succeeded/);

  // Verify manifest in artifact store
  const manifest = store.loadManifest(batchResp.run_id);
  assert.ok(manifest);
  assert.equal(manifest.run_id, batchResp.run_id);
});

test("executeBatch: dirty workspace failure text content contains explicit reason and fix guidance", async (t) => {
  const { config, store, tmpDir, baseRev } = await createTempRepo(t);

  // Dirty the workspace with uncommitted changes
  await fs.writeFile(path.join(tmpDir, "dirty.txt"), "uncommitted changes\n");

  const worker = {
    async execute() {
      throw new Error("Worker should not run on dirty workspace");
    },
  };

  const result = await executeBatch(
    {
      schema_version: "1",
      workspace: { root: tmpDir, base_revision: baseRev },
      tasks: [
        {
          id: "task-dirty",
          objective: "test dirty check",
          scope: { include: ["src/**"] },
          owns: ["src/feature.js"],
        },
      ],
    },
    { store, config, worker },
  );

  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /\[agy-orch-mcp\] Batch run_/);
  assert.match(text, /failed/);
  assert.match(
    text,
    /workspace has uncommitted changes; commit or stash, then retry/,
  );
});
