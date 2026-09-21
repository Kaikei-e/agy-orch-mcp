import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectSecrets,
  redactSecrets,
  inspectPatchForSecrets,
} from "../dist/artifacts/redaction.js";

test("detectSecrets identifies sensitive API keys and tokens", () => {
  assert.equal(detectSecrets("AIzaSyD-1234567890abcdefghijklmnopqrstuv"), true);
  assert.equal(
    detectSecrets("ghp_1234567890abcdefghijklmnopqrstuvwxyz12"),
    true,
  );
  assert.equal(
    detectSecrets("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz"),
    true,
  );
  assert.equal(detectSecrets("public ordinary text with no secrets"), false);
});

test("redactSecrets sanitizes tokens without retaining originals", () => {
  const input =
    "Connecting with token: ghp_1234567890abcdefghijklmnopqrstuvwxyz12 and secret: 'super_secret_password'";
  const result = redactSecrets(input);

  assert.equal(result.found, true);
  assert.ok(
    !result.redacted.includes("ghp_1234567890abcdefghijklmnopqrstuvwxyz12"),
  );
  assert.ok(result.redacted.includes("[REDACTED_GITHUB_TOKEN]"));
});

test("inspectPatchForSecrets fails closed when patches contain secrets", () => {
  const cleanPatch = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
-console.log("hello");
+console.log("world");
`;
  const cleanCheck = inspectPatchForSecrets(cleanPatch);
  assert.equal(cleanCheck.safe, true);

  const dirtyPatch = `--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,3 @@
-const token = "";
+const token = "AIzaSyD-1234567890abcdefghijklmnopqrstuv";
`;
  const dirtyCheck = inspectPatchForSecrets(dirtyPatch);
  assert.equal(dirtyCheck.safe, false);
  assert.ok(dirtyCheck.reason?.includes("secrets"));
});
