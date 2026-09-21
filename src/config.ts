import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { validateModelSlug } from "./policy.js";

import type { ServerLimits } from "./domain/limits.js";
import { DEFAULT_SERVER_LIMITS } from "./domain/limits.js";

export type ToolSurface = "all" | "batch";

export interface Config {
  bin: string;
  defaultWorkspace: string;
  allowedRoot?: string;
  defaultModel?: string;
  fastModel?: string;
  reasoningModel?: string;
  maxOutputChars: number;
  maxBufferBytes: number;
  maxConcurrent: number;
  allowFullAutonomy: boolean;
  storageDir?: string;
  limits: ServerLimits;
  enableFetch: boolean;
  enableBatch: boolean;
  toolSurface: ToolSurface;
}

function directory(value: string): string {
  const resolved = path.resolve(value);
  try {
    const real = realpathSync(resolved);
    if (statSync(real).isDirectory()) return real;
  } catch {
    // Report the setting, not a platform-specific filesystem stack trace.
  }
  throw new Error(`Workspace is not an accessible directory: ${resolved}`);
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Config {
  const bin = env.AGY_MCP_BIN ?? "agy";
  if (!bin.trim() || bin !== bin.trim() || bin.includes("\0"))
    throw new Error("AGY_MCP_BIN must be an executable name or path");
  for (const key of [
    "AGY_MCP_DEFAULT_WORKSPACE",
    "AGY_MCP_ALLOWED_ROOT",
  ] as const) {
    if (env[key] !== undefined && !env[key].trim())
      throw new Error(`${key} must not be blank`);
  }
  const full = env.AGY_MCP_ALLOW_FULL_AUTONOMY ?? "false";
  if (full !== "true" && full !== "false")
    throw new Error("AGY_MCP_ALLOW_FULL_AUTONOMY must be true or false");
  const rawSurface = (
    env.AGY_MCP_TOOL_SURFACE ??
    env.AGY_MCP_TOOL_PROFILE ??
    "all"
  )
    .trim()
    .toLowerCase();
  if (
    rawSurface !== "all" &&
    rawSurface !== "batch" &&
    rawSurface !== "compat"
  ) {
    throw new Error("AGY_MCP_TOOL_SURFACE must be 'all', 'compat', or 'batch'");
  }
  const toolSurface: ToolSurface = rawSurface === "batch" ? "batch" : "all";
  const batchEnv = env.AGY_MCP_ENABLE_BATCH;
  if (batchEnv !== undefined && batchEnv !== "true" && batchEnv !== "false") {
    throw new Error("AGY_MCP_ENABLE_BATCH must be true or false");
  }
  const fetchEnv = env.AGY_MCP_ENABLE_FETCH;
  if (fetchEnv !== undefined && fetchEnv !== "true" && fetchEnv !== "false") {
    throw new Error("AGY_MCP_ENABLE_FETCH must be true or false");
  }

  const enableBatch =
    batchEnv !== undefined ? batchEnv === "true" : toolSurface === "batch";
  const enableFetch =
    fetchEnv !== undefined ? fetchEnv === "true" : toolSurface === "batch";

  if (toolSurface === "batch" && !enableBatch && !enableFetch) {
    throw new Error(
      "Contradictory configuration: AGY_MCP_TOOL_SURFACE 'batch' would publish neither tool when both batch and fetch are disabled",
    );
  }

  const maxConcurrent = integer(env, "AGY_MCP_MAX_CONCURRENT", 4, 1, 32);

  const config: Config = {
    bin: bin.includes("/") || bin.includes("\\") ? path.resolve(cwd, bin) : bin,
    defaultWorkspace: directory(
      path.resolve(cwd, env.AGY_MCP_DEFAULT_WORKSPACE ?? "."),
    ),
    allowedRoot:
      env.AGY_MCP_ALLOWED_ROOT === undefined
        ? undefined
        : directory(path.resolve(cwd, env.AGY_MCP_ALLOWED_ROOT)),
    defaultModel: validateModelSlug(
      env.AGY_MCP_DEFAULT_MODEL,
      "AGY_MCP_DEFAULT_MODEL",
    ),
    fastModel: validateModelSlug(env.AGY_MCP_FAST_MODEL, "AGY_MCP_FAST_MODEL"),
    reasoningModel: validateModelSlug(
      env.AGY_MCP_REASONING_MODEL,
      "AGY_MCP_REASONING_MODEL",
    ),
    maxOutputChars: integer(
      env,
      "AGY_MCP_MAX_OUTPUT_CHARS",
      40_000,
      1_024,
      1_000_000,
    ),
    maxBufferBytes: integer(
      env,
      "AGY_MCP_MAX_BUFFER_BYTES",
      8_388_608,
      1_024,
      67_108_864,
    ),
    maxConcurrent,
    allowFullAutonomy: full === "true",
    storageDir:
      env.AGY_ORCH_STORAGE_DIR && env.AGY_ORCH_STORAGE_DIR.trim()
        ? path.resolve(cwd, env.AGY_ORCH_STORAGE_DIR)
        : undefined,
    limits: {
      ...DEFAULT_SERVER_LIMITS,
      maxParallelism: Math.min(
        DEFAULT_SERVER_LIMITS.maxParallelism,
        maxConcurrent,
      ),
    },
    enableFetch,
    enableBatch,
    toolSurface,
  };
  resolveWorkspace(undefined, config);
  return config;
}

export function resolveWorkspace(
  input: string | undefined,
  config: Config,
): string {
  if (input !== undefined && !path.isAbsolute(input))
    throw new Error("workspace must be an absolute path");
  const workspace = directory(input ?? config.defaultWorkspace);
  if (config.allowedRoot) {
    const relative = path.relative(config.allowedRoot, workspace);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Workspace is outside AGY_MCP_ALLOWED_ROOT: ${workspace}`,
      );
    }
  }
  return workspace;
}
