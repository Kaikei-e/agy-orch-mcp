#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { ProcessRunner } from "./process.js";
import { createServer } from "./server.js";
import { version } from "./version.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(
      `agy-mcp ${version}\n\nUsage: agy-mcp [--help | --version | --doctor]\n\nWith no arguments, serves MCP over stdio.\n--doctor checks the workspace and CLI flags without starting a model turn.\n\nSettings: AGY_MCP_BIN, AGY_MCP_DEFAULT_WORKSPACE, AGY_MCP_ALLOWED_ROOT,\nAGY_MCP_DEFAULT_MODEL, AGY_MCP_MAX_CONCURRENT (default 4, range 1-32),\nAGY_MCP_MAX_OUTPUT_CHARS, AGY_MCP_MAX_BUFFER_BYTES, AGY_MCP_ALLOW_FULL_AUTONOMY.\nSee https://github.com/Kaikei-e/agy-mcp for setup.\n`,
    );
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (args.length && (args.length !== 1 || args[0] !== "--doctor"))
    throw new Error("Unknown arguments. Use agy-mcp --help.");
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
      process.stdout.write(
        `Workspace: ${config.defaultWorkspace}\nAllowed root: ${config.allowedRoot ?? "unrestricted"}\nDefault model: ${config.defaultModel ?? "CLI default"}\nMax concurrent CLI processes: ${config.maxConcurrent}\nFull autonomy: ${config.allowFullAutonomy ? "enabled" : "disabled"}\nCLI compatibility checks passed. Authentication and workspace trust require an interactive agy session.\n`,
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
        console.error(`agy-mcp: ${error.message}`);
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
    `agy-mcp: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
