import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
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
import { ProcessRunner } from "../dist/process.js";

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
  "implicit continuation is exclusive in both directions",
  { timeout: 8_000 },
  async (t) => {
    const [first, second] = await barriers(t, 2);
    const runner = new ProcessRunner();
    t.after(() => runner.close());
    const run = (extra) =>
      runAgy(
        { prompt: "ok", workspace: process.cwd(), ...extra },
        config,
        runner,
      );
    const active = run({ prompt: first.prompt });
    await first.ready();
    assert.equal((await run({ continueLatest: true })).status, "BUSY");
    first.release();
    assert.equal((await active).ok, true);

    const latest = run({ prompt: second.prompt, continueLatest: true });
    await second.ready();
    assert.equal((await run({})).status, "BUSY");
    assert.equal(
      (await run({ conversationId: "055a398f-db14-4c5f-abbb-1bf03f8120a7" }))
        .status,
      "BUSY",
    );
    assert.equal((await run({ continueLatest: true })).status, "BUSY");
    second.release();
    assert.equal((await latest).ok, true);
    assert.equal((await run({})).ok, true);
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
    try {
      state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0];
    } catch {
      state = "gone";
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
  assert.equal(timeoutResult.error, "process timed out after 5000ms");
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
