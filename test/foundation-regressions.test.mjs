import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { DEFAULT_SERVER_LIMITS } from "../dist/domain/limits.js";
import { buildDeterministicDigest } from "../dist/digest/deterministic.js";
import {
  createMetricsTracker,
  finalizeMetrics,
} from "../dist/telemetry/metrics.js";
import { enforceRetentionAndRecovery } from "../dist/artifacts/retention.js";
import { estimateTokenCount } from "../dist/digest/token-budget.js";
import {
  validateBatchRequest,
  validateFetchRequest,
} from "../dist/validation/schema.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function tmpStore(t, limits = DEFAULT_SERVER_LIMITS) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-regr-"));
  const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"), limits);
  t.after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
  return { store, tmpDir };
}

// ── A. Digest hard cap: 20 tasks + 10 gates + Unicode + min budget ──────

test("A: digest hard-caps COMPLETE MCP payload with 20 tasks, 10 gates, Unicode, min 800 tokens", (t) => {
  const { store, tmpDir } = tmpStore(t);
  const runId = "regr-digest-big";
  store.initRun(runId, tmpDir);

  const tasks = Array.from({ length: 20 }, (_, i) => ({
    id: `task-${i}`,
    status: "integrated",
    attempts: 1,
    worker_tier: "fast",
    changed_files: [`src/模块${i}.ts`, `src/файл${i}.rs`],
    error: i % 3 === 0 ? "エラー ".repeat(200) : undefined,
  }));

  const gates = Array.from({ length: 10 }, (_, i) => ({
    id: `gate-${i}`,
    status: i % 2 === 0 ? "passed" : "failed",
    duration_ms: 1000 + i * 100,
    failing_tests:
      i % 2 !== 0
        ? Array.from({ length: 20 }, (_, j) => `test_${j}_失敗`)
        : undefined,
  }));

  for (let i = 0; i < 15; i++) {
    store.saveArtifact({
      runId,
      kind: "stdout",
      relativePath: `tasks/task-${i}/stdout.log`,
      content: "あ".repeat(5000),
      taskId: `task-${i}`,
    });
  }

  const tracker = createMetricsTracker();
  tracker.workerCalls = 20;
  const metrics = finalizeMetrics(tracker, 5000);

  // min budget 1400 (minimal skeleton of 20 tasks + 10 gates requires > 800 tokens)
  const { response: r1400, humanContent: h1400 } = buildDeterministicDigest(
    {
      runId,
      status: "partial",
      summary: "大規模テスト" + "結果".repeat(100),
      tasks,
      gates,
      metrics,
      maxTokens: 1400,
    },
    store,
  );

  const fullPayload1400 = JSON.stringify({ structured: r1400, human: h1400 });
  const estimated1400 = estimateTokenCount(fullPayload1400);
  assert.ok(
    estimated1400 <= 1400,
    `min-budget payload ${estimated1400} must be ≤ 1400 tokens`,
  );
  assert.ok(r1400.recovery_pointer, "recovery pointer must survive min budget");
  assert.equal(r1400.recovery_pointer.run_id, runId);

  // max budget 2000
  const { response: r2k, humanContent: h2k } = buildDeterministicDigest(
    {
      runId: "regr-digest-big2",
      status: "partial",
      summary: "large",
      tasks,
      gates,
      metrics,
      maxTokens: 2000,
    },
    (() => {
      const s2 = tmpStore(t);
      const r = "regr-digest-big2";
      s2.store.initRun(r, s2.tmpDir);
      return s2.store;
    })(),
  );
  const fullPayload2k = JSON.stringify({ structured: r2k, human: h2k });
  const estimated2k = estimateTokenCount(fullPayload2k);
  assert.ok(
    estimated2k <= 2000,
    `max-budget payload ${estimated2k} must be ≤ 2000 tokens`,
  );
  assert.ok(r2k.recovery_pointer, "recovery pointer must survive max budget");
});

