import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { toToolResult } from "../dist/result.js";
import { HANDOFF_JSON_SCHEMA, parseHandoff } from "../dist/handoff-schema.js";

function makeRecord(stepIndex, overrides = {}) {
  return {
    step_index: stepIndex,
    command: `cmd-${stepIndex}`,
    status: "completed",
    exit_code: 0,
    output_tail: `tail-${stepIndex}`,
    duration_seconds: 0.1,
    ...overrides,
  };
}

test("toToolResult emits new snake_case keys and passes richer context through as-is", () => {
  const records = [makeRecord(1, { full_output_path: "/tmp/out.txt" })];
  const context = {
    turns: 3,
    cumulative_total_tokens: 150_000,
    turn_total_tokens: 50_000,
    rotate_threshold_tokens: 200_000,
    rotate_recommended: false,
    advice: "keep going",
  };
  const handoff = {
    summary: "completed task",
    changes: [{ path: "src/a.ts", change: "added feature" }],
    verification: [
      { command: "pnpm test", outcome: "pass", detail: "all green" },
    ],
    facts: ["fact 1"],
    side_effects: [],
    blockers: [],
  };

  const res = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: "done",
      exitCode: 0,
      verifiedOutputs: records,
      partialResponse: "partial text",
      preflightWarnings: ["warn-1", "warn-2"],
      queueWaitSeconds: 1.25,
      handoff,
      handoffError: "minor warning",
      context,
    },
    10_000,
  );

  const data = res.structuredContent;
  assert.deepEqual(JSON.parse(res.content[0].text), data);
  assert.deepEqual(data.verified_outputs, records);
  assert.equal(data.partial_response, "partial text");
  assert.deepEqual(data.preflight_warnings, ["warn-1", "warn-2"]);
  assert.equal(data.queue_wait_seconds, 1.25);
  assert.deepEqual(data.handoff, handoff);
  assert.equal(data.handoff_error, "minor warning");
  assert.deepEqual(data.context, context);
});

test("verified_outputs budget steps: drop early output_tail, keep last 40, then drop key", () => {
  // Step 1: over 30% budget -> drops output_tail from all but the last 10 records
  const fifteenRecords = Array.from({ length: 15 }, (_, i) =>
    makeRecord(i + 1, { output_tail: "x".repeat(200) }),
  );
  // With output_tail on all 15: ~15 * 280 = 4200 chars.
  // With output_tail only on last 10: ~10 * 280 + 5 * 80 = 3200 chars.
  // Pick limit = 12_000 -> 30% budget = 3_600 chars.
  const step1 = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: "ok",
      exitCode: 0,
      verifiedOutputs: fifteenRecords,
    },
    12_000,
  );
  const vo1 = step1.structuredContent.verified_outputs;
  assert.equal(vo1.length, 15);
  for (let i = 0; i < 5; i++) {
    assert.equal(vo1[i].output_tail, undefined);
    assert.equal(vo1[i].step_index, i + 1);
  }
  for (let i = 5; i < 15; i++) {
    assert.equal(vo1[i].output_tail, "x".repeat(200));
  }
  assert.equal(step1.structuredContent.verified_outputs_omitted, undefined);

  // Step 2: still over 30% budget after dropping early output_tail -> keep last 40 and set verified_outputs_omitted
  const fiftyRecords = Array.from({ length: 50 }, (_, i) =>
    makeRecord(i + 1, { output_tail: "y".repeat(50) }),
  );
  // Initial 50 with tails: ~8000 chars. After Step 1 (drop first 40 tails): ~5400 chars. After Step 2 (last 40): ~4450 chars.
  // Pick limit = 16_000 -> 30% budget = 4_800 chars.
  const step2 = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: "ok",
      exitCode: 0,
      verifiedOutputs: fiftyRecords,
    },
    16_000,
  );
  const vo2 = step2.structuredContent.verified_outputs;
  assert.equal(vo2.length, 40);
  assert.equal(vo2[0].step_index, 11);
  assert.equal(vo2[39].step_index, 50);
  for (let i = 0; i < 30; i++) {
    assert.equal(vo2[i].output_tail, undefined);
  }
  for (let i = 30; i < 40; i++) {
    assert.equal(vo2[i].output_tail, "y".repeat(50));
  }
  assert.equal(step2.structuredContent.verified_outputs_omitted, 10);

  // Step 3: still over 30% budget even with last 40 -> drop verified_outputs and set verified_outputs_omitted to total
  const hugeRecords = Array.from({ length: 50 }, (_, i) =>
    makeRecord(i + 1, { output_tail: "z".repeat(500) }),
  );
  const step3 = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: "ok",
      exitCode: 0,
      verifiedOutputs: hugeRecords,
    },
    2_000,
  );
  assert.equal(step3.structuredContent.verified_outputs, undefined);
  assert.equal(step3.structuredContent.verified_outputs_omitted, 50);
  assert.ok(step3.content[0].text.length <= 2_000);
});

