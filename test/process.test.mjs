import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { parseAgyOutput, runAgy } from "../dist/agy.js";
import { loadConfig } from "../dist/config.js";
import {
  defaultHooksPath,
  guardHookCommand,
  installGuard,
} from "../dist/guard.js";
import { ProcessRunner } from "../dist/process.js";
import { transcriptPath } from "../dist/transcript.js";

const fixture = fileURLToPath(new URL("./fixtures/agy.mjs", import.meta.url));
const config = loadConfig({ AGY_MCP_BIN: fixture });
const options = (prompt, extra = {}) => ({
  bin: process.execPath,
  args: [fixture, "-p", prompt],
  cwd: process.cwd(),
  timeoutMs: 5_000,
  maxBufferBytes: 1_000_000,
  ...extra,
});

async function barriers(t, count) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agy-parallel-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return Array.from({ length: count }, (_, i) => {
    const file = path.join(temp, String(i));
    return {
      prompt: `wait:${file}`,
      ready: async () => {
        for (let i = 0; i < 150; i++) {
          if (existsSync(`${file}.ready`)) return;
          await delay(20);
        }
        assert.fail("fixture did not reach the barrier");
      },
      release: () => writeFileSync(`${file}.release`, ""),
    };
  });
}

test("spawn failure, pre-canceled requests, and closed runners settle", async () => {
  const runner = new ProcessRunner();
  assert.equal(
    (await runner.run(options("ok", { bin: "/missing-agy-test" }))).failure,
    "SPAWN_ERROR",
  );
  assert.equal(
    (await runner.run(options("ok", { signal: AbortSignal.abort() }))).failure,
    "CANCELED",
  );
  await runner.close();
  assert.equal((await runner.run(options("ok"))).failure, "CANCELED");
});

test(
  "hard deadline escalates when a CLI ignores SIGTERM",
  { timeout: 6_000 },
  async () => {
    const runner = new ProcessRunner();
    const started = Date.now();
    assert.equal(
      (await runner.run(options("hang", { timeoutMs: 250 }))).failure,
      "TIMEOUT",
    );
    assert.ok(Date.now() - started < 4_000);
    await runner.close();
  },
);

test("output overflow and bounded stderr", async () => {
  const runner = new ProcessRunner();
  const overflow = await runner.run(
    options("overflow", { maxBufferBytes: 1_024 }),
  );
  assert.equal(overflow.failure, "OUTPUT_LIMIT");
  assert.ok(overflow.stdout.length <= 1_024);
  const stderr = await runner.run(options("stderr"));
  assert.equal(stderr.stderr.length, 4_000);
  assert.equal(stderr.exitCode, 2);
  await runner.close();
});

test(
  "parallel processes overlap, keep results separate, and reuse capacity",
  { timeout: 8_000 },
  async (t) => {
    const [first, second] = await barriers(t, 2);
    const runner = new ProcessRunner(2);
    t.after(() => runner.close());
    const one = runner.run(options(first.prompt));
    const two = runner.run(options(second.prompt));
    await Promise.all([first.ready(), second.ready()]);
    const full = await runner.run(options("ok"));
    assert.equal(full.failure, "BUSY");
    assert.match(full.error, /AGY_MCP_MAX_CONCURRENT/);

    second.release();
    const secondResult = await two;
    assert.equal(secondResult.exitCode, 0);
    assert.equal(
      JSON.parse(parseAgyOutput(secondResult.stdout).response).prompt,
      second.prompt,
    );
    assert.equal((await runner.run(options("ok"))).exitCode, 0);
    first.release();
    const firstResult = await one;
    assert.equal(firstResult.exitCode, 0);
    assert.equal(
      JSON.parse(parseAgyOutput(firstResult.stdout).response).prompt,
      first.prompt,
    );
  },
);

