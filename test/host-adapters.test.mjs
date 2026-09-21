import test from "node:test";
import assert from "node:assert/strict";

// Import from isolated build output (shared pnpm build blocked by foundation TS errors).
// When foundation is fixed, switch imports to '../dist/telemetry/host-adapters/*.js'.
import { parseCodexTrace } from "../dist/telemetry/host-adapters/codex.js";
import { parseClaudeCodeTrace } from "../dist/telemetry/host-adapters/claude-code.js";

// ═══════════════════════════════════════════════════════════════════
// CODEX PARSER
// ═══════════════════════════════════════════════════════════════════

test("codex: basic token extraction with last_token_usage", () => {
  const jsonl = [
    JSON.stringify({
      request_id: "req_1",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            reasoning_output_tokens: 5,
          },
        },
      },
    }),
  ].join("\n");

  const result = parseCodexTrace(jsonl);
  assert.equal(result.requests.length, 1);
  const r = result.requests[0];
  assert.equal(r.requestId, "req_1");
  assert.equal(r.usage.totalInputTokens, 100);
  assert.equal(r.usage.cachedInputTokens, 20);
  assert.equal(r.usage.freshInputTokens, 80);
  assert.equal(r.usage.outputTokens, 10);
  assert.equal(r.usage.reasoningOutputTokens, 5);
  assert.equal(r.agentSteps, 1);
});

test("codex: observed zero is distinct from null (unknown)", () => {
  // Event with explicit zeros — these are valid observed values
  const jsonl = JSON.stringify({
    request_id: "req_z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  });

  const result = parseCodexTrace(jsonl);
  const r = result.requests[0];
  assert.equal(r.usage.totalInputTokens, 0);
  assert.equal(r.usage.cachedInputTokens, 0);
  assert.equal(r.usage.freshInputTokens, 0);
  assert.equal(r.usage.outputTokens, 0);
  // reasoning not provided => null
  assert.equal(r.usage.reasoningOutputTokens, null);
});

test("codex: missing usage fields produce null not zero", () => {
  // token_count with no usage at all
  const jsonl = JSON.stringify({ payload: { type: "token_count", info: {} } });
  const result = parseCodexTrace(jsonl);
  const r = result.requests[0];
  assert.equal(r.usage.totalInputTokens, null);
  assert.equal(r.usage.outputTokens, null);
});

test("codex: negative token counts rejected as invalid", () => {
  const jsonl = JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: -5,
          cached_input_tokens: 10,
          output_tokens: 0,
        },
      },
    },
  });
  const result = parseCodexTrace(jsonl);
  const r = result.requests[0];
  // Negative input is invalid — usage should not be extracted
  assert.equal(r.quality.invalidUsageEvents, 1);
});

test("codex: cached_input_tokens > input_tokens rejected", () => {
  const jsonl = JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 200,
          output_tokens: 10,
        },
      },
    },
  });
  const result = parseCodexTrace(jsonl);
  const r = result.requests[0];
  assert.equal(r.quality.invalidUsageEvents, 1);
});

test("codex: explicit compaction marker counted, no heuristic inference", () => {
  const jsonl = [
    JSON.stringify({ type: "compaction" }),
    JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 500,
            output_tokens: 50,
          },
        },
      },
    }),
    // Falling token counts — NOT a compaction indicator
    JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 200,
            cached_input_tokens: 100,
            output_tokens: 20,
          },
        },
      },
    }),
  ].join("\n");
  const result = parseCodexTrace(jsonl);
  const r = result.requests[0];
  assert.equal(r.compactionCount, 1); // only explicit marker
});

test("codex: absent compaction marker yields null not zero", () => {
  const jsonl = JSON.stringify({
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 10,
        },
      },
    },
  });
  const result = parseCodexTrace(jsonl);
  assert.equal(result.requests[0].compactionCount, null);
});

