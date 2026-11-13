import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { GUARD_HOOK_NAME, guardHookCommand } from "../dist/guard.js";

const root = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const cli = path.join(root, "dist", "index.js");
const guardHookScript = path.join(root, "dist", "guard-hook.js");
const fixture = path.join(root, "test", "fixtures", "agy.mjs");

function runCli(args, homeDir, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      AGY_MCP_BIN: fixture,
      AGY_MCP_DEFAULT_WORKSPACE: root,
      ...extraEnv,
    },
  });
}

test("CLI --help includes guard flags and new environment variables", (t) => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "agy-cli-help-"));
  t.after(() => rmSync(tempHome, { recursive: true, force: true }));

  const res = runCli(["--help"], tempHome);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--install-guard/);
  assert.match(res.stdout, /--uninstall-guard/);
  assert.match(res.stdout, /--doctor/);
  assert.match(
    res.stdout,
    /AGY_MCP_DEFAULT_MODEL \(default gemini-4-hydrogen-high\)/,
  );
  assert.match(
    res.stdout,
    /AGY_MCP_SUBAGENT_MODEL \(default gemini-4-argon-medium\)/,
  );
  assert.match(res.stdout, /AGY_MCP_FAST_MODEL/);
  assert.match(
    res.stdout,
    /AGY_MCP_REASONING_MODEL \(default gemini-4-carbon-high\)/,
  );
  assert.match(res.stdout, /AGY_MCP_GUARD/);
  assert.match(res.stdout, /AGY_MCP_ENV_ISOLATION/);
  assert.match(res.stdout, /AGY_MCP_ENV_ROOT/);
  assert.match(res.stdout, /AGY_MCP_TASKS/);
});

test("CLI --install-guard and --uninstall-guard manage hooks.json and print status and backup path", (t) => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "agy-cli-guard-"));
  t.after(() => rmSync(tempHome, { recursive: true, force: true }));

  const hooksPath = path.join(tempHome, ".gemini", "config", "hooks.json");
  const expectedCommand = guardHookCommand(process.execPath, guardHookScript);

  // 1. Fresh install
  const firstInstall = runCli(["--install-guard"], tempHome);
  assert.equal(firstInstall.status, 0);
  assert.match(firstInstall.stdout, /installed/);
  assert.equal(existsSync(hooksPath), true);

  const parsedHooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.deepEqual(parsedHooks[GUARD_HOOK_NAME], {
    SessionStart: [
      {
        type: "command",
        command: expectedCommand,
        timeout: 10,
      },
    ],
    PreToolUse: [
      {
        matcher: "run_command",
        hooks: [
          {
            type: "command",
            command: expectedCommand,
            timeout: 10,
          },
        ],
      },
      {
        matcher: "swarm",
        hooks: [
          {
            type: "command",
            command: expectedCommand,
            timeout: 10,
          },
        ],
      },
      {
        matcher: "invoke_subagent",
        hooks: [
          {
            type: "command",
            command: expectedCommand,
            timeout: 10,
          },
        ],
      },
    ],
  });

  // 2. Idempotent re-install prints unchanged
  const secondInstall = runCli(["--install-guard"], tempHome);
  assert.equal(secondInstall.status, 0);
  assert.match(secondInstall.stdout, /unchanged/);

  // 3. Updating an existing hooks.json creates a backup and prints the backup path
  writeFileSync(
    hooksPath,
    JSON.stringify(
      {
        "other-hook": { PreToolUse: [] },
        [GUARD_HOOK_NAME]: {
          PreToolUse: [
            {
              matcher: "run_command",
              hooks: [{ type: "command", command: "outdated", timeout: 10 }],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  const updateInstall = runCli(["--install-guard"], tempHome);
  assert.equal(updateInstall.status, 0);
  assert.match(updateInstall.stdout, /installed/);
  const backupMatch =
    /(?:backup[:\s]+)([^\s)]+\.agy-orch-mcp-\d{8}T\d{6}Z\.bak)/i.exec(
      updateInstall.stdout,
    );
  assert.ok(
    backupMatch?.[1],
    `Expected backup path in stdout, got: ${updateInstall.stdout}`,
  );
  assert.equal(existsSync(backupMatch[1]), true);

  // 4. Uninstall removes the guard entry while preserving other hooks
  const uninstallRes = runCli(["--uninstall-guard"], tempHome);
  assert.equal(uninstallRes.status, 0);
  assert.match(uninstallRes.stdout, /removed|uninstalled/i);
  const afterUninstall = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.equal(GUARD_HOOK_NAME in afterUninstall, false);
  assert.ok("other-hook" in afterUninstall);
});

test("CLI --doctor reports guard status (missing, outdated, installed) and permissions audit findings", (t) => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "agy-cli-doctor-"));
  t.after(() => rmSync(tempHome, { recursive: true, force: true }));

  const hooksPath = path.join(tempHome, ".gemini", "config", "hooks.json");
  const settingsPath = path.join(
    tempHome,
    ".gemini",
    "antigravity-cli",
    "settings.json",
  );

  // 1. Missing hooks.json and unreadable (missing) settings.json
  const missingDoc = runCli(["--doctor"], tempHome);
  assert.equal(missingDoc.status, 0);
  assert.match(missingDoc.stdout, /missing/i);
  assert.match(missingDoc.stdout, /--install-guard/);
  assert.match(missingDoc.stdout, /settings\.json.*not readable|unreadable/i);

  // 2. Outdated hooks.json and settings.json with high, medium, and low findings
  mkdirSync(path.dirname(hooksPath), { recursive: true });
  writeFileSync(
    hooksPath,
    JSON.stringify({
      [GUARD_HOOK_NAME]: {
        PreToolUse: [
          {
            matcher: "run_command",
            hooks: [{ type: "command", command: "old-cmd", timeout: 10 }],
          },
        ],
      },
    }),
  );
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      permissions: {
        allow: [
          "command(git push)",
          "command(gh pr create)",
          "command(cd pkg && pnpm test)",
          "command(pnpm test)",
          "command(pnpm test)",
        ],
      },
    }),
  );

  const findingsDoc = runCli(["--doctor"], tempHome);
  assert.equal(findingsDoc.status, 0);
  assert.match(findingsDoc.stdout, /outdated/i);
  assert.match(findingsDoc.stdout, /--install-guard/);
  assert.match(findingsDoc.stdout, /2 high/i);
  assert.match(findingsDoc.stdout, /1 medium/i);
  assert.match(findingsDoc.stdout, /2 low/i);
  assert.match(findingsDoc.stdout, /command\(git push\)/);
  assert.match(findingsDoc.stdout, /command\(gh pr create\)/);

  // 3. After --install-guard and clean settings.json
  runCli(["--install-guard"], tempHome);
  writeFileSync(
    settingsPath,
    JSON.stringify({
      permissions: {
        allow: ["command(pnpm test)"],
        deny: ["command(git push)"],
      },
    }),
  );
  const cleanDoc = runCli(["--doctor"], tempHome);
  assert.equal(cleanDoc.status, 0);
  assert.match(cleanDoc.stdout, /Default model:\s*gemini-4-hydrogen-high/);
  assert.match(cleanDoc.stdout, /Subagent model:\s*gemini-4-argon-medium/);
  assert.match(cleanDoc.stdout, /Fast worker model:\s*gemini-4-argon-medium/);
  assert.match(
    cleanDoc.stdout,
    /Reasoning worker model:\s*gemini-4-carbon-high/,
  );
  assert.match(cleanDoc.stdout, /Guard hook:\s*installed/i);
  assert.match(cleanDoc.stdout, /0 high.*0 medium.*0 low/i);
});