test("single-slot configuration preserves BUSY behavior", async (t) => {
  const runner = new ProcessRunner(1);
  t.after(() => runner.close());
  const active = runner.run(options("hang"));
  assert.equal((await runner.run(options("ok"))).failure, "BUSY");
  await runner.close();
  assert.equal((await active).failure, "CANCELED");
});

test(
  "shutdown cancels and awaits every active CLI",
  { timeout: 8_000 },
  async (t) => {
    const gates = await barriers(t, 4);
    const runner = new ProcessRunner();
    t.after(() => runner.close());
    const pending = gates.map((gate) => runner.run(options(gate.prompt)));
    await Promise.all(gates.map((gate) => gate.ready()));
    await Promise.all([runner.close(), runner.close()]);
    assert.deepEqual(
      (await Promise.all(pending)).map((result) => result.failure),
      Array(4).fill("CANCELED"),
    );
    assert.equal((await runner.run(options("ok"))).failure, "CANCELED");
  },
);

test(
  "cancellation and timeout leave other calls running and release their slots",
  { timeout: 8_000 },
  async (t) => {
    const [first, second] = await barriers(t, 2);
    const runner = new ProcessRunner(2);
    t.after(() => runner.close());
    const controller = new AbortController();
    const one = runner.run(
      options(first.prompt, { signal: controller.signal }),
    );
    const two = runner.run(options(second.prompt));
    await Promise.all([first.ready(), second.ready()]);
    controller.abort();
    assert.equal((await one).failure, "CANCELED");
    assert.equal(
      (await runner.run(options("hang", { timeoutMs: 250 }))).failure,
      "TIMEOUT",
    );
    assert.equal(
      (await runner.run(options("overflow", { maxBufferBytes: 1_024 })))
        .failure,
      "OUTPUT_LIMIT",
    );
    assert.equal(
      (await runner.run(options("ok", { bin: "/missing-agy-test" }))).failure,
      "SPAWN_ERROR",
    );
    assert.equal((await runner.run(options("ok"))).exitCode, 0);
    second.release();
    assert.equal((await two).exitCode, 0);
  },
);

test(
  "continuations lock the same UUID across workspaces and release it on cancellation",
  { timeout: 8_000 },
  async (t) => {
    const [gate] = await barriers(t, 1);
    const runner = new ProcessRunner();
    t.after(() => runner.close());
    const controller = new AbortController();
    const id = "055a398f-db14-4c5f-abbb-1bf03f8120a7";
    const run = (extra) =>
      runAgy(
        { prompt: "ok", workspace: process.cwd(), ...extra },
        config,
        runner,
      );
    const active = run({
      prompt: gate.prompt,
      conversationId: id,
      signal: controller.signal,
    });
    await gate.ready();
    const busy = await run({
      conversationId: id.toUpperCase(),
      workspace: os.tmpdir(),
    });
    assert.equal(busy.status, "BUSY");
    assert.match(busy.error, /conversation is already running/);
    assert.equal(
      (await run({ conversationId: "155a398f-db14-4c5f-abbb-1bf03f8120a7" }))
        .ok,
      true,
    );
    assert.equal((await run({})).ok, true);
    controller.abort();
    assert.equal((await active).status, "CANCELED");
    assert.equal((await run({ conversationId: id })).ok, true);
  },
);

test(
  "cancellation kills descendants in the CLI process group",
  { skip: process.platform !== "linux", timeout: 8_000 },
  async (t) => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "agy-tree-"));
    const previous = process.env.TEST_PID_FILE;
    process.env.TEST_PID_FILE = path.join(temp, "pid");
    const runner = new ProcessRunner();
    t.after(async () => {
      await runner.close();
      if (previous === undefined) delete process.env.TEST_PID_FILE;
      else process.env.TEST_PID_FILE = previous;
      rmSync(temp, { recursive: true, force: true });
    });
    const controller = new AbortController();
    const pending = runner.run(options("tree", { signal: controller.signal }));
    for (let i = 0; i < 150 && !existsSync(process.env.TEST_PID_FILE); i++)
      await delay(20);
    const pid = Number(readFileSync(process.env.TEST_PID_FILE, "utf8"));
    controller.abort();
    assert.equal((await pending).failure, "CANCELED");
    let state;
    for (let i = 0; i < 50; i++) {
      try {
        state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0];
        if (state === "Z" || state === "gone") break;
      } catch {
        state = "gone";
        break;
      }
      await delay(20);
    }
    assert.ok(
      state === "Z" || state === "gone",
      `descendant still running: ${state}`,
    );
  },
);

