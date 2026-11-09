import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StreamLedger } from "../dist/stream.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/agy.mjs",
);

test("StreamLedger tracks ACTIVE, completed, failed, truncated preview, and background commands", () => {
  const ledger = new StreamLedger();

  ledger.push({ event: "init", conversation_id: "conv-1" });
  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: '"rg -i ^(COPY|ADD) x/"' },
      },
    },
  });

  assert.deepEqual(ledger.commands(), [
    {
      step_index: 1,
      command: "rg -i ^(COPY|ADD) x/",
      status: "running",
      exit_code: null,
    },
  ]);

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 0.04,
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: '"rg -i ^(COPY|ADD) x/"' },
        output:
          "Command exited with code 0.\n\nCommand output:\nx/Dockerfile:1:COPY a b\r\n",
      },
    },
  });

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "ls /nope" },
      },
    },
  });
  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 0.07,
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "ls /nope" },
        output:
          "Command exited with code 2.\n\nCommand output:\nls: cannot access '/nope': No such file or directory\r\n",
      },
    },
  });

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 3,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 1.2,
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "cat big.txt" },
        output:
          "The tool's output was truncated due to being too long. You can find the full output in a file at file:///home/koko/.gemini/steps/109/output.txt.\n\nHere is a preview with the middle of the output truncated:\nCommand exited with code 0.\n\nCommand output:\nhead line\r\ntail line\r\n",
      },
    },
  });

  ledger.push({
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
        output:
          "Tool is running as a background task with task id: conv-1/task-213\nTask Description: go -C alt-backend/app test ./...\nTask logs are available at: file:///home/koko/.gemini/steps/213/output.txt",
      },
    },
  });

  assert.deepEqual(ledger.commands(), [
    {
      step_index: 1,
      command: "rg -i ^(COPY|ADD) x/",
      status: "completed",
      exit_code: 0,
      output_tail: "x/Dockerfile:1:COPY a b",
      duration_seconds: 0.04,
    },
    {
      step_index: 2,
      command: "ls /nope",
      status: "failed",
      exit_code: 2,
      output_tail: "ls: cannot access '/nope': No such file or directory",
      duration_seconds: 0.07,
    },
    {
      step_index: 3,
      command: "cat big.txt",
      status: "completed",
      exit_code: 0,
      output_tail: "head line\ntail line",
      full_output_path: "/home/koko/.gemini/steps/109/output.txt",
      duration_seconds: 1.2,
    },
    {
      step_index: 4,
      command: "go -C alt-backend/app test ./...",
      status: "background",
      exit_code: null,
      background_task_id: "conv-1/task-213",
      duration_seconds: 0.5,
    },
  ]);
});

test("StreamLedger caps output_tail to last 20 lines and last 1200 chars", () => {
  const ledger = new StreamLedger();
  const thirtyLines = Array.from(
    { length: 30 },
    (_, i) => `line-${i + 1}\r`,
  ).join("\n");

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "seq 30" },
        output: `Command exited with code 0.\n\nCommand output:\n${thirtyLines}\n`,
      },
    },
  });

  const expectedLines = Array.from(
    { length: 20 },
    (_, i) => `line-${i + 11}`,
  ).join("\n");
  assert.equal(ledger.commands()[0].output_tail, expectedLines);

  const longLine = "a".repeat(800) + "b".repeat(800);
  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "long" },
        output: `Command exited with code -1.\n\nCommand output:\n${longLine}`,
      },
    },
  });

  const second = ledger.commands()[1];
  assert.equal(second.status, "failed");
  assert.equal(second.exit_code, -1);
  assert.equal(second.output_tail.length, 1200);
  assert.equal(second.output_tail, "a".repeat(400) + "b".repeat(800));
});

