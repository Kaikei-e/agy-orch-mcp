import { randomUUID } from "node:crypto";
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY =
  "io.modelcontextprotocol/clientCapabilities";
const MODERN_PROTOCOL_VERSION = "2026-07-28";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_RETAIN_MS = 3_600_000;

export type TaskStatus = "working" | "completed" | "failed" | "cancelled";

export interface TaskAnswer {
  [key: string]: unknown;
  resultType: "task";
  taskId: string;
  status: "working";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: null;
  pollIntervalMs: number;
}

export interface TaskError {
  code: number;
  message: string;
  data?: unknown;
}

export interface TaskGetResult {
  [key: string]: unknown;
  resultType: "complete";
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: null;
  statusMessage?: string;
  pollIntervalMs: number;
  result?: CallToolResult;
  error?: TaskError;
}

export interface TaskRegistryOptions {
  pollIntervalMs?: number;
  retainMs?: number;
  now?: () => Date;
}

interface InternalTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAtMs?: number;
  result?: CallToolResult;
  error?: TaskError;
  controller: AbortController;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTaskAnswer(value: unknown): value is TaskAnswer {
  return (
    isPlainObject(value) &&
    value.resultType === "task" &&
    typeof value.taskId === "string" &&
    value.status === "working"
  );
}

/**
 * Casts a `TaskAnswer` to `CallToolResult` so a `server.registerTool` callback
 * can return it directly.
 */
export function asTaskToolResult(task: TaskAnswer): CallToolResult {
  return task as unknown as CallToolResult;
}

/**
 * Runs `run` as an asynchronous MCP task when the connection negotiated
 * `2026-07-28` and the request advertises `io.modelcontextprotocol/tasks` in
 * `context.mcpReq.envelope` (or `context.mcpReq._meta`), or executes `run`
 * inline and returns a standard `CallToolResult` otherwise.
 */
export function runToolOrTask(
  server: McpServer,
  registry: TaskRegistry,
  context: ServerContext,
  run: (
    signal: AbortSignal,
    setStatus: (message: string) => void,
  ) => Promise<CallToolResult>,
  statusMessage?: string,
): Promise<CallToolResult> | CallToolResult {
  const negotiated = server.server.getNegotiatedProtocolVersion();
  const meta = context.mcpReq.envelope ?? context.mcpReq._meta;
  if (negotiated === MODERN_PROTOCOL_VERSION && clientRequestsTasks(meta)) {
    return asTaskToolResult(registry.start(run, statusMessage));
  }
  return run(context.mcpReq.signal, () => {});
}

export function clientRequestsTasks(requestMeta: unknown): boolean {
  if (!isPlainObject(requestMeta)) return false;
  const candidate = isPlainObject(requestMeta.mcpReq)
    ? (requestMeta.mcpReq.envelope ?? requestMeta.mcpReq._meta)
    : (requestMeta.envelope ?? requestMeta._meta ?? requestMeta);
  if (!isPlainObject(candidate)) return false;

  const version = candidate[PROTOCOL_VERSION_META_KEY];
  if (version !== undefined && version !== MODERN_PROTOCOL_VERSION) {
    return false;
  }
  const capabilities = candidate[CLIENT_CAPABILITIES_META_KEY];
  if (!isPlainObject(capabilities)) return false;
  const extensions = capabilities.extensions;
  if (!isPlainObject(extensions)) return false;
  return isPlainObject(extensions[TASKS_EXTENSION_ID]);
}

export class TaskRegistry {
  private readonly pollIntervalMs: number;
  private readonly retainMs: number;
  private readonly now: () => Date;
  private readonly tasks = new Map<string, InternalTask>();

