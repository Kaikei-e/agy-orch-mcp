import { GitRepository } from "./git-repository.js";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectPatchForSecrets } from "../artifacts/redaction.js";

export class PatchIntegrator {
  constructor(private readonly worktreePath: string) {}

  public async applyPatch(patchContent: string): Promise<void> {
    if (!patchContent.trim()) {
      return; // Nothing to apply
    }

    // Fail-closed secret check: never apply patches containing secrets (before any disk write)
    const secretCheck = inspectPatchForSecrets(patchContent);
    if (!secretCheck.safe) {
      const err = new Error(
        `POLICY_DENIED: ${secretCheck.reason ?? "Patch contains detected secrets. Integration rejected for security."}`,
      );
      (err as any).code = "POLICY_DENIED";
      throw err;
    }

    const repo = new GitRepository(this.worktreePath);

    // Clean precondition: ensure integration target is a clean dedicated worktree.
    // Refuse to apply to a dirty workspace so rollback (reset/clean) never destroys pre-existing uncommitted data.
    const isDirty = await repo.checkDirty();
    if (isDirty) {
      const err = new Error(
        "WORKSPACE_DIRTY: Cannot apply patch to dirty workspace. PatchIntegrator requires a clean dedicated worktree to prevent accidental data loss.",
      );
      (err as any).code = "WORKSPACE_DIRTY";
      throw err;
    }

    const patchPath = path.join(
      this.worktreePath,
      `.git-apply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`,
    );
    await fs.writeFile(patchPath, patchContent);

    try {
      const res = await repo.exec(["apply", "--3way", patchPath]);
      if (res.exitCode !== 0) {
        // Transactional rollback: revert any partial modifications or conflict markers
        await repo.exec(["reset", "--hard", "HEAD"]).catch(() => {});
        await repo.exec(["clean", "-fd"]).catch(() => {});
        throw new Error("PATCH_CONFLICT: " + res.stderr);
      }
    } catch (error) {
      // Ensure clean state on any unexpected error
      await repo.exec(["reset", "--hard", "HEAD"]).catch(() => {});
      await repo.exec(["clean", "-fd"]).catch(() => {});
      throw error;
    } finally {
      await fs.unlink(patchPath).catch(() => {});
    }
  }

  public async commitAsBaseline(message: string): Promise<string> {
    const repo = new GitRepository(this.worktreePath);
    await repo.exec(["add", "--all"]);
    const res = await repo.exec(["commit", "-m", message]);
    if (res.exitCode !== 0 && !res.stdout.includes("nothing to commit")) {
      throw new Error("Failed to commit baseline: " + res.stderr);
    }
    const rev = await repo.getBaseRevision();
    return rev;
  }

  public async getTreeHash(): Promise<string> {
    const repo = new GitRepository(this.worktreePath);
    // commit and get tree hash
    await repo.exec(["add", "--all"]);
    const writeTree = await repo.exec(["write-tree"]);
    if (writeTree.exitCode !== 0) {
      throw new Error("Failed to write tree: " + writeTree.stderr);
    }
    return writeTree.stdout.trim();
  }
}