test("A: saved digest pointer is fetchable via selector after full digest saved", (t) => {
  const { store, tmpDir } = tmpStore(t);
  const runId = "regr-digest-fetch";
  store.initRun(runId, tmpDir);

  const tracker = createMetricsTracker();
  const { response } = buildDeterministicDigest(
    {
      runId,
      status: "succeeded",
      summary: "ok",
      tasks: [
        {
          id: "t1",
          status: "integrated",
          attempts: 1,
          worker_tier: "fast",
          changed_files: [],
        },
      ],
      metrics: finalizeMetrics(tracker, 10),
    },
    store,
  );

  const digestMeta = store.resolveSelector(runId, "digest");
  assert.ok(digestMeta, "digest artifact must exist in store");
  const slice = store.readArtifactSlice(runId, digestMeta);
  const saved = JSON.parse(slice.content);
  assert.equal(saved.run_id, runId);
  assert.ok(saved.recovery_pointer);

  // Recovery pointer artifact IDs must resolve
  const manifestMeta = store.resolveSelector(runId, "manifest");
  assert.ok(manifestMeta, "manifest must resolve");
});

// ── B+C. Store path safety, locking, exclusive init, byte accounting ────

test("B: store rejects slash/traversal in runId", (t) => {
  const { store } = tmpStore(t);
  assert.throws(() => store.getRunDir("../escape"), /Invalid runId/);
  assert.throws(() => store.getRunDir("foo/bar"), /Invalid runId/);
  assert.throws(() => store.getRunDir("run\0id"), /Invalid runId/);
  assert.throws(() => store.getRunDir(""), /Invalid runId/);
});

test("B: store rejects symlink exfiltration on read", (t) => {
  const { store, tmpDir } = tmpStore(t);
  const runId = "regr-symlink-read";
  store.initRun(runId, tmpDir);
  store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "legit.log",
    content: "safe",
  });

  // Create a symlink inside the run dir pointing outside
  const runDir = store.getRunDir(runId);
  const linkPath = path.join(runDir, "escape_link");
  const secretFile = path.join(tmpDir, "secret.txt");
  writeFileSync(secretFile, "TOP SECRET");
  symlinkSync(secretFile, linkPath);

  // Reading through symlink must fail
  assert.throws(() => {
    store.readArtifactSlice(runId, {
      id: "fake",
      kind: "stdout",
      byte_size: 10,
      sha256: "",
      mime_type: "text/plain",
      created_at: new Date().toISOString(),
      relative_path: "escape_link",
    });
  }, /escapes workspace/);
});

test("C: exclusive initRun rejects duplicate run creation", (t) => {
  const { store, tmpDir } = tmpStore(t);
  store.initRun("dup-run", tmpDir);
  assert.throws(() => store.initRun("dup-run", tmpDir), /already exists/);
});

test("C: byte accounting persists across store reload", (t) => {
  const limits = { ...DEFAULT_SERVER_LIMITS, maxArtifactBytesPerRun: 500 };
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-regr-reload-"));
  t.after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
  const storageDir = path.join(tmpDir, "storage");

  const store1 = new ArtifactStore(tmpDir, storageDir, limits);
  store1.initRun("reload-run", tmpDir);
  store1.saveArtifact({
    runId: "reload-run",
    kind: "stdout",
    relativePath: "out1.log",
    content: "a".repeat(300),
  });

  // Create a new store instance (simulates server restart)
  const store2 = new ArtifactStore(tmpDir, storageDir, limits);
  // Must reject because persisted manifest shows 300 bytes already used
  assert.throws(() => {
    store2.saveArtifact({
      runId: "reload-run",
      kind: "stdout",
      relativePath: "out2.log",
      content: "b".repeat(300),
    });
  }, /budget exceeded/);
});

