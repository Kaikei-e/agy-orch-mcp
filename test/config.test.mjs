import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";

test("loadConfig provides safe defaults with batch disabled and all tool surfaces", () => {
  const config = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
  });

  assert.equal(config.enableBatch, false);
  assert.equal(config.enableFetch, false);
  assert.equal(config.toolSurface, "all");
  assert.equal(config.defaultModel, "gemini-4-argon-high");
  assert.equal(config.fastModel, undefined);
  assert.equal(config.reasoningModel, undefined);
  assert.equal(config.allowFullAutonomy, false);
  assert.equal(config.maxConcurrent, 8);
  assert.equal(config.limits.maxParallelism, 8);
});

test("loadConfig respects AGY_MCP_ENABLE_BATCH=true while maintaining legacy compatibility", () => {
  const config = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
    AGY_MCP_ENABLE_BATCH: "true",
  });

  assert.equal(config.enableBatch, true);
  assert.equal(config.toolSurface, "all");
});

test("loadConfig supports AGY_MCP_TOOL_SURFACE=batch for minimal batch/fetch surface", () => {
  const config = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
    AGY_MCP_TOOL_SURFACE: "batch",
  });

  assert.equal(config.toolSurface, "batch");
  assert.equal(config.enableBatch, true);
  assert.equal(config.enableFetch, true);
});

test("loadConfig supports AGY_MCP_TOOL_PROFILE=batch alias", () => {
  const config = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
    AGY_MCP_TOOL_PROFILE: "batch",
  });

  assert.equal(config.toolSurface, "batch");
  assert.equal(config.enableBatch, true);
  assert.equal(config.enableFetch, true);
});

test("loadConfig rejects invalid AGY_MCP_TOOL_SURFACE", () => {
  assert.throws(() => {
    loadConfig({
      AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
      AGY_MCP_TOOL_SURFACE: "unsupported",
    });
  }, /AGY_MCP_TOOL_SURFACE must be 'all', 'compat', or 'batch'/);
});

test("loadConfig validates and populates fastModel and reasoningModel tiers", () => {
  const config = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
    AGY_MCP_FAST_MODEL: "gemini-2.5-flash",
    AGY_MCP_REASONING_MODEL: "gemini-2.5-pro",
  });

  assert.equal(config.fastModel, "gemini-2.5-flash");
  assert.equal(config.reasoningModel, "gemini-2.5-pro");
});

test("loadConfig rejects invalid model slug for tier models", () => {
  assert.throws(() => {
    loadConfig({
      AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
      AGY_MCP_FAST_MODEL: "-invalid-flag-slug",
    });
  }, /must not contain whitespace, NUL, or start with a dash/);

  assert.throws(() => {
    loadConfig({
      AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
      AGY_MCP_REASONING_MODEL: "has spaces model",
    });
  }, /must not contain whitespace, NUL, or start with a dash/);
});

test("loadConfig composes limits.maxParallelism with maxConcurrent", () => {
  const config = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
    AGY_MCP_MAX_CONCURRENT: "2",
  });

  assert.equal(config.maxConcurrent, 2);
  assert.equal(config.limits.maxParallelism, 2);
});

test("loadConfig strictly validates AGY_MCP_ENABLE_BATCH and AGY_MCP_ENABLE_FETCH booleans", () => {
  assert.throws(() => {
    loadConfig({
      AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
      AGY_MCP_ENABLE_BATCH: "yes",
    });
  }, /AGY_MCP_ENABLE_BATCH must be true or false/);

  assert.throws(() => {
    loadConfig({
      AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
      AGY_MCP_ENABLE_FETCH: "1",
    });
  }, /AGY_MCP_ENABLE_FETCH must be true or false/);
});

test("loadConfig rejects contradictory flags that would publish neither tool in batch surface", () => {
  assert.throws(() => {
    loadConfig({
      AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
      AGY_MCP_TOOL_SURFACE: "batch",
      AGY_MCP_ENABLE_BATCH: "false",
      AGY_MCP_ENABLE_FETCH: "false",
    });
  }, /Contradictory configuration.*publish neither tool/);
});

test("loadConfig parses guard, envIsolation, tasks, and envRoot with defaults and strict validation", () => {
  const defaults = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
  });
  assert.equal(defaults.guard, true);
  assert.equal(defaults.envIsolation, "full");
  assert.equal(defaults.tasks, true);
  assert.equal(
    defaults.envRoot,
    path.join(os.homedir(), ".local", "state", "agy-orch", "env"),
  );

  const xdg = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
    XDG_STATE_HOME: "/tmp/custom-xdg-state",
    AGY_MCP_GUARD: "off",
    AGY_MCP_ENV_ISOLATION: "install",
    AGY_MCP_TASKS: "off",
  });
  assert.equal(xdg.guard, false);
  assert.equal(xdg.envIsolation, "install");
  assert.equal(xdg.tasks, false);
  assert.equal(
    xdg.envRoot,
    path.join("/tmp/custom-xdg-state", "agy-orch", "env"),
  );

  const customRoot = loadConfig({
    AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
    AGY_MCP_GUARD: "on",
    AGY_MCP_ENV_ISOLATION: "off",
    AGY_MCP_TASKS: "auto",
    AGY_MCP_ENV_ROOT: "/tmp/custom-env-root",
  });
  assert.equal(customRoot.guard, true);
  assert.equal(customRoot.envIsolation, "off");
  assert.equal(customRoot.tasks, true);
  assert.equal(customRoot.envRoot, path.resolve("/tmp/custom-env-root"));

  assert.throws(
    () =>
      loadConfig({
        AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
        AGY_MCP_GUARD: "true",
      }),
    /AGY_MCP_GUARD/,
  );
  assert.throws(
    () =>
      loadConfig({
        AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
        AGY_MCP_ENV_ISOLATION: "sandbox",
      }),
    /AGY_MCP_ENV_ISOLATION/,
  );
  assert.throws(
    () =>
      loadConfig({
        AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
        AGY_MCP_TASKS: "on",
      }),
    /AGY_MCP_TASKS/,
  );
  assert.throws(
    () =>
      loadConfig({
        AGY_MCP_DEFAULT_WORKSPACE: process.cwd(),
        AGY_MCP_ENV_ROOT: "   ",
      }),
    /AGY_MCP_ENV_ROOT/,
  );
});
