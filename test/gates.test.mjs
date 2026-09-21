import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GateRunner,
  NodeTapParser,
  VitestParser,
  JestParser,
  GoTestParser,
  GenericParser,
} from "../dist/gates/index.js";

test("Gate modules", async (t) => {
  const fixturesDir = path.join(process.cwd(), "test/fixtures/gates");
  await fs.mkdir(fixturesDir, { recursive: true });

  await t.test("GateRunner allowlist / denylist", async () => {
    const runner = new GateRunner({
      allowedExecutables: ["node"],
      deniedExecutables: ["rm", "sh", "bash"],
      allowedEnvKeys: ["TEST_ENV"],
      maxOutputBytes: 1024 * 1024,
    });

    // Valid command
    const res = await runner.runGate(
      ["node", "-e", "console.log('hello')"],
      fixturesDir,
      5000,
    );
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout.includes("hello"));

    // Denied command
    const resDenied = await runner.runGate(
      ["rm", "-rf", "/"],
      fixturesDir,
      5000,
    );
    assert.strictEqual(resDenied.failure, "POLICY_DENIED");

    // Not allowed command
    const resNotAllowed = await runner.runGate(
      ["echo", "hello"],
      fixturesDir,
      5000,
    );
    assert.strictEqual(resNotAllowed.failure, "POLICY_DENIED");
  });

  await t.test("GateRunner env filtering", async () => {
    const runner = new GateRunner({
      allowedExecutables: ["node"],
      deniedExecutables: [],
      allowedEnvKeys: ["ALLOWED_VAR"],
      maxOutputBytes: 1024 * 1024,
    });

    process.env.ALLOWED_VAR = "yes";
    process.env.DENIED_VAR = "secret";

    const res = await runner.runGate(
      [
        "node",
        "-e",
        "console.log(process.env.ALLOWED_VAR); console.log(process.env.DENIED_VAR);",
      ],
      fixturesDir,
      5000,
    );
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout.includes("yes"));
    assert.ok(res.stdout.includes("undefined"));

    delete process.env.ALLOWED_VAR;
    delete process.env.DENIED_VAR;
  });

  await t.test("GateRunner timeout", async () => {
    const runner = new GateRunner({
      allowedExecutables: ["node"],
      deniedExecutables: [],
      allowedEnvKeys: [],
      maxOutputBytes: 1024 * 1024,
    });

    const scriptPath = path.join(fixturesDir, "timeout.js");
    await fs.writeFile(
      scriptPath,
      "setTimeout(() => console.log('done'), 10000);",
    );

    const res = await runner.runGate(["node", scriptPath], fixturesDir, 100);
    assert.strictEqual(res.failure, "GATE_TIMEOUT");

    await fs.unlink(scriptPath);
  });

  await t.test(
    "GateRunner resolves binaries via PATH even when allowedEnvKeys does not list PATH",
    async () => {
      const customBinDir = await fs.mkdtemp(
        path.join(fixturesDir, "custom-bin-"),
      );
      const toolName = `custom-gate-tool-${Date.now()}`;
      const toolScript = path.join(customBinDir, toolName);
      await fs.writeFile(toolScript, "#!/bin/sh\necho custom-gate-ok\n", {
        mode: 0o755,
      });

      const origPath = process.env.PATH;
      process.env.PATH = `${customBinDir}${path.delimiter}${origPath ?? ""}`;

      try {
        const runner = new GateRunner({
          allowedExecutables: [toolName],
          deniedExecutables: [],
          allowedEnvKeys: [],
          maxOutputBytes: 1024 * 1024,
        });

        const res = await runner.runGate([toolName], fixturesDir, 5000);
        assert.strictEqual(res.exitCode, 0);
        assert.ok(res.stdout.includes("custom-gate-ok"));
        assert.strictEqual(res.failure, undefined);
      } finally {
        if (origPath !== undefined) process.env.PATH = origPath;
        else delete process.env.PATH;
        await fs.rm(customBinDir, { recursive: true, force: true });
      }
    },
  );

  await t.test("Parsers", () => {
    const tap = new NodeTapParser();
    const tapRes = tap.parse("not ok 1 - test failed", "");
    assert.deepStrictEqual(tapRes.failingTests, ["- test failed"]);
    assert.strictEqual(tapRes.parserName, "tap");

    const vitest = new VitestParser();
    const vitestRes = vitest.parse("FAIL  src/fail.test.ts", "");
    assert.deepStrictEqual(vitestRes.failingTests, ["src/fail.test.ts"]);
    assert.strictEqual(vitestRes.parserName, "vitest");

    const jest = new JestParser();
    const jestRes = jest.parse("FAIL src/app.test.js", "");
    assert.deepStrictEqual(jestRes.failingTests, ["src/app.test.js"]);
    assert.strictEqual(jestRes.parserName, "jest");

    const goTest = new GoTestParser();
    const goTestRes = goTest.parse("--- FAIL: TestMyFunc", "");
    assert.deepStrictEqual(goTestRes.failingTests, ["TestMyFunc"]);
    assert.strictEqual(goTestRes.parserName, "go-test");

    const generic = new GenericParser();
    const genericRes = generic.parse(
      "Something went wrong\nAn error occurred",
      "",
    );
    assert.deepStrictEqual(genericRes.failingTests, ["An error occurred"]);
    assert.strictEqual(genericRes.parserName, "generic");
  });
});