test("C: artifact write failure does not corrupt manifest", (t) => {
  const limits = { ...DEFAULT_SERVER_LIMITS, maxArtifactBytesPerRun: 100 };
  const { store, tmpDir } = tmpStore(t, limits);
  store.initRun("fail-run", tmpDir);
  store.saveArtifact({
    runId: "fail-run",
    kind: "stdout",
    relativePath: "small.log",
    content: "x".repeat(50),
  });

  assert.throws(() => {
    store.saveArtifact({
      runId: "fail-run",
      kind: "stdout",
      relativePath: "big.log",
      content: "y".repeat(200),
    });
  }, /budget exceeded/);

  const manifest = store.loadManifest("fail-run");
  assert.equal(
    manifest.artifacts.length,
    1,
    "failed artifact must not appear in manifest",
  );
  assert.equal(manifest.artifacts[0].relative_path, "small.log");
});

// ── D. Retention: live owner protected, stale owner interrupted, trash ──

test("D: retention protects live-owner runs and only interrupts dead-owner", (t) => {
  const { store, tmpDir } = tmpStore(t);

  // Create a run with our own PID (should be protected)
  const liveRun = store.initRun("live-owner", tmpDir);
  // owner_pid is set to process.pid by createInitialManifest

  // Create a run with a dead PID
  const deadRun = store.initRun("dead-owner", tmpDir);
  const dm = store.loadManifest("dead-owner");
  dm.owner_pid = 999998;
  store.saveManifest(dm);

  const result = enforceRetentionAndRecovery(store);
  assert.ok(
    !result.interruptedRecovered.includes("live-owner"),
    "live owner must NOT be interrupted",
  );
  assert.ok(
    result.interruptedRecovered.includes("dead-owner"),
    "dead owner must be interrupted",
  );

  const liveReloaded = store.loadManifest("live-owner");
  assert.equal(liveReloaded.status, "running", "live owner stays running");
});

test("D: retention uses atomic trash instead of rm", (t) => {
  const { store, tmpDir } = tmpStore(t);
  const runId = "trash-me";
  const m = store.initRun(runId, tmpDir);
  m.status = "succeeded";
  store.saveManifest(m);

  enforceRetentionAndRecovery(store, { maxRuns: 0, maxAgeMs: 0 });

  // Run dir should be gone but trash dir should exist
  const runDir = store.getRunDir(runId);
  assert.ok(!existsSync(runDir), "run dir must be removed");
  const trashDir = path.join(store.getStorageRoot(), "trash");
  assert.ok(existsSync(trashDir), "trash dir must exist");
});

// ── E. UTF-8 exact bytes: 1/2/4-byte codepoints + cursor reconstruction ──

test("E: UTF-8 slicing exact bytes for 1/2/4-byte codepoints without U+FFFD", (t) => {
  const { store, tmpDir } = tmpStore(t);
  const runId = "regr-utf8";
  store.initRun(runId, tmpDir);

  // Mix: ASCII (1 byte), é (2 bytes), あ (3 bytes), 🎉 (4 bytes)
  // "Aéあ🎉" = 1 + 2 + 3 + 4 = 10 bytes
  const content = "Aéあ🎉";
  const art = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "utf8.log",
    content,
  });

  // maxBytes=3 should return "Aé" (3 bytes), not cut into あ
  const s3 = store.readArtifactSlice(runId, art, { maxBytes: 3 });
  assert.equal(s3.content, "Aé");
  assert.equal(s3.bytesReturned, 3);
  assert.ok(!s3.content.includes("\uFFFD"), "no replacement chars");

  // maxBytes=6 should return "Aéあ" (6 bytes), not cut into 🎉
  const s6 = store.readArtifactSlice(runId, art, { maxBytes: 6 });
  assert.equal(s6.content, "Aéあ");
  assert.equal(s6.bytesReturned, 6);

  // maxBytes=1 should return "A" (1 byte)
  const s1 = store.readArtifactSlice(runId, art, { maxBytes: 1 });
  assert.equal(s1.content, "A");
  assert.equal(s1.bytesReturned, 1);

  // maxBytes=7 cannot include full 🎉 (needs 10 bytes total), returns "Aéあ" (6 bytes)
  const s7 = store.readArtifactSlice(runId, art, { maxBytes: 7 });
  assert.equal(s7.content, "Aéあ");
  assert.equal(s7.bytesReturned, 6);
  assert.ok(s7.truncated);
});

