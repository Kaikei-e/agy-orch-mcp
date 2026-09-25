import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const server = path.join(root, "dist", "index.js");
const fixture = path.join(root, "test", "fixtures", "agy.mjs");

function clientPair(extraEnv = {}, options = {}) {
  const env = {
    ...process.env,
    AGY_MCP_BIN: fixture,
    AGY_MCP_DEFAULT_WORKSPACE: root,
    AGY_MCP_ALLOWED_ROOT: root,
    AGY_MCP_MAX_CONCURRENT: "4",
  };
  delete env.AGY_MCP_DEFAULT_MODEL;
  Object.assign(env, extraEnv);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: root,
    stderr: "pipe",
    env,
  });
  const client = new Client(
    { name: "agy-orch-mcp-integration-test", version: "1.0.0" },
    options,
  );
  return { client, transport };
}

async function connected(extraEnv = {}, options = {}, connectOptions) {
  const pair = clientPair(extraEnv, options);
  await pair.client.connect(pair.transport, connectOptions);
  return pair;
}

async function closePair({ client, transport }) {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

function valueOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object")
    return result.structuredContent;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP result has no text content");
  return JSON.parse(text);
}

async function waitFor(condition, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail("condition did not become true before the deadline");
}

test("legacy and modern MCP negotiation expose all three tools", async (t) => {
  const legacy = await connected();
  t.after(() => closePair(legacy));
  assert.equal(legacy.client.getProtocolEra(), "legacy");
  const legacyTools = (await legacy.client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(legacyTools, [
    "antigravity_continue",
    "antigravity_models",
    "antigravity_run",
  ]);
  const legacyInstructions = legacy.client.getInstructions();
  assert.ok(
    legacyInstructions?.includes("Host acts only as orchestrator"),
    "legacy client must receive routing policy instructions",
  );
  assert.ok(
    legacyInstructions?.includes(
      "without recursively invoking agy-orch-mcp or delegating back",
    ),
  );
  const legacyToolList = (await legacy.client.listTools()).tools;
  const runDesc = legacyToolList.find(
    (tool) => tool.name === "antigravity_run",
  )?.description;
  assert.match(runDesc, /Policy:/);
  assert.match(runDesc, /concurrently/);
  const continueDesc = legacyToolList.find(
    (tool) => tool.name === "antigravity_continue",
  )?.description;
  assert.match(continueDesc, /Policy:/);
  assert.match(continueDesc, /parallel/);
  assert.match(continueDesc, /BUSY/);

  const modern = await connected(
    {},
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 1_000 } } },
  );
  t.after(() => closePair(modern));
  assert.equal(modern.client.getProtocolEra(), "modern");
  assert.equal(modern.client.getNegotiatedProtocolVersion(), "2026-07-28");
  const modernInstructions = modern.client.getInstructions();
  assert.ok(
    modernInstructions?.includes("Host acts only as orchestrator"),
    "modern client must receive routing policy instructions",
  );
  assert.ok(
    modernInstructions?.includes(
      "without recursively invoking agy-orch-mcp or delegating back",
    ),
  );
  const modernTools = (await modern.client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(modernTools, legacyTools);
});

test("models, new turns, and explicit or implicit continuation pass safe argv", async (t) => {
  const pair = await connected();
  t.after(() => closePair(pair));
  const models = await pair.client.callTool({
    name: "antigravity_models",
    arguments: {},
  });
  assert.equal(models.isError, false);
  assert.match(String(valueOf(models).response), /test-model/);

  const first = await pair.client.callTool({
    name: "antigravity_run",
    arguments: {
      prompt: "first",
      workspace: root,
      model: "test-model",
      mode: "accept-edits",
      autonomy: "sandbox",
      effort: "high",
      timeout_seconds: 10,
    },
  });
  const firstValue = valueOf(first);
  assert.equal(firstValue.ok, true);
  assert.ok(firstValue.conversation_id);
  const firstResponse = JSON.parse(firstValue.response);
  assert.equal(firstResponse.prompt, "first");
  assert.equal(firstResponse.cwd, root);
  assert.ok(firstResponse.argv.includes("--sandbox"));
  assert.ok(
    firstResponse.argv.includes("--model") &&
      firstResponse.argv.includes("test-model"),
  );
  assert.ok(
    firstResponse.argv.includes("--effort") &&
      firstResponse.argv.includes("high"),
  );

  const explicit = await pair.client.callTool({
    name: "antigravity_continue",
    arguments: {
      prompt: "explicit",
      conversation_id: firstValue.conversation_id,
      workspace: root,
      timeout_seconds: 10,
    },
  });
  assert.ok(
    JSON.parse(valueOf(explicit).response).argv.includes("--conversation"),
  );
  assert.ok(
    JSON.parse(valueOf(explicit).response).argv.includes(
      firstValue.conversation_id,
    ),
  );

  let implicit;
  try {
    implicit = await pair.client.callTool({
      name: "antigravity_continue",
      arguments: { prompt: "implicit", workspace: root, timeout_seconds: 10 },
    });
  } catch (error) {
    implicit = error;
  }
  if (implicit?.isError !== undefined) assert.equal(implicit.isError, true);
  else
    assert.match(
      String(implicit?.message ?? implicit),
      /conversation_id|invalid|validation/i,
    );
});

