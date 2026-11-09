import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FIXED_DENY_RULES,
  GUARD_ENV,
  GUARD_HOOK_NAME,
  defaultHooksPath,
  evaluateCommand,
  guardHookCommand,
  guardStatus,
  installGuard,
  sessionSettingsJson,
  uninstallGuard,
} from "../dist/guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScriptPath = path.resolve(__dirname, "../dist/guard-hook.js");

test("FIXED_DENY_RULES and sessionSettingsJson cover remote operations", () => {
  assert.ok(Array.isArray(FIXED_DENY_RULES));
  assert.equal(FIXED_DENY_RULES.length, 38);
  for (const expected of [
    "command(git push)",
    "command(gh pr create)",
    "command(gh pr merge)",
    "command(gh pr close)",
    "command(gh pr reopen)",
    "command(gh pr edit)",
    "command(gh pr ready)",
    "command(gh pr review)",
    "command(gh pr comment)",
    "command(gh workflow run)",
    "command(gh workflow enable)",
    "command(gh workflow disable)",
    "command(gh run rerun)",
    "command(gh run cancel)",
    "command(gh run delete)",
    "command(gh release create)",
    "command(gh release delete)",
    "command(gh release edit)",
    "command(gh release upload)",
    "command(gh repo create)",
    "command(gh repo delete)",
    "command(gh repo edit)",
    "command(gh repo fork)",
    "command(gh repo rename)",
    "command(gh repo archive)",
    "command(gh issue create)",
    "command(gh issue close)",
    "command(gh issue reopen)",
    "command(gh issue edit)",
    "command(gh issue comment)",
    "command(gh issue delete)",
    "command(gh secret set)",
    "command(gh secret delete)",
    "command(gh variable set)",
    "command(gh variable delete)",
    "command(gh label create)",
    "command(gh label edit)",
    "command(gh label delete)",
  ]) {
    assert.ok(
      FIXED_DENY_RULES.includes(expected),
      `missingFIXED_DENY_RULES entry: ${expected}`,
    );
  }
  const parsed = JSON.parse(sessionSettingsJson());
  assert.deepEqual(parsed, { permissions: { deny: [...FIXED_DENY_RULES] } });
});

test("evaluateCommand denies remote git and gh operations", () => {
  const remoteCommands = [
    "git push",
    "git -C x push origin",
    "git -c http.extraHeader=x --no-pager -P --git-dir=.git --work-tree=. --namespace=ns push origin main",
    "env FOO=1 git push",
    "FOO=1 env -i -u BAR BAZ=2 timeout 10s nohup nice -n 5 time stdbuf -oL git push",
    "gh pr create --title x",
    "gh pr merge 42",
    "gh workflow run ci.yml",
    "gh run rerun 123",
    "gh release create v1.0.0",
    "gh repo delete owner/repo",
    "gh issue comment 10 --body hi",
    "gh secret set MY_SECRET",
    "gh variable delete MY_VAR",
    "gh label create bug",
    "gh api repos/x/y",
    "gh api -X POST repos/x/y",
    "gh api --method=POST repos/x/y",
    "git status && git push origin HEAD",
  ];
  for (const cmd of remoteCommands) {
    const verdict = evaluateCommand(cmd);
    assert.equal(verdict.decision, "deny", `expected deny for: ${cmd}`);
    assert.equal(verdict.rule, "remote", `expected rule=remote for: ${cmd}`);
    assert.equal(
      verdict.reason,
      "Remote-changing git/GitHub operations are reserved for the host. Do not retry; list what you would run in your handoff instead.",
    );
  }
});

test("evaluateCommand allows gh api when explicit GET method is present", () => {
  for (const cmd of [
    "gh api --method GET repos/x/y -f a=b",
    "gh api --method=GET repos/x/y",
    "gh api -X GET repos/x/y",
    "gh api -XGET repos/x/y",
    "gh api --method get repos/x/y",
  ]) {
    const verdict = evaluateCommand(cmd);
    assert.equal(
      verdict.decision,
      "deny_unless_prior_grant",
      `expected deny_unless_prior_grant for: ${cmd}`,
    );
    assert.equal(verdict.rule, "allow-list");
  }
});