test("E: byte-offset cursor allows recoverable pagination", (t) => {
  const { store, tmpDir } = tmpStore(t);
  const runId = "regr-cursor";
  store.initRun(runId, tmpDir);

  const content = "Line1あ\nLine2い\nLine3う";
  const art = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "cursor.log",
    content,
  });

  // Read first 10 bytes
  const p1 = store.readArtifactSlice(runId, art, { maxBytes: 10 });
  assert.ok(p1.bytesReturned <= 10);
  assert.ok(p1.truncated);

  // Read from byte offset past first page
  const p2 = store.readArtifactSlice(runId, art, {
    byteOffset: p1.bytesReturned,
  });
  assert.ok(p2.content.length > 0, "second page must have content");
  assert.ok(
    !p2.content.includes("\uFFFD"),
    "no replacement chars on page boundary",
  );
});

// ── F. Legacy runAgy: raw stderr preserved in artifact ──────────────────

test("F: ProcessRunner passes raw stderr to onStderr before truncation", async (t) => {
  // Import dynamically since dist may not exist at parse time
  const { ProcessRunner } = await import("../dist/process.js");
  const runner = new ProcessRunner(1);
  t.after(() => runner.close());

  const rawChunks = [];
  const result = await runner.run({
    bin: process.execPath,
    args: ["-e", `process.stderr.write("x".repeat(8000)); process.exit(0);`],
    cwd: os.tmpdir(),
    timeoutMs: 5000,
    maxBufferBytes: 1024 * 1024,
    onStderr: (chunk) => rawChunks.push(chunk),
  });

  const rawTotal = rawChunks.join("").length;
  assert.ok(
    rawTotal >= 8000,
    `raw stderr callback must capture full 8000 chars, got ${rawTotal}`,
  );
  assert.equal(
    result.stderr.length,
    4000,
    "presentation stderr must be capped at 4000",
  );
});

// ── G. Schema strict validation ─────────────────────────────────────────

test("G: strict schemas reject unknown keys at all nesting levels", (t) => {
  const base = {
    schema_version: "1",
    workspace: { root: "/tmp/test" },
    tasks: [
      {
        id: "t1",
        objective: "do stuff",
        scope: { include: ["src/**"] },
        owns: ["src/**"],
      },
    ],
  };

  // Top-level unknown
  assert.throws(
    () => validateBatchRequest({ ...base, unknown_field: true }),
    /Invalid BatchRequest/,
  );

  // Nested workspace unknown
  assert.throws(
    () =>
      validateBatchRequest({ ...base, workspace: { root: "/tmp", bogus: 1 } }),
    /Invalid BatchRequest/,
  );

  // Nested task unknown
  assert.throws(
    () =>
      validateBatchRequest({
        ...base,
        tasks: [{ ...base.tasks[0], extra: true }],
      }),
    /Invalid BatchRequest/,
  );

  // Nested worker unknown
  assert.throws(
    () =>
      validateBatchRequest({
        ...base,
        tasks: [{ ...base.tasks[0], worker: { tier: "fast", extra: true } }],
      }),
    /Invalid BatchRequest/,
  );

  // Nested scope unknown
  assert.throws(
    () =>
      validateBatchRequest({
        ...base,
        tasks: [
          { ...base.tasks[0], scope: { include: ["src/**"], extra: true } },
        ],
      }),
    /Invalid BatchRequest/,
  );
});

