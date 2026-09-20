import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { validateModelSlug } from "./policy.js";

export interface Config {
  bin: string;
  defaultWorkspace: string;
  allowedRoot?: string;
  defaultModel?: string;
  maxOutputChars: number;
  maxBufferBytes: number;
  maxConcurrent: number;
  allowFullAutonomy: boolean;
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
    maxConcurrent: integer(env, "AGY_MCP_MAX_CONCURRENT", 4, 1, 32),
    allowFullAutonomy: full === "true",
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