test("validation, policy, and workspace failures are returned as tool errors", async (t) => {
  const pair = await connected();
  t.after(() => closePair(pair));
  let invalid;
  try {
    invalid = await pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: "" },
    });
  } catch (error) {
    invalid = error;
  }
  if (invalid?.isError !== undefined) assert.equal(invalid.isError, true);
  else
    assert.match(
      String(invalid?.message ?? invalid),
      /prompt|invalid|validation/i,
    );
  const outside = await pair.client.callTool({
    name: "antigravity_run",
    arguments: { prompt: "ok", workspace: os.tmpdir(), timeout_seconds: 10 },
  });
  assert.equal(outside.isError, true);
  assert.equal(valueOf(outside).status, "CONFIG_ERROR");

  const denied = await pair.client.callTool({
    name: "antigravity_run",
    arguments: { prompt: "ok", autonomy: "full", timeout_seconds: 10 },
  });
  assert.equal(denied.isError, true);
  assert.equal(valueOf(denied).status, "POLICY_ERROR");

  for (const badModel of [
    "--dangerously-skip-permissions",
    "-model",
    "model with spaces",
    "model\twith\ttab",
    "model\nwith\nnewline",
    "model\rwith\rcarriage",
    "model\0with\0nul",
    "a".repeat(201),
  ]) {
    const unsafeRun = await pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: "ok", model: badModel, timeout_seconds: 10 },
    });
    assert.equal(
      unsafeRun.isError,
      true,
      `antigravity_run should reject model: ${JSON.stringify(badModel)}`,
    );

    const unsafeContinue = await pair.client.callTool({
      name: "antigravity_continue",
      arguments: { prompt: "ok", model: badModel, timeout_seconds: 10 },
    });
    assert.equal(
      unsafeContinue.isError,
      true,
      `antigravity_continue should reject model: ${JSON.stringify(badModel)}`,
    );
  }
});

test("progress notifications and bounded tool results survive the MCP boundary", async (t) => {
  const storage = mkdtempSync(path.join(os.tmpdir(), "agy-orch-store-"));
  const pair = await connected({
    AGY_MCP_MAX_OUTPUT_CHARS: "1024",
    AGY_ORCH_STORAGE_DIR: storage,
  });
  t.after(async () => {
    await closePair(pair);
    rmSync(storage, { recursive: true, force: true });
  });
  const progress = [];
  const result = await pair.client.callTool(
    {
      name: "antigravity_run",
      arguments: { prompt: "progress", timeout_seconds: 10 },
    },
    { onprogress: (notification) => progress.push(notification) },
  );
  assert.equal(valueOf(result).ok, true);
  assert.ok(
    progress.some(
      (item) => typeof item.message === "string" && item.message.length > 0,
    ),
  );

  const large = await pair.client.callTool({
    name: "antigravity_run",
    arguments: { prompt: "large", timeout_seconds: 10 },
  });
  const largeValue = valueOf(large);
  assert.equal(largeValue.ok, true);
  assert.equal(largeValue.truncated, true);
  assert.ok(large.content[0].text.length <= 1_024);
  assert.match(largeValue.truncation_notice, /response_artifact\.path/);
  assert.ok(largeValue.response_artifact.path.startsWith(storage));
  assert.equal(
    readFileSync(largeValue.response_artifact.path, "utf8"),
    "語".repeat(80_000),
  );
});

test("denied commands are recovered from the agy transcript with actionable guidance", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agy-orch-home-"));
  const pair = await connected({ HOME: home, AGY_ORCH_STORAGE_DIR: home });
  t.after(async () => {
    await closePair(pair);
    rmSync(home, { recursive: true, force: true });
  });
  const value = valueOf(
    await pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: "denied-command", timeout_seconds: 10 },
    }),
  );
  assert.equal(value.status, "PERMISSION_DENIED");
  // Denials recorded before this run belong to earlier turns.
  assert.deepEqual(value.denied_commands, ["git ls-tree HEAD"]);
  assert.match(value.error, /`git ls-tree HEAD`/);
  assert.match(value.error, /permitted alternative/);
  assert.match(value.error, /permissions\.allow/);
});