test("evaluateCommand handles shell constructs vs quoted characters and fd duplications", () => {
  for (const cmd of [
    "rg turn>model path",
    "rg foo > out.txt",
    "rg foo >> out.txt",
    "cat < input.txt",
    "cat << EOF",
    "echo $(whoami)",
    'echo "$(whoami)"',
    "echo `whoami`",
    'echo "`whoami`"',
    "diff <(ls a) <(ls b)",
    "tee >(cat)",
  ]) {
    const verdict = evaluateCommand(cmd);
    assert.equal(verdict.decision, "deny", `expected deny for: ${cmd}`);
    assert.equal(
      verdict.rule,
      "shell-construct",
      `expected shell-construct for: ${cmd}`,
    );
    assert.equal(
      verdict.reason,
      "Redirection and command substitution are unavailable here. Run the command without them and read its output from the tool result; create or edit files with your file tools.",
    );
  }

  for (const safeCmd of [
    "rg -F '<|turn>model'",
    'rg "foo > bar | baz" src',
    "echo '$(not_substituted)'",
    "git status 2>&1",
    "git status 1>&2",
    "git status >&2",
  ]) {
    const verdict = evaluateCommand(safeCmd);
    assert.equal(
      verdict.decision,
      "deny_unless_prior_grant",
      `expected safe verdict for: ${safeCmd}`,
    );
    assert.equal(verdict.rule, "allow-list");
  }
});

test("evaluateCommand returns tailored hints for deny_unless_prior_grant rules", () => {
  const pathVerdict = evaluateCommand("/home/u/go/bin/govulncheck -version");
  assert.equal(pathVerdict.decision, "deny_unless_prior_grant");
  assert.equal(pathVerdict.rule, "path-binary");
  assert.match(pathVerdict.reason, /govulncheck/);
  assert.match(pathVerdict.reason, /bare name/);
  assert.match(pathVerdict.reason, /instead of a path/);

  const templateVerdict = evaluateCommand(
    "docker image inspect img --format {{.Id}}",
  );
  assert.equal(templateVerdict.decision, "deny_unless_prior_grant");
  assert.equal(templateVerdict.rule, "go-template");
  assert.equal(
    templateVerdict.reason,
    "If this is denied, drop the Go template and request JSON output (for example `--format json`), then read the fields from it.",
  );

  const parenVerdict = evaluateCommand("rg -i ^(COPY|ADD) x/");
  assert.equal(parenVerdict.decision, "deny_unless_prior_grant");
  assert.equal(parenVerdict.rule, "unquoted-paren");
  assert.equal(
    parenVerdict.reason,
    "If this is denied, quote the pattern, or use your file search tool for patterns containing ( ) |.",
  );

  for (const envCmd of ["FOO=1 rg bar", "env FOO=1 rg bar"]) {
    const envVerdict = evaluateCommand(envCmd);
    assert.equal(envVerdict.decision, "deny_unless_prior_grant");
    assert.equal(envVerdict.rule, "env-prefix");
    assert.equal(
      envVerdict.reason,
      "If this is denied, the inner command is what must be allowed; run an allowed command directly without the environment prefix.",
    );
  }

  const defaultVerdict = evaluateCommand("pnpm test");
  assert.equal(defaultVerdict.decision, "deny_unless_prior_grant");
  assert.equal(defaultVerdict.rule, "allow-list");
  assert.equal(
    defaultVerdict.reason,
    "This command is not in the allow list for this environment. Use an allowed alternative (bare tool names, one simple command per call) or report it as a blocker in your handoff. Do not retry the same command.",
  );
});

test("evaluateCommand unwraps shell -c scripts and transparent wrappers (xargs, command, exec)", () => {
  for (const remoteWrapped of [
    'sh -c "git push"',
    "bash -lc 'git status && git push'",
    'zsh -c "gh pr create"',
    'dash -ec "git push origin main"',
    'ksh -c "gh run cancel 1"',
    "xargs git push",
    "xargs -n1 gh pr close",
    "xargs -0 -r -n 1 -I {} -L 1 -P 2 -d x -s 128 -t --null --no-run-if-empty --max-args=1 git push",
    "command git push",
    "exec git push",
  ]) {
    const verdict = evaluateCommand(remoteWrapped);
    assert.equal(
      verdict.decision,
      "deny",
      `expected deny for: ${remoteWrapped}`,
    );
    assert.equal(
      verdict.rule,
      "remote",
      `expected rule=remote for: ${remoteWrapped}`,
    );
  }

  const shellConstructWrapped = evaluateCommand('bash -c "rg x > out"');
  assert.equal(shellConstructWrapped.decision, "deny");
  assert.equal(shellConstructWrapped.rule, "shell-construct");

  const depthExceeded = evaluateCommand(
    `sh -c 'sh -c "sh -c \\"sh -c true\\""'`,
  );
  assert.equal(depthExceeded.decision, "deny");
  assert.equal(depthExceeded.rule, "shell-construct");

  const safeWrapped = evaluateCommand('bash -c "git status"');
  assert.equal(safeWrapped.decision, "deny_unless_prior_grant");
  assert.equal(safeWrapped.rule, "allow-list");
});

