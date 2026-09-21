import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitRepository } from "./git-repository.js";

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export interface WorktreeManagerOptions {
  storageDir?: string;
}

export class WorktreeManager {
  private sessionDir: string;
  private readonly ownedWorktrees = new Set<string>();

  constructor(
    private readonly repo: GitRepository,
    private readonly runId: string,
    storageDir?: string,
  ) {
    if (!runId || !VALID_ID_REGEX.test(runId)) {
      throw new Error(
        `Invalid runId "${runId}": must contain only alphanumeric characters, dashes, and underscores`,
      );
    }

    if (storageDir) {
      // Validate provided storageDir
      const resolved = path.resolve(storageDir);
      this.sessionDir = resolved;
    } else {
      // Default: Private session directory outside source working tree, distinct from artifact stores
      this.sessionDir = path.join(os.tmpdir(), "agy-orch-worktrees", runId);
    }
  }

  public async init(): Promise<void> {
    const root = await this.repo.getRoot();
    const resolvedRoot = path.resolve(root);

    // If storageDir was placed inside the source working tree (and not inside .git),
    // redirect to os.tmpdir to prevent working tree pollution and dirty_policy:reject conflicts.
    const rel = path.relative(resolvedRoot, this.sessionDir);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      const gitDir = await this.repo.getGitDir();
      const relToGit = path.relative(gitDir, this.sessionDir);
      if (relToGit.startsWith("..") || path.isAbsolute(relToGit)) {
        // It's inside working tree, but not inside .git! Move to os.tmpdir
        this.sessionDir = path.join(
          os.tmpdir(),
          "agy-orch-worktrees",
          this.runId,
        );
      }
    }

    await fsp.mkdir(this.sessionDir, { recursive: true });
    try {
      this.sessionDir = fs.realpathSync(this.sessionDir);
    } catch {
      // Keep resolved path if realpath fails
    }
  }

  public getSessionDir(): string {
    return this.sessionDir;
  }

  public isOwned(worktreePath: string): boolean {
    const resolved = path.resolve(worktreePath);
    if (this.ownedWorktrees.has(resolved)) {
      return true;
    }
    try {
      const real = fs.realpathSync(worktreePath);
      return this.ownedWorktrees.has(real);
    } catch {
      return false;
    }
  }

  public async createDetachedWorktree(
    taskId: string,
    baseRevision: string,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    if (!taskId || !VALID_ID_REGEX.test(taskId)) {
      throw new Error(
        `Invalid taskId "${taskId}": must contain only alphanumeric characters, dashes, and underscores`,
      );
    }
    if (!baseRevision || baseRevision.startsWith("-")) {
      throw new Error(
        `Invalid baseRevision "${baseRevision}": option injection rejected`,
      );
    }

    await this.init();

    const taskDir = path.join(this.sessionDir, "tasks", taskId);
    const worktreePath = path.join(taskDir, "worktree");

    // Path safety check: ensure worktreePath is strictly inside sessionDir
    const rel = path.relative(this.sessionDir, worktreePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `Path traversal attempt detected in worktree path for task "${taskId}"`,
      );
    }

    await fsp.mkdir(taskDir, { recursive: true });

    // Execute git worktree add with --detach
    const res = await this.repo.exec(
      ["worktree", "add", "--detach", worktreePath, baseRevision],
      undefined,
      { signal: options?.signal },
    );
    if (res.exitCode !== 0) {
      throw new Error(
        `Failed to create detached worktree for task "${taskId}": ${res.stderr}`,
      );
    }

    const resolved = path.resolve(worktreePath);
    this.ownedWorktrees.add(resolved);
    try {
      this.ownedWorktrees.add(fs.realpathSync(worktreePath));
    } catch {
      // Ignore
    }

    return worktreePath;
  }

  public async createIntegrationWorktree(
    baseRevision: string,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    if (!baseRevision || baseRevision.startsWith("-")) {
      throw new Error(
        `Invalid baseRevision "${baseRevision}": option injection rejected`,
      );
    }

    await this.init();

    const worktreePath = path.join(this.sessionDir, "integration", "worktree");
    const rel = path.relative(this.sessionDir, worktreePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        "Path traversal attempt detected in integration worktree path",
      );
    }

    await fsp.mkdir(path.dirname(worktreePath), { recursive: true });

    const res = await this.repo.exec(
      ["worktree", "add", "--detach", worktreePath, baseRevision],
      undefined,
      { signal: options?.signal },
    );
    if (res.exitCode !== 0) {
      throw new Error(`Failed to create integration worktree: ${res.stderr}`);
    }

    const resolved = path.resolve(worktreePath);
    this.ownedWorktrees.add(resolved);
    try {
      this.ownedWorktrees.add(fs.realpathSync(worktreePath));
    } catch {
      // Ignore
    }

    return worktreePath;
  }

  public async removeWorktree(
    worktreePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    if (!this.isOwned(worktreePath)) {
      const err = new Error(
        `UNOWNED_PATH: Refusing to remove path not owned by this WorktreeManager: "${worktreePath}"`,
      );
      (err as unknown as { code: string }).code = "UNOWNED_PATH";
      throw err;
    }

    // Attempt git worktree remove
    const res = await this.repo.exec(
      ["worktree", "remove", "--force", worktreePath],
      undefined,
      { signal: options?.signal },
    );

    if (res.exitCode !== 0) {
      // Try worktree prune if remove failed
      await this.repo.exec(["worktree", "prune"], undefined, {
        signal: options?.signal,
      });
    }

    // Only clean up filesystem directory if it was an owned path
    const resolved = path.resolve(worktreePath);
    let real: string | undefined;
    try {
      real = fs.realpathSync(worktreePath);
    } catch {
      // ignore
    }

    await fsp
      .rm(worktreePath, { recursive: true, force: true })
      .catch(() => {});

    this.ownedWorktrees.delete(resolved);
    if (real) {
      this.ownedWorktrees.delete(real);
    }
  }

  public async cleanupAll(): Promise<{
    cleaned: string[];
    failed: Array<{ path: string; error: string }>;
  }> {
    const cleaned: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    const worktrees = Array.from(this.ownedWorktrees);
    for (const wt of worktrees) {
      try {
        await this.removeWorktree(wt);
        cleaned.push(wt);
      } catch (err) {
        failed.push({ path: wt, error: (err as Error).message });
      }
    }

    // Try to remove sessionDir if empty
    try {
      await fsp.rm(this.sessionDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    return { cleaned, failed };
  }
}
