#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const prompt = value("-p");
const id = args.includes("--conversation")
  ? value("--conversation")
  : randomUUID();
const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);
if (args[0] === "--version") {
  console.log("1.2.6-test");
} else if (args[0] === "--help") {
  console.log(
    "--output-format --print-timeout --disable-slash-commands --conversation --mode --sandbox",
  );
} else if (args[0] === "models") {
  console.log("test-model\tTest Model");
} else if (prompt === "hang" || prompt === "tree") {
  process.on("SIGTERM", () => {});
  if (prompt === "tree") {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout.once("data", () =>
      writeFileSync(process.env.TEST_PID_FILE, String(child.pid)),
    );
  } else if (process.env.TEST_PID_FILE)
    writeFileSync(process.env.TEST_PID_FILE, String(process.pid));
  emit({ event: "init", conversation_id: id });
  setInterval(() => {}, 1_000);
} else if (prompt === "overflow") {
  process.stdout.write("x".repeat(100_000));
  setInterval(() => {}, 1_000);
} else if (prompt === "denied-hang") {
  process.on("SIGTERM", () => {});
  emit({ event: "init", conversation_id: id });
  emit({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "denied but hanging",
      conversation_id: id,
      denied_actions: [{ tool: "write_to_file" }],
    },
  });
  setInterval(() => {}, 1_000);
} else if (prompt === "denied-command") {
  // Mirrors agy, which records the rejected command line only in the transcript.
  const logs = path.join(
    os.homedir(),
    ".gemini/antigravity-cli/brain",
    id,
    ".system_generated/logs",
  );
  mkdirSync(logs, { recursive: true });
  const denial = (command, createdAt) =>
    JSON.stringify({
      step_index: 1,
      type: "GENERIC",
      status: "ERROR",
      created_at: createdAt,
      error: `permission check failed for unsandboxed "${command}": user denied permission to run command:\n${command}\nDo not attempt to circumvent this denial.`,
    });
  writeFileSync(
    path.join(logs, "transcript.jsonl"),
    [
      denial("rm -rf stale", "2000-01-01T00:00:00Z"),
      denial("git ls-tree HEAD", new Date().toISOString()),
      "not json",
    ].join("\n") + "\n",
  );
  emit({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "",
      conversation_id: id,
      denied_actions: [{ action: "command", display_name: "RunCommand" }],
    },
  });
} else if (prompt === "malformed") {
  console.log("Authentication required");
} else {
  emit({ event: "init", conversation_id: id });
  emit({
    event: "step_update",
    step_update: {
      step_type: "agent_response",
      text_delta: "not forwarded as progress",
    },
  });
  // A file barrier proves subprocesses overlap without relying on timing.
  if (prompt.startsWith("wait:")) {
    const barrier = prompt.slice("wait:".length);
    writeFileSync(`${barrier}.ready`, String(process.pid));
    while (!existsSync(`${barrier}.release`)) await delay(20);
  }
  const result = {
    status: prompt === "error" ? "ERROR" : "SUCCESS",
    response:
      prompt === "empty" || prompt === "denied-empty"
        ? ""
        : prompt === "large"
          ? "語".repeat(80_000)
          : JSON.stringify({
              prompt,
              argv: args,
              cwd: process.cwd(),
              stdinIsTTY: Boolean(process.stdin.isTTY),
            }),
    conversation_id: id,
    duration_seconds: 0.01,
    usage: { total_tokens: 42 },
    ...(prompt === "error" ? { error: { message: "Model unavailable" } } : {}),
    ...(prompt === "denied" || prompt === "denied-empty"
      ? { denied_actions: [{ tool: "write_to_file" }] }
      : {}),
  };
  if (prompt === "stderr") process.stderr.write("diagnostic ".repeat(1_000));
  emit({ event: "result", result });
  // A diagnostic after the result must not replace it.
  emit({ event: "log", message: "done" });
  if (prompt === "nonzero" || prompt === "stderr") process.exitCode = 2;
}
