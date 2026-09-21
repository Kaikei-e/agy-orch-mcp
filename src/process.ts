import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failure?: "SPAWN_ERROR" | "TIMEOUT" | "CANCELED" | "OUTPUT_LIMIT" | "BUSY";
  error?: string;
}

export interface ProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBufferBytes: number;
  maxArtifactBytes?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  lockKey?: string;
  exclusive?: boolean;
}

const failureResult = (
  failure: ProcessResult["failure"],
  error: string,
): ProcessResult => ({
  stdout: "",
  stderr: "",
  exitCode: null,
  failure,
  error,
});

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.on("error", () => {
        child.kill(signal);
      });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

export class ProcessRunner {
  private readonly active = new Set<{
    stop: () => void;
    done: Promise<ProcessResult>;
    lockKey?: string;
    exclusive: boolean;
  }>();
  private closed = false;

  constructor(private readonly maxConcurrent = 4) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)
      throw new Error("maxConcurrent must be a positive integer");
  }

  async close(): Promise<void> {
    this.closed = true;
    const active = [...this.active];
    for (const process of active) process.stop();
    await Promise.all(active.map((process) => process.done));
  }

  run(options: ProcessOptions): Promise<ProcessResult> {
    if (this.closed || options.signal?.aborted)
      return Promise.resolve(
        failureResult("CANCELED", "Request canceled before starting agy"),
      );
    if (
      this.active.size > 0 &&
      (options.exclusive ||
        [...this.active].some((process) => process.exclusive))
    )
      return Promise.resolve(
        failureResult(
          "BUSY",
          "Continuing the latest conversation requires exclusive access. Wait for active calls to finish or use an explicit conversation_id.",
        ),
      );
    if (
      options.lockKey !== undefined &&
      [...this.active].some((process) => process.lockKey === options.lockKey)
    )
      return Promise.resolve(
        failureResult(
          "BUSY",
          "This conversation is already running. Wait for it to finish before continuing it.",
        ),
      );
    if (this.active.size >= this.maxConcurrent)
      return Promise.resolve(
        failureResult(
          "BUSY",
          `All ${this.maxConcurrent} agy slots are in use. Wait for a call to finish or raise AGY_MCP_MAX_CONCURRENT.`,
        ),
      );

    let cancel = () => {};
    const done = new Promise<ProcessResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(options.bin, options.args, {
          cwd: options.cwd,
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        resolve(failureResult("SPAWN_ERROR", String(error)));
        return;
      }
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let failure: ProcessResult["failure"];
      let error: string | undefined;
      let finished = false;
      let killTimer: NodeJS.Timeout | undefined;
      let forceCloseTimer: NodeJS.Timeout | undefined;
      let exitCodeReceived: number | null = null;
      const pid = child.pid;

      const stop = (reason: ProcessResult["failure"], message: string) => {
        if (finished || failure) return;
        failure = reason;
        error = message;
        killTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          killTree(child, "SIGKILL");
          // If stdio still keeps the process from closing, force destroy streams
          forceCloseTimer = setTimeout(() => {
            try {
              child.stdout?.destroy();
            } catch {}
            try {
              child.stderr?.destroy();
            } catch {}
            finish(exitCodeReceived ?? null);
          }, 500);
        }, 1_000);
      };
      cancel = () => stop("CANCELED", "Request canceled");
      const timeout = setTimeout(
        () =>
          stop("TIMEOUT", `agy exceeded ${options.timeoutMs / 1_000} seconds`),
        options.timeoutMs,
      );
      const finish = (exitCode: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        clearTimeout(forceCloseTimer);
        options.signal?.removeEventListener("abort", cancel);
        // Only reap if we terminated with failure/stop
        if (failure && pid) {
          killTree(child, "SIGKILL");
        }
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? exitCodeReceived,
          failure,
          error,
        });
      };

      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");

      child.stdout!.on("data", (chunk: string) => {
        if (failure) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > options.maxBufferBytes) {
          stop(
            "OUTPUT_LIMIT",
            `agy stdout exceeded ${options.maxBufferBytes} bytes; narrow the task or raise AGY_MCP_MAX_BUFFER_BYTES`,
          );
          return;
        }
        stdout += chunk;
        // Pass to raw handler for artifact capture
        options.onStdout?.(chunk);
      });

      child.stderr!.on("data", (chunk: string) => {
        // Pass to raw handler for artifact capture before truncation
        options.onStderr?.(chunk);
        stderr = (stderr + chunk).slice(-4_000);
      });

      child.on("error", (cause) => {
        failure = "SPAWN_ERROR";
        error = `Could not start ${options.bin}: ${cause.message}. Install agy or set AGY_MCP_BIN to its executable path.`;
        finish(null);
      });
      child.on("exit", (code) => {
        exitCodeReceived = code;
        if (failure) {
          // Parent exited during stop/cleanup flow: immediately reap any lingering grandchildren
          if (pid) killTree(child, "SIGKILL");
        } else {
          // Normal exit: wait briefly for close event, force finish if stdio leaked
          forceCloseTimer = setTimeout(() => {
            try {
              child.stdout?.destroy();
            } catch {}
            try {
              child.stderr?.destroy();
            } catch {}
            finish(code);
          }, 500);
        }
      });
      child.on("close", finish);
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
    const active = {
      stop: () => cancel(),
      done,
      lockKey: options.lockKey,
      exclusive: options.exclusive ?? false,
    };
    this.active.add(active);
    void done.then(() => {
      this.active.delete(active);
    });
    return done;
  }
}