test("CLI result failures never masquerade as success", async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  for (const prompt of [
    "error",
    "empty",
    "malformed",
    "nonzero",
    "denied",
    "denied-empty",
  ]) {
    const result = await runAgy(
      { prompt, workspace: process.cwd() },
      config,
      runner,
    );
    assert.equal(result.ok, false, prompt);
    assert.ok(result.error, prompt);
    if (prompt === "denied") {
      assert.equal(result.status, "PERMISSION_DENIED");
      assert.notEqual(result.response, "");
      assert.ok(result.conversationId);
      assert.deepEqual(result.deniedActions, [{ tool: "write_to_file" }]);
    }
    if (prompt === "denied-empty") {
      assert.equal(result.status, "PERMISSION_DENIED");
      assert.equal(result.response, "");
      assert.ok(result.conversationId);
      assert.deepEqual(result.deniedActions, [{ tool: "write_to_file" }]);
    }
  }
  const success = await runAgy(
    { prompt: "literal ; $(touch must-not-exist)", workspace: process.cwd() },
    config,
    runner,
  );
  assert.equal(success.ok, true);
  assert.equal(
    JSON.parse(success.response).prompt,
    "literal ; $(touch must-not-exist)",
  );
  assert.equal(
    (
      await runAgy(
        { prompt: "ok", workspace: process.cwd(), autonomy: "full" },
        config,
        runner,
      )
    ).status,
    "POLICY_ERROR",
  );
});

test("hard process failures take precedence over denied actions", async (t) => {
  const fakeRunner = {
    run: async () => ({
      failure: "TIMEOUT",
      error: "process timed out after 5000ms",
      stdout: JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "partial output",
          conversation_id: "fake-timeout-id",
          denied_actions: [{ tool: "write_to_file" }],
        },
      }),
      stderr: "",
      exitCode: null,
    }),
  };
  const timeoutResult = await runAgy(
    { prompt: "any", workspace: process.cwd() },
    config,
    fakeRunner,
  );
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.status, "TIMEOUT");
  assert.equal(
    timeoutResult.error,
    "Turn reached the 900-second cap. Resume with antigravity_continue using conversation_id; partial_response, verified_outputs and workspace_changes show where it stopped.",
  );
  assert.equal(timeoutResult.resumable, true);
  assert.equal(timeoutResult.partialResponse, "partial output");
  assert.equal(timeoutResult.conversationId, "fake-timeout-id");
  assert.deepEqual(timeoutResult.deniedActions, [{ tool: "write_to_file" }]);

  const runner = new ProcessRunner();
  t.after(() => runner.close());
  const controller = new AbortController();
  controller.abort();
  const canceledResult = await runAgy(
    { prompt: "denied", workspace: process.cwd(), signal: controller.signal },
    config,
    runner,
  );
  assert.equal(canceledResult.ok, false);
  assert.equal(canceledResult.status, "CANCELED");
});

test("env option merges over process.env while preserving NO_COLOR=1", async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  const result = await runner.run({
    bin: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({ custom: process.env.CUSTOM_TEST_VAR, noColor: process.env.NO_COLOR }))",
    ],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    maxBufferBytes: 1_000_000,
    env: { CUSTOM_TEST_VAR: "isolated-value", NO_COLOR: "0" },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.queuedMs, undefined);
  assert.deepEqual(JSON.parse(result.stdout), {
    custom: "isolated-value",
    noColor: "1",
  });
});

