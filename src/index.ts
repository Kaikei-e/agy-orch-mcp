#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_MODEL, DEFAULT_SUBAGENT_MODEL, loadConfig } from "./config.js";
import {
  defaultHooksPath,
  guardHookCommand,
  guardStatus,
  installGuard,
  uninstallGuard,
} from "./guard.js";
import { ProcessRunner } from "./process.js";
import { createServer } from "./server.js";
import { auditPermissions } from "./settings-audit.js";
import { version } from "./version.js";

const guardHookScriptPath = fileURLToPath(
  new URL("./guard-hook.js", import.meta.url),
);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(
      `agy-orch-mcp ${version}\n\nUsage: agy-orch-mcp [--help | --version | --doctor | --install-guard | --uninstall-guard]\n\nWith no arguments, serves MCP over stdio.\n--doctor checks the workspace, CLI flags, guard hook, and permission settings without starting a model turn.\n--install-guard installs or updates the command guard hook in ~/.gemini/config/hooks.json.\n--uninstall-guard removes the command guard hook from ~/.gemini/config/hooks.json.\n\nSettings: AGY_MCP_BIN, AGY_MCP_DEFAULT_WORKSPACE, AGY_MCP_ALLOWED_ROOT,\nAGY_MCP_DEFAULT_MODEL (default ${DEFAULT_MODEL}), AGY_MCP_SUBAGENT_MODEL (default ${DEFAULT_SUBAGENT_MODEL}),\nAGY_MCP_FAST_MODEL (default AGY_MCP_SUBAGENT_MODEL), AGY_MCP_REASONING_MODEL (default AGY_MCP_DEFAULT_MODEL),\nAGY_MCP_MAX_CONCURRENT (default 8, range 1-32),\nAGY_MCP_MAX_OUTPUT_CHARS, AGY_MCP_MAX_BUFFER_BYTES, AGY_MCP_CONTEXT_ROTATE_TOKENS, AGY_MCP_ALLOW_FULL_AUTONOMY,\nAGY_MCP_GUARD, AGY_MCP_ENV_ISOLATION, AGY_MCP_ENV_ROOT, AGY_MCP_TASKS.\nSee https://github.com/Kaikei-e/agy-orch-mcp for setup.\n`,
    );
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--install-guard") {
    const hooksPath = defaultHooksPath();
    const result = installGuard(
      hooksPath,
      guardHookCommand(process.execPath, guardHookScriptPath),
    );
    process.stdout.write(
      `Guard hook: ${result.status} (${hooksPath})${result.backupPath ? ` (backup: ${result.backupPath})` : ""}\n`,
    );
    return;
  }
  if (args.length === 1 && args[0] === "--uninstall-guard") {
    const hooksPath = defaultHooksPath();
    const removed = uninstallGuard(hooksPath);
    process.stdout.write(
      `Guard hook: ${removed ? "removed" : "not installed"} (${hooksPath})\n`,
    );
    return;
  }
  if (args.length && (args.length !== 1 || args[0] !== "--doctor"))
    throw new Error("Unknown arguments. Use agy-orch-mcp --help.");
  const config = loadConfig();
  const runner = new ProcessRunner(config.maxConcurrent);
  if (args[0] === "--doctor") {
    try {
      for (const flag of ["--version", "--help"]) {
        const result = await runner.run({
          bin: config.bin,
          args: [flag],
          cwd: config.defaultWorkspace,
          timeoutMs: 10_000,
          maxBufferBytes: config.maxBufferBytes,
        });
        if (result.failure || result.exitCode !== 0)
          throw new Error(
            result.error ?? `agy ${flag} failed: ${result.stderr}`,
          );
        if (flag === "--version")
          process.stdout.write(`agy version: ${result.stdout.trim()}\n`);
        else
          for (const required of [
            "--output-format",
            "--print-timeout",
            "--disable-slash-commands",
            "--conversation",
            "--mode",
            "--sandbox",
          ]) {
            if (!(result.stdout + result.stderr).includes(required))
              throw new Error(
                `Installed agy is missing ${required}; update Antigravity CLI.`,
              );
          }
      }
      const hooksPath = defaultHooksPath();
      const gStatus = guardStatus(
        hooksPath,
        guardHookCommand(process.execPath, guardHookScriptPath),
      );
      const guardLine =
        gStatus === "installed"
          ? `Guard hook: installed (${hooksPath})`
          : `Guard hook: ${gStatus} (${hooksPath}; run \`agy-orch-mcp --install-guard\` to fix)`;

      const settingsPath = path.join(
        homedir(),
        ".gemini",
        "antigravity-cli",
        "settings.json",
      );
      let auditLines: string;
      try {
        const parsedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
        const findings = auditPermissions(parsedSettings);
        const highFindings = findings.filter((f) => f.severity === "high");
        const mediumCount = findings.filter(
          (f) => f.severity === "medium",
        ).length;
        const lowCount = findings.filter((f) => f.severity === "low").length;
        const lines = [
          `Permissions audit (${settingsPath}): ${highFindings.length} high, ${mediumCount} medium, ${lowCount} low`,
          ...highFindings.map((f) => `  [HIGH] ${f.rule}: ${f.reason}`),
        ];
        auditLines = lines.join("\n");
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        auditLines =
          code === "ENOENT"
            ? `Permissions audit: ${settingsPath} is not readable (file not found)`
            : `Permissions audit: ${settingsPath} is not readable (${err instanceof Error ? err.message : String(err)})`;
      }

      process.stdout.write(
        `Workspace: ${config.defaultWorkspace}\nAllowed root: ${config.allowedRoot ?? "unrestricted"}\nDefault model: ${config.defaultModel ?? "CLI default"}\nSubagent model: ${config.subagentModel ?? "CLI default"}\nFast worker model: ${config.fastModel ?? "CLI default"}\nMax concurrent CLI processes: ${config.maxConcurrent}\nFull autonomy: ${config.allowFullAutonomy ? "enabled" : "disabled"}\n${guardLine}\n${auditLines}\nCLI compatibility checks passed. Authentication and workspace trust require an interactive agy session.\n`,
      );
    } finally {
      await runner.close();
    }
    return;
  }

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (code = 0): Promise<void> => {
    shuttingDown ??= (async () => {
      process.exitCode = code;
      await runner.close();
      await handle.close();
      process.stdin.pause();
    })();
    return shuttingDown;
  };
  const handle = serveStdio(
    () => {
      const server = createServer(config, runner);
      server.server.onclose = () => {
        void shutdown();
      };
      return server;
    },
    {
      onerror: (error) => {
        console.error(`agy-orch-mcp: ${error.message}`);
      },
    },
  );
  process.once("SIGINT", () => {
    void shutdown(130);
  });
  process.once("SIGTERM", () => {
    void shutdown(143);
  });
  process.stdin.once("end", () => {
    void shutdown();
  });
  process.stdin.once("error", () => {
    void shutdown(1);
  });
}

main().catch((error: unknown) => {
  console.error(
    `agy-orch-mcp: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
