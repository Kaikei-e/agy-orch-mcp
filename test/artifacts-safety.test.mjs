import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../dist/artifacts/store.js";
import { DEFAULT_SERVER_LIMITS } from "../dist/domain/limits.js";

function setupStore(t, limits = DEFAULT_SERVER_LIMITS) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "agy-test-store-safe-"));
  const store = new ArtifactStore(tmpDir, path.join(tmpDir, "storage"), limits);
  t.after(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
  return { store, tmpDir };
}

test("ArtifactStore rejects symlink exfiltration", (t) => {
  const { store, tmpDir } = setupStore(t);
  const runId = "test-run-symlink";
  store.initRun(runId, tmpDir);

  const runDir = store.getRunDir(runId);
  const maliciousLink = path.join(runDir, "malicious_link");
  // point to something outside
  symlinkSync(os.tmpdir(), maliciousLink);

  assert.throws(() => {
    store.saveArtifact({
      runId,
      kind: "stdout",
      relativePath: "malicious_link/sneaky.log",
      content: "you got hacked",
    });
  }, /Symlink exfiltration attempt/);
});

test("ArtifactStore performs exact safe UTF-8 slicing", (t) => {
  const limits = { ...DEFAULT_SERVER_LIMITS, maxFetchBytes: 10 };
  const { store, tmpDir } = setupStore(t, limits);
  const runId = "test-run-utf8";
  store.initRun(runId, tmpDir);

  // Japanese chars are 3 bytes each in UTF-8
  // "あいうえお" = 15 bytes
  const content = "あいうえお";
  const artifact = store.saveArtifact({
    runId,
    kind: "stdout",
    relativePath: "stdout.log",
    content,
  });

  const sliceResult = store.readArtifactSlice(runId, artifact);
  assert.equal(sliceResult.truncated, true);

  // 10 bytes limit. "あいう" is 9 bytes. The next char "え" is 3 bytes (total 12 bytes).
  // Therefore, sliceResult.content should be exactly 9 bytes ("あいう") and not contain \uFFFD.
  assert.equal(sliceResult.content, "あいう");
  assert.equal(sliceResult.bytesReturned, 9);
});
