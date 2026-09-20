import assert from "node:assert/strict";
import test from "node:test";
import { validateModelSlug } from "../dist/policy.js";

test("validateModelSlug handles valid slugs", () => {
  assert.equal(validateModelSlug(undefined, "test"), undefined);
  assert.equal(validateModelSlug("test-model", "test"), "test-model");
  assert.equal(
    validateModelSlug("test-model-sonnet", "test"),
    "test-model-sonnet",
  );
  assert.equal(validateModelSlug("a", "test"), "a");
  assert.equal(validateModelSlug("a".repeat(200), "test"), "a".repeat(200));
});

test("validateModelSlug rejects invalid slugs", () => {
  assert.throws(
    () => validateModelSlug("", "test"),
    /must be between 1 and 200/,
  );
  assert.throws(
    () => validateModelSlug("a".repeat(201), "test"),
    /must be between 1 and 200/,
  );
  for (const whitespace of [" ", "\t", "\n", "\r", "\f", "\v"]) {
    assert.throws(
      () => validateModelSlug(`${whitespace}model`, "test"),
      /must not contain whitespace, NUL, or start with a dash/,
    );
    assert.throws(
      () => validateModelSlug(`model${whitespace}`, "test"),
      /must not contain whitespace, NUL, or start with a dash/,
    );
    assert.throws(
      () => validateModelSlug(`mod${whitespace}el`, "test"),
      /must not contain whitespace, NUL, or start with a dash/,
    );
  }
  for (const nul of ["\0", "\u0000"]) {
    assert.throws(
      () => validateModelSlug(`model${nul}`, "test"),
      /must not contain whitespace, NUL, or start with a dash/,
    );
    assert.throws(
      () => validateModelSlug(`${nul}model`, "test"),
      /must not contain whitespace, NUL, or start with a dash/,
    );
    assert.throws(
      () => validateModelSlug(`mod${nul}el`, "test"),
      /must not contain whitespace, NUL, or start with a dash/,
    );
  }
  assert.throws(() => validateModelSlug("-model", "test"), /start with a dash/);
  assert.throws(
    () => validateModelSlug("--dangerously-skip-permissions", "test"),
    /start with a dash/,
  );
});
