import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const server = path.join(root, "dist", "index.js");
const fixture = path.join(root, "test", "fixtures", "agy.mjs");

function clientPair(extraEnv = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-mcp-fetch-test-"));
  const env = {
    ...process.env,
    AGY_MCP_BIN: fixture,
    AGY_MCP_DEFAULT_WORKSPACE: root,
    AGY_MCP_ALLOWED_ROOT: root,
    AGY_MCP_MAX_CONCURRENT: "4",
    AGY_MCP_ENABLE_FETCH: "true",
    AGY_ORCH_STORAGE_DIR: path.join(tmpDir, "storage"),
  };
  Object.assign(env, extraEnv);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: root,
    stderr: "pipe",
    env,
  });
  const client = new Client(
    { name: "agy-orch-mcp-fetch-integration-test", version: "1.0.0" },
    {},
  );
  return { client, transport, tmpDir };
}

async function closePair({ client, transport, tmpDir }) {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

function valueOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object")
    return result.structuredContent;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "MCP result has no text content");
  return JSON.parse(text);
}

test("antigravity_fetch tool is exposed when AGY_MCP_ENABLE_FETCH=true and retrieves digest artifacts", async (t) => {
  const pair = clientPair();
  t.after(() => closePair(pair));
  await pair.client.connect(pair.transport);

  const tools = (await pair.client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  assert.ok(
    tools.includes("antigravity_fetch"),
    "antigravity_fetch must be exposed when enabled",
  );
  assert.ok(tools.includes("antigravity_run"));
  assert.ok(tools.includes("antigravity_continue"));
  assert.ok(tools.includes("antigravity_models"));

  // Run a turn with return_mode="digest"
  const runCall = await pair.client.callTool({
    name: "antigravity_run",
    arguments: {
      prompt: "test task for digest and artifact preservation",
      workspace: root,
      return_mode: "digest",
    },
  });

  const runData = valueOf(runCall);
  assert.ok(runData.run_id, "run_id must be returned");
  assert.ok(runData.recovery_pointer, "recovery_pointer must be returned");
  assert.ok(
    runData.artifacts && runData.artifacts.length > 0,
    "artifacts list must be returned",
  );

  const runId = runData.run_id;

  // Use antigravity_fetch to retrieve the stdout artifact
  const fetchCall = await pair.client.callTool({
    name: "antigravity_fetch",
    arguments: {
      schema_version: "1",
      run_id: runId,
      selector: "manifest",
    },
  });

  assert.equal(fetchCall.isError, false);
  const fetchData = valueOf(fetchCall);
  assert.equal(fetchData.schema_version, "1");
  assert.equal(fetchData.run_id, runId);
  assert.equal(fetchData.artifact.kind, "manifest");
  assert.ok(fetchData.content.includes(runId));
});
