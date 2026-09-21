import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export interface GitExecOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBufferBytes?: number;
  env?: Record<string, string>;
}

export interface GitRepositoryOptions {
  allowedEnvKeys?: string[];
  defaultTimeoutMs?: number;
  maxBufferBytes?: number;
}

const DEFAULT_ALLOWED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_NOSYSTEM",
];

export class GitRepository {
  private readonly canonicalRoot: string;
  private readonly allowedEnvKeys: Set<string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(rootPath: string, options: GitRepositoryOptions = {}) {
    if (!rootPath || typeof rootPath !== "string") {
      throw new Error(
        "Invalid repository rootPath: path must be a non-empty string",
      );
    }
    if (rootPath.includes("\0")) {
      throw new Error("Invalid repository rootPath: contains null byte");
    }

    // Resolve canonical realpath if directory exists, else absolute normalized path
    try {
      this.canonicalRoot = fs.realpathSync(rootPath);
    } catch {
      this.canonicalRoot = path.resolve(rootPath);
    }

    this.allowedEnvKeys = new Set([
      ...DEFAULT_ALLOWED_ENV,
      ...(options.allowedEnvKeys ?? []),
    ]);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 10 * 1024 * 1024;
  }

  public async getRoot(): Promise<string> {
    return this.canonicalRoot;
  }

  public getCanonicalRoot(): string {
    return this.canonicalRoot;
  }

  public async getGitDir(): Promise<string> {
    const res = await this.exec(["rev-parse", "--git-dir"]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to resolve git directory: ${res.stderr}`);
    }
    return path.resolve(this.canonicalRoot, res.stdout.trim());
  }

  public async getCommonDir(): Promise<string> {
    const res = await this.exec(["rev-parse", "--git-common-dir"]);
    if (res.exitCode !== 0) {
      return this.getGitDir();
    }
    return path.resolve(this.canonicalRoot, res.stdout.trim());
  }

  public async getBaseRevision(ref: string = "HEAD"): Promise<string> {
    if (!ref || typeof ref !== "string") {
      throw new Error(
        "Invalid git revision: revision must be a non-empty string",
      );
    }
    // Prevent git option injection via revisions starting with -
    if (ref.startsWith("-")) {
      throw new Error(
        `Invalid git revision: option injection rejected for "${ref}"`,
      );
    }
    if (ref.includes("\0") || ref.includes("\n") || ref.includes("\r")) {
      throw new Error("Invalid git revision: contains control characters");
    }

    const res = await this.exec([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    if (res.exitCode === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }

    // Fallback without ^{commit} if ref was a direct object or tree
    const fallback = await this.exec([
      "rev-parse",
      "--verify",
      "--end-of-options",
      ref,
    ]);
    if (fallback.exitCode !== 0 || !fallback.stdout.trim()) {
      throw new Error(
        `Failed to resolve revision "${ref}": ${res.stderr || fallback.stderr}`,
      );
    }
    return fallback.stdout.trim();
  }

  public async checkDirty(): Promise<boolean> {
    const res = await this.exec([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--end-of-options",
    ]);
    if (res.exitCode !== 0) {
      throw new Error("Failed to inspect git status: " + res.stderr);
    }
    return res.stdout.length > 0;
  }

  public async rejectIfDirty(): Promise<void> {
    const dirty = await this.checkDirty();
    if (dirty) {
      const err = new Error(
        "POLICY_DENIED: Workspace is dirty. dirty_policy:reject requires a clean repository.",
      );
      (err as unknown as { code: string }).code = "POLICY_DENIED";
      throw err;
    }
  }

  public async checkUnsupportedFeatures(): Promise<{
    submodule: boolean;
    lfs: boolean;
  }> {
    const gitmodulesPath = path.join(this.canonicalRoot, ".gitmodules");
    const gitattributesPath = path.join(this.canonicalRoot, ".gitattributes");

    let submodule = false;
    let lfs = false;

    if (fs.existsSync(gitmodulesPath)) {
      submodule = true;
    }

    if (fs.existsSync(gitattributesPath)) {
      try {
        const content = await fsp.readFile(gitattributesPath, "utf8");
        if (
          content.includes("filter=lfs") ||
          content.includes("merge=lfs") ||
          content.includes("diff=lfs")
        ) {
          lfs = true;
        }
      } catch {
        // Ignore read errors
      }
    }

    return { submodule, lfs };
  }

  public async rejectUnsupportedFeatures(): Promise<void> {
    const { submodule, lfs } = await this.checkUnsupportedFeatures();
    if (submodule) {
      const err = new Error(
        "UNSUPPORTED_LIMITATION: Git submodules are not supported in v1.",
      );
      (err as unknown as { code: string }).code = "POLICY_DENIED";
      throw err;
    }
    if (lfs) {
      const err = new Error(
        "UNSUPPORTED_LIMITATION: Git LFS is not supported in v1.",
      );
      (err as unknown as { code: string }).code = "POLICY_DENIED";
      throw err;
    }
  }

  public async exec(
    args: string[],
    cwd?: string,
    options?: GitExecOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const targetCwd = cwd ? path.resolve(cwd) : this.canonicalRoot;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxBuffer = options?.maxBufferBytes ?? this.maxBufferBytes;
    const signal = options?.signal;

    if (signal?.aborted) {
      return {
        stdout: "",
        stderr: "Operation cancelled before git process started",
        exitCode: 1,
      };
    }

    // Explicit minimal environment allowlist - no indiscriminate copying of process.env
    const env: Record<string, string> = { NO_COLOR: "1" };
    for (const key of this.allowedEnvKeys) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]!;
      }
    }
    if (options?.env) {
      Object.assign(env, options.env);
    }

    // Git hooks & external config safety flags
    const safeConfigArgs = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.editor=",
      "-c",
      "advice.detachedHead=false",
    ];
    const fullArgs = [...safeConfigArgs, ...args];

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn("git", fullArgs, {
          cwd: targetCwd,
          shell: false,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({
          stdout: "",
          stderr: (err as Error).message || String(err),
          exitCode: 1,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let totalBytes = 0;
      let finished = false;
      let killTimer: NodeJS.Timeout | undefined;

      const stop = (reason: string) => {
        if (finished) return;
        try {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }, 500);
        } catch {
          // ignore
        }
        stderr += `\n[Git execution terminated: ${reason}]`;
      };

      const timeoutTimer = setTimeout(() => {
        stop(`Timeout after ${timeoutMs}ms`);
      }, timeoutMs);

      const onAbort = () => {
        stop("Cancelled via AbortSignal");
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk: string) => {
        const bytes = Buffer.byteLength(chunk);
        totalBytes += bytes;
        if (totalBytes > maxBuffer) {
          stop(`Output exceeded limit of ${maxBuffer} bytes`);
          return;
        }
        stdout += chunk;
      });

      child.stderr?.on("data", (chunk: string) => {
        const bytes = Buffer.byteLength(chunk);
        totalBytes += bytes;
        if (totalBytes > maxBuffer) {
          stop(`Output exceeded limit of ${maxBuffer} bytes`);
          return;
        }
        stderr += chunk;
      });

      child.on("error", (err) => {
        stderr += err.message;
        finish(1);
      });

      child.on("close", (code) => {
        finish(code);
      });
    });
  }
}