test("conversations past the token threshold recommend a fresh run", async (t) => {
  const pair = await connected({ AGY_MCP_CONTEXT_ROTATE_TOKENS: "80" });
  t.after(() => closePair(pair));
  const first = valueOf(
    await pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: "hello", timeout_seconds: 10 },
    }),
  );
  assert.deepEqual(first.context, {
    turns: 1,
    cumulative_total_tokens: 42,
    rotate_recommended: false,
  });
  const second = valueOf(
    await pair.client.callTool({
      name: "antigravity_continue",
      arguments: {
        prompt: "hello",
        conversation_id: first.conversation_id,
        timeout_seconds: 10,
      },
    }),
  );
  assert.equal(second.ok, true);
  assert.equal(second.context.turns, 2);
  assert.equal(second.context.cumulative_total_tokens, 84);
  assert.equal(second.context.rotate_recommended, true);
  assert.match(second.context.advice, /new antigravity_run/);
  const other = valueOf(
    await pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: "hello", timeout_seconds: 10 },
    }),
  );
  assert.equal(other.context.turns, 1);
});

test(
  "MCP runs and distinct continuations overlap with separate results and progress",
  { timeout: 10_000 },
  async (t) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "agy-orch-mcp-parallel-"));
    const pair = await connected({ AGY_MCP_MAX_CONCURRENT: "2" });
    t.after(async () => {
      await closePair(pair);
      rmSync(temp, { recursive: true, force: true });
    });
    const gates = [path.join(temp, "first"), path.join(temp, "second")];
    const id = "055a398f-db14-4c5f-abbb-1bf03f8120a7";
    const progress = [[], []];
    const pending = gates.map((gate, i) =>
      pair.client.callTool(
        {
          name: i === 0 ? "antigravity_run" : "antigravity_continue",
          arguments: {
            prompt: `wait:${gate}`,
            timeout_seconds: 10,
            ...(i === 1 ? { conversation_id: id } : {}),
          },
        },
        { onprogress: (event) => progress[i].push(event) },
      ),
    );
    await waitFor(
      () => gates.every((gate) => existsSync(`${gate}.ready`)),
      4_000,
    );
    const full = await pair.client.callTool({
      name: "antigravity_models",
      arguments: {},
    });
    assert.equal(full.isError, true);
    assert.equal(valueOf(full).status, "BUSY");
    const sameConversation = await pair.client.callTool({
      name: "antigravity_continue",
      arguments: { prompt: "ok", conversation_id: id.toUpperCase() },
    });
    assert.equal(valueOf(sameConversation).status, "BUSY");
    assert.match(
      valueOf(sameConversation).error,
      /conversation is already running/,
    );

    writeFileSync(`${gates[1]}.release`, "");
    const second = valueOf(await pending[1]);
    assert.equal(second.ok, true);
    assert.equal(second.conversation_id, id);
    assert.equal(JSON.parse(second.response).prompt, `wait:${gates[1]}`);
    const models = await pair.client.callTool({
      name: "antigravity_models",
      arguments: {},
    });
    assert.equal(models.isError, false);

    writeFileSync(`${gates[0]}.release`, "");
    const first = valueOf(await pending[0]);
    assert.equal(first.ok, true);
    assert.notEqual(first.conversation_id, second.conversation_id);
    assert.equal(JSON.parse(first.response).prompt, `wait:${gates[0]}`);
    for (const events of progress)
      assert.ok(
        events.some(
          (event) => event.message === "Antigravity is processing the task",
        ),
      );
    const resumed = await pair.client.callTool({
      name: "antigravity_continue",
      arguments: { prompt: "ok", conversation_id: id },
    });
    assert.equal(valueOf(resumed).ok, true);
  },
);

test(
  "client cancellation stops only the selected agy subprocess",
  { timeout: 8_000 },
  async (t) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "agy-orch-mcp-cancel-"));
    const pidFile = path.join(temp, "pid");
    const pair = await connected({ TEST_PID_FILE: pidFile });
    t.after(async () => {
      await closePair(pair);
      rmSync(temp, { recursive: true, force: true });
    });
    const controller = new AbortController();
    const survivorGate = path.join(temp, "survivor");
    const survivor = pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: `wait:${survivorGate}`, timeout_seconds: 10 },
    });
    const pending = pair.client.callTool(
      {
        name: "antigravity_run",
        arguments: { prompt: "hang", timeout_seconds: 10 },
      },
      { signal: controller.signal },
    );
    await waitFor(
      () => existsSync(pidFile) && existsSync(`${survivorGate}.ready`),
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    await assert.rejects(pending, /abort|cancel|closed/i);
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }, 4_000);
    const models = await pair.client.callTool({
      name: "antigravity_models",
      arguments: {},
    });
    assert.equal(models.isError, false);
    writeFileSync(`${survivorGate}.release`, "");
    assert.equal(valueOf(await survivor).ok, true);
  },
);

