import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
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
  for (const tool of legacyToolList) {
    assert.equal(
      tool.annotations?.readOnlyHint,
      true,
      `${tool.name} must set readOnlyHint: true so Claude Code schedules parallel calls`,
    );
    assert.equal(
      tool.annotations?.destructiveHint,
      false,
      `${tool.name} must set destructiveHint: false for parallel host execution`,
    );
  }
  const runDesc = legacyToolList.find(
    (tool) => tool.name === "antigravity_run",
  )?.description;
  assert.match(runDesc, /Policy:/);
  assert.match(runDesc, /single turn/);
  assert.match(runDesc, /parallel/);
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
    turn_total_tokens: 42,
    cumulative_total_tokens: 42,
    rotate_threshold_tokens: 80,
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
  assert.equal(second.context.turn_total_tokens, 42);
  assert.equal(second.context.cumulative_total_tokens, 84);
  assert.equal(second.context.rotate_threshold_tokens, 80);
  assert.equal(second.context.rotate_recommended, true);
  assert.match(second.context.advice, /new antigravity_run/);
  const other = valueOf(
    await pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: "hello", timeout_seconds: 10 },
    }),
  );
  assert.equal(other.context.turns, 1);
  assert.equal(other.context.turn_total_tokens, 42);
  assert.equal(other.context.rotate_threshold_tokens, 80);
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

  // Pair without AGY_MCP_DEFAULT_MODEL uses built-in default (gemini-4-hydrogen-high)
  const pairWithoutDefault = await connected();
  t.after(() => closePair(pairWithoutDefault));

  // 5. Built-in default model passed on antigravity_run when neither env nor argument set
  const runNoModel = await pairWithoutDefault.client.callTool({
    name: "antigravity_run",
    arguments: { prompt: "run-no-model", workspace: root, timeout_seconds: 10 },
  });
  const runNoModelVal = valueOf(runNoModel);
  assert.equal(runNoModelVal.ok, true);
  const runNoModelParsed = JSON.parse(runNoModelVal.response);
  const runNoModelArgv = runNoModelParsed.argv;
  assert.ok(runNoModelArgv.includes("--model"));
  assert.equal(
    runNoModelArgv[runNoModelArgv.indexOf("--model") + 1],
    "gemini-4-hydrogen-high",
  );
  assert.equal(
    runNoModelParsed.env.AGY_ORCH_MCP_SUBAGENT_MODEL,
    "gemini-4-argon-medium",
  );

  // 6. Built-in default model passed on antigravity_continue when neither env nor argument set
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
  assert.ok(contNoModelArgv.includes("--model"));
  assert.equal(
    contNoModelArgv[contNoModelArgv.indexOf("--model") + 1],
    "gemini-4-hydrogen-high",
  );
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

test("timeout_seconds max 900 validation, default 900 --print-timeout, and policy text updates", async (t) => {
  const pair = await connected();
  t.after(() => closePair(pair));

  const instructions = pair.client.getInstructions() ?? "";
  assert.match(instructions, /15 minutes/);
  assert.match(instructions, /resumable=true/);
  assert.match(instructions, /partial_response/);
  assert.match(instructions, /verified_outputs/);
  assert.match(instructions, /workspace_changes/);
  assert.match(instructions, /queue_timeout_seconds/);

  const tools = (await pair.client.listTools()).tools;
  for (const name of ["antigravity_run", "antigravity_continue"]) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    assert.match(tool.description ?? "", /15 minutes/);
    assert.match(tool.description ?? "", /resumable=true/);
    assert.match(tool.description ?? "", /verified_outputs/);
    assert.match(tool.description ?? "", /queue_timeout_seconds/);
  }

  // timeout_seconds: 901 rejected on antigravity_run and antigravity_continue
  for (const toolName of ["antigravity_run", "antigravity_continue"]) {
    let rejected;
    try {
      rejected = await pair.client.callTool({
        name: toolName,
        arguments: {
          prompt: "ok",
          timeout_seconds: 901,
          ...(toolName === "antigravity_continue"
            ? { conversation_id: "055a398f-db14-4c5f-abbb-1bf03f8120a7" }
            : {}),
        },
      });
    } catch (error) {
      rejected = error;
    }
    if (rejected?.isError !== undefined) assert.equal(rejected.isError, true);
    else
      assert.match(
        String(rejected?.message ?? rejected),
        /900|invalid|validation/i,
      );
  }

  // Default timeout_seconds is 900 and reaches --print-timeout 900s
  const defaultRun = valueOf(
    await pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: "default-timeout", workspace: root },
    }),
  );
  assert.equal(defaultRun.ok, true);
  const argv = JSON.parse(defaultRun.response).argv;
  assert.equal(argv[argv.indexOf("--print-timeout") + 1], "900s");
});