test("codex: multiple requests per file grouped by request_id", () => {
  const jsonl = [
    JSON.stringify({
      request_id: "req_a",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 10,
          },
        },
      },
    }),
    JSON.stringify({
      request_id: "req_b",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 200,
            cached_input_tokens: 50,
            output_tokens: 20,
          },
        },
      },
    }),
    JSON.stringify({
      request_id: "req_a",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 150,
            cached_input_tokens: 100,
            output_tokens: 15,
          },
        },
      },
    }),
  ].join("\n");
  const result = parseCodexTrace(jsonl);
  assert.equal(result.requests.length, 2);
  const reqA = result.requests.find((r) => r.requestId === "req_a");
  const reqB = result.requests.find((r) => r.requestId === "req_b");
  assert.ok(reqA);
  assert.ok(reqB);
  assert.equal(reqA.usage.totalInputTokens, 250); // 100 + 150
  assert.equal(reqA.agentSteps, 2);
  assert.equal(reqB.usage.totalInputTokens, 200);
  assert.equal(reqB.agentSteps, 1);
});

test("codex: duplicate event_id deduplication", () => {
  const jsonl = [
    JSON.stringify({
      event_id: "e1",
      request_id: "r1",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 10,
          },
        },
      },
    }),
    JSON.stringify({
      event_id: "e1",
      request_id: "r1",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 10,
          },
        },
      },
    }),
  ].join("\n");
  const result = parseCodexTrace(jsonl);
  const r = result.requests[0];
  // Deduped: should be 100, not 200
  assert.equal(r.usage.totalInputTokens, 100);
  assert.equal(r.agentSteps, 1);
});

test("codex: total_token_usage snapshot delta extraction", () => {
  const jsonl = [
    JSON.stringify({
      request_id: "r1",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
          },
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
    JSON.stringify({
      request_id: "r1",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 150,
            cached_input_tokens: 50,
            output_tokens: 20,
          },
          total_token_usage: {
            input_tokens: 250,
            cached_input_tokens: 70,
            output_tokens: 30,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
  ].join("\n");
  const result = parseCodexTrace(jsonl);
  const r = result.requests[0];
  // First step: uses last_token_usage (no previous snapshot for delta)
  // Second step: delta from total_token_usage = (250-100, 70-20, 30-10, 0-0)
  assert.equal(r.usage.totalInputTokens, 250); // 100 + 150 delta
  assert.equal(r.usage.cachedInputTokens, 70); // 20 + 50 delta
  assert.equal(r.usage.outputTokens, 30); // 10 + 20 delta
  assert.equal(r.agentSteps, 2);
});

test("codex: JSON array format accepted", () => {
  const json = JSON.stringify([
    {
      request_id: "r1",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 300,
            cached_input_tokens: 100,
            output_tokens: 25,
          },
        },
      },
    },
  ]);
  const result = parseCodexTrace(json);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].usage.totalInputTokens, 300);
});

test("codex: malformed lines tracked in quality, not silently ignored", () => {
  const jsonl =
    'not json\n{"payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":5}}}}\n{bad json too';
  const result = parseCodexTrace(jsonl);
  assert.equal(result.quality.malformedEvents, 2);
  assert.equal(result.quality.isComplete, false);
  // Valid event still parsed
  assert.equal(result.requests[0].usage.totalInputTokens, 50);
});

test("codex: empty input produces empty result", () => {
  const result = parseCodexTrace("");
  assert.equal(result.requests.length, 0);
});

test("codex: no prompt/source/path/rawline content in output", () => {
  const jsonl = JSON.stringify({
    request_id: "r1",
    prompt: "SECRET_API_KEY=abc123",
    source_code: "const x = 1;",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 1,
        },
      },
    },
  });
  const result = parseCodexTrace(jsonl);
  const str = JSON.stringify(result);
  assert.ok(!str.includes("SECRET_API_KEY"));
  assert.ok(!str.includes("const x = 1"));
});

// ═══════════════════════════════════════════════════════════════════
// CLAUDE CODE PARSER
// ═══════════════════════════════════════════════════════════════════

