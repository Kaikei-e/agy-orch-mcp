import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  TaskRegistry,
  installTasksExtension,
  runToolOrTask,
} from "../../dist/tasks.js";

const abortedKeys = new Set();

function createFixtureServer() {
  const registry = new TaskRegistry({ pollIntervalMs: 500 });
  const server = new McpServer({
    name: "tasks-fixture-server",
    version: "1.0.0",
  });
  installTasksExtension(server, registry);

  server.registerTool(
    "slow_tool",
    {
      description: "Fixture tool supporting ok, fail, hang, and check_abort",
      inputSchema: z.object({
        mode: z.enum(["ok", "fail", "hang", "check_abort"]).default("ok"),
        value: z.string().default("test"),
        delayMs: z.number().int().min(0).max(5_000).default(50),
      }),
    },
    (args, context) => {
      if (args.mode === "check_abort") {
        return {
          content: [
            {
              type: "text",
              text: abortedKeys.has(args.value)
                ? "aborted:true"
                : "aborted:false",
            },
          ],
        };
      }
      return runToolOrTask(
        server,
        registry,
        context,
        async (signal, setStatus) => {
          setStatus(`working:${args.value}`);
          if (args.mode === "fail") {
            await delay(10);
            throw new Error(`boom:${args.value}`);
          }
          if (args.mode === "hang") {
            await new Promise((resolve) => {
              if (signal.aborted) {
                abortedKeys.add(args.value);
                resolve();
                return;
              }
              signal.addEventListener(
                "abort",
                () => {
                  abortedKeys.add(args.value);
                  resolve();
                },
                { once: true },
              );
            });
            return {
              content: [{ type: "text", text: `aborted:${args.value}` }],
            };
          }
          await delay(args.delayMs);
          return {
            content: [{ type: "text", text: `done:${args.value}` }],
          };
        },
        `starting:${args.value}`,
      );
    },
  );

  return server;
}

serveStdio(() => createFixtureServer());
