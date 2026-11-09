import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isolatedEnv, removeIsolatedEnv } from "../dist/isolation.js";

test("isolatedEnv off mode returns empty object and creates no directories", (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agy-iso-off-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runRoot = path.join(temp, "run");

  const env = isolatedEnv("off", runRoot);
  assert.deepEqual(env, {});
  assert.equal(existsSync(runRoot), false);
});

test("isolatedEnv install mode sets install vars, prepends PATH in order, and creates dirs", (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agy-iso-install-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runRoot = path.join(temp, "run");

  const env = isolatedEnv("install", runRoot);

  assert.equal(env.GOBIN, path.join(runRoot, "go", "bin"));
  assert.equal(env.npm_config_prefix, path.join(runRoot, "npm"));
  assert.equal(env.BUN_INSTALL, path.join(runRoot, "bun"));
  assert.equal(env.PNPM_HOME, path.join(runRoot, "pnpm"));
  assert.equal(env.CARGO_INSTALL_ROOT, path.join(runRoot, "cargo-install"));
  assert.equal(env.PYTHONUSERBASE, path.join(runRoot, "python-user"));
  assert.equal(env.CHOKIDAR_USEPOLLING, "1");
  assert.equal(env.WATCHPACK_POLLING, "true");

  assert.equal(env.GOPATH, undefined);
  assert.equal(env.GOMODCACHE, undefined);
  assert.equal(env.PIP_USER, undefined);
  assert.equal(env.HOME, undefined);
  for (const key of Object.keys(env)) {
    assert.equal(key.startsWith("XDG_"), false, `unexpected XDG var: ${key}`);
  }

  const expectedBins = [
    path.join(runRoot, "go", "bin"),
    path.join(runRoot, "npm", "bin"),
    path.join(runRoot, "bun", "bin"),
    path.join(runRoot, "pnpm"),
    path.join(runRoot, "cargo-install", "bin"),
    path.join(runRoot, "python-user", "bin"),
  ];
  const pathParts = env.PATH.split(path.delimiter);
  assert.deepEqual(pathParts.slice(0, expectedBins.length), expectedBins);
  if (process.env.PATH) {
    assert.equal(
      pathParts.slice(expectedBins.length).join(path.delimiter),
      process.env.PATH,
    );
  }

  for (const dir of [
    env.GOBIN,
    env.npm_config_prefix,
    env.BUN_INSTALL,
    env.PNPM_HOME,
    env.CARGO_INSTALL_ROOT,
    env.PYTHONUSERBASE,
    ...expectedBins,
  ]) {
    assert.equal(statSync(dir).isDirectory(), true, `missing dir: ${dir}`);
  }
});

test("isolatedEnv full mode includes install vars plus all cache directories", (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agy-iso-full-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runRoot = path.join(temp, "run");

  const env = isolatedEnv("full", runRoot);

  assert.equal(env.GOBIN, path.join(runRoot, "go", "bin"));
  assert.equal(env.npm_config_prefix, path.join(runRoot, "npm"));
  assert.equal(env.BUN_INSTALL, path.join(runRoot, "bun"));
  assert.equal(env.PNPM_HOME, path.join(runRoot, "pnpm"));
  assert.equal(env.CARGO_INSTALL_ROOT, path.join(runRoot, "cargo-install"));
  assert.equal(env.PYTHONUSERBASE, path.join(runRoot, "python-user"));
  assert.equal(env.CHOKIDAR_USEPOLLING, "1");
  assert.equal(env.WATCHPACK_POLLING, "true");

  assert.equal(env.GOPATH, path.join(runRoot, "go"));
  assert.equal(env.GOMODCACHE, path.join(runRoot, "go", "pkg", "mod"));
  assert.equal(env.GOCACHE, path.join(runRoot, "go", "cache"));
  assert.equal(env.npm_config_cache, path.join(runRoot, "npm-cache"));
  assert.equal(env.npm_config_store_dir, path.join(runRoot, "pnpm-store"));
  assert.equal(env.BUN_INSTALL_CACHE_DIR, path.join(runRoot, "bun-cache"));
  assert.equal(env.CARGO_HOME, path.join(runRoot, "cargo-home"));
  assert.equal(env.PIP_CACHE_DIR, path.join(runRoot, "pip-cache"));
  assert.equal(env.UV_CACHE_DIR, path.join(runRoot, "uv-cache"));

  assert.equal(env.PIP_USER, undefined);
  assert.equal(env.HOME, undefined);
  for (const key of Object.keys(env)) {
    assert.equal(key.startsWith("XDG_"), false, `unexpected XDG var: ${key}`);
  }

  for (const dir of [
    env.GOPATH,
    env.GOMODCACHE,
    env.GOCACHE,
    env.npm_config_cache,
    env.npm_config_store_dir,
    env.BUN_INSTALL_CACHE_DIR,
    env.CARGO_HOME,
    env.PIP_CACHE_DIR,
    env.UV_CACHE_DIR,
  ]) {
    assert.equal(statSync(dir).isDirectory(), true, `missing dir: ${dir}`);
  }
});

test("removeIsolatedEnv removes read-only chmod 0555 directories and ignores missing root", async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agy-iso-rm-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const runRoot = path.join(temp, "run");

  isolatedEnv("full", runRoot);
  const modDir = path.join(
    runRoot,
    "go",
    "pkg",
    "mod",
    "example.com",
    "pkg@v1.0.0",
  );
  mkdirSync(modDir, { recursive: true });
  const modFile = path.join(modDir, "go.mod");
  writeFileSync(modFile, "module example.com/pkg\n");
  chmodSync(modFile, 0o444);
  chmodSync(modDir, 0o555);
  chmodSync(path.dirname(modDir), 0o555);

  await removeIsolatedEnv(runRoot);
  assert.equal(existsSync(runRoot), false);

  await removeIsolatedEnv(path.join(temp, "does-not-exist"));
});