test("claude: basic token extraction with dedup", () => {
  const jsonl = [
    JSON.stringify({
      request_id: "r1",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 0,
          output_tokens: 50,
        },
      },
    }),
    JSON.stringify({
      request_id: "r1",
      message: {
        id: "msg_2",
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 600,
          output_tokens: 30,
        },
      },
    }),
  ].join("\n");
  const result = parseClaudeCodeTrace(jsonl);
  const r = result.requests[0];
  assert.equal(r.requestId, "r1");
  assert.equal(r.agentSteps, 2);
  // msg_1: total = 100+500+0=600, cached=0, fresh=100+500=600
  // msg_2: total = 0+0+600=600, cached=600, fresh=0+0=0
  assert.equal(r.usage.totalInputTokens, 1200);
  assert.equal(r.usage.cachedInputTokens, 600);
  assert.equal(r.usage.freshInputTokens, 600);
  assert.equal(r.usage.outputTokens, 80);
  assert.equal(r.usage.reasoningOutputTokens, null);
});

test("claude: LATEST message.id usage wins (not first)", () => {
  // Streaming: msg_1 appears twice, second event has higher output
  const jsonl = [
    JSON.stringify({
      request_id: "r1",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 0,
          output_tokens: 50,
        },
      },
    }),
    JSON.stringify({
      request_id: "r1",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 120,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 0,
          output_tokens: 80,
        },
      },
    }),
  ].join("\n");
  const result = parseClaudeCodeTrace(jsonl);
  const r = result.requests[0];
  assert.equal(r.agentSteps, 1); // deduplicated
  // Should use LATEST: input=120, creation=500, read=0, output=80
  assert.equal(r.usage.totalInputTokens, 620); // 120+500+0
  assert.equal(r.usage.outputTokens, 80);
});

test("claude: observed zero distinct from null", () => {
  const jsonl = JSON.stringify({
    request_id: "r1",
    message: {
      id: "msg_1",
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  });
  const result = parseClaudeCodeTrace(jsonl);
  const r = result.requests[0];
  assert.equal(r.usage.totalInputTokens, 0);
  assert.equal(r.usage.outputTokens, 0);
});

test("claude: explicit compact_boundary marker counted", () => {
  const jsonl = [
    JSON.stringify({ request_id: "r1", type: "compact_boundary" }),
    JSON.stringify({
      request_id: "r1",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
  ].join("\n");
  const result = parseClaudeCodeTrace(jsonl);
  assert.equal(result.requests[0].compactionCount, 1);
});

test("claude: absent compaction marker yields null not zero", () => {
  const jsonl = JSON.stringify({
    request_id: "r1",
    message: {
      id: "msg_1",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });
  const result = parseClaudeCodeTrace(jsonl);
  assert.equal(result.requests[0].compactionCount, null);
});

test("claude: multiple requests per file grouped", () => {
  const jsonl = [
    JSON.stringify({
      request_id: "r1",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
    JSON.stringify({
      request_id: "r2",
      message: {
        id: "msg_2",
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 2,
        },
      },
    }),
  ].join("\n");
  const result = parseClaudeCodeTrace(jsonl);
  assert.equal(result.requests.length, 2);
  assert.ok(result.requests.find((r) => r.requestId === "r1"));
  assert.ok(result.requests.find((r) => r.requestId === "r2"));
});

test("claude: JSON array format accepted", () => {
  const json = JSON.stringify([
    {
      request_id: "r1",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    },
  ]);
  const result = parseClaudeCodeTrace(json);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].usage.totalInputTokens, 10);
});

test("claude: malformed lines tracked in quality", () => {
  const jsonl =
    "{bad\n" +
    JSON.stringify({
      request_id: "r1",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    });
  const result = parseClaudeCodeTrace(jsonl);
  assert.equal(result.quality.malformedEvents, 1);
  assert.equal(result.quality.isComplete, false);
});

test("claude: no prompt/source content leaks", () => {
  const jsonl = JSON.stringify({
    request_id: "r1",
    prompt: "SUPER_SECRET",
    message: {
      id: "msg_1",
      content: [{ text: "private code" }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });
  const result = parseClaudeCodeTrace(jsonl);
  const str = JSON.stringify(result);
  assert.ok(!str.includes("SUPER_SECRET"));
  assert.ok(!str.includes("private code"));
});

test("claude: missing message.id events not counted as steps", () => {
  const jsonl = [
    JSON.stringify({
      request_id: "r1",
      message: {
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    }),
  ].join("\n");
  const result = parseClaudeCodeTrace(jsonl);
  const r = result.requests[0];
  assert.equal(r.agentSteps, null); // no identifiable steps
});
