import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import {
  TASKS_EXTENSION_ID,
  TaskRegistry,
  clientRequestsTasks,
  installTasksExtension,
} from "../dist/tasks.js";

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureServerPath = path.join(
  root,
  "test",
  "fixtures",
  "tasks-server.mjs",
);

function modernMeta(withTasks = true) {
  return {
    [PROTOCOL_VERSION_KEY]: "2026-07-28",
    [CLIENT_INFO_KEY]: { name: "raw-stdio-test-client", version: "1.0.0" },
    [CLIENT_CAPS_KEY]: withTasks
      ? { extensions: { [TASKS_EXTENSION_ID]: {} } }
      : {},
  };
}

function spawnRawJsonRpcPeer() {
  const child = spawn(process.execPath, [fixtureServerPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg && typeof msg === "object" && "id" in msg) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter({ raw: trimmed, parsed: msg });
      }
    }
  });

  const send = (message) =>
    new Promise((resolve, reject) => {
      pending.set(message.id, resolve);
      child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
        if (err) {
          pending.delete(message.id);
          reject(err);
        }
      });
    });

  const close = async () => {
    rl.close();
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  };

  return { send, close };
}

test("clientRequestsTasks and installTasksExtension capability self-check", () => {
  assert.equal(clientRequestsTasks(undefined), false);
  assert.equal(clientRequestsTasks(null), false);
  assert.equal(clientRequestsTasks({}), false);
  assert.equal(
    clientRequestsTasks({ [CLIENT_CAPS_KEY]: { extensions: {} } }),
    false,
  );
  assert.equal(
    clientRequestsTasks({
      [CLIENT_CAPS_KEY]: { extensions: { [TASKS_EXTENSION_ID]: null } },
    }),
    false,
  );
  assert.equal(
    clientRequestsTasks({
      [CLIENT_CAPS_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } },
    }),
    true,
  );
  assert.equal(
    clientRequestsTasks({
      [PROTOCOL_VERSION_KEY]: "2026-07-28",
      [CLIENT_CAPS_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } },
    }),
    true,
  );
  assert.equal(
    clientRequestsTasks({
      [PROTOCOL_VERSION_KEY]: "2025-11-25",
      [CLIENT_CAPS_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } },
    }),
    false,
  );

  const registry = new TaskRegistry();
  const realServer = new McpServer({ name: "check", version: "1.0.0" });
  assert.equal(installTasksExtension(realServer, registry), true);

  // Self-check returns false without throwing or mutating when SDK methods are absent
  const brokenServer = { server: { registerCapabilities: () => {} } };
  assert.equal(installTasksExtension(brokenServer, registry), false);
  assert.equal(installTasksExtension(null, registry), false);
});

test("TaskRegistry lifecycle, clamping, failure, cancellation, and pruning", async () => {
  let currentMs = Date.parse("2026-11-10T00:00:00.000Z");
  const registry = new TaskRegistry({
    pollIntervalMs: 100, // clamped to 250
    retainMs: 5_000,
    now: () => new Date(currentMs),
  });

  let resolveTask;
  const answer = registry.start((_signal, setStatus) => {
    setStatus("step 1");
    return new Promise((resolve) => {
      resolveTask = resolve;
    });
  }, "starting");

  assert.equal(answer.resultType, "task");
  assert.equal(answer.status, "working");
  assert.equal(answer.statusMessage, "step 1");
  assert.equal(answer.ttlMs, null);
  assert.equal(answer.pollIntervalMs, 250);
  assert.ok(answer.taskId.length > 0 && answer.taskId.length <= 128);
  assert.match(answer.taskId, /^[\x21-\x7e]+$/);

  currentMs += 1_000;
  resolveTask({ content: [{ type: "text", text: "done" }] });
  await delay(10);

  const completed = registry.get(answer.taskId);
  assert.equal(completed?.resultType, "complete");
  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.result, {
    content: [{ type: "text", text: "done" }],
  });

  currentMs += 5_001;
  assert.equal(registry.get(answer.taskId), undefined);
});