test(
  "queue_timeout_seconds waits when AGY_MCP_MAX_CONCURRENT=1, emits position progress, and reports queue_wait_seconds",
  { timeout: 10_000 },
  async (t) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "agy-orch-mcp-queue-"));
    const pair = await connected({ AGY_MCP_MAX_CONCURRENT: "1" });
    t.after(async () => {
      await closePair(pair);
      rmSync(temp, { recursive: true, force: true });
    });

    const gate = path.join(temp, "slot");
    const first = pair.client.callTool({
      name: "antigravity_run",
      arguments: { prompt: `wait:${gate}`, timeout_seconds: 10 },
    });
    await waitFor(() => existsSync(`${gate}.ready`), 4_000);

    const progress = [];
    const second = pair.client.callTool(
      {
        name: "antigravity_run",
        arguments: {
          prompt: "queued-second",
          timeout_seconds: 10,
          queue_timeout_seconds: 10,
        },
      },
      { onprogress: (event) => progress.push(event) },
    );

    await waitFor(
      () =>
        progress.some(
          (event) => event.message === "Queued for an agy slot (position 1)",
        ),
      4_000,
    );

    writeFileSync(`${gate}.release`, "");
    const firstVal = valueOf(await first);
    assert.equal(firstVal.ok, true);
    assert.equal(firstVal.queue_wait_seconds, undefined);

    const secondVal = valueOf(await second);
    assert.equal(secondVal.ok, true);
    assert.equal(JSON.parse(secondVal.response).prompt, "queued-second");
    assert.equal(typeof secondVal.queue_wait_seconds, "number");
    assert.ok(secondVal.queue_wait_seconds >= 0);
  },
);

test("return_mode structured passes --json-schema, keeps raw response, and populates handoff", async (t) => {
  const pair = await connected();
  t.after(() => closePair(pair));

  const structuredRes = valueOf(
    await pair.client.callTool({
      name: "antigravity_run",
      arguments: {
        prompt: "handoff-ok",
        workspace: root,
        timeout_seconds: 10,
        return_mode: "structured",
      },
    }),
  );
  assert.equal(structuredRes.ok, true);
  assert.equal(typeof structuredRes.response, "string");
  assert.deepEqual(JSON.parse(structuredRes.response), structuredRes.handoff);
  assert.equal(structuredRes.handoff.summary, "completed task");
  assert.deepEqual(structuredRes.handoff.changes, [
    { path: "src/agy.ts", change: "wired run path" },
  ]);

  // Verify --json-schema flag was passed when return_mode is structured
  const echoRes = valueOf(
    await pair.client.callTool({
      name: "antigravity_run",
      arguments: {
        prompt: "check-schema-flag",
        workspace: root,
        timeout_seconds: 10,
        return_mode: "structured",
      },
    }),
  );
  assert.equal(echoRes.ok, true);
  const argv = JSON.parse(echoRes.response).argv;
  assert.ok(argv.includes("--json-schema"));
  assert.equal(typeof echoRes.handoff_error, "string");
});

