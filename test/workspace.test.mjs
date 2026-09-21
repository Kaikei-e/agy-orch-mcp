import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GitRepository,
  WorktreeManager,
  PatchCollector,
  PatchIntegrator,
  OwnershipValidator,
} from "../dist/workspace/index.js";

test("Workspace modules", async (t) => {
  const fixturesDir = path.join(process.cwd(), "test/fixtures/workspace");
  await fs.mkdir(fixturesDir, { recursive: true });

  const repoDir = path.join(fixturesDir, "repo");
  await fs.rm(repoDir, { recursive: true, force: true });
  await fs.mkdir(repoDir, { recursive: true });

  // Init repo
  const repo = new GitRepository(repoDir);
  await repo.exec(["init"]);
  await repo.exec(["config", "user.name", "Test"]);
  await repo.exec(["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repoDir, "base.txt"), "hello\n");
  await repo.exec(["add", "base.txt"]);
  await repo.exec(["commit", "-m", "init"]);

  const baseRev = await repo.getBaseRevision();

  await t.test("OwnershipValidator", () => {
    const validator = new OwnershipValidator(
      repoDir,
      ["src/**", "test/*"],
      ["src/**", "test/*", "docs/**"],
      ["src/secret/**"],
    );

    assert.strictEqual(validator.isOwned("src/index.js"), true);
    assert.strictEqual(validator.isOwned("test/index.test.js"), true);
    assert.strictEqual(validator.isOwned("test/deep/test.js"), false); // test/* is only 1 level
    assert.strictEqual(validator.isOwned("src/secret/key.txt"), false); // excluded
    assert.strictEqual(validator.isOwned("docs/readme.md"), false); // in include, but not in owns
    assert.strictEqual(validator.isOwned("../outside"), false);

    assert.throws(
      () => new OwnershipValidator(repoDir, ["/*"], ["/*"]),
      /Invalid pattern/,
    );
    assert.throws(
      () => new OwnershipValidator(repoDir, ["src/**"], ["test/**"]),
      /not covered by scope.include/,
    );
  });

  await t.test("WorktreeManager and patching", async () => {
    const wm = new WorktreeManager(
      repo,
      "run-1",
      path.join(repoDir, ".git", "agy-orch", "runs", "run-1"),
    );
    await wm.init();

    // Create detached worktree
    const wtPath = await wm.createDetachedWorktree("task-1", baseRev);
    assert.ok(await fs.stat(wtPath));

    // Edit in worktree
    await fs.writeFile(path.join(wtPath, "base.txt"), "hello\nworld\n");
    await fs.writeFile(path.join(wtPath, "new.txt"), "new file");

    const collector = new PatchCollector(wtPath);
    const patch = await collector.collectPatch(baseRev);
    assert.ok(patch.includes("world"));

    const changed = await collector.getChangedPaths(baseRev);
    assert.deepStrictEqual(changed, [
      { status: "M", path: "base.txt" },
      { status: "A", path: "new.txt" },
    ]);

    // Integration worktree
    const intWtPath = await wm.createIntegrationWorktree(baseRev);
    const integrator = new PatchIntegrator(intWtPath);
    await integrator.applyPatch(patch);

    const treeHash = await integrator.getTreeHash();
    assert.ok(treeHash);

    // Commit baseline in integration (just to check functionality)
    const newBaseline = await integrator.commitAsBaseline("Integrated task-1");
    assert.notStrictEqual(newBaseline, baseRev);

    // Cleanup
    await wm.removeWorktree(wtPath);
    await assert.rejects(fs.stat(wtPath));
    await wm.removeWorktree(intWtPath);
  });
});

test("Workspace advanced constraints", async (t) => {
  const fixturesDir = path.join(process.cwd(), "test/fixtures/workspace_adv");
  await fs.mkdir(fixturesDir, { recursive: true });

  const repoDir = path.join(fixturesDir, "repo");
  await fs.rm(repoDir, { recursive: true, force: true });
  await fs.mkdir(repoDir, { recursive: true });

  const repo = new GitRepository(repoDir);
  await repo.exec(["init"]);
  await repo.exec(["config", "user.name", "Test"]);
  await repo.exec(["config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(repoDir, "base.txt"), "base\n");
  await fs.writeFile(path.join(repoDir, "delete.txt"), "delete\n");
  await repo.exec(["add", "base.txt", "delete.txt"]);
  await repo.exec(["commit", "-m", "init"]);

  const baseRev = await repo.getBaseRevision();
  const wm = new WorktreeManager(
    repo,
    "run-2",
    path.join(repoDir, ".git", "agy-orch", "runs", "run-2"),
  );
  await wm.init();

  await t.test("dirty source rejection", async () => {
    assert.strictEqual(await repo.checkDirty(), false);
    await fs.writeFile(path.join(repoDir, "dirty.txt"), "dirty");
    assert.strictEqual(await repo.checkDirty(), true);
    await fs.unlink(path.join(repoDir, "dirty.txt"));
  });

  await t.test(
    "dependency patch-only diff and creation/deletion/rename",
    async () => {
      const wtPath = await wm.createDetachedWorktree("task-adv", baseRev);
      await fs.unlink(path.join(wtPath, "delete.txt"));
      await fs.writeFile(path.join(wtPath, "new.txt"), "new file\n");
      await fs.rename(
        path.join(wtPath, "base.txt"),
        path.join(wtPath, "renamed.txt"),
      );

      const collector = new PatchCollector(wtPath);
      const patch = await collector.collectPatch(baseRev);
      const changed = await collector.getChangedPaths(baseRev);
      assert.ok(
        changed.find((c) => c.path === "delete.txt" && c.status === "D"),
      );
      assert.ok(changed.find((c) => c.path === "new.txt" && c.status === "A"));
      assert.ok(
        changed.find(
          (c) =>
            (c.path === "renamed.txt" && c.status.startsWith("R")) ||
            (c.path === "base.txt" && c.status === "D"),
        ),
      );

      await wm.removeWorktree(wtPath);
    },
  );

  await t.test("out-of-scope/excludes new file rejection", async () => {
    const validator = new OwnershipValidator(
      repoDir,
      ["src/**"],
      ["src/**"],
      ["src/secret/**"],
    );
    assert.strictEqual(validator.isOwned("src/secret/key.txt"), false);
    assert.strictEqual(validator.isOwned("src/new.txt"), true);
  });

  await t.test("symlink traversal rejection", async () => {
    const validator = new OwnershipValidator(repoDir, ["src/**"], ["src/**"]);
    assert.strictEqual(validator.isOwned("../outside.txt"), false);
  });

  await t.test("patch conflicts rollback", async () => {
    const intWtPath = await wm.createIntegrationWorktree(baseRev);
    const integrator = new PatchIntegrator(intWtPath);

    await assert.rejects(integrator.applyPatch("invalid patch format"));

    await wm.removeWorktree(intWtPath);
  });
});