test("guardHookCommand formats env-gated POSIX sh command and quotes paths with spaces and single quotes", () => {
  assert.equal(GUARD_ENV, "AGY_ORCH_MCP_GUARD");
  assert.equal(GUARD_HOOK_NAME, "agy-orch-mcp-guard");
  assert.equal(
    defaultHooksPath("/tmp/fake-home"),
    path.join("/tmp/fake-home", ".gemini", "config", "hooks.json"),
  );

  const cmd = guardHookCommand(
    "/usr/local/bin/node",
    "/opt/my app/it's/guard-hook.js",
  );
  assert.equal(
    cmd,
    `if [ -n "$AGY_ORCH_MCP_GUARD" ]; then exec '/usr/local/bin/node' '/opt/my app/it'\\''s/guard-hook.js'; else cat >/dev/null; fi`,
  );
});

test("installGuard, guardStatus, and uninstallGuard manage hooks.json safely with backups", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "guard-hooks-test-"));
  try {
    const cmd1 = guardHookCommand(process.execPath, hookScriptPath);
    const cmd2 = guardHookCommand(process.execPath, "/other/guard-hook.js");

    const missingHooksPath = path.join(
      tempDir,
      "fresh",
      "config",
      "hooks.json",
    );
    assert.equal(guardStatus(missingHooksPath, cmd1), "missing");
    const firstInstall = installGuard(missingHooksPath, cmd1);
    assert.deepEqual(firstInstall, { status: "installed" });
    assert.equal(statSync(missingHooksPath).mode & 0o777, 0o644);
    assert.equal(guardStatus(missingHooksPath, cmd1), "installed");

    const statBefore = statSync(missingHooksPath);
    const secondInstall = installGuard(missingHooksPath, cmd1);
    assert.deepEqual(secondInstall, { status: "unchanged" });
    const statAfter = statSync(missingHooksPath);
    assert.equal(statAfter.ino, statBefore.ino);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
    assert.equal(
      readdirSync(path.dirname(missingHooksPath)).filter((f) =>
        f.endsWith(".bak"),
      ).length,
      0,
    );

    assert.equal(guardStatus(missingHooksPath, cmd2), "outdated");

    const sharedHooksPath = path.join(tempDir, "shared", "hooks.json");
    mkdirSync(path.dirname(sharedHooksPath), { recursive: true });
    const existingContent = JSON.stringify(
      {
        "other-user-hook": {
          PreToolUse: [
            {
              matcher: "write_file",
              hooks: [{ type: "command", command: "echo ok", timeout: 5 }],
            },
          ],
        },
      },
      null,
      2,
    );
    writeFileSync(sharedHooksPath, existingContent, {
      encoding: "utf8",
      mode: 0o600,
    });
    assert.equal(guardStatus(sharedHooksPath, cmd1), "missing");

    const sharedInstall = installGuard(sharedHooksPath, cmd1);
    assert.equal(sharedInstall.status, "installed");
    assert.ok(sharedInstall.backupPath);
    assert.match(
      path.basename(sharedInstall.backupPath),
      /^hooks\.json\.agy-orch-mcp-\d{8}T\d{6}Z\.bak$/,
    );
    assert.equal(
      readFileSync(sharedInstall.backupPath, "utf8"),
      existingContent,
    );
    assert.equal(statSync(sharedHooksPath).mode & 0o777, 0o600);

    const merged = JSON.parse(readFileSync(sharedHooksPath, "utf8"));
    assert.deepEqual(merged["other-user-hook"], {
      PreToolUse: [
        {
          matcher: "write_file",
          hooks: [{ type: "command", command: "echo ok", timeout: 5 }],
        },
      ],
    });
    assert.deepEqual(merged[GUARD_HOOK_NAME], {
      PreToolUse: [
        {
          matcher: "run_command",
          hooks: [{ type: "command", command: cmd1, timeout: 10 }],
        },
      ],
    });

    const removed = uninstallGuard(sharedHooksPath);
    assert.equal(removed, true);
    assert.equal(guardStatus(sharedHooksPath, cmd1), "missing");
    const afterUninstall = JSON.parse(readFileSync(sharedHooksPath, "utf8"));
    assert.equal(GUARD_HOOK_NAME in afterUninstall, false);
    assert.ok("other-user-hook" in afterUninstall);
    assert.equal(uninstallGuard(sharedHooksPath), false);

    const corruptHooksPath = path.join(tempDir, "corrupt", "hooks.json");
    mkdirSync(path.dirname(corruptHooksPath), { recursive: true });
    writeFileSync(corruptHooksPath, "{invalid json", "utf8");
    assert.throws(() => installGuard(corruptHooksPath, cmd1));
    assert.equal(readFileSync(corruptHooksPath, "utf8"), "{invalid json");
    assert.equal(
      readdirSync(path.dirname(corruptHooksPath)).filter((f) =>
        f.endsWith(".bak"),
      ).length,
      0,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("guardHookCommand end-to-end via sh -c enforces when AGY_ORCH_MCP_GUARD=1 and abstains when unset", () => {
  const shCommand = guardHookCommand(process.execPath, hookScriptPath);
  const stdinPayload = JSON.stringify({
    toolCall: {
      name: "run_command",
      args: { CommandLine: "git push origin main" },
    },
  });

  const enforcedEnv = { ...process.env, [GUARD_ENV]: "1" };
  const enforcedRes = spawnSync("sh", ["-c", shCommand], {
    input: stdinPayload,
    encoding: "utf8",
    env: enforcedEnv,
  });
  assert.equal(enforcedRes.status, 0);
  const enforcedJson = JSON.parse(enforcedRes.stdout.trim());
  assert.deepEqual(Object.keys(enforcedJson).sort(), ["decision", "reason"]);
  assert.equal(enforcedJson.decision, "deny");

  const abstainedEnv = { ...process.env };
  delete abstainedEnv[GUARD_ENV];
  const abstainedRes = spawnSync("sh", ["-c", shCommand], {
    input: stdinPayload,
    encoding: "utf8",
    env: abstainedEnv,
  });
  assert.equal(abstainedRes.status, 0);
  assert.equal(abstainedRes.stdout, "");
});

test("guard-hook CLI processes stdin end-to-end and omits rule key", () => {
  const runHook = (input) =>
    spawnSync(process.execPath, [hookScriptPath], {
      input,
      encoding: "utf8",
    });

  const denyRes = runHook(
    JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: "git push origin main" },
      },
    }),
  );
  assert.equal(denyRes.status, 0);
  const denyJson = JSON.parse(denyRes.stdout.trim());
  assert.deepEqual(Object.keys(denyJson).sort(), ["decision", "reason"]);
  assert.equal(denyJson.decision, "deny");

  const encodedRes = runHook(
    JSON.stringify({
      toolCall: {
        name: "run_command",
        args: { CommandLine: JSON.stringify("rg -i ^(COPY|ADD) x/") },
      },
    }),
  );
  assert.equal(encodedRes.status, 0);
  const encodedJson = JSON.parse(encodedRes.stdout.trim());
  assert.deepEqual(Object.keys(encodedJson).sort(), ["decision", "reason"]);
  assert.equal(encodedJson.decision, "deny_unless_prior_grant");
  assert.match(encodedJson.reason, /quote the pattern/);

  const nonRunRes = runHook(
    JSON.stringify({
      toolCall: {
        name: "read_file",
        args: { Path: "/tmp/x" },
      },
    }),
  );
  assert.equal(nonRunRes.status, 0);
  assert.deepEqual(JSON.parse(nonRunRes.stdout.trim()), {
    decision: "deny_unless_prior_grant",
    reason: "guard hook: no command line",
  });

  const invalidRes = runHook("{not valid json");
  assert.equal(invalidRes.status, 0);
  const invalidJson = JSON.parse(invalidRes.stdout.trim());
  assert.equal(invalidJson.decision, "deny_unless_prior_grant");
  assert.match(invalidJson.reason, /^guard hook error: /);
});
