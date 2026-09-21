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
const id = args.includes("--conversation")
  ? value("--conversation")
  : randomUUID();
const cwd = process.cwd();
const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);

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

// Handle timeout scenario
if (process.env.BATCH_FIXTURE_TIMEOUT === "true") {
  process.on("SIGTERM", () => {});
  emit({ event: "init", conversation_id: id });
  setInterval(() => {}, 1_000);
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
  const editFile = process.env.BATCH_FIXTURE_EDIT_FILE;
  const editContent =
    process.env.BATCH_FIXTURE_EDIT_CONTENT ?? "edited by fake agy";

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
      }),
      conversation_id: id,
      duration_seconds: 0.01,
      usage: { total_tokens: 10 },
    },
  });
}