test("response_outline extracts ATX headings outside code fences and caps at 80 entries", () => {
  const longHeading = "H".repeat(150);
  const markdown = [
    "# Title One",
    "intro line",
    "```bash",
    "# comment in backtick fence",
    "## another fake heading",
    "```",
    "## Section Two",
    "~~~python",
    "### fake heading in tilde fence",
    "~~~",
    `###### ${longHeading}`,
    "body text",
    "#not-a-heading",
    "####### seven hashes not a heading",
    "### Final Section",
    "last line of body",
    "padding ".repeat(300),
  ].join("\n");

  const res = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: markdown,
      exitCode: 0,
    },
    1_200,
  );

  assert.ok(res.content[0].text.length <= 1_200);
  assert.equal(res.structuredContent.truncated, true);
  assert.deepEqual(res.structuredContent.response_outline, [
    { level: 1, heading: "Title One", start_line: 1, end_line: 6 },
    { level: 2, heading: "Section Two", start_line: 7, end_line: 10 },
    { level: 6, heading: "H".repeat(120), start_line: 11, end_line: 14 },
    { level: 3, heading: "Final Section", start_line: 15, end_line: 17 },
  ]);

  // Cap at 80 entries
  const manyHeadings =
    Array.from({ length: 95 }, (_, i) => `## H${i + 1}\nline ${i + 1}`).join(
      "\n",
    ) +
    "\n" +
    "pad ".repeat(3_000);
  const capped = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: manyHeadings,
      exitCode: 0,
    },
    8_000,
  );
  assert.equal(capped.structuredContent.response_outline.length, 80);
  assert.equal(capped.structuredContent.response_outline[0].start_line, 1);
  assert.equal(capped.structuredContent.response_outline[0].end_line, 2);
  assert.equal(capped.structuredContent.response_outline[79].heading, "H80");
  assert.equal(capped.structuredContent.response_outline[79].start_line, 159);
  assert.equal(capped.structuredContent.response_outline[79].end_line, 160);

  // When outline itself does not fit within limit, drop it and set response_outline_omitted: true
  const omitted = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: manyHeadings,
      exitCode: 0,
    },
    600,
  );
  assert.ok(omitted.content[0].text.length <= 600);
  assert.equal(omitted.structuredContent.response_outline, undefined);
  assert.equal(omitted.structuredContent.response_outline_omitted, true);
});

test("resource_link block is appended when responseArtifact is set", () => {
  const fullResponse = "# Heading\n" + "content ".repeat(500);
  const artifactPath = "/tmp/agy-test-run/response.txt";
  const res = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: fullResponse,
      exitCode: 0,
      responseArtifact: { id: "art_1", path: artifactPath },
    },
    800,
  );

  assert.equal(res.content.length, 2);
  assert.equal(res.content[0].type, "text");
  assert.ok(res.content[0].text.length <= 800);
  assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
  assert.deepEqual(res.content[1], {
    type: "resource_link",
    uri: pathToFileURL(artifactPath).href,
    name: "response.txt",
    mimeType: "text/plain",
    description: `Full agy response, ${fullResponse.length} characters`,
  });
});

