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
  if (prompt === "hang" && value("--print-timeout") === "1s") {
    await delay(50);
    emit({
      event: "result",
      result: {
        conversation_id: id,
        status: "ERROR",
        response: "",
        error:
          "print timeout after 1s with the turn still in progress; the response is partial",
        finished_reason: "print_timeout",
      },
    });
    process.exit(3);
  }
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
} else if (prompt === "ledger") {
  emit({ event: "init", conversation_id: id });
  emit({
    event: "step_update",
    step_update: {
      conversation_id: id,
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        thinking_tokens: 10,
        cache_read_tokens: 0,
        total_tokens: 150,
      },
    },
  });
  emit({
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "echo ok" },
      },
    },
  });
  emit({
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 0.02,
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "echo ok" },
        output: "Command exited with code 0.\n\nCommand output:\nok\r\n",
      },
    },
  });
  emit({
    event: "step_update",
    step_update: {
      step_index: 3,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "ls /nope" },
      },
    },
  });
  emit({
    event: "step_update",
    step_update: {
      step_index: 3,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 0.07,
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "ls /nope" },
        output:
          "Command exited with code 1.\n\nCommand output:\nls: cannot access '/nope': No such file or directory\r\n",
      },
    },
  });
  emit({
    event: "step_update",
    step_update: {
      step_index: 4,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "go -C alt-backend/app test ./..." },
      },
    },
  });
  emit({
    event: "step_update",
    step_update: {
      step_index: 4,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 0.5,
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "go -C alt-backend/app test ./..." },
        output: `Tool is running as a background task with task id: ${id}/task-213\nTask Description: go -C alt-backend/app test ./...\nTask logs are available at: file:///tmp/task-213.log`,
      },
    },
  });
  emit({
    event: "result",
    result: {
      conversation_id: id,
      status: "SUCCESS",
      response: "ledger complete",
      duration_seconds: 0.6,
      usage: { total_tokens: 150 },
    },
  });
} else if (prompt === "denied-tail") {
  emit({ event: "init", conversation_id: id });
  emit({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "rm -rf /tmp/nope" },
      },
    },
  });
  emit({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 0.01,
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "rm -rf /tmp/nope" },
      },
    },
  });
  emit({
    event: "result",
    result: {
      conversation_id: id,
      status: "SUCCESS",
      response: "",
      duration_seconds: 0.1,
      denied_actions: [{ action: "command", display_name: "RunCommand" }],
    },
  });
} else if (prompt === "print-timeout") {
  emit({ event: "init", conversation_id: id });
  emit({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "sleep 40" },
      },
    },
  });
  emit({
    event: "result",
    result: {
      conversation_id: id,
      status: "ERROR",
      response: "",
      error: `print timeout after 15s with the turn still in progress; the response is partial; terminated ${id}/task-2 (sleep 40)`,
      finished_reason: "print_timeout",
      duration_seconds: 15,
      usage: { total_tokens: 95 },
    },
  });
  process.stderr.write(
    `AGY_ERROR: ${JSON.stringify({
      short_error: "print timeout",
      status: "DEADLINE_EXCEEDED",
      retryable: false,
      reason: "print_timeout",
      tasks: [
        {
          id: `${id}/task-2`,
          description: "sleep 40",
          log_uri: "file:///tmp/task-2.log",
        },
      ],
    })}\n`,
  );
  process.exitCode = 3;
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
          : prompt === "handoff-ok"
            ? JSON.stringify({
                summary: "completed task",
                changes: [{ path: "src/agy.ts", change: "wired run path" }],
                verification: [
                  { command: "pnpm test", outcome: "pass", detail: "green" },
                ],
                facts: ["fact-1"],
                side_effects: [],
                blockers: [],
              })
            : JSON.stringify({
                prompt,
                argv: args,
                cwd: process.cwd(),
                stdinIsTTY: Boolean(process.stdin.isTTY),
                env: {
                  AGY_ORCH_MCP_GUARD: process.env.AGY_ORCH_MCP_GUARD,
                  GOBIN: process.env.GOBIN,
                  GOPATH: process.env.GOPATH,
                },
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
