import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildArgs, parseAgyOutput } from "../dist/agy.js";
import { loadConfig, resolveWorkspace } from "../dist/config.js";
import { toToolResult } from "../dist/result.js";

test("configuration validates numeric limits and booleans", () => {
  for (const value of ["", "NaN", "Infinity", "-1", "10.2", "1000001"]) {
    assert.throws(
      () => loadConfig({ AGY_MCP_MAX_OUTPUT_CHARS: value }),
      /integer/,
    );
  }
  assert.throws(
    () => loadConfig({ AGY_MCP_ALLOW_FULL_AUTONOMY: "yes" }),
    /true or false/,
  );
  assert.throws(() => loadConfig({ AGY_MCP_BIN: "" }), /executable/);
  assert.throws(() => loadConfig({ AGY_MCP_BIN: " agy" }), /executable/);
  assert.throws(
    () => loadConfig({ AGY_MCP_DEFAULT_WORKSPACE: "" }),
    /must not be blank/,
  );
  assert.throws(
    () => loadConfig({ AGY_MCP_ALLOWED_ROOT: "   " }),
    /must not be blank/,
  );
  assert.equal(loadConfig({}).allowFullAutonomy, false);
});

test("configuration validates AGY_MCP_DEFAULT_MODEL", () => {
  assert.throws(
    () => loadConfig({ AGY_MCP_DEFAULT_MODEL: "" }),
    /must be between/,
  );
  assert.throws(
    () => loadConfig({ AGY_MCP_DEFAULT_MODEL: "a".repeat(201) }),
    /must be between/,
  );
  for (const bad of [
    "test\0model",
    "test model",
    "test\tmodel",
    "test\nmodel",
    "test\rmodel",
    "-test-model",
  ]) {
    assert.throws(
      () => loadConfig({ AGY_MCP_DEFAULT_MODEL: bad }),
      /must not contain whitespace, NUL, or start with a dash/,
    );
  }
  assert.equal(
    loadConfig({ AGY_MCP_DEFAULT_MODEL: "test-model" }).defaultModel,
    "test-model",
  );
  assert.equal(
    loadConfig({ AGY_MCP_DEFAULT_MODEL: "a".repeat(200) }).defaultModel,
    "a".repeat(200),
  );
});

test("parallelism defaults to four and accepts only bounded positive integers", () => {
  assert.equal(loadConfig({}).maxConcurrent, 4);
  for (const value of ["1", "2", "32"])
    assert.equal(
      loadConfig({ AGY_MCP_MAX_CONCURRENT: value }).maxConcurrent,
      Number(value),
    );
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "33", " 2"])
    assert.throws(
      () => loadConfig({ AGY_MCP_MAX_CONCURRENT: value }),
      /AGY_MCP_MAX_CONCURRENT must be an integer between 1 and 32/,
    );
});

test("canonical paths reject traversal, sibling prefixes and escaping symlinks", (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agy-paths-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root");
  const outside = path.join(temp, "root-other");
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(path.join(root, "..valid"));
  symlinkSync(outside, path.join(root, "escape"), "dir");
  const canonicalRoot = realpathSync(root);
  const canonicalValid = realpathSync(path.join(root, "..valid"));
  const config = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: root,
    AGY_MCP_ALLOWED_ROOT: root,
  });
  assert.equal(resolveWorkspace(root, config), canonicalRoot);
  assert.equal(
    resolveWorkspace(path.join(root, "..valid"), config),
    canonicalValid,
  );
  for (const dir of [outside, path.join(root, "escape"), temp])
    assert.throws(() => resolveWorkspace(dir, config), /outside/);
  assert.throws(() => resolveWorkspace("relative", config), /absolute/);
  assert.throws(
    () =>
      loadConfig({
        AGY_MCP_DEFAULT_WORKSPACE: outside,
        AGY_MCP_ALLOWED_ROOT: root,
      }),
    /outside/,
  );
  assert.throws(
    () => loadConfig({ AGY_MCP_ALLOWED_ROOT: path.join(temp, "missing") }),
    /directory/,
  );
});

test("argv keeps prompts literal and permission bypass opt-in", () => {
  const options = {
    prompt: '/skill; $(touch bad) `echo no` "quoted"\nnext',
    workspace: "/tmp/space dir",
  };
  const args = buildArgs(options);
  assert.equal(args[1], options.prompt);
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
  const continued = buildArgs({
    ...options,
    conversationId: "test-id",
    autonomy: "sandbox",
    model: "test-model",
    effort: "high",
    timeoutSec: 42,
  });
  assert.ok(continued.includes("--conversation"));
  assert.ok(!continued.includes("--continue"));
  assert.ok(continued.includes("--sandbox"));
  assert.ok(continued.includes("42s"));
  assert.ok(
    buildArgs({ ...options, autonomy: "full" }).includes(
      "--dangerously-skip-permissions",
    ),
  );
});

test("parsing supports direct JSON and stream results with trailing logs", () => {
  const result = {
    status: "SUCCESS",
    response: "日本語\nresponse",
    conversation_id: "id",
    duration_seconds: 2,
    usage: { total_tokens: 5 },
  };
  assert.equal(
    parseAgyOutput(JSON.stringify(result, null, 2)).response,
    result.response,
  );
  const stream = [
    "diagnostic",
    JSON.stringify({ event: "init", conversation_id: "init-id" }),
    JSON.stringify({ event: "result", result }),
    JSON.stringify({ event: "log", message: "end" }),
  ].join("\n");
  const parsed = parseAgyOutput(stream);
  assert.equal(parsed.conversationId, "id");
  assert.equal(parsed.response, result.response);
  assert.equal(parsed.usage.total_tokens, 5);
  assert.equal(
    parseAgyOutput('{"event":"init","conversation_id":"id"}').parsed,
    false,
  );
  assert.equal(parseAgyOutput("[]").parsed, false);
  assert.equal(parseAgyOutput("").status, "EMPTY_RESPONSE");
  assert.equal(
    parseAgyOutput('{"status":"ERROR","error":{"message":"bad"}}').error,
    '{"message":"bad"}',
  );
});

test("all output fields fit the configured budget with metadata retained", () => {
  const result = toToolResult(
    {
      ok: false,
      status: "ERROR",
      response: '"\n語'.repeat(40_000),
      exitCode: 1,
      conversationId: "test-id",
      error: "error".repeat(10_000),
      stderr: "failure".repeat(10_000),
      deniedActions: ["denied".repeat(10_000)],
      usage: { huge: "x".repeat(10_000) },
    },
    1_024,
  );
  assert.ok(result.content[0].text.length <= 1_024);
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  assert.equal(result.structuredContent.conversation_id, "test-id");
  assert.equal(result.structuredContent.truncated, true);
  assert.equal(result.isError, true);
});

test("malformed CLI strings cannot evade the MCP result budget through JSON escaping", () => {
  const controls = "\u0000".repeat(10_000);
  const result = toToolResult(
    {
      ok: false,
      status: controls,
      response: "",
      exitCode: null,
      conversationId: controls,
      error: controls,
    },
    1_024,
  );
  assert.ok(result.content[0].text.length <= 1_024);
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  assert.equal(result.structuredContent.truncated, true);
});