test("stdio SDK Client: legacy initialize path and 2026-07-28 without extension return plain CallToolResult", async (t) => {
  // 1. Legacy initialize path
  const legacyTransport = new StdioClientTransport({
    command: process.execPath,
    args: [fixtureServerPath],
    cwd: root,
    stderr: "pipe",
  });
  const legacyClient = new Client({ name: "legacy-client", version: "1.0.0" });
  await legacyClient.connect(legacyTransport);
  t.after(async () => {
    await legacyClient.close().catch(() => {});
    await legacyTransport.close().catch(() => {});
  });

  assert.equal(legacyClient.getProtocolEra(), "legacy");
  const legacyRes = await legacyClient.callTool({
    name: "slow_tool",
    arguments: { mode: "ok", value: "legacy", delayMs: 5 },
  });
  assert.deepEqual(legacyRes.content, [{ type: "text", text: "done:legacy" }]);

  // 2. Modern 2026-07-28 without tasks extension in clientCapabilities
  const modernTransport = new StdioClientTransport({
    command: process.execPath,
    args: [fixtureServerPath],
    cwd: root,
    stderr: "pipe",
  });
  const modernClient = new Client(
    { name: "modern-no-ext-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 2_000 } } },
  );
  await modernClient.connect(modernTransport);
  t.after(async () => {
    await modernClient.close().catch(() => {});
    await modernTransport.close().catch(() => {});
  });

  assert.equal(modernClient.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.ok(
    modernClient.getServerCapabilities()?.extensions?.[TASKS_EXTENSION_ID],
  );
  const modernPlain = await modernClient.callTool({
    name: "slow_tool",
    arguments: { mode: "ok", value: "plain-modern", delayMs: 5 },
  });
  assert.deepEqual(modernPlain.content, [
    { type: "text", text: "done:plain-modern" },
  ]);
});

test("stdio raw JSON-RPC 2026-07-28 with tasks extension: task answer, tasks/get polling, failure, tasks/cancel, unknown id (-32602), and tasks/update error", async (t) => {
  const peer = spawnRawJsonRpcPeer();
  t.after(() => peer.close());

  // 1. Negotiate 2026-07-28 via server/discover
  const discover = await peer.send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: modernMeta(true) },
  });
  assert.equal(discover.parsed.result.resultType, "complete");
  assert.ok(discover.parsed.result.supportedVersions.includes("2026-07-28"));
  assert.ok(
    discover.parsed.result.capabilities?.extensions?.[TASKS_EXTENSION_ID],
  );

  // 2. tools/call with tasks extension -> TaskAnswer
  const callOk = await peer.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "slow_tool",
      arguments: { mode: "ok", value: "alpha", delayMs: 80 },
      _meta: modernMeta(true),
    },
  });
  const taskAnswer = callOk.parsed.result;
  assert.equal(taskAnswer.resultType, "task");
  assert.equal(taskAnswer.status, "working");
  assert.equal(taskAnswer.statusMessage, "working:alpha");
  assert.equal(taskAnswer.ttlMs, null);
  assert.equal(taskAnswer.pollIntervalMs, 500);
  assert.equal(typeof taskAnswer.createdAt, "string");
  assert.equal(typeof taskAnswer.lastUpdatedAt, "string");
  assert.equal(typeof taskAnswer.taskId, "string");

  // Poll tasks/get until completed
  let getResult;
  for (let i = 0; i < 20; i++) {
    const poll = await peer.send({
      jsonrpc: "2.0",
      id: 100 + i,
      method: "tasks/get",
      params: { taskId: taskAnswer.taskId, _meta: modernMeta(true) },
    });
    getResult = poll.parsed.result;
    assert.equal(getResult.resultType, "complete");
    assert.equal(getResult.taskId, taskAnswer.taskId);
    if (getResult.status !== "working") break;
    await delay(20);
  }
  assert.equal(getResult.status, "completed");
  assert.deepEqual(getResult.result, {
    content: [{ type: "text", text: "done:alpha" }],
  });

  // 3. Failure path -> status "failed" with error.message
  const callFail = await peer.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "slow_tool",
      arguments: { mode: "fail", value: "bad-op" },
      _meta: modernMeta(true),
    },
  });
  const failTaskId = callFail.parsed.result.taskId;
  let failGet;
  for (let i = 0; i < 20; i++) {
    const poll = await peer.send({
      jsonrpc: "2.0",
      id: 200 + i,
      method: "tasks/get",
      params: { taskId: failTaskId, _meta: modernMeta(true) },
    });
    failGet = poll.parsed.result;
    if (failGet.status !== "working") break;
    await delay(20);
  }
  assert.equal(failGet.status, "failed");
  assert.equal(failGet.error?.message, "boom:bad-op");
  assert.equal(typeof failGet.error?.code, "number");

  // 4. tasks/cancel aborts the run's signal
  const callHang = await peer.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "slow_tool",
      arguments: { mode: "hang", value: "cancel-key" },
      _meta: modernMeta(true),
    },
  });
  const hangTaskId = callHang.parsed.result.taskId;

  const cancelResp = await peer.send({
    jsonrpc: "2.0",
    id: 5,
    method: "tasks/cancel",
    params: { taskId: hangTaskId, _meta: modernMeta(true) },
  });
  assert.equal(cancelResp.parsed.result.resultType, "complete");
  assert.equal(cancelResp.parsed.result.status, "cancelled");
  assert.equal(typeof cancelResp.parsed.result.statusMessage, "string");

  // Verify the signal inside the server process actually fired
  const checkAbort = await peer.send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "slow_tool",
      arguments: { mode: "check_abort", value: "cancel-key" },
      _meta: modernMeta(false),
    },
  });
  assert.deepEqual(checkAbort.parsed.result.content, [
    { type: "text", text: "aborted:true" },
  ]);

  // 5. Unknown id -> -32602
  const unknownGet = await peer.send({
    jsonrpc: "2.0",
    id: 7,
    method: "tasks/get",
    params: { taskId: "task_does_not_exist", _meta: modernMeta(true) },
  });
  assert.equal(unknownGet.parsed.error?.code, -32602);

  const unknownCancel = await peer.send({
    jsonrpc: "2.0",
    id: 8,
    method: "tasks/cancel",
    params: { taskId: "task_does_not_exist", _meta: modernMeta(true) },
  });
  assert.equal(unknownCancel.parsed.error?.code, -32602);

  // 6. tasks/update -> error
  const updateResp = await peer.send({
    jsonrpc: "2.0",
    id: 9,
    method: "tasks/update",
    params: { taskId: hangTaskId, _meta: modernMeta(true) },
  });
  assert.equal(updateResp.parsed.error?.code, -32602);
});