test(
  "FIFO queue ordering, position callbacks, abort while queued, and queuedMs",
  { timeout: 8_000 },
  async (t) => {
    const [slot, first, second, third] = await barriers(t, 4);
    const runner = new ProcessRunner(1);
    t.after(() => runner.close());

    const active = runner.run(options(slot.prompt));
    await slot.ready();

    const pos1 = [];
    const pos2 = [];
    const pos3 = [];
    const abortSecond = new AbortController();

    const q1 = runner.run(
      options(first.prompt, {
        queueTimeoutMs: 5_000,
        onQueued: (p) => pos1.push(p),
      }),
    );
    const q2 = runner.run(
      options(second.prompt, {
        queueTimeoutMs: 5_000,
        signal: abortSecond.signal,
        onQueued: (p) => pos2.push(p),
      }),
    );
    const q3 = runner.run(
      options(third.prompt, {
        queueTimeoutMs: 5_000,
        onQueued: (p) => pos3.push(p),
      }),
    );

    assert.deepEqual(pos1, [1]);
    assert.deepEqual(pos2, [2]);
    assert.deepEqual(pos3, [3]);

    // Aborting the middle waiter updates the third waiter's position to 2
    abortSecond.abort();
    const res2 = await q2;
    assert.equal(res2.failure, "CANCELED");
    assert.equal(typeof res2.queuedMs, "number");
    assert.deepEqual(pos1, [1]);
    assert.deepEqual(pos3, [3, 2]);

    // Releasing the active slot starts q1 and advances q3 to position 1
    slot.release();
    const activeRes = await active;
    assert.equal(activeRes.exitCode, 0);
    assert.equal(activeRes.queuedMs, undefined);

    await first.ready();
    assert.deepEqual(pos3, [3, 2, 1]);

    first.release();
    const res1 = await q1;
    assert.equal(res1.exitCode, 0);
    assert.equal(typeof res1.queuedMs, "number");
    assert.ok(res1.queuedMs >= 0);

    await third.ready();
    third.release();
    const res3 = await q3;
    assert.equal(res3.exitCode, 0);
    assert.equal(typeof res3.queuedMs, "number");
  },
);

test(
  "queue timeout returns BUSY with wait message, same-lockKey stays immediate BUSY, and close cancels waiters",
  { timeout: 8_000 },
  async (t) => {
    const [slot] = await barriers(t, 1);
    const runner = new ProcessRunner(1);
    t.after(() => runner.close());

    const active = runner.run(options(slot.prompt, { lockKey: "conv-1" }));
    await slot.ready();

    // Same lockKey is immediate BUSY even with queueTimeoutMs
    const sameKey = await runner.run(
      options("ok", { lockKey: "conv-1", queueTimeoutMs: 5_000 }),
    );
    assert.equal(sameKey.failure, "BUSY");
    assert.match(sameKey.error, /conversation is already running/);

    // Queue timeout
    const timedOut = await runner.run(options("ok", { queueTimeoutMs: 100 }));
    assert.equal(timedOut.failure, "BUSY");
    assert.equal(
      timedOut.error,
      "Waited 0.1 seconds for a free agy slot; all 1 slots stayed busy.",
    );
    assert.equal(typeof timedOut.queuedMs, "number");

    // Waiter canceled when runner.close() is called
    const waiter = runner.run(options("ok", { queueTimeoutMs: 5_000 }));
    await runner.close();
    const waiterRes = await waiter;
    assert.equal(waiterRes.failure, "CANCELED");
    assert.equal((await active).failure, "CANCELED");
  },
);

