#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(process.env.AGY_MCP_DEFAULT_WORKSPACE ?? root);
const server = path.join(root, "dist", "index.js");

function structured(result) {
  if (result?.isError) {
    const detail =
      result.structuredContent ?? result.content?.[0]?.text ?? "tool failed";
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail),
    );
  }
  if (
    result?.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return result.structuredContent;
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("tool returned no text content");
  try {
    return JSON.parse(text);
  } catch {
    return { response: text };
  }
}

function responseOf(result) {
  return typeof result?.response === "string" ? result.response : "";
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  cwd: root,
  // Probe output must stay concise even when agy emits authentication diagnostics.
  stderr: "pipe",
  env: {
    ...process.env,
    AGY_MCP_DEFAULT_WORKSPACE: workspace,
  },
});
const client = new Client({ name: "agy-orch-mcp-probe", version: "0.1.0" });
transport.stderr?.on("data", () => {});
const memoryToken = `agy-orch-mcp-${Math.random().toString(36).slice(2, 10)}`;

try {
  await client.connect(transport);
  const models = structured(
    await client.callTool(
      { name: "antigravity_models", arguments: {} },
      { timeout: 120_000 },
    ),
  );
  const modelLines = String(models.response ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const first = structured(
    await client.callTool(
      {
        name: "antigravity_run",
        arguments: {
          prompt: `Reply with exactly pong. Do not use tools and do not read or modify files. Remember this token for my next turn: ${memoryToken}`,
          workspace,
          mode: "plan",
          autonomy: "safe",
          timeout_seconds: 300,
        },
      },
      { timeout: 360_000 },
    ),
  );
  if (first.ok !== true || first.status !== "SUCCESS") {
    throw new Error(`initial turn failed: ${first.status ?? "unknown"}`);
  }
  if (responseOf(first).trim() !== "pong")
    throw new Error("initial turn did not reply exactly pong");
  if (!first.conversation_id)
    throw new Error("agy did not return a conversation_id");

  const follow = structured(
    await client.callTool(
      {
        name: "antigravity_continue",
        arguments: {
          prompt:
            "Reply with only the token I asked you to remember in my previous turn. Do not use tools or read or modify files.",
          conversation_id: first.conversation_id,
          workspace,
          mode: "plan",
          autonomy: "safe",
          timeout_seconds: 300,
        },
      },
      { timeout: 360_000 },
    ),
  );
  if (follow.ok !== true || follow.status !== "SUCCESS") {
    throw new Error(`continuation failed: ${follow.status ?? "unknown"}`);
  }
  if (responseOf(follow).trim() !== memoryToken)
    throw new Error("continuation did not recall the memory token");

  process.stdout.write(
    `${JSON.stringify({
      models: modelLines.length,
      initial: {
        status: first.status,
        conversation_id: Boolean(first.conversation_id),
        response_chars: responseOf(first).length,
      },
      continuation: {
        status: follow.status,
        response_chars: responseOf(follow).length,
        recalled_token: true,
      },
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `agy-orch-mcp probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