test(
  "server stdin EOF shuts down every active subprocess",
  { timeout: 8_000 },
  async (t) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "agy-orch-mcp-eof-"));
    const pair = await connected();
    t.after(async () => {
      await closePair(pair);
      rmSync(temp, { recursive: true, force: true });
    });
    const gates = [0, 1, 2].map((i) => path.join(temp, String(i)));
    const pending = gates.map((gate) =>
      pair.client.callTool({
        name: "antigravity_run",
        arguments: { prompt: `wait:${gate}`, timeout_seconds: 10 },
      }),
    );
    await waitFor(() => gates.every((gate) => existsSync(`${gate}.ready`)));
    const pids = gates.map((gate) =>
      Number(readFileSync(`${gate}.ready`, "utf8")),
    );
    const child = pair.transport._process;
    assert.ok(child, "stdio transport child process is unavailable");
    const childExit = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    child.stdin.end();
    const outcomes = await Promise.all(
      pending.map(async (call) => {
        try {
          return { result: await call };
        } catch (error) {
          return { error };
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.error) {
        assert.match(String(outcome.error), /closed|abort|cancel/i);
      } else {
        assert.equal(outcome.result.isError, true);
        assert.equal(valueOf(outcome.result).status, "CANCELED");
      }
    }
    const exit = await childExit;
    assert.equal(exit.code, 0);
    assert.equal(
      exit.signal,
      null,
      `server process was terminated by ${exit.signal ?? "unknown signal"}`,
    );
    await waitFor(
      () =>
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return error?.code === "ESRCH";
          }
        }),
      4_000,
    );
  },
);

test("MCP env-model precedence on antigravity_run and antigravity_continue", async (t) => {
  const pairWithDefault = await connected({
    AGY_MCP_DEFAULT_MODEL: "default-test-model",
  });
  t.after(() => closePair(pairWithDefault));

  // 1. Configured default model used when no request model on antigravity_run
  const runDefault = await pairWithDefault.client.callTool({
    name: "antigravity_run",
    arguments: { prompt: "run-default", workspace: root, timeout_seconds: 10 },
  });
  const runDefaultVal = valueOf(runDefault);
  assert.equal(runDefaultVal.ok, true);
  const runDefaultArgv = JSON.parse(runDefaultVal.response).argv;
  assert.ok(runDefaultArgv.includes("--model"));
  assert.equal(
    runDefaultArgv[runDefaultArgv.indexOf("--model") + 1],
    "default-test-model",
  );

  // 2. Configured default model used when no request model on antigravity_continue
  const contDefault = await pairWithDefault.client.callTool({
    name: "antigravity_continue",
    arguments: {
      prompt: "cont-default",
      conversation_id: runDefaultVal.conversation_id,
      workspace: root,
      timeout_seconds: 10,
    },
  });
  const contDefaultVal = valueOf(contDefault);
  assert.equal(contDefaultVal.ok, true);
  const contDefaultArgv = JSON.parse(contDefaultVal.response).argv;
  assert.ok(contDefaultArgv.includes("--model"));
  assert.equal(
    contDefaultArgv[contDefaultArgv.indexOf("--model") + 1],
    "default-test-model",
  );

  // 3. Request model overrides configured default on antigravity_run
  const runOverride = await pairWithDefault.client.callTool({
    name: "antigravity_run",
    arguments: {
      prompt: "run-override",
      workspace: root,
      model: "override-test-model",
      timeout_seconds: 10,
    },
  });
  const runOverrideVal = valueOf(runOverride);
  assert.equal(runOverrideVal.ok, true);
  const runOverrideArgv = JSON.parse(runOverrideVal.response).argv;
  assert.ok(runOverrideArgv.includes("--model"));
  assert.equal(
    runOverrideArgv[runOverrideArgv.indexOf("--model") + 1],
    "override-test-model",
  );
  assert.ok(!runOverrideArgv.includes("default-test-model"));

  // 4. Request model overrides configured default on antigravity_continue
  const contOverride = await pairWithDefault.client.callTool({
    name: "antigravity_continue",
    arguments: {
      prompt: "cont-override",
      conversation_id: runDefaultVal.conversation_id,
      workspace: root,
      model: "override-test-model",
      timeout_seconds: 10,
    },
  });
  const contOverrideVal = valueOf(contOverride);
  assert.equal(contOverrideVal.ok, true);
  const contOverrideArgv = JSON.parse(contOverrideVal.response).argv;
  assert.ok(contOverrideArgv.includes("--model"));
  assert.equal(
    contOverrideArgv[contOverrideArgv.indexOf("--model") + 1],
    "override-test-model",
  );
  assert.ok(!contOverrideArgv.includes("default-test-model"));

  // Pair without AGY_MCP_DEFAULT_MODEL
  const pairWithoutDefault = await connected();
  t.after(() => closePair(pairWithoutDefault));

  // 5. No --model passed on antigravity_run when neither set
  const runNoModel = await pairWithoutDefault.client.callTool({
    name: "antigravity_run",
    arguments: { prompt: "run-no-model", workspace: root, timeout_seconds: 10 },
  });
  const runNoModelVal = valueOf(runNoModel);
  assert.equal(runNoModelVal.ok, true);
  const runNoModelArgv = JSON.parse(runNoModelVal.response).argv;
  assert.ok(!runNoModelArgv.includes("--model"));

  // 6. No --model passed on antigravity_continue when neither set
  const contNoModel = await pairWithoutDefault.client.callTool({
    name: "antigravity_continue",
    arguments: {
      prompt: "cont-no-model",
      conversation_id: runNoModelVal.conversation_id,
      workspace: root,
      timeout_seconds: 10,
    },
  });
  const contNoModelVal = valueOf(contNoModel);
  assert.equal(contNoModelVal.ok, true);
  const contNoModelArgv = JSON.parse(contNoModelVal.response).argv;
  assert.ok(!contNoModelArgv.includes("--model"));
});

