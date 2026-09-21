import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";

export interface GateRunnerOptions {
  allowedExecutables: string[];
  deniedExecutables: string[];
  allowedEnvKeys: string[];
  maxOutputBytes: number;
}

export interface GateExecutionResult {
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  failure?: string;
  error?: string;
}

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

export class GateRunner {
  constructor(private readonly options: GateRunnerOptions) {}

  public async runGate(
    command: string[],
    cwd: string,
    timeoutMs: number,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<GateExecutionResult> {
    const startTime = Date.now();

    if (signal?.aborted) {
      return this.failResult(
        "Gate canceled before starting",
        startTime,
        "CANCELED",
      );
    }

    if (command.length === 0) {
      return this.failResult("Invalid command", startTime);
    }
    const bin = command[0];
    if (!bin) return this.failResult("Invalid command", startTime);
    const args = command.slice(1);

    if (this.options.deniedExecutables.includes(bin)) {
      return this.failResult(
        `Executable ${bin} is explicitly denied`,
        startTime,
        "POLICY_DENIED",
      );
    }
    if (
      !this.options.allowedExecutables.includes(bin) &&
      !this.options.allowedExecutables.includes("*")
    ) {
      return this.failResult(
        `Executable ${bin} is not in the allowlist`,
        startTime,
        "POLICY_DENIED",
      );
    }

    let realCwd: string;
    try {
      realCwd = await fs.realpath(cwd);
    } catch (e) {
      return this.failResult(`Invalid cwd: ${cwd}`, startTime);
    }

    const env: Record<string, string> = { NO_COLOR: "1" };
    for (const key of this.options.allowedEnvKeys) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]!;
      }
    }

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, {
          cwd: realCwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        resolve(this.failResult(String(error), startTime, "SPAWN_ERROR"));
        return;
      }

      let stdout = "";
      let stderr = "";
      let totalBytes = 0;
      let failure: string | undefined;
      let errorStr: string | undefined;
      let finished = false;
      let killTimer: NodeJS.Timeout | undefined;
      let forceCloseTimer: NodeJS.Timeout | undefined;
      let exitCodeReceived: number | null = null;
      const pid = child.pid;

      const stop = (reason: string, message: string) => {
        if (finished || failure) return;
        failure = reason;
        errorStr = message;
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
        }, 1000);
      };

      const cancel = () => stop("CANCELED", "Gate canceled by abort signal");
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();

      const timeoutTimer = setTimeout(() => {
        stop("GATE_TIMEOUT", `gate exceeded ${timeoutMs}ms`);
      }, timeoutMs);

      const finish = (exitCode: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        clearTimeout(forceCloseTimer);
        signal?.removeEventListener("abort", cancel);
        // If we stopped due to failure, ensure process group is definitively reaped
        if (failure && pid) {
          killTree(child, "SIGKILL");
        }
        resolve({
          exitCode: exitCode ?? exitCodeReceived,
          durationMs: Date.now() - startTime,
          stdout,
          stderr,
          failure,
          error: errorStr,
        });
      };

      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");

      child.stdout!.on("data", (chunk: string) => {
        if (failure) return;
        const chunkBytes = Buffer.byteLength(chunk);
        totalBytes += chunkBytes;
        if (totalBytes > this.options.maxOutputBytes) {
          stop("OUTPUT_LIMIT", `gate output exceeded limit`);
          return;
        }
        onStdout?.(chunk);
        stdout += chunk;
      });

      child.stderr!.on("data", (chunk: string) => {
        if (failure) return;
        const chunkBytes = Buffer.byteLength(chunk);
        totalBytes += chunkBytes;
        if (totalBytes > this.options.maxOutputBytes) {
          stop("OUTPUT_LIMIT", `gate output exceeded limit`);
          return;
        }
        onStderr?.(chunk);
        stderr += chunk;
      });

      child.on("error", (cause) => {
        failure = "SPAWN_ERROR";
        errorStr = cause.message;
        finish(null);
      });
      child.on("exit", (code) => {
        exitCodeReceived = code;
        if (failure) {
          // When in stopping flow, parent exit must reap any lingering grandchildren immediately
          if (pid) killTree(child, "SIGKILL");
        } else {
          // Normal exit: allow short window for stdio flush, then force finish if streams remain open
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
    });
  }

  private failResult(
    error: string,
    startTime: number,
    failure: string = "INTERNAL_ERROR",
  ): GateExecutionResult {
    return {
      exitCode: null,
      durationMs: Date.now() - startTime,
      stdout: "",
      stderr: "",
      failure,
      error,
    };
  }
}
