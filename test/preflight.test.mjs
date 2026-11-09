import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadPermissionRules, preflightWarnings } from "../dist/preflight.js";

function withFakePath(t, execNames, nonExecNames = []) {
  const binDir = mkdtempSync(path.join(os.tmpdir(), "agy-preflight-bin-"));
  for (const name of execNames) {
    const file = path.join(binDir, name);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  for (const name of nonExecNames) {
    const file = path.join(binDir, name);
    writeFileSync(file, "not executable\n");
    chmodSync(file, 0o644);
  }
  const prevPath = process.env.PATH;
  process.env.PATH = binDir;
  t.after(() => {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(binDir, { recursive: true, force: true });
  });
}

test("loadPermissionRules reads allow/deny strings and handles missing or invalid files", (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agy-preflight-cfg-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const validPath = path.join(temp, "settings.json");
  writeFileSync(
    validPath,
    JSON.stringify({
      permissions: {
        allow: ["command(git status)", 123, null, "command(pnpm test)"],
        deny: ["command(git push)", false, { bad: true }],
      },
    }),
  );
  assert.deepEqual(loadPermissionRules(validPath), {
    allow: ["command(git status)", "command(pnpm test)"],
    deny: ["command(git push)"],
  });

  assert.deepEqual(loadPermissionRules(path.join(temp, "missing.json")), {
    allow: [],
    deny: [],
  });

  const invalidPath = path.join(temp, "invalid.json");
  writeFileSync(invalidPath, "{bad json");
  assert.deepEqual(loadPermissionRules(invalidPath), {
    allow: [],
    deny: [],
  });
});

test("preflightWarnings extracts inline and fenced candidates, filters by PATH X_OK, and unwraps env/timeout/nohup/nice", (t) => {
  withFakePath(
    t,
    ["mycmd", "env", "timeout", "nohup", "nice", "rg", "wc"],
    ["notexec"],
  );

  const prompt = [
    "Edit `src/agy.ts` and `notexec --flag` or `unknown_symbol`.",
    "Run `FOO=1 BAR=two mycmd --check` first.",
    "```bash",
    "",
    "env A=1 mycmd sub",
    "timeout 10s mycmd timed",
    "nohup nice -n 5 mycmd wrapped",
    "```",
  ].join("\n");

  const warnings = preflightWarnings(prompt, {
    allow: ["command(FOO=1 BAR=two mycmd)"],
    deny: [],
  });

  assert.deepEqual(warnings, [
    "`env A=1 mycmd sub` is not in permissions.allow; agy will deny it in headless mode.",
    "`timeout 10s mycmd timed` is not in permissions.allow; agy will deny it in headless mode.",
    "`nohup nice -n 5 mycmd wrapped` is not in permissions.allow; agy will deny it in headless mode.",
  ]);
});

test("preflightWarnings splits unquoted pipelines/chains and matches prefix, wildcard, regex, and deny rules", (t) => {
  withFakePath(t, ["rg", "wc", "git", "gh", "pnpm"]);

  const prompt = [
    'Use `rg "a | b && c" | wc -l && git push origin main; gh pr create`',
    "Then `git push-other` and `pnpm test`.",
  ].join("\n");

  const rules = {
    allow: [
      'command(rg "a | b && c")',
      "command(regex:pnpm (?:test|check))",
      "command(regex:[invalid)",
      "read_file(*)",
      "command(git push)",
    ],
    deny: ["command(git push)"],
  };
  const extraDeny = ["command(gh pr create)"];

  const warnings = preflightWarnings(prompt, rules, extraDeny);
  assert.deepEqual(warnings, [
    "`wc -l` is not in permissions.allow; agy will deny it in headless mode.",
    "`git push origin main` matches deny rule `command(git push)`; the worker cannot run it.",
    "`gh pr create` matches deny rule `command(gh pr create)`; the worker cannot run it.",
    "`git push-other` is not in permissions.allow; agy will deny it in headless mode.",
  ]);

  assert.deepEqual(
    preflightWarnings(prompt, { allow: ["command(*)"], deny: [] }),
    [],
  );
});

test("preflightWarnings deduplicates in prompt order and caps at 10 warnings", (t) => {
  withFakePath(t, ["cmd"]);

  const lines = [
    "`cmd 1`",
    "`cmd 2`",
    "`cmd 1`",
    ...Array.from({ length: 15 }, (_, i) => `\`cmd ${i + 3}\``),
  ].join("\n");

  const warnings = preflightWarnings(lines, { allow: [], deny: [] });
  assert.equal(warnings.length, 10);
  assert.equal(
    warnings[0],
    "`cmd 1` is not in permissions.allow; agy will deny it in headless mode.",
  );
  assert.equal(
    warnings[1],
    "`cmd 2` is not in permissions.allow; agy will deny it in headless mode.",
  );
  assert.equal(
    warnings[9],
    "`cmd 10` is not in permissions.allow; agy will deny it in headless mode.",
  );
});