test("SUCCESS with denied_actions returns PERMISSION_DENIED across MCP, preserving response, conversation_id, denied_actions", async (t) => {
  const pair = await connected();
  t.after(() => closePair(pair));

  // 1. Nonempty response with denied_actions
  const nonemptyDenied = await pair.client.callTool({
    name: "antigravity_run",
    arguments: { prompt: "denied", workspace: root, timeout_seconds: 10 },
  });
  assert.equal(nonemptyDenied.isError, true);
  const nonemptyVal = valueOf(nonemptyDenied);
  assert.equal(nonemptyVal.ok, false);
  assert.equal(nonemptyVal.status, "PERMISSION_DENIED");
  assert.ok(nonemptyVal.conversation_id);
  assert.deepEqual(nonemptyVal.denied_actions, [{ tool: "write_to_file" }]);
  assert.ok(nonemptyVal.response.length > 0);
  assert.match(nonemptyVal.response, /"prompt":"denied"/);
  assert.match(nonemptyVal.error, /denied actions/);

  // 2. Empty response with denied_actions
  const emptyDenied = await pair.client.callTool({
    name: "antigravity_run",
    arguments: { prompt: "denied-empty", workspace: root, timeout_seconds: 10 },
  });
  assert.equal(emptyDenied.isError, true);
  const emptyVal = valueOf(emptyDenied);
  assert.equal(emptyVal.ok, false);
  assert.equal(emptyVal.status, "PERMISSION_DENIED");
  assert.ok(emptyVal.conversation_id);
  assert.deepEqual(emptyVal.denied_actions, [{ tool: "write_to_file" }]);
  assert.equal(emptyVal.response, "");
  assert.match(emptyVal.error, /denied actions/);

  // 3. Continue turn with denied_actions preserves conversation_id
  const contDenied = await pair.client.callTool({
    name: "antigravity_continue",
    arguments: {
      prompt: "denied",
      conversation_id: nonemptyVal.conversation_id,
      workspace: root,
      timeout_seconds: 10,
    },
  });
  assert.equal(contDenied.isError, true);
  const contVal = valueOf(contDenied);
  assert.equal(contVal.ok, false);
  assert.equal(contVal.status, "PERMISSION_DENIED");
  assert.equal(contVal.conversation_id, nonemptyVal.conversation_id);
  assert.deepEqual(contVal.denied_actions, [{ tool: "write_to_file" }]);

  // 4. Client cancellation takes precedence over denied actions
  const controller = new AbortController();
  const pendingCancel = pair.client.callTool(
    {
      name: "antigravity_run",
      arguments: {
        prompt: "denied-hang",
        workspace: root,
        timeout_seconds: 10,
      },
    },
    { signal: controller.signal },
  );
  await delay(100);
  controller.abort();
  await assert.rejects(pendingCancel, /abort|cancel|closed/i);
});