test("2026-07-28 client with tasks extension receives a task handle and tasks/get reaches completed with tool result", async (t) => {
  const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
  const CLIENT_CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
  const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
  const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

  const modernMeta = (withTasks = true) => ({
    [PROTOCOL_VERSION_KEY]: "2026-07-28",
    [CLIENT_INFO_KEY]: { name: "mcp-tasks-test-client", version: "1.0.0" },
    [CLIENT_CAPS_KEY]: withTasks
      ? { extensions: { [TASKS_EXTENSION_ID]: {} } }
      : {},
  });

  const tempEnvRoot = mkdtempSync(
    path.join(os.tmpdir(), "agy-orch-env-prune-"),
  );
  const staleDir = path.join(tempEnvRoot, "stale-conv");
  const freshDir = path.join(tempEnvRoot, "fresh-conv");
  mkdirSync(staleDir, { recursive: true });
  mkdirSync(freshDir, { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
  utimesSync(staleDir, twoDaysAgo, twoDaysAgo);

  const stderrLines = [];
  const child = spawn(process.execPath, [server], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGY_MCP_BIN: fixture,
      AGY_MCP_DEFAULT_WORKSPACE: root,
      AGY_MCP_ALLOWED_ROOT: root,
      AGY_MCP_ENV_ROOT: tempEnvRoot,
      AGY_MCP_ENV_ISOLATION: "off",
      AGY_MCP_GUARD: "off",
    },
  });
  const rlOut = createInterface({ input: child.stdout });
  const rlErr = createInterface({ input: child.stderr });
  rlErr.on("line", (line) => stderrLines.push(line));
  const pending = new Map();

  rlOut.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg && typeof msg === "object" && "id" in msg) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
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

  t.after(async () => {
    rlOut.close();
    rlErr.close();
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(tempEnvRoot, { recursive: true, force: true });
  });

  // 1. Discover 2026-07-28 and verify tasks extension is advertised
  const discover = await send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: modernMeta(true) },
  });
  assert.equal(discover.result.resultType, "complete");
  assert.ok(discover.result.supportedVersions.includes("2026-07-28"));
  assert.ok(discover.result.capabilities?.extensions?.[TASKS_EXTENSION_ID]);
  await waitFor(() =>
    stderrLines.some((line) => line === "agy-orch-mcp: tasks_enabled"),
  );

  // Verify startup pruneEnvRoots removed staleDir while keeping freshDir
  await waitFor(() => !existsSync(staleDir), 2_000);
  assert.equal(existsSync(freshDir), true);

  // 2. Call antigravity_run with tasks extension -> returns task handle
  const callRun = await send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "antigravity_run",
      arguments: {
        prompt: "task-mode-run",
        workspace: root,
        timeout_seconds: 10,
      },
      _meta: modernMeta(true),
    },
  });
  const taskHandle = callRun.result;
  assert.equal(taskHandle.resultType, "task");
  assert.equal(taskHandle.status, "working");
  assert.equal(typeof taskHandle.taskId, "string");

  // 3. Poll tasks/get until completed
  let completedTask;
  for (let i = 0; i < 40; i++) {
    const poll = await send({
      jsonrpc: "2.0",
      id: 100 + i,
      method: "tasks/get",
      params: { taskId: taskHandle.taskId, _meta: modernMeta(true) },
    });
    completedTask = poll.result;
    assert.equal(completedTask.resultType, "complete");
    if (completedTask.status !== "working") break;
    await delay(20);
  }
  assert.equal(completedTask.status, "completed");
  const toolVal = valueOf(completedTask.result);
  assert.equal(toolVal.ok, true);
  assert.equal(JSON.parse(toolVal.response).prompt, "task-mode-run");
  assert.equal(toolVal.context.turns, 1);
  assert.equal(toolVal.context.turn_total_tokens, 42);
  assert.equal(typeof toolVal.context.rotate_threshold_tokens, "number");

  // 4. Call antigravity_continue with tasks extension -> returns task handle and completes
  const callCont = await send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "antigravity_continue",
      arguments: {
        prompt: "task-mode-continue",
        conversation_id: toolVal.conversation_id,
        workspace: root,
        timeout_seconds: 10,
      },
      _meta: modernMeta(true),
    },
  });
  assert.equal(callCont.result.resultType, "task");
  assert.equal(callCont.result.status, "working");
  let completedCont;
  for (let i = 0; i < 40; i++) {
    const poll = await send({
      jsonrpc: "2.0",
      id: 200 + i,
      method: "tasks/get",
      params: { taskId: callCont.result.taskId, _meta: modernMeta(true) },
    });
    completedCont = poll.result;
    if (completedCont.status !== "working") break;
    await delay(20);
  }
  assert.equal(completedCont.status, "completed");
  assert.equal(valueOf(completedCont.result).context.turns, 2);
});

test("AGY_MCP_TASKS=off logs tasks_disabled to stderr and executes inline", async (t) => {
  const stderrLines = [];
  const child = spawn(process.execPath, [server], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGY_MCP_BIN: fixture,
      AGY_MCP_DEFAULT_WORKSPACE: root,
      AGY_MCP_ALLOWED_ROOT: root,
      AGY_MCP_TASKS: "off",
      AGY_MCP_ENV_ISOLATION: "off",
      AGY_MCP_GUARD: "off",
    },
  });
  const rlOut = createInterface({ input: child.stdout });
  const rlErr = createInterface({ input: child.stderr });
  rlErr.on("line", (line) => stderrLines.push(line));
  const pending = new Map();
  rlOut.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg && typeof msg === "object" && "id" in msg) {
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
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

  t.after(async () => {
    rlOut.close();
    rlErr.close();
    child.stdin.end();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });

  await send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "c", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
      },
    },
  });

  await waitFor(() =>
    stderrLines.some((line) =>
      line.startsWith("agy-orch-mcp: tasks_disabled ("),
    ),
  );

  const inlineCall = await send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "antigravity_run",
      arguments: { prompt: "inline-when-tasks-off", timeout_seconds: 10 },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
      },
    },
  });
  assert.notEqual(inlineCall.result.resultType, "task");
  assert.equal(valueOf(inlineCall.result).ok, true);
});
