import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { executeFetch } from "../dist/tools/antigravity-fetch.js";

function setupStore(t) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-test-fetch-"));
  const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"));
  t.after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
  return { store, tmpDir };
}

test("executeFetch retrieves artifact content with line pagination", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "fetch-run-1";
  store.initRun(runId, tmpDir);

  const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join(
    "\n",
  );
  const art = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "tasks/t1/attempt-001/stdout.log",
    content: lines,
    taskId: "t1",
    attempt: 1,
  });

  // Fetch lines 10-19 (10 lines)
  const result = executeFetch(
    {
      schema_version: "1",
      run_id: runId,
      artifact_id: art.id,
      start_line: 10,
      max_lines: 10,
    },
    store,
  );

  assert.equal(result.isError, false);
  const data = result.structuredContent;
  assert.equal(data.artifact.id, art.id);
  assert.equal(data.range.start_line, 10);
  assert.equal(data.range.lines_returned, 10);
  assert.equal(data.range.total_lines, 50);
  assert.equal(data.range.truncated, true);
  assert.ok(data.content.startsWith("Line 10"));
  assert.ok(data.content.endsWith("Line 19"));
});

test("executeFetch resolves logical selector task:t1:stdout", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "fetch-run-2";
  store.initRun(runId, tmpDir);

  store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "tasks/t1/attempt-001/stdout.log",
    content: "Task 1 output via selector",
    taskId: "t1",
    attempt: 1,
  });

  const result = executeFetch(
    {
      schema_version: "1",
      run_id: runId,
      selector: "task:t1:stdout",
    },
    store,
  );

  assert.equal(result.isError, false);
  const data = result.structuredContent;
  assert.equal(data.content, "Task 1 output via selector");
});

test("executeFetch safely slices UTF-8 multibyte characters without corruption", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "fetch-run-utf8";
  store.initRun(runId, tmpDir);

  // Each Japanese character is 3 bytes in UTF-8
  const multibyte = "日本語テキスト\n".repeat(20);
  const art = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "out.log",
    content: multibyte,
  });

  // Request max 50 bytes
  const result = executeFetch(
    {
      schema_version: "1",
      run_id: runId,
      artifact_id: art.id,
      max_bytes: 50,
    },
    store,
  );

  assert.equal(result.isError, false);
  const data = result.structuredContent;
  assert.ok(data.range.bytes_returned <= 50);
  assert.equal(data.range.truncated, true);
  // Verify valid UTF-8 string
  assert.doesNotThrow(() => {
    Buffer.from(data.content, "utf8");
  });
});

test("executeFetch returns clear notice for binary artifacts without inline dump", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "fetch-run-binary";
  store.initRun(runId, tmpDir);

  const binBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
  const art = store.saveArtifact({
    runId,
    kind: "custom",
    relativePath: "data.bin",
    content: binBuffer,
    isBinary: true,
  });

  const result = executeFetch(
    {
      schema_version: "1",
      run_id: runId,
      artifact_id: art.id,
    },
    store,
  );

  assert.equal(result.isError, false);
  const data = result.structuredContent;
  assert.equal(data.artifact.is_binary, true);
  assert.ok(data.content.includes("Binary artifact"));
  assert.ok(data.content.includes("Inline inspection not supported"));
});

test("executeFetch returns structured error for non-existent run or artifact", (t) => {
  const { store } = setupStore(t);
  const missingRun = executeFetch(
    {
      schema_version: "1",
      run_id: "missing-run-id",
      selector: "manifest",
    },
    store,
  );
  assert.equal(missingRun.isError, true);
  assert.ok(missingRun.content[0].text.includes("Run not found"));
});