test("shortening order and hard limit guarantee with large inputs", () => {
  // When over limit: denied/usage omitted first; if that brings it under limit and verified_outputs <= 30%, response stays intact
  const preservedResponse = toToolResult(
    {
      ok: true,
      status: "SUCCESS",
      response: "keep this full response",
      exitCode: 0,
      deniedActions: [{ big: "d".repeat(800) }],
      verifiedOutputs: [makeRecord(1, { output_tail: "ok" })],
    },
    600,
  );
  assert.ok(preservedResponse.content[0].text.length <= 600);
  assert.equal(preservedResponse.structuredContent.denied_actions, undefined);
  assert.equal(
    preservedResponse.structuredContent.denied_actions_omitted,
    true,
  );
  assert.equal(preservedResponse.structuredContent.verified_outputs.length, 1);
  assert.equal(
    preservedResponse.structuredContent.response,
    "keep this full response",
  );

  // Hard limit respected when every field is huge
  const extreme = toToolResult(
    {
      ok: false,
      status: "ERROR",
      response: "# H1\n" + "r".repeat(20_000),
      exitCode: 1,
      conversationId: "conv-123",
      error: "e".repeat(5_000),
      stderr: "s".repeat(10_000),
      deniedActions: ["da".repeat(2_000)],
      deniedCommands: ["dc".repeat(2_000)],
      usage: { tokens: "u".repeat(2_000) },
      verifiedOutputs: Array.from({ length: 60 }, (_, i) =>
        makeRecord(i + 1, { output_tail: "t".repeat(500) }),
      ),
      partialResponse: "p".repeat(5_000),
      preflightWarnings: ["w".repeat(2_000)],
      handoffError: "he".repeat(2_000),
    },
    1_024,
  );
  assert.ok(extreme.content[0].text.length <= 1_024);
  assert.deepEqual(
    JSON.parse(extreme.content[0].text),
    extreme.structuredContent,
  );
  assert.equal(extreme.structuredContent.truncated, true);
});

test("HANDOFF_JSON_SCHEMA and parseHandoff accept and reject cases", () => {
  assert.equal(
    HANDOFF_JSON_SCHEMA.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(HANDOFF_JSON_SCHEMA.additionalProperties, false);
  assert.ok(HANDOFF_JSON_SCHEMA.required.includes("summary"));

  const validObj = {
    summary: "All tasks done",
    changes: [{ path: "src/result.ts", change: "updated toToolResult" }],
    verification: [
      { command: "pnpm test", outcome: "pass", detail: "220 passed" },
    ],
    facts: ["agy 1.5.3 tested"],
    side_effects: [],
    blockers: [],
  };

  // Direct JSON
  const direct = parseHandoff(JSON.stringify(validObj));
  assert.equal(direct.error, undefined);
  assert.deepEqual(direct.handoff, validObj);

  // Single ```json fenced block
  const fenced = parseHandoff(
    `Here is the handoff:\n\`\`\`json\n${JSON.stringify(validObj, null, 2)}\n\`\`\`\n`,
  );
  assert.equal(fenced.error, undefined);
  assert.deepEqual(fenced.handoff, validObj);

  // Reject cases
  for (const bad of [
    "",
    "not json at all",
    "null",
    "[]",
    "123",
    JSON.stringify({ ...validObj, summary: 123 }),
    JSON.stringify({ ...validObj, summary: undefined }),
    JSON.stringify({ ...validObj, changes: "not-array" }),
    JSON.stringify({ ...validObj, verification: {} }),
    JSON.stringify({ ...validObj, facts: null }),
    JSON.stringify({ ...validObj, side_effects: "none" }),
    JSON.stringify({ ...validObj, blockers: false }),
    `\`\`\`json\n${JSON.stringify(validObj)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(validObj)}\n\`\`\``,
  ]) {
    const res = parseHandoff(bad);
    assert.equal(res.handoff, undefined, `Expected rejection for: ${bad}`);
    assert.equal(
      typeof res.error,
      "string",
      `Expected error string for: ${bad}`,
    );
    assert.ok(res.error.length > 0);
  }
});