test("runAgy maps print-timeout to TIMEOUT with resumable, terminatedTasks, turnSeconds, verifiedOutputs, and turnTokens", async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());

  const res = await runAgy(
    { prompt: "print-timeout", workspace: process.cwd(), timeoutSec: 15 },
    config,
    runner,
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, "TIMEOUT");
  assert.equal(res.resumable, true);
  assert.ok(res.conversationId);
  assert.equal(
    res.error,
    "Turn reached the 15-second cap. Resume with antigravity_continue using conversation_id; partial_response, verified_outputs and workspace_changes show where it stopped.",
  );
  assert.deepEqual(res.terminatedTasks, [
    { id: `${res.conversationId}/task-2`, description: "sleep 40" },
  ]);
  assert.equal(typeof res.turnSeconds, "number");
  assert.ok(res.turnSeconds >= 0);
  assert.equal(res.durationSec, 15);
  assert.equal(res.turnTokens, 95);
  assert.deepEqual(res.verifiedOutputs, [
    {
      step_index: 1,
      command: "sleep 40",
      status: "running",
      exit_code: null,
    },
  ]);
});

test("runAgy collects verifiedOutputs and deniedCommands from ledger and merges transcript denials", async (t) => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "agy-home-ledger-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  const runner = new ProcessRunner();
  t.after(async () => {
    await runner.close();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  const ledgerRes = await runAgy(
    { prompt: "ledger", workspace: process.cwd() },
    config,
    runner,
  );
  assert.equal(ledgerRes.ok, true);
  assert.equal(ledgerRes.turnTokens, 150);
  assert.equal(ledgerRes.verifiedOutputs?.length, 3);
  assert.equal(ledgerRes.verifiedOutputs[0].command, "echo ok");
  assert.equal(ledgerRes.verifiedOutputs[0].status, "completed");
  assert.equal(ledgerRes.verifiedOutputs[1].command, "ls /nope");
  assert.equal(ledgerRes.verifiedOutputs[1].status, "failed");
  assert.equal(ledgerRes.verifiedOutputs[2].status, "background");

  const convId = randomUUID();
  const tFile = transcriptPath(convId, tempHome);
  mkdirSync(path.dirname(tFile), { recursive: true });
  writeFileSync(
    tFile,
    [
      JSON.stringify({
        type: "GENERIC",
        status: "ERROR",
        created_at: new Date().toISOString(),
        error:
          'permission check failed for unsandboxed "rm -rf /tmp/nope": user denied permission to run command:\nrm -rf /tmp/nope\n',
      }),
      JSON.stringify({
        type: "GENERIC",
        status: "ERROR",
        created_at: new Date().toISOString(),
        error:
          'permission check failed for unsandboxed "curl bad": user denied permission to run command:\ncurl bad\n',
      }),
    ].join("\n") + "\n",
  );

  const deniedRes = await runAgy(
    {
      prompt: "denied-tail",
      workspace: process.cwd(),
      conversationId: convId,
    },
    config,
    runner,
  );
  assert.equal(deniedRes.status, "PERMISSION_DENIED");
  assert.deepEqual(deniedRes.deniedCommands, ["rm -rf /tmp/nope", "curl bad"]);
  assert.equal(deniedRes.verifiedOutputs?.length, 1);
  assert.equal(deniedRes.verifiedOutputs[0].status, "denied");
});

test("runAgy partialResponse fallback order and workspaceChanges in temp git repo", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agy-ws-git-"));
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "agy-home-partial-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  const runner = new ProcessRunner();
  t.after(async () => {
    await runner.close();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(temp, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  // Non-git workspace omits workspaceChanges
  const nonGitRes = await runAgy(
    { prompt: "empty", workspace: temp },
    config,
    runner,
  );
  assert.equal(nonGitRes.status, "EMPTY_RESPONSE");
  assert.equal(nonGitRes.workspaceChanges, undefined);

  // Initialize git repo and create 55 untracked files
  execFileSync("git", ["init"], { cwd: temp });
  for (let i = 1; i <= 55; i++) {
    writeFileSync(
      path.join(temp, `file-${String(i).padStart(2, "0")}.txt`),
      "x",
    );
  }

  // Fallback 1: non-empty response on PERMISSION_DENIED is used directly
  const deniedWithResponse = await runAgy(
    { prompt: "denied", workspace: temp },
    config,
    runner,
  );
  assert.equal(deniedWithResponse.status, "PERMISSION_DENIED");
  assert.equal(deniedWithResponse.partialResponse, deniedWithResponse.response);
  assert.equal(deniedWithResponse.workspaceChanges?.length, 50);
  assert.match(deniedWithResponse.workspaceChanges[0], /^\?\? file-01\.txt$/);

  // Fallback 2: empty response falls back to readLastPlannerText from transcript
  const convId = randomUUID();
  const tFile = transcriptPath(convId, tempHome);
  mkdirSync(path.dirname(tFile), { recursive: true });
  writeFileSync(
    tFile,
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      created_at: new Date().toISOString(),
      content: "Planner stopped after step 1",
    }) + "\n",
  );

  const timeoutWithPlanner = await runAgy(
    { prompt: "print-timeout", workspace: temp, conversationId: convId },
    config,
    runner,
  );
  assert.equal(timeoutWithPlanner.status, "TIMEOUT");
  assert.equal(
    timeoutWithPlanner.partialResponse,
    "Planner stopped after step 1",
  );
  assert.equal(timeoutWithPlanner.workspaceChanges?.length, 50);
});

test("runAgy sets guard env, emits missing-guard and prompt preflight warnings, and suppresses guard warning when installed", async (t) => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "agy-home-guard-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tempHome;
  const runner = new ProcessRunner();
  t.after(async () => {
    await runner.close();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  const guardOnConfig = loadConfig({
    AGY_MCP_BIN: fixture,
    AGY_MCP_GUARD: "on",
    AGY_MCP_ENV_ISOLATION: "off",
  });

  const missingRes = await runAgy(
    { prompt: "Run `git push`", workspace: process.cwd() },
    guardOnConfig,
    runner,
  );
  assert.equal(missingRes.ok, true);
  const missingPayload = JSON.parse(missingRes.response);
  assert.equal(missingPayload.env.AGY_ORCH_MCP_GUARD, "1");
  assert.ok(
    missingRes.preflightWarnings?.some((w) =>
      w.includes("`git push` matches deny rule `command(git push)`"),
    ),
  );
  assert.ok(
    missingRes.preflightWarnings?.includes(
      "agy-orch-mcp guard hook is missing; run `agy-orch-mcp --install-guard` to enable command guarding.",
    ),
  );

  // Install the guard hook into a second temp HOME and verify warning disappears
  const installedHome = mkdtempSync(
    path.join(os.tmpdir(), "agy-home-installed-"),
  );
  t.after(() => rmSync(installedHome, { recursive: true, force: true }));
  process.env.HOME = installedHome;
  const hookScriptPath = fileURLToPath(
    new URL("../dist/guard-hook.js", import.meta.url),
  );
  installGuard(
    defaultHooksPath(installedHome),
    guardHookCommand(process.execPath, hookScriptPath),
  );

  const installedRes = await runAgy(
    { prompt: "plain text prompt", workspace: process.cwd() },
    guardOnConfig,
    runner,
  );
  assert.equal(installedRes.preflightWarnings, undefined);

  // Guard off omits AGY_ORCH_MCP_GUARD env
  const guardOffConfig = loadConfig({
    AGY_MCP_BIN: fixture,
    AGY_MCP_GUARD: "off",
    AGY_MCP_ENV_ISOLATION: "off",
  });
  const offRes = await runAgy(
    { prompt: "plain text prompt", workspace: process.cwd() },
    guardOffConfig,
    runner,
  );
  assert.equal(JSON.parse(offRes.response).env.AGY_ORCH_MCP_GUARD, undefined);
});

test("runAgy manages isolated env roots: pending rename on new turn, remove if target exists, reuse on continuation", async (t) => {
  const tempEnvRoot = mkdtempSync(path.join(os.tmpdir(), "agy-env-root-"));
  const runner = new ProcessRunner();
  t.after(async () => {
    await runner.close();
    rmSync(tempEnvRoot, { recursive: true, force: true });
  });

  const isoConfig = loadConfig({
    AGY_MCP_BIN: fixture,
    AGY_MCP_ENV_ISOLATION: "full",
    AGY_MCP_ENV_ROOT: tempEnvRoot,
    AGY_MCP_GUARD: "off",
  });

  // New turn creates pending-<id> and renames to <envRoot>/<conversation_id>
  const first = await runAgy(
    { prompt: "new-turn", workspace: process.cwd() },
    isoConfig,
    runner,
  );
  assert.equal(first.ok, true);
  assert.ok(first.conversationId);
  const firstPayload = JSON.parse(first.response);
  assert.match(firstPayload.env.GOBIN, /pending-/);
  const convDir = path.join(tempEnvRoot, first.conversationId);
  assert.equal(existsSync(convDir), true);
  assert.deepEqual(readdirSync(tempEnvRoot), [first.conversationId]);

  // Continuing turn reuses <envRoot>/<conversation_id>
  const cont = await runAgy(
    {
      prompt: "continue-turn",
      workspace: process.cwd(),
      conversationId: first.conversationId,
    },
    isoConfig,
    runner,
  );
  assert.equal(cont.ok, true);
  const contPayload = JSON.parse(cont.response);
  assert.equal(contPayload.env.GOBIN, path.join(convDir, "go", "bin"));

  // If <envRoot>/<conversation_id> already exists when a new turn finishes, pending dir is removed
  const preExistingId = randomUUID();
  mkdirSync(path.join(tempEnvRoot, preExistingId, "marker"), {
    recursive: true,
  });
  const fakeCollisionRunner = {
    run: async (opts) => {
      assert.match(opts.env.GOBIN, /pending-/);
      return {
        stdout: JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "ok",
            conversation_id: preExistingId,
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    },
  };
  await runAgy(
    { prompt: "collision", workspace: process.cwd() },
    isoConfig,
    fakeCollisionRunner,
  );
  const remaining = readdirSync(tempEnvRoot);
  assert.equal(
    remaining.some((name) => name.startsWith("pending-")),
    false,
  );
  assert.equal(
    existsSync(path.join(tempEnvRoot, preExistingId, "marker")),
    true,
  );
});

test("runAgy structuredHandoff parses valid handoff and records handoffError on invalid handoff, and forwards queue options", async (t) => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());

  const validRes = await runAgy(
    {
      prompt: "handoff-ok",
      workspace: process.cwd(),
      structuredHandoff: true,
    },
    config,
    runner,
  );
  assert.equal(validRes.ok, true);
  assert.equal(validRes.handoffError, undefined);
  assert.equal(validRes.handoff?.summary, "completed task");

  const invalidRes = await runAgy(
    {
      prompt: "not-a-handoff",
      workspace: process.cwd(),
      structuredHandoff: true,
    },
    config,
    runner,
  );
  assert.equal(invalidRes.ok, true);
  assert.equal(invalidRes.handoff, undefined);
  assert.match(invalidRes.handoffError, /handoff\.summary/);

  const queuedPositions = [];
  const fakeQueuedRunner = {
    run: async (opts) => {
      assert.equal(opts.queueTimeoutMs, 4_500);
      opts.onQueued?.(2);
      return {
        stdout: JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "queued ok",
            conversation_id: randomUUID(),
          },
        }),
        stderr: "",
        exitCode: 0,
        queuedMs: 1_250,
      };
    },
  };
  const queuedRes = await runAgy(
    {
      prompt: "queued",
      workspace: process.cwd(),
      queueTimeoutMs: 4_500,
      onQueued: (pos) => queuedPositions.push(pos),
    },
    config,
    fakeQueuedRunner,
  );
  assert.equal(queuedRes.ok, true);
  assert.deepEqual(queuedPositions, [2]);
  assert.equal(queuedRes.queueWaitSeconds, 1.25);
});