  constructor(options?: TaskRegistryOptions) {
    const rawPoll = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollIntervalMs = Math.min(
      MAX_POLL_INTERVAL_MS,
      Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(rawPoll)),
    );
    this.retainMs = Math.max(
      0,
      Math.trunc(options?.retainMs ?? DEFAULT_RETAIN_MS),
    );
    this.now = options?.now ?? (() => new Date());
  }

  private prune(): void {
    const nowMs = this.now().getTime();
    for (const [id, entry] of this.tasks) {
      if (
        entry.finishedAtMs !== undefined &&
        nowMs - entry.finishedAtMs >= this.retainMs
      ) {
        this.tasks.delete(id);
      }
    }
  }

  start(
    run: (
      signal: AbortSignal,
      setStatus: (message: string) => void,
    ) => Promise<CallToolResult>,
    statusMessage?: string,
  ): TaskAnswer {
    this.prune();
    const taskId = `task_${randomUUID()}`;
    const createdIso = this.now().toISOString();
    const controller = new AbortController();
    const entry: InternalTask = {
      taskId,
      status: "working",
      statusMessage,
      createdAt: createdIso,
      lastUpdatedAt: createdIso,
      controller,
    };
    this.tasks.set(taskId, entry);

    const setStatus = (message: string): void => {
      if (entry.status !== "working") return;
      entry.statusMessage = message;
      entry.lastUpdatedAt = this.now().toISOString();
    };

    let execution: Promise<CallToolResult>;
    try {
      execution = Promise.resolve(run(controller.signal, setStatus));
    } catch (error) {
      execution = Promise.reject(error);
    }

    execution.then(
      (result) => {
        if (entry.status !== "working") return;
        const finished = this.now();
        entry.status = "completed";
        entry.result = result;
        entry.lastUpdatedAt = finished.toISOString();
        entry.finishedAtMs = finished.getTime();
      },
      (error: unknown) => {
        if (entry.status !== "working") return;
        const finished = this.now();
        const rawCode = isPlainObject(error) ? error.code : undefined;
        const code =
          typeof rawCode === "number" && Number.isSafeInteger(rawCode)
            ? rawCode
            : ProtocolErrorCode.InternalError;
        const message = error instanceof Error ? error.message : String(error);
        const data = isPlainObject(error) ? error.data : undefined;
        entry.status = "failed";
        entry.error = {
          code,
          message,
          ...(data !== undefined ? { data } : {}),
        };
        entry.lastUpdatedAt = finished.toISOString();
        entry.finishedAtMs = finished.getTime();
      },
    );

    return {
      resultType: "task",
      taskId,
      status: "working",
      ...(entry.statusMessage !== undefined
        ? { statusMessage: entry.statusMessage }
        : {}),
      createdAt: entry.createdAt,
      lastUpdatedAt: entry.lastUpdatedAt,
      ttlMs: null,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  get(taskId: string): TaskGetResult | undefined {
    this.prune();
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    return {
      resultType: "complete",
      taskId: entry.taskId,
      status: entry.status,
      createdAt: entry.createdAt,
      lastUpdatedAt: entry.lastUpdatedAt,
      ttlMs: null,
      ...(entry.statusMessage !== undefined
        ? { statusMessage: entry.statusMessage }
        : {}),
      pollIntervalMs: this.pollIntervalMs,
      ...(entry.status === "completed" && entry.result !== undefined
        ? { result: entry.result }
        : {}),
      ...(entry.status === "failed" && entry.error !== undefined
        ? { error: entry.error }
        : {}),
    };
  }

  cancel(taskId: string): boolean {
    this.prune();
    const entry = this.tasks.get(taskId);
    if (!entry || entry.status !== "working") return false;
    const finished = this.now();
    entry.status = "cancelled";
    entry.statusMessage ??= "Task cancelled";
    entry.lastUpdatedAt = finished.toISOString();
    entry.finishedAtMs = finished.getTime();
    entry.controller.abort(new Error("Task cancelled"));
    return true;
  }
}

const taskIdParamsSchema = z.object({
  taskId: z.string().min(1).max(128),
});

/**
 * Installs MCP Tasks (`io.modelcontextprotocol/tasks`, revision `2026-07-28`)
 * on `server`. Returns `true` when the SDK surface is compatible and the
 * extension handlers were registered, or `false` without mutating `server` if
 * required SDK methods are missing.
 *
 * How `server.ts` must wire this:
 * 1. Create `const tasks = new TaskRegistry();` and call
 *    `const tasksEnabled = installTasksExtension(server, tasks);` inside
 *    `createServer()` before connecting the transport (if `!tasksEnabled`,
 *    log `tasks_disabled` and continue serving plain tool calls).
 * 2. In long-running tool callbacks (`antigravity_run`, `antigravity_continue`,
 *    `antigravity_batch`), delegate execution through
 *    `runToolOrTask(server, tasks, context, (signal, setStatus) => ..., initialStatus)`.
 */
export function installTasksExtension(
  server: McpServer,
  registry: TaskRegistry,
): boolean {
  const underlying = (server as { server?: unknown } | null | undefined)
    ?.server;
  if (
    !isPlainObject(underlying) ||
    typeof underlying.registerCapabilities !== "function" ||
    typeof underlying.setRequestHandler !== "function" ||
    typeof underlying.getNegotiatedProtocolVersion !== "function"
  ) {
    return false;
  }

  try {
    server.server.registerCapabilities({
      extensions: { [TASKS_EXTENSION_ID]: {} },
    });

    server.server.setRequestHandler(
      "tasks/get",
      { params: taskIdParamsSchema },
      (params) => {
        const task = registry.get(params.taskId);
        if (!task) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Unknown taskId: ${params.taskId}`,
          );
        }
        return task;
      },
    );

    server.server.setRequestHandler(
      "tasks/cancel",
      { params: taskIdParamsSchema },
      (params) => {
        const existing = registry.get(params.taskId);
        if (!existing) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Unknown taskId: ${params.taskId}`,
          );
        }
        registry.cancel(params.taskId);
        return registry.get(params.taskId)!;
      },
    );

    server.server.setRequestHandler(
      "tasks/update",
      { params: z.looseObject({}) },
      () => {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "tasks/update is not supported: server never requests task input",
        );
      },
    );
    return true;
  } catch {
    return false;
  }
}