test("Gates advanced constraints", async (t) => {
  const fixturesDir = path.join(process.cwd(), "test/fixtures/gates_adv");
  await fs.mkdir(fixturesDir, { recursive: true });

  const runner = new GateRunner({
    allowedExecutables: ["node"],
    deniedExecutables: ["rm"],
    allowedEnvKeys: ["SAFE_VAR"],
    maxOutputBytes: 1024 * 1024,
  });

  await t.test("gate argv injection mitigation", async () => {
    // shell injection like `node -e '...' && rm -rf /` should fail because shell is false
    const res = await runner.runGate(
      ["node", "-e", "console.log('hello')", "&&", "echo", "injected"],
      fixturesDir,
      5000,
    );
    // Node evaluates the first part, the rest are just arguments and it will ignore them unless the script uses them
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout.includes("hello"));
    assert.strictEqual(res.stdout.includes("injected"), false);
  });

  await t.test("denied exec / cwd", async () => {
    const resCwd = await runner.runGate(
      ["node", "-v"],
      "/invalid_path_does_not_exist",
      5000,
    );
    assert.strictEqual(resCwd.exitCode, null);
    assert.ok(resCwd.error.includes("Invalid cwd"));
  });

  await t.test("timeout+abort process-group children", async () => {
    const scriptPath = path.join(fixturesDir, "spawn.cjs");
    await fs.writeFile(
      scriptPath,
      `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => console.log("child done"), 20000)'], { detached: true });
      child.unref();
      setTimeout(() => console.log('parent done'), 20000);
    `,
    );

    const res = await runner.runGate(["node", scriptPath], fixturesDir, 100);
    assert.strictEqual(res.failure, "GATE_TIMEOUT");
    await fs.unlink(scriptPath);
  });

  await t.test(
    "signal cancellation reaps running process cleanly",
    async () => {
      const ac = new AbortController();
      const startTime = Date.now();
      setTimeout(() => ac.abort(), 100);
      const res = await runner.runGate(
        ["node", "-e", "setTimeout(() => {}, 10000)"],
        fixturesDir,
        10000,
        undefined,
        undefined,
        ac.signal,
      );
      const duration = Date.now() - startTime;
      assert.strictEqual(res.failure, "CANCELED");
      assert.ok(
        duration < 2000,
        `Duration ${duration}ms should be well under 10000ms`,
      );
    },
  );
});
