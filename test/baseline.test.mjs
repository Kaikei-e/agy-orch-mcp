import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import { generateBaselineReport } from "../scripts/baseline.mjs";
import { compareRuns } from "../scripts/compare-runs.mjs";

// ═══════════════════════════════════════════════════════════════════
// BASELINE REPORT
// ═══════════════════════════════════════════════════════════════════

test("baseline: generates report with variant/group/synthetic metadata", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-baseline-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "trace.jsonl"),
      [
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
            },
          },
        }),
      ].join("\n"),
    );
    const outPath = path.join(tmpDir, "report.json");
    const report = await generateBaselineReport(tmpDir, "codex", {
      variant: "A",
      comparableGroup: "g1",
      isSynthetic: true,
      outPath,
    });
    assert.equal(report.version, "1");
    assert.equal(report.hostType, "codex");
    assert.equal(report.variant, "A");
    assert.equal(report.comparableGroup, "g1");
    assert.equal(report.isSynthetic, true);
    assert.ok(report.requests.length >= 1);
    assert.ok(report.stats);
    // Written to file
    const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(written.variant, "A");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("baseline: merges same request_id across files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-merge-"));
  try {
    // Same request_id in two files
    fs.writeFileSync(
      path.join(tmpDir, "part1.jsonl"),
      JSON.stringify({
        request_id: "shared_req",
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
    );
    fs.writeFileSync(
      path.join(tmpDir, "part2.jsonl"),
      JSON.stringify({
        request_id: "shared_req",
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
    );
    const report = await generateBaselineReport(tmpDir, "codex", {
      variant: "A",
      isSynthetic: true,
    });
    // Should merge into single request, not count files as requests
    const shared = report.requests.find((r) => r.requestId === "shared_req");
    assert.ok(shared);
    assert.equal(shared.usage.totalInputTokens, 300); // 100+200
    assert.equal(shared.usage.outputTokens, 30);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("baseline: reads JSON format files too", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-json-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "trace.json"),
      JSON.stringify([
        {
          request_id: "json_r",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 50,
                cached_input_tokens: 0,
                output_tokens: 5,
              },
            },
          },
        },
      ]),
    );
    const report = await generateBaselineReport(tmpDir, "codex", {
      variant: "A",
      isSynthetic: true,
    });
    assert.equal(report.requests.length, 1);
    assert.equal(report.requests[0].usage.totalInputTokens, 50);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("baseline: no source filenames, paths, or raw content in output", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-priv-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "secret-file.jsonl"),
      JSON.stringify({
        request_id: "r1",
        prompt: "API_KEY_LEAKED",
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
      }),
    );
    const outPath = path.join(tmpDir, "report.json");
    await generateBaselineReport(tmpDir, "codex", {
      variant: "A",
      isSynthetic: true,
      outPath,
    });
    const raw = fs.readFileSync(outPath, "utf8");
    assert.ok(!raw.includes("secret-file"));
    assert.ok(!raw.includes("API_KEY_LEAKED"));
    assert.ok(!raw.includes(tmpDir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("baseline: descriptive stats with N, median, p95", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stats-"));
  try {
    const events = [
      {
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
      },
      {
        request_id: "r2",
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
      },
      {
        request_id: "r3",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 300,
              cached_input_tokens: 100,
              output_tokens: 30,
            },
          },
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "trace.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n"),
    );
    const report = await generateBaselineReport(tmpDir, "codex", {
      variant: "B",
      isSynthetic: true,
    });
    assert.equal(report.stats.n, 3);
    assert.equal(report.stats.excluded, 0);
    assert.ok(report.stats.totalInputTokens);
    assert.equal(report.stats.totalInputTokens.min, 100);
    assert.equal(report.stats.totalInputTokens.max, 300);
    assert.equal(report.stats.totalInputTokens.median, 200);
    assert.equal(report.stats.totalInputTokens.sum, 600);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("baseline: quality tracks malformed and invalid events", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-qual-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "trace.jsonl"),
      "bad json\n" +
        JSON.stringify({
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
        }),
    );
    const report = await generateBaselineReport(tmpDir, "codex", {
      variant: "A",
      isSynthetic: true,
    });
    assert.equal(report.quality.malformedEvents, 1);
    assert.equal(report.quality.isComplete, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("baseline: fatal exit on empty traces dir", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-empty-"));
  try {
    await assert.rejects(
      () =>
        generateBaselineReport(tmpDir, "codex", {
          variant: "A",
          isSynthetic: true,
        }),
      { message: /No .jsonl or .json trace files/ },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("baseline: fatal exit on invalid host type", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "x.jsonl"), "{}");
    await assert.rejects(
      () =>
        generateBaselineReport(tmpDir, "invalid-host", {
          variant: "A",
          isSynthetic: true,
        }),
      { message: /Failed to load invalid-host adapter/ },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════
// COMPARE RUNS
// ═══════════════════════════════════════════════════════════════════

test("compare: requires at least 2 variants", () => {
  assert.throws(
    () => compareRuns({ A: { requests: [], stats: null } }),
    /At least 2/,
  );
});

test("compare: requires valid A/B/C/D labels", () => {
  assert.throws(() => compareRuns({ X: {}, Y: {} }), /Invalid variant label/);
});

test("compare: warns on mismatched comparableGroup", () => {
  const result = compareRuns({
    A: { comparableGroup: "g1", isSynthetic: true, requests: [] },
    B: { comparableGroup: "g2", isSynthetic: true, requests: [] },
  });
  assert.ok(result.warnings.some((w) => w.includes("Mismatched")));
});

test("compare: warns on synthetic data", () => {
  const result = compareRuns({
    A: { comparableGroup: "g1", isSynthetic: true, requests: [] },
    B: { comparableGroup: "g1", isSynthetic: false, requests: [] },
  });
  assert.ok(result.warnings.some((w) => w.includes("synthetic")));
});

test("compare: warns on unequal N", () => {
  const result = compareRuns({
    A: {
      comparableGroup: "g1",
      isSynthetic: true,
      requests: [
        {
          requestId: "r1",
          usage: {
            totalInputTokens: 100,
            cachedInputTokens: 0,
            freshInputTokens: 100,
            outputTokens: 10,
            reasoningOutputTokens: null,
          },
          agentSteps: 1,
          compactionCount: null,
          quality: {
            totalEvents: 1,
            malformedEvents: 0,
            invalidUsageEvents: 0,
            isComplete: true,
          },
        },
      ],
    },
    B: {
      comparableGroup: "g1",
      isSynthetic: true,
      requests: [
        {
          requestId: "r1",
          usage: {
            totalInputTokens: 50,
            cachedInputTokens: 0,
            freshInputTokens: 50,
            outputTokens: 5,
            reasoningOutputTokens: null,
          },
          agentSteps: 1,
          compactionCount: null,
          quality: {
            totalEvents: 1,
            malformedEvents: 0,
            invalidUsageEvents: 0,
            isComplete: true,
          },
        },
        {
          requestId: "r2",
          usage: {
            totalInputTokens: 60,
            cachedInputTokens: 0,
            freshInputTokens: 60,
            outputTokens: 6,
            reasoningOutputTokens: null,
          },
          agentSteps: 1,
          compactionCount: null,
          quality: {
            totalEvents: 1,
            malformedEvents: 0,
            invalidUsageEvents: 0,
            isComplete: true,
          },
        },
      ],
    },
  });
  assert.ok(result.warnings.some((w) => w.includes("Unequal")));
  assert.equal(result.variants.A.n, 1);
  assert.equal(result.variants.B.n, 2);
});

test("compare: per-successful-request metrics with median/p95", () => {
  const mkReq = (id, input, output, steps) => ({
    requestId: id,
    usage: {
      totalInputTokens: input,
      cachedInputTokens: 0,
      freshInputTokens: input,
      outputTokens: output,
      reasoningOutputTokens: null,
    },
    agentSteps: steps,
    compactionCount: null,
    quality: {
      totalEvents: 1,
      malformedEvents: 0,
      invalidUsageEvents: 0,
      isComplete: true,
    },
  });
  const result = compareRuns({
    A: {
      comparableGroup: "g1",
      isSynthetic: true,
      requests: [
        mkReq("r1", 100, 10, 3),
        mkReq("r2", 200, 20, 5),
        mkReq("r3", 300, 30, 7),
      ],
    },
    B: {
      comparableGroup: "g1",
      isSynthetic: true,
      requests: [
        mkReq("r1", 50, 5, 1),
        mkReq("r2", 100, 10, 2),
        mkReq("r3", 150, 15, 3),
      ],
    },
  });

  assert.equal(result.variants.A.n, 3);
  assert.equal(result.variants.B.n, 3);
  assert.equal(
    result.variants.A.perSuccessfulRequest.totalInputTokens.median,
    200,
  );
  assert.equal(
    result.variants.B.perSuccessfulRequest.totalInputTokens.median,
    100,
  );
  assert.equal(result.variants.A.perSuccessfulRequest.agentSteps.median, 5);
  assert.equal(result.variants.B.perSuccessfulRequest.agentSteps.median, 2);
});

test("compare: excluded requests with null usage", () => {
  const result = compareRuns({
    A: {
      comparableGroup: "g1",
      isSynthetic: true,
      requests: [
        {
          requestId: "r1",
          usage: {
            totalInputTokens: 100,
            cachedInputTokens: 0,
            freshInputTokens: 100,
            outputTokens: 10,
            reasoningOutputTokens: null,
          },
          agentSteps: 1,
          compactionCount: null,
          quality: {
            totalEvents: 1,
            malformedEvents: 0,
            invalidUsageEvents: 0,
            isComplete: true,
          },
        },
        {
          requestId: "r2",
          usage: {
            totalInputTokens: null,
            cachedInputTokens: null,
            freshInputTokens: null,
            outputTokens: null,
            reasoningOutputTokens: null,
          },
          agentSteps: null,
          compactionCount: null,
          quality: {
            totalEvents: 0,
            malformedEvents: 0,
            invalidUsageEvents: 0,
            isComplete: false,
          },
        },
      ],
    },
    B: {
      comparableGroup: "g1",
      isSynthetic: true,
      requests: [
        {
          requestId: "r1",
          usage: {
            totalInputTokens: 50,
            cachedInputTokens: 0,
            freshInputTokens: 50,
            outputTokens: 5,
            reasoningOutputTokens: null,
          },
          agentSteps: 1,
          compactionCount: null,
          quality: {
            totalEvents: 1,
            malformedEvents: 0,
            invalidUsageEvents: 0,
            isComplete: true,
          },
        },
      ],
    },
  });
  assert.equal(result.variants.A.n, 1);
  assert.equal(result.variants.A.excluded, 1);
  assert.equal(result.variants.B.n, 1);
  assert.equal(result.variants.B.excluded, 0);
});

test("compare: warns on small sample sizes", () => {
  const result = compareRuns({
    A: { comparableGroup: "g1", isSynthetic: true, requests: [] },
    B: { comparableGroup: "g1", isSynthetic: true, requests: [] },
  });
  assert.ok(result.warnings.some((w) => w.includes("only 0")));
});
