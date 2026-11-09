import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  readDeniedCommands,
  readLastPlannerText,
  transcriptPath,
} from "../dist/transcript.js";

function writeTranscript(home, id, lines) {
  const file = transcriptPath(id, home);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n") + "\n",
  );
}

test("readDeniedCommands recovers trailing PLANNER_RESPONSE run_command when no GENERIC step follows", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agy-transcript-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = randomUUID();
  const sinceMs = Date.parse("2026-11-09T11:34:15Z");

  writeTranscript(home, id, [
    {
      type: "USER_INPUT",
      created_at: "2026-11-09T11:34:15Z",
      content: "audit dockerfiles",
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:34:16Z",
      content: "Listing files first.",
      tool_calls: [
        {
          name: "run_command",
          args: {
            CommandLine: '"ls -la"',
            WaitMsBeforeAsync: "5000",
          },
        },
      ],
    },
    {
      type: "GENERIC",
      created_at: "2026-11-09T11:34:16Z",
      content: "Command exited with code 0.",
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:34:17Z",
      content: "Now searching COPY and ADD directives.",
      tool_calls: [
        {
          name: "read_file",
          args: { Path: '"/tmp/Dockerfile"' },
        },
        {
          name: "run_command",
          args: {
            CommandLine: '"rg -i ^(COPY|ADD) a/ b/"',
            WaitMsBeforeAsync: "10000",
          },
        },
      ],
    },
  ]);

  assert.deepEqual(readDeniedCommands(id, sinceMs, home), [
    "rg -i ^(COPY|ADD) a/ b/",
  ]);
});

test("readDeniedCommands ignores trailing PLANNER_RESPONSE when followed by GENERIC or before sinceMs", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agy-transcript-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = randomUUID();
  const sinceMs = Date.parse("2026-11-09T11:34:15Z");

  writeTranscript(home, id, [
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:34:17Z",
      content: "Running allowed command.",
      tool_calls: [
        {
          name: "run_command",
          args: { CommandLine: '"rg foo"' },
        },
      ],
    },
    {
      type: "GENERIC",
      created_at: "2026-11-09T11:34:18Z",
      content: "Command exited with code 0.",
    },
  ]);
  assert.deepEqual(readDeniedCommands(id, sinceMs, home), []);

  const staleId = randomUUID();
  writeTranscript(home, staleId, [
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:30:00Z",
      content: "Old turn.",
      tool_calls: [
        {
          name: "run_command",
          args: { CommandLine: '"rg stale"' },
        },
      ],
    },
  ]);
  assert.deepEqual(readDeniedCommands(staleId, sinceMs, home), []);
});

test("readDeniedCommands combines error-step matches and trailing PLANNER_RESPONSE with deduplication and caps", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agy-transcript-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = randomUUID();
  const sinceMs = Date.parse("2026-11-09T11:34:15Z");

  const toolCalls = [];
  for (let i = 1; i <= 12; i++) {
    toolCalls.push({
      name: "run_command",
      args: { CommandLine: JSON.stringify(`cmd-${i}`) },
    });
  }

  writeTranscript(home, id, [
    "malformed json line",
    {
      type: "GENERIC",
      status: "ERROR",
      created_at: "2026-11-09T11:34:16Z",
      error:
        'permission check failed for unsandboxed "cmd-err": user denied permission to run command:\ncmd-err\nDo not circumvent.',
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:34:17Z",
      content: "Trying batch of commands.",
      tool_calls: [
        {
          name: "run_command",
          args: { CommandLine: '"cmd-err"' },
        },
        ...toolCalls,
      ],
    },
  ]);

  const result = readDeniedCommands(id, sinceMs, home);
  assert.equal(result.length, 10);
  assert.equal(result[0], "cmd-err");
  assert.equal(result[1], "cmd-1");
  assert.equal(result[9], "cmd-9");
  assert.deepEqual(readDeniedCommands("not-a-uuid", sinceMs, home), []);
});

test("readLastPlannerText returns last non-empty PLANNER_RESPONSE content within time window", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agy-transcript-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = randomUUID();
  const sinceMs = Date.parse("2026-11-09T11:34:15.500Z");

  writeTranscript(home, id, [
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:34:10Z",
      content: "Too old planner text",
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:34:15Z",
      content: "First valid planner text (within 1s tolerance)",
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:34:16Z",
      content: "Last non-empty planner response",
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-09T11:34:17Z",
      content: "   ",
      tool_calls: [{ name: "run_command", args: { CommandLine: '"ls"' } }],
    },
  ]);

  assert.equal(
    readLastPlannerText(id, sinceMs, home),
    "Last non-empty planner response",
  );
  assert.equal(
    readLastPlannerText(id, Date.parse("2026-11-09T11:35:00Z"), home),
    undefined,
  );
  assert.equal(readLastPlannerText("bad-id", sinceMs, home), undefined);
  assert.equal(readLastPlannerText(randomUUID(), sinceMs, home), undefined);
});
