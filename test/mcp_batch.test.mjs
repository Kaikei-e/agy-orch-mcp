import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { estimateTokenCount } from "../dist/digest/token-budget.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const server = path.join(root, "dist", "index.js");

function createFakeCliScript(dir) {
  const cliPath = path.join(dir, "fake-agy.mjs");
  const scriptContent = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.2.6-test\\n");
  process.exit(0);
}
if (args[0] === "--help") {
  process.stdout.write("--output-format --print-timeout --disable-slash-commands --conversation --mode --sandbox\\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("test-model\\tTest Model\\n");
  process.exit(0);
}

// Marker file to verify worker spawn
const markerFile = process.env.FAKE_CLI_SPAWN_MARKER;
if (markerFile) {
  fs.appendFileSync(markerFile, "spawn\\n");
}

const promptIdx = args.indexOf("-p");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";
const cwd = process.cwd();
const targetFile = path.join(cwd, "src", "index.js");

if (prompt.includes("Task 1")) {
  if (fs.existsSync(targetFile)) {
    fs.appendFileSync(targetFile, "\\nexport function feat1() { return 'feat1'; }\\n");
  }
} else if (prompt.includes("Task 2")) {
  if (fs.existsSync(targetFile)) {
    fs.appendFileSync(targetFile, "\\nexport function feat2() { return 'feat2'; }\\n");
  }
}

console.log(JSON.stringify({ event: "init", conversation_id: "fake-conv-id" }));
console.log(JSON.stringify({
  event: "result",
  result: {
    status: "SUCCESS",
    response: "Applied changes successfully",
    conversation_id: "fake-conv-id"
  }
}));
process.exit(0);
`;
  writeFileSync(cliPath, scriptContent, { mode: 0o755 });
  return cliPath;
}

function createTestClient(extraEnv = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-mcp-batch-test-"));
  const fakeCli = createFakeCliScript(tmpDir);

  const env = {
    ...process.env,
    AGY_MCP_BIN: fakeCli,
    AGY_MCP_DEFAULT_WORKSPACE: root,
    AGY_MCP_ALLOWED_ROOT: root,
    AGY_MCP_MAX_CONCURRENT: "4",
    AGY_ORCH_STORAGE_DIR: path.join(tmpDir, "storage"),
  };
  delete env.AGY_MCP_ENABLE_BATCH;
  delete env.AGY_MCP_ENABLE_FETCH;
  delete env.AGY_MCP_TOOL_SURFACE;
  delete env.AGY_MCP_TOOL_PROFILE;
  Object.assign(env, extraEnv);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: root,
    stderr: "pipe",
    env,
  });
  const client = new Client(
    { name: "agy-orch-mcp-batch-integration-test", version: "1.0.0" },
    {},
  );
  return { client, transport, tmpDir, fakeCli };
}

async function closeClient({ client, transport, tmpDir }) {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

function initGitRepo(repoDir) {
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  mkdirSync(path.join(repoDir, "src"), { recursive: true });
  writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\n");
  writeFileSync(
    path.join(repoDir, "src", "index.js"),
    "export const initial = true;\n",
  );
  execFileSync("git", ["add", "--all"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();
}

test("MCP discovery: default configuration preserves backward-compatible tools without batch", async (t) => {
  const pair = createTestClient();
  t.after(() => closeClient(pair));
  await pair.client.connect(pair.transport);

  const list = await pair.client.listTools();
  const toolNames = list.tools.map((tool) => tool.name).sort();

  assert.deepEqual(toolNames, [
    "antigravity_continue",
    "antigravity_models",
    "antigravity_run",
  ]);
  assert.equal(toolNames.includes("antigravity_batch"), false);
});

test("MCP discovery: AGY_MCP_ENABLE_BATCH=true adds antigravity_batch while maintaining legacy endpoints", async (t) => {
  const pair = createTestClient({ AGY_MCP_ENABLE_BATCH: "true" });
  t.after(() => closeClient(pair));
  await pair.client.connect(pair.transport);

  const list = await pair.client.listTools();
  const toolNames = list.tools.map((tool) => tool.name).sort();

  assert.deepEqual(toolNames, [
    "antigravity_batch",
    "antigravity_continue",
    "antigravity_models",
    "antigravity_run",
  ]);
});

test("MCP discovery: antigravity_batch tool description publishes effective limits from config", async (t) => {
  const pair = createTestClient({
    AGY_MCP_ENABLE_BATCH: "true",
    AGY_MCP_MAX_CONCURRENT: "8",
  });
  t.after(() => closeClient(pair));
  await pair.client.connect(pair.transport);

  const list = await pair.client.listTools();
  const batchTool = list.tools.find(
    (tool) => tool.name === "antigravity_batch",
  );
  assert.ok(batchTool, "antigravity_batch tool must be present");

  const desc = batchTool.description ?? "";
  assert.match(desc, /up to 20 tasks/);
  assert.match(desc, /10 gates/);
  assert.match(desc, /8 parallel tasks/); // scaled to min(16, maxConcurrent=8)
  assert.match(desc, /50 worker calls/);
  assert.match(desc, /7200000ms/);
  assert.match(desc, /clamped/);
  assert.match(desc, /clean git tree/);
  assert.match(desc, /scope\.include/);
  assert.match(desc, /isolated git worktree/);
  assert.match(desc, /final\.patch/);
});

test("MCP discovery: AGY_MCP_TOOL_SURFACE=batch exposes minimal batch and fetch surface only", async (t) => {
  const pair = createTestClient({ AGY_MCP_TOOL_SURFACE: "batch" });
  t.after(() => closeClient(pair));
  await pair.client.connect(pair.transport);

  const list = await pair.client.listTools();
  const toolNames = list.tools.map((tool) => tool.name).sort();

  assert.deepEqual(toolNames, ["antigravity_batch", "antigravity_fetch"]);
});

test("MCP call: invalid preflight rejects upfront with zero worker spawn marker check", async (t) => {
  const markerFile = path.join(
    os.tmpdir(),
    `preflight-spawn-marker-${Date.now()}.txt`,
  );
  t.after(() => {
    try {
      rmSync(markerFile, { force: true });
    } catch {}
  });

  const pair = createTestClient({
    AGY_MCP_ENABLE_BATCH: "true",
    FAKE_CLI_SPAWN_MARKER: markerFile,
  });
  t.after(() => closeClient(pair));
  await pair.client.connect(pair.transport);

  // Invalid request: cyclic dependency
  const result = await pair.client.callTool({
    name: "antigravity_batch",
    arguments: {
      schema_version: "1",
      workspace: { root: pair.tmpDir },
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
  });

  assert.equal(result.isError, true);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Cycle detected/);

  // Assert ZERO CLI worker spawn via marker file
  assert.equal(
    existsSync(markerFile),
    false,
    "Fake CLI must not have been spawned for invalid preflight",
  );
});

test("MCP call: capacity preflight rejection rejects impossible max_tokens with zero worker spawn", async (t) => {
  const markerFile = path.join(
    os.tmpdir(),
    `capacity-spawn-marker-${Date.now()}.txt`,
  );
  t.after(() => {
    try {
      rmSync(markerFile, { force: true });
    } catch {}
  });

  const pair = createTestClient({
    AGY_MCP_ENABLE_BATCH: "true",
    FAKE_CLI_SPAWN_MARKER: markerFile,
  });
  t.after(() => closeClient(pair));
  await pair.client.connect(pair.transport);

  // 20 tasks and 5 gates with max_tokens: 100 cannot fit minimal skeleton
  const tasks = Array.from({ length: 20 }, (_, i) => ({
    id: `task-${i + 1}`,
    objective: `Task ${i + 1}`,
    scope: { include: ["src/**"] },
    owns: [`src/file-${i + 1}.ts`],
  }));
  const gates = Array.from({ length: 5 }, (_, i) => ({
    id: `gate-${i + 1}`,
    after: ["task-1"],
    command: ["node", "-v"],
  }));

  const result = await pair.client.callTool({
    name: "antigravity_batch",
    arguments: {
      schema_version: "1",
      workspace: { root: pair.tmpDir },
      tasks,
      gates,
      return: {
        mode: "digest",
        max_tokens: 100,
      },
    },
  });

  assert.equal(
    result.isError,
    true,
    "Tool result must indicate error for impossible capacity",
  );
  const text = result.content[0]?.text ?? "";
  assert.match(
    text,
    /CAPACITY_EXCEEDED/,
    "Error message must report CAPACITY_EXCEEDED",
  );
  assert.match(
    text,
    /minimal response skeleton/,
    "Error message must report required skeleton tokens",
  );

  // Assert ZERO CLI worker spawn via marker file
  assert.equal(
    existsSync(markerFile),
    false,
    "CLI must not have been spawned when capacity exceeded preflight",
  );
});

test("MCP call: cancelled request rejects or returns error before worker execution", async (t) => {
  const pair = createTestClient({
    AGY_MCP_ENABLE_BATCH: "true",
  });
  t.after(() => closeClient(pair));
  await pair.client.connect(pair.transport);

  const controller = new AbortController();
  controller.abort();

  try {
    const result = await pair.client.callTool(
      {
        name: "antigravity_batch",
        arguments: {
          schema_version: "1",
          workspace: { root: pair.tmpDir },
          tasks: [
            {
              id: "t1",
              objective: "test",
              scope: { include: ["src/**"] },
              owns: ["src/index.js"],
            },
          ],
        },
      },
      { signal: controller.signal },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /cancelled/i);
  } catch (err) {
    assert.match(String(err), /aborted|cancelled/i);
  }
});

test("MCP call: gate cancellation via abort signal terminates running gate cleanly", async (t) => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "agy-git-gate-cancel-"));
  const pair = createTestClient({
    AGY_MCP_ENABLE_BATCH: "true",
    AGY_MCP_DEFAULT_WORKSPACE: repoDir,
    AGY_MCP_ALLOWED_ROOT: repoDir,
  });

  t.after(() => {
    closeClient(pair);
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  });

  const baseRev = initGitRepo(repoDir);
  await pair.client.connect(pair.transport);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);

  try {
    const result = await pair.client.callTool(
      {
        name: "antigravity_batch",
        arguments: {
          schema_version: "1",
          workspace: { root: repoDir, base_revision: baseRev },
          tasks: [
            {
              id: "task-1",
              objective: "Task 1",
              scope: { include: ["src/**"] },
              owns: ["src/index.js"],
            },
          ],
          gates: [
            {
              id: "gate-long",
              after: ["task-1"],
              command: ["node", "-e", "setTimeout(() => {}, 5000)"],
              timeout_ms: 5000,
            },
          ],
        },
      },
      { signal: controller.signal },
    );
    if (result.structuredContent) {
      assert.notEqual(result.structuredContent.gates[0]?.status, "passed");
    }
  } catch (err) {
    assert.match(String(err), /aborted|cancelled/i);
  }
});

test("MCP call: strict success contract via fake CLI, 2 dependent tasks, and argv gate", async (t) => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "agy-git-strict-repo-"));

  const pair = createTestClient({
    AGY_MCP_ENABLE_BATCH: "true",
    AGY_MCP_ENABLE_FETCH: "true",
    AGY_MCP_DEFAULT_WORKSPACE: repoDir,
    AGY_MCP_ALLOWED_ROOT: repoDir,
  });
  const markerFile = path.join(pair.tmpDir, "strict-spawn-marker.txt");

  t.after(() => {
    closeClient(pair);
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  });

  const baseRev = initGitRepo(repoDir);
  await pair.client.connect(pair.transport);

  const result = await pair.client.callTool({
    name: "antigravity_batch",
    arguments: {
      schema_version: "1",
      workspace: { root: repoDir, base_revision: baseRev },
      tasks: [
        {
          id: "task-1",
          objective: "Task 1: Add first function",
          scope: { include: ["src/**"] },
          owns: ["src/index.js"],
        },
        {
          id: "task-2",
          objective: "Task 2: Add second function",
          after: ["task-1"],
          scope: { include: ["src/**"] },
          owns: ["src/index.js"],
        },
      ],
      gates: [
        {
          id: "gate-verify",
          after: ["task-1", "task-2"],
          command: [
            process.execPath,
            "-e",
            "const fs = require('fs'); const content = fs.readFileSync('src/index.js', 'utf8'); if (!content.includes('feat1') || !content.includes('feat2')) process.exit(1);",
          ],
        },
      ],
      return: {
        mode: "digest",
        max_tokens: 800,
      },
    },
  });

  // 1. Unconditional assertion of success
  assert.equal(
    result.isError,
    false,
    "Batch result must succeed without error",
  );
  assert.ok(result.structuredContent, "structuredContent must be returned");

  const batchResp = result.structuredContent;
  assert.equal(batchResp.schema_version, "1");
  assert.equal(batchResp.status, "succeeded", "status must be succeeded");
  assert.ok(batchResp.run_id, "run_id must be present");

  // 2. All requested tasks integrated and gate passed
  assert.equal(batchResp.tasks.length, 2, "Both tasks must be reported");
  assert.ok(
    batchResp.tasks.every((t) => t.status === "integrated"),
    "All tasks must have transitioned to integrated",
  );
  assert.equal(batchResp.gates.length, 1, "Verification gate must be reported");
  assert.equal(
    batchResp.gates[0].status,
    "passed",
    "Gate must pass on integrated workspace",
  );

  // 3. Emitted MCP payload budget estimation check
  const serialized = JSON.stringify(result);
  const estimatedTokens = estimateTokenCount(serialized);
  assert.ok(
    estimatedTokens <= 800,
    `Complete serialized MCP response (${estimatedTokens} tokens) must be <= requested 800 tokens`,
  );

  // 4. Fetch persisted final.patch through antigravity_fetch and assert both changes included
  const patchArtifact = batchResp.artifacts.find((a) => a.kind === "patch");
  assert.ok(
    patchArtifact,
    "final.patch artifact must be recorded in response artifacts",
  );

  const fetchResult = await pair.client.callTool({
    name: "antigravity_fetch",
    arguments: {
      schema_version: "1",
      run_id: batchResp.run_id,
      artifact_id: patchArtifact.id,
    },
  });

  assert.equal(fetchResult.isError, false, "Fetching patch must succeed");
  const patchText = fetchResult.structuredContent?.content ?? "";
  assert.ok(
    patchText.includes("feat1"),
    "final.patch must include feat1 from task-1",
  );
  assert.ok(
    patchText.includes("feat2"),
    "final.patch must include feat2 from task-2",
  );

  // 5. User's original repo content and git status are completely unchanged (artifact-only delivery)
  const originalContent = readFileSync(
    path.join(repoDir, "src", "index.js"),
    "utf8",
  );
  assert.equal(
    originalContent,
    "export const initial = true;\n",
    "User original workspace files must remain untouched",
  );

  const gitStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();
  assert.equal(
    gitStatus,
    "",
    "User original repository status must remain clean",
  );
});

test("MCP call: batch tool emits progress notifications when progressToken is supplied", async (t) => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "agy-git-progress-repo-"));
  const baseRev = initGitRepo(repoDir);

  const pair = createTestClient({
    AGY_MCP_ENABLE_BATCH: "true",
    AGY_MCP_DEFAULT_WORKSPACE: repoDir,
    AGY_MCP_ALLOWED_ROOT: repoDir,
  });

  t.after(() => {
    closeClient(pair);
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  });

  await pair.client.connect(pair.transport);

  const progress = [];
  const result = await pair.client.callTool(
    {
      name: "antigravity_batch",
      arguments: {
        schema_version: "1",
        workspace: { root: repoDir, base_revision: baseRev },
        tasks: [
          {
            id: "task-1",
            objective: "Task 1",
            scope: { include: ["src/**"] },
            owns: ["src/index.js"],
          },
        ],
      },
    },
    { onprogress: (notification) => progress.push(notification) },
  );

  assert.equal(result.isError, false);
  assert.ok(
    progress.length > 0,
    "Progress notifications must be emitted for batch call with progressToken",
  );
  assert.ok(
    progress.some(
      (item) => typeof item.message === "string" && item.message.length > 0,
    ),
    "At least one progress notification must have a non-empty message",
  );
});
