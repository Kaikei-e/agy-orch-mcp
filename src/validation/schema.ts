import * as z from "zod/v4";
import type { BatchRequestV1, FetchRequestV1 } from "../domain/ir.js";
import { validateModelSlug } from "../policy.js";
import { validateDag, patternsOverlap } from "./dag.js";
import { resolveEffectiveBudget } from "../domain/limits.js";

const noNul = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("\0"), "Must not contain NUL bytes");

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Identifier must contain only letters, numbers, underscores, or hyphens",
  );

// Glob check: allow exact path or /* or /**
const globPattern = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => {
    if (v.includes("\0")) return false;
    return true;
  }, "Invalid glob");

export const taskSpecSchema = z
  .object({
    id: identifier,
    objective: noNul(32_000).refine(
      (v) => v.trim().length > 0,
      "Objective cannot be blank",
    ),
    after: z.array(identifier).optional(),
    scope: z
      .object({
        include: z
          .array(globPattern)
          .min(1, "scope.include must contain at least one pattern"),
        exclude: z.array(globPattern).optional(),
      })
      .strict(),
    owns: z.array(globPattern).min(1, "owns must contain at least one pattern"),
    acceptance: z.array(noNul(4_096)).optional(),
    worker: z
      .object({
        tier: z.enum(["fast", "reasoning"]).optional(),
        model: z
          .string()
          .max(200)
          .refine((v) => {
            try {
              validateModelSlug(v, "model");
              return true;
            } catch {
              return false;
            }
          }, "Invalid model slug")
          .optional(),
        timeout_ms: z.number().int().min(1_000).max(3_600_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const gateSpecSchema = z
  .object({
    id: identifier,
    after: z.array(identifier),
    command: z
      .array(noNul(4_096))
      .min(1, "gate command must contain at least one executable/argument"),
    cwd: noNul(1_024).optional(),
    timeout_ms: z.number().int().min(1_000).max(3_600_000).optional(),
    on_fail: z
      .object({
        repair_attempts: z.number().int().min(0).max(5).optional(),
        escalate_when: z
          .array(
            z.enum([
              "TRANSIENT_INFRA",
              "RATE_LIMIT",
              "WORKER_TIMEOUT",
              "GATE_TIMEOUT",
              "DETERMINISTIC_TEST_FAILURE",
              "SEMANTIC_FAILURE",
              "SCOPE_VIOLATION",
              "PATCH_CONFLICT",
              "REQUIREMENT_AMBIGUITY",
              "ARCHITECTURE_DECISION",
              "POLICY_DENIED",
              "BUDGET_EXHAUSTED",
              "INTERNAL_ERROR",
            ]),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const batchRequestSchema = z
  .object({
    schema_version: z.literal("1"),
    workspace: z
      .object({
        root: noNul(4_096),
        base_revision: noNul(256).optional(),
        dirty_policy: z.enum(["reject", "snapshot"]).default("reject"),
      })
      .strict(),
    tasks: z
      .array(taskSpecSchema)
      .min(1, "tasks must contain at least one task")
      .max(20),
    gates: z.array(gateSpecSchema).max(10).optional(),
    budget: z
      .object({
        max_worker_calls: z.number().int().min(1).max(50).optional(),
        max_replans: z.number().int().min(0).max(5).optional(),
        max_repair_attempts: z.number().int().min(0).max(5).optional(),
        max_parallelism: z.number().int().min(1).max(16).optional(),
        wall_time_ms: z.number().int().min(10_000).max(7_200_000).optional(),
      })
      .strict()
      .optional(),
    return: z
      .object({
        mode: z.literal("digest").default("digest"),
        max_tokens: z.number().int().min(100).max(2_000).default(1_400),
        include_patch_stat: z.boolean().default(true),
      })
      .strict()
      .optional(),
  })
  .strict();

export const selectorRegex =
  /^(task:[a-zA-Z0-9_-]+:(stdout|stderr|patch)|gate:[a-zA-Z0-9_-]+:(stdout|stderr)|manifest|digest|request|plan|events)$/;

export const fetchRequestSchema = z
  .object({
    schema_version: z.literal("1"),
    run_id: noNul(200),
    artifact_id: noNul(200).optional(),
    selector: z
      .string()
      .regex(
        selectorRegex,
        "selector must match 'task:<id>:(stdout|stderr|patch)', 'gate:<id>:(stdout|stderr)', 'manifest', 'digest', 'request', 'plan', or 'events'",
      )
      .optional(),
    start_line: z.number().int().min(1).default(1).optional(),
    max_lines: z.number().int().min(1).max(1_000).default(100).optional(),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(2 * 1024 * 1024)
      .optional(),
    byte_offset: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (data) =>
      (data.artifact_id !== undefined) !== (data.selector !== undefined),
    {
      message: "Exactly one of 'artifact_id' or 'selector' must be provided",
      path: ["artifact_id"],
    },
  );

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function validateGlobPatterns(patterns: string[], field: string) {
  for (const p of patterns) {
    if (!/^([a-zA-Z0-9_\-\.\/]+)(\/\*|\/\*\*|\*)?$/.test(p)) {
      if (p.includes("**") && !p.endsWith("/**")) {
        throw new Error(
          `Invalid glob in ${field}: ${p}. Only exact paths, /*, or /** are supported.`,
        );
      }
    }
  }
}

function computeRecursiveSize(obj: any): number {
  let size = 0;
  if (typeof obj === "string") {
    size += Buffer.byteLength(obj, "utf8");
  } else if (typeof obj === "object" && obj !== null) {
    for (const key of Object.keys(obj)) {
      size += Buffer.byteLength(key, "utf8");
      size += computeRecursiveSize(obj[key]);
    }
  } else if (typeof obj === "number" || typeof obj === "boolean") {
    size += 8;
  }
  return size;
}

export function isPatternContained(child: string, parent: string): boolean {
  const normChild = child.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  const normParent = parent.replace(/\\/g, "/").replace(/\/+/g, "/").trim();

  if (normParent === "**" || normParent === normChild) {
    return true;
  }

  // If parent is a directory wildcard: "dir/**"
  if (normParent.endsWith("/**")) {
    const parentBase = normParent.slice(0, -3);
    if (normChild === parentBase || normChild.startsWith(parentBase + "/")) {
      return true;
    }
  }

  // If parent is single-level wildcard: "dir/*"
  if (normParent.endsWith("/*")) {
    const parentBase = normParent.slice(0, -2);
    if (normChild === normParent) return true;
    if (normChild.startsWith(parentBase + "/")) {
      const remainder = normChild.slice(parentBase.length + 1);
      if (!remainder.includes("/")) {
        return true;
      }
    }
  }

  // Exact path match
  const cleanParent = normParent.replace(/\/+$/, "");
  const cleanChild = normChild.replace(/\/+$/, "");
  return cleanChild === cleanParent;
}

export function validateBatchRequest(
  raw: unknown,
  serverLimits?: any,
): BatchRequestV1 {
  const parseResult = batchRequestSchema.safeParse(raw);
  if (!parseResult.success) {
    throw new Error(
      `Invalid BatchRequest: ${formatZodError(parseResult.error)}`,
    );
  }
  const req = parseResult.data as BatchRequestV1;

  const totalBytes = computeRecursiveSize(raw);
  const limit = serverLimits?.maxPayloadBytes ?? 1024 * 1024;
  if (totalBytes > limit) {
    throw new Error(`Payload exceeds size limit of ${limit} bytes`);
  }

  for (const t of req.tasks) {
    validateGlobPatterns(t.scope.include, "scope.include");
    if (t.scope.exclude) validateGlobPatterns(t.scope.exclude, "scope.exclude");
    validateGlobPatterns(t.owns, "owns");

    for (const own of t.owns) {
      const isIncluded = t.scope.include.some((inc) =>
        isPatternContained(own, inc),
      );
      if (!isIncluded) {
        throw new Error(`owns path ${own} is not within scope.include`);
      }
      if (
        t.scope.exclude &&
        t.scope.exclude.some((exc) => patternsOverlap(own, exc))
      ) {
        throw new Error(`owns path ${own} overlaps with scope.exclude`);
      }
    }
  }

  const dagResult = validateDag(req.tasks, req.gates);
  if (!dagResult.valid) {
    throw new Error(`DAG validation failed: ${dagResult.errors.join("; ")}`);
  }

  if (serverLimits) {
    if (serverLimits.maxTasks && req.tasks.length > serverLimits.maxTasks) {
      throw new Error(
        `Task count (${req.tasks.length}) exceeds server limit (${serverLimits.maxTasks})`,
      );
    }
    if (
      serverLimits.maxGates &&
      req.gates &&
      req.gates.length > serverLimits.maxGates
    ) {
      throw new Error(
        `Gate count (${req.gates.length}) exceeds server limit (${serverLimits.maxGates})`,
      );
    }
    if (req.budget) {
      if (
        serverLimits.maxWorkerCalls &&
        req.budget.max_worker_calls !== undefined &&
        req.budget.max_worker_calls > serverLimits.maxWorkerCalls
      ) {
        throw new Error(
          `Requested max_worker_calls (${req.budget.max_worker_calls}) exceeds server limit (${serverLimits.maxWorkerCalls})`,
        );
      }
      if (
        serverLimits.maxReplans !== undefined &&
        req.budget.max_replans !== undefined &&
        req.budget.max_replans > serverLimits.maxReplans
      ) {
        throw new Error(
          `Requested max_replans (${req.budget.max_replans}) exceeds server limit (${serverLimits.maxReplans})`,
        );
      }
      if (
        serverLimits.maxRepairAttempts !== undefined &&
        req.budget.max_repair_attempts !== undefined &&
        req.budget.max_repair_attempts > serverLimits.maxRepairAttempts
      ) {
        throw new Error(
          `Requested max_repair_attempts (${req.budget.max_repair_attempts}) exceeds server limit (${serverLimits.maxRepairAttempts})`,
        );
      }
      if (
        serverLimits.maxParallelism &&
        req.budget.max_parallelism !== undefined &&
        req.budget.max_parallelism > serverLimits.maxParallelism
      ) {
        throw new Error(
          `Requested max_parallelism (${req.budget.max_parallelism}) exceeds server limit (${serverLimits.maxParallelism})`,
        );
      }
      if (
        serverLimits.maxWallTimeMs &&
        req.budget.wall_time_ms !== undefined &&
        req.budget.wall_time_ms > serverLimits.maxWallTimeMs
      ) {
        throw new Error(
          `Requested wall_time_ms (${req.budget.wall_time_ms}) exceeds server limit (${serverLimits.maxWallTimeMs})`,
        );
      }
      req.budget = resolveEffectiveBudget(req.budget, serverLimits);
    }
  }

  return req;
}

export function validateFetchRequest(raw: unknown): FetchRequestV1 {
  const parseResult = fetchRequestSchema.safeParse(raw);
  if (!parseResult.success) {
    throw new Error(
      `Invalid FetchRequest: ${formatZodError(parseResult.error)}`,
    );
  }
  return parseResult.data as FetchRequestV1;
}
