#!/usr/bin/env node
/**
 * Fake agy subprocess for batch integration tests.
 *
 * Reads the task instruction from the prompt (-p flag).
 * Optionally makes controlled filesystem edits based on env vars:
 *   BATCH_FIXTURE_EDIT_FILE  - relative path to create/edit
 *   BATCH_FIXTURE_EDIT_CONTENT - content to write
 *   BATCH_FIXTURE_FAIL - if set, simulate failure
 *   BATCH_FIXTURE_TIMEOUT - if set, hang forever
 *   BATCH_FIXTURE_SCOPE_VIOLATE - write outside owns
 *
 * Emits stream-json events like real agy CLI.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const prompt = value("-p") ?? "";
const hasConversation = args.includes("--conversation");
const id = hasConversation ? value("--conversation") : randomUUID();
const cwd = process.cwd();
const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);

function resolveEditFile(promptText) {
  if (process.env.BATCH_FIXTURE_EDIT_FILE) {
    return process.env.BATCH_FIXTURE_EDIT_FILE;
  }
  const ownedMatch = /^  - ([^\s*]+)$/m.exec(promptText);
  if (ownedMatch) return ownedMatch[1];
  const statusMatch = /^(?:\?\?| M|M |A )\s+([^\s]+)$/m.exec(promptText);
  if (statusMatch) return statusMatch[1];
  return undefined;
}

// Handle version/help
if (args[0] === "--version") {
  console.log("1.0.0-batch-test");
  process.exit(0);
} else if (args[0] === "--help") {
  console.log("batch test fixture");
  process.exit(0);
} else if (args[0] === "models") {
  console.log("test-fast-model\tTest Fast Model");
  process.exit(0);
}

const isPrintTimeoutOnce =
  process.env.BATCH_FIXTURE_PRINT_TIMEOUT === "true" ||
  process.env.BATCH_FIXTURE_PRINT_TIMEOUT === "once" ||
  process.env.BATCH_FIXTURE_RESUME === "true" ||
  prompt.includes("PRINT_TIMEOUT_ONCE");
const isPrintTimeoutAlways =
  process.env.BATCH_FIXTURE_PRINT_TIMEOUT === "always" ||
  prompt.includes("PRINT_TIMEOUT_ALWAYS");

// Handle timeout scenario
if (process.env.BATCH_FIXTURE_TIMEOUT === "true") {
  process.on("SIGTERM", () => {});
  emit({ event: "init", conversation_id: id });
  setInterval(() => {}, 1_000);
} else if (isPrintTimeoutAlways || (isPrintTimeoutOnce && !hasConversation)) {
  emit({ event: "init", conversation_id: id });
  const editFile = resolveEditFile(prompt);
  if (editFile) {
    const fullPath = join(cwd, editFile);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, "// partial work from first turn\n");
  }
  emit({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      duration_seconds: 0.02,
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "pnpm test" },
        output: "Command exited with code 0.\n\nCommand output:\nok\n",
      },
    },
  });
  emit({
    event: "result",
    result: {
      status: "ERROR",
      response: "Partial progress before 15-minute cap",
      conversation_id: id,
      error: `print timeout after 900s with the turn still in progress; the response is partial; terminated ${id}/task-1 (sleep 30)`,
      finished_reason: "print_timeout",
      duration_seconds: 900,
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
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
          id: `${id}/task-1`,
          description: "sleep 30",
          log_uri: "file:///tmp/task-1.log",
        },
      ],
    })}\n`,
  );
  process.exit(3);
} else {
  emit({ event: "init", conversation_id: id });

  // Handle failure scenario
  if (process.env.BATCH_FIXTURE_FAIL === "true") {
    emit({
      event: "result",
      result: {
        status: "ERROR",
        response: "",
        conversation_id: id,
        error: {
          message: process.env.BATCH_FIXTURE_FAIL_MSG || "Simulated failure",
        },
      },
    });
    process.exit(1);
  }

  // Handle scope violation scenario
  if (process.env.BATCH_FIXTURE_SCOPE_VIOLATE === "true") {
    const violatePath = join(cwd, "outside_scope.txt");
    writeFileSync(violatePath, "scope violation content");
  }

  // Perform edits if instructed
  const editFile = resolveEditFile(prompt);
  const editContent =
    process.env.BATCH_FIXTURE_EDIT_CONTENT ?? "edited by fake agy\n";

  if (editFile) {
    const fullPath = join(cwd, editFile);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, editContent);
  }

  // Small delay to simulate work
  await delay(10);

  emit({
    event: "result",
    result: {
      status: "SUCCESS",
      response: JSON.stringify({
        prompt,
        workspace: cwd,
        editFile,
        editContent,
        conversationId: id,
      }),
      conversation_id: id,
      duration_seconds: 0.01,
      usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
    },
  });
}