test("StreamLedger classifies tool_info.error and resolves provisional denials on result", () => {
  const ledger = new StreamLedger();

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "git push" },
        error: "tool call denied by pre-tool hook: blocked by guard",
      },
    },
  });

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "curl example.com" },
        error:
          "Permission denied for unsandboxed(curl example.com). Not in allow list",
      },
    },
  });

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 3,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "git push" },
        error:
          'permission check failed for unsandboxed "git push": user denied permission',
      },
    },
  });

  const hugeError = "spawn error: " + "x".repeat(600);
  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 4,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "bad-bin" },
        error: hugeError,
      },
    },
  });

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 5,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "unmatched-cmd" },
      },
    },
  });

  // Before result arrives, step 5 is provisionally denied
  assert.deepEqual(ledger.deniedCommands(), [
    "git push",
    "curl example.com",
    "unmatched-cmd",
  ]);
  assert.equal(ledger.commands()[3].status, "failed");
  assert.equal(ledger.commands()[3].error.length, 500);

  // Result without command denied_actions turns provisional step 5 into failed
  ledger.push({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "done",
      denied_actions: [{ tool: "write_file" }],
    },
  });

  assert.equal(ledger.commands()[4].status, "failed");
  assert.equal(ledger.commands()[4].error, "no output recorded");
  assert.deepEqual(ledger.deniedCommands(), ["git push", "curl example.com"]);
});

test("StreamLedger keeps provisional denial when result reports command denied_actions", () => {
  const ledger = new StreamLedger();
  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "bun test" },
      },
    },
  });
  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "bun test" },
      },
    },
  });
  ledger.push({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "",
      denied_actions: [{ action: "command", display_name: "RunCommand" }],
    },
  });

  assert.equal(ledger.commands()[0].status, "denied");
  assert.deepEqual(ledger.deniedCommands(), ["bun test"]);
});

test("StreamLedger caps at 200 records, ignores other tools and malformed events, and tracks tokens and finishedReason", () => {
  const ledger = new StreamLedger();
  assert.equal(ledger.turnTokens(), undefined);
  assert.equal(ledger.finishedReason(), undefined);

  for (const junk of [
    null,
    undefined,
    42,
    "not an object",
    [],
    { event: "unknown" },
    { event: "step_update", step_update: null },
    {
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "read_file",
        tool_info: { name: "read_file", parameters: { Path: "/etc/hosts" } },
      },
    },
  ]) {
    ledger.push(junk);
  }
  assert.deepEqual(ledger.commands(), []);

  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      usage: { total_tokens: 120 },
    },
  });
  ledger.push({
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "DONE",
      step_type: "agent_response",
      usage: { total_tokens: 80 },
    },
  });
  assert.equal(ledger.turnTokens(), 200);

  for (let i = 1; i <= 205; i++) {
    ledger.push({
      event: "step_update",
      step_update: {
        step_index: i + 10,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: `echo ${i}` },
          output: "Command exited with code 0.\n\nCommand output:\n",
        },
      },
    });
  }

  const cmds = ledger.commands();
  assert.equal(cmds.length, 200);
  assert.equal(cmds[0].command, "echo 6");
  assert.equal(cmds[199].command, "echo 205");

  ledger.push({
    event: "result",
    result: {
      status: "ERROR",
      finished_reason: "print_timeout",
      usage: { total_tokens: 350 },
    },
  });
  assert.equal(ledger.turnTokens(), 350);
  assert.equal(ledger.finishedReason(), "print_timeout");
});

test("agy.mjs fixture emits expected stream shapes for ledger and denied-tail prompts", () => {
  const ledgerOut = execFileSync(process.execPath, [
    fixturePath,
    "-p",
    "ledger",
  ]).toString("utf8");
  const ledger = new StreamLedger();
  for (const line of ledgerOut.trim().split("\n")) {
    ledger.push(JSON.parse(line));
  }
  const cmds = ledger.commands();
  assert.equal(cmds.length, 3);
  assert.equal(cmds[0].status, "completed");
  assert.equal(cmds[0].exit_code, 0);
  assert.equal(cmds[1].status, "failed");
  assert.equal(cmds[1].exit_code, 1);
  assert.equal(cmds[2].status, "background");
  assert.match(cmds[2].background_task_id, /\/task-213$/);
  assert.equal(ledger.turnTokens(), 150);

  const deniedOut = execFileSync(process.execPath, [
    fixturePath,
    "-p",
    "denied-tail",
  ]).toString("utf8");
  const deniedLedger = new StreamLedger();
  for (const line of deniedOut.trim().split("\n")) {
    deniedLedger.push(JSON.parse(line));
  }
  assert.equal(deniedLedger.commands().length, 1);
  assert.equal(deniedLedger.commands()[0].status, "denied");
  assert.deepEqual(deniedLedger.deniedCommands(), ["rm -rf /tmp/nope"]);
});
