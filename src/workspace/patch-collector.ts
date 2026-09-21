import { GitRepository } from "./git-repository.js";
import { OwnershipValidator } from "./ownership-validator.js";

export interface ChangedPathEntry {
  status: string;
  path: string;
  oldPath?: string;
}

export interface CollectPatchOptions {
  validator?: OwnershipValidator;
  signal?: AbortSignal;
}

export class PatchCollector {
  private readonly repo: GitRepository;

  constructor(private readonly repoPath: string) {
    this.repo = new GitRepository(this.repoPath);
  }

  public async getChangedPaths(
    baseRevision: string,
    options?: { signal?: AbortSignal },
  ): Promise<ChangedPathEntry[]> {
    if (!baseRevision || baseRevision.startsWith("-")) {
      throw new Error(
        `Invalid baseRevision "${baseRevision}": option injection rejected`,
      );
    }

    // Explicit check on git add failure - do NOT ignore errors
    const addRes = await this.repo.exec(["add", "--all"], undefined, {
      signal: options?.signal,
    });
    if (addRes.exitCode !== 0) {
      throw new Error(`Failed to stage changes in worktree: ${addRes.stderr}`);
    }

    // Null-separated diff to handle newlines, spaces, and binary entries safely
    const res = await this.repo.exec(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "-z",
        baseRevision,
        "--cached",
        "--end-of-options",
      ],
      undefined,
      { signal: options?.signal },
    );

    if (res.exitCode !== 0) {
      throw new Error(
        `Failed to inspect changed paths against base revision: ${res.stderr}`,
      );
    }

    const parts = res.stdout.split("\0");
    const changed: ChangedPathEntry[] = [];

    for (let i = 0; i < parts.length - 1; i++) {
      const status = parts[i];
      if (!status) continue;

      if (status.startsWith("R") || status.startsWith("C")) {
        const oldPath = parts[i + 1];
        const newPath = parts[i + 2];
        if (oldPath && newPath) {
          // Track BOTH oldPath (deletion/source) and newPath (addition/target) for ownership verification
          changed.push({ status: "D", path: oldPath, oldPath });
          changed.push({ status: status.charAt(0), path: newPath, oldPath });
        }
        i += 2;
      } else {
        const path = parts[i + 1];
        if (path) {
          changed.push({ status: status.charAt(0), path });
        }
        i += 1;
      }
    }

    return changed;
  }

  public async collectPatch(
    baseRevision: string,
    options?: CollectPatchOptions,
  ): Promise<string> {
    if (!baseRevision || baseRevision.startsWith("-")) {
      throw new Error(
        `Invalid baseRevision "${baseRevision}": option injection rejected`,
      );
    }

    // 1. Verify changed paths and enforce ownership before generating final patch
    const changes = await this.getChangedPaths(baseRevision, options);

    if (options?.validator) {
      for (const change of changes) {
        // Prevent worker tampering with .git metadata or parent traversal
        if (
          change.path === ".git" ||
          change.path.startsWith(".git/") ||
          change.path.includes("/.git/") ||
          change.path.endsWith("/.git")
        ) {
          const err = new Error(
            `POLICY_DENIED: Attempt to modify git metadata at "${change.path}"`,
          );
          (err as unknown as { code: string }).code = "POLICY_DENIED";
          throw err;
        }

        if (!options.validator.isOwned(change.path, { checkFs: true })) {
          const err = new Error(
            `SCOPE_VIOLATION: Changed path "${change.path}" is outside declared owns or in scope.exclude`,
          );
          (err as unknown as { code: string }).code = "SCOPE_VIOLATION";
          throw err;
        }

        // For renames, the deleted old path must also be owned
        if (
          change.oldPath &&
          !options.validator.isOwned(change.oldPath, { checkFs: true })
        ) {
          const err = new Error(
            `SCOPE_VIOLATION: Renamed source path "${change.oldPath}" is outside declared owns or in scope.exclude`,
          );
          (err as unknown as { code: string }).code = "SCOPE_VIOLATION";
          throw err;
        }
      }
    }

    // 2. Generate full binary git patch against baseline commit
    const diffRes = await this.repo.exec(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        baseRevision,
        "--cached",
        "--end-of-options",
      ],
      undefined,
      { signal: options?.signal },
    );

    if (diffRes.exitCode !== 0) {
      throw new Error(`Failed to collect git patch: ${diffRes.stderr}`);
    }

    return diffRes.stdout;
  }
}