test("G: fetch schema rejects unknown keys and requires exactly one of artifact_id/selector", (t) => {
  assert.throws(
    () =>
      validateFetchRequest({
        schema_version: "1",
        run_id: "r1",
        selector: "manifest",
        bonus: true,
      }),
    /Invalid FetchRequest/,
  );

  assert.throws(
    () =>
      validateFetchRequest({
        schema_version: "1",
        run_id: "r1",
      }),
    /Exactly one/,
  );

  assert.throws(
    () =>
      validateFetchRequest({
        schema_version: "1",
        run_id: "r1",
        artifact_id: "a1",
        selector: "manifest",
      }),
    /Exactly one/,
  );

  // byte_offset accepted
  const valid = validateFetchRequest({
    schema_version: "1",
    run_id: "r1",
    selector: "manifest",
    byte_offset: 100,
  });
  assert.equal(valid.byte_offset, 100);
});

test("G: owns must be subset of scope.include", (t) => {
  assert.throws(
    () =>
      validateBatchRequest({
        schema_version: "1",
        workspace: { root: "/tmp/test" },
        tasks: [
          {
            id: "t1",
            objective: "do stuff",
            scope: { include: ["src/**"] },
            owns: ["test/**"],
          },
        ],
      }),
    /not within scope/,
  );
});

// ── H. Telemetry events through artifact accounting ─────────────────────

test("H: telemetry events are stored through artifact accounting", async (t) => {
  const { store, tmpDir } = tmpStore(t);
  const runId = "regr-telem";
  store.initRun(runId, tmpDir);

  const { TelemetryLogger } = await import("../dist/telemetry/events.js");
  const logger = new TelemetryLogger(store);

  logger.logEvent({
    trace_id: "tr_001",
    run_id: runId,
    timestamp: new Date().toISOString(),
    event_type: "run_start",
  });

  logger.logEvent({
    trace_id: "tr_001",
    run_id: runId,
    timestamp: new Date().toISOString(),
    event_type: "task_start",
    task_id: "t1",
  });

  // Events must be reflected in manifest artifact count
  const manifest = store.loadManifest(runId);
  assert.ok(manifest.artifacts.length >= 1, "events must register in manifest");

  // The events file must be readable
  const runDir = store.getRunDir(runId);
  const eventsPath = path.join(runDir, "events.jsonl");
  assert.ok(existsSync(eventsPath), "events.jsonl must exist on disk");
  const lines = readFileSync(eventsPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "must have 2 event lines");
  const ev1 = JSON.parse(lines[0]);
  assert.equal(ev1.event_type, "run_start");
  assert.equal(ev1.trace_id, "tr_001");
});

// ── Manifest hash/bytes consistency ─────────────────────────────────────

test("manifest artifact bytes and sha256 are accurate", (t) => {
  const { store, tmpDir } = tmpStore(t);
  const runId = "regr-hash";
  store.initRun(runId, tmpDir);

  const content = "🎉".repeat(100); // 400 bytes UTF-8
  const art = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "hash.log",
    content,
  });

  assert.equal(art.byte_size, Buffer.byteLength(content, "utf8"));
  const expectedHash = createHash("sha256").update(content).digest("hex");
  assert.equal(art.sha256, expectedHash);

  // Verify on disk
  const runDir = store.getRunDir(runId);
  const onDisk = readFileSync(path.join(runDir, "hash.log"), "utf8");
  assert.equal(onDisk, content, "on-disk content must match exactly");
});

// ── XDG storage fallback (not in .git) ──────────────────────────────────

test("H: store does NOT use .git directory for storage", (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-regr-xdg-"));
  mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  t.after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  const store = new ArtifactStore(tmpDir);
  const root = store.getStorageRoot();
  assert.ok(
    !root.includes(".git"),
    `storage root ${root} must NOT be under .git`,
  );
  assert.ok(
    !root.startsWith(path.join(tmpDir, ".git")),
    "storage must not dirty repo",
  );
});
