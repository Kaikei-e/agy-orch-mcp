import { mkdirSync } from "node:fs";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export type IsolationMode = "full" | "install" | "off";

export function isolatedEnv(
  mode: IsolationMode,
  runRoot: string,
): Record<string, string> {
  if (mode === "off") return {};

  const goBin = path.join(runRoot, "go", "bin");
  const npmPrefix = path.join(runRoot, "npm");
  const bunInstall = path.join(runRoot, "bun");
  const pnpmHome = path.join(runRoot, "pnpm");
  const cargoInstall = path.join(runRoot, "cargo-install");
  const pythonUser = path.join(runRoot, "python-user");

  const binDirs = [
    goBin,
    path.join(npmPrefix, "bin"),
    path.join(bunInstall, "bin"),
    pnpmHome,
    path.join(cargoInstall, "bin"),
    path.join(pythonUser, "bin"),
  ];

  const dirsToCreate = [
    npmPrefix,
    bunInstall,
    cargoInstall,
    pythonUser,
    ...binDirs,
  ];

  const env: Record<string, string> = {
    GOBIN: goBin,
    npm_config_prefix: npmPrefix,
    BUN_INSTALL: bunInstall,
    PNPM_HOME: pnpmHome,
    CARGO_INSTALL_ROOT: cargoInstall,
    PYTHONUSERBASE: pythonUser,
    CHOKIDAR_USEPOLLING: "1",
    WATCHPACK_POLLING: "true",
    PATH: process.env.PATH
      ? [...binDirs, process.env.PATH].join(path.delimiter)
      : binDirs.join(path.delimiter),
  };

  if (mode === "full") {
    const goPath = path.join(runRoot, "go");
    const goModCache = path.join(runRoot, "go", "pkg", "mod");
    const goCache = path.join(runRoot, "go", "cache");
    const npmCache = path.join(runRoot, "npm-cache");
    const pnpmStore = path.join(runRoot, "pnpm-store");
    const bunCache = path.join(runRoot, "bun-cache");
    const cargoHome = path.join(runRoot, "cargo-home");
    const pipCache = path.join(runRoot, "pip-cache");
    const uvCache = path.join(runRoot, "uv-cache");

    env.GOPATH = goPath;
    env.GOMODCACHE = goModCache;
    env.GOCACHE = goCache;
    env.npm_config_cache = npmCache;
    env.npm_config_store_dir = pnpmStore;
    env.BUN_INSTALL_CACHE_DIR = bunCache;
    env.CARGO_HOME = cargoHome;
    env.PIP_CACHE_DIR = pipCache;
    env.UV_CACHE_DIR = uvCache;

    dirsToCreate.push(
      goPath,
      goModCache,
      goCache,
      npmCache,
      pnpmStore,
      bunCache,
      cargoHome,
      pipCache,
      uvCache,
    );
  }

  for (const dir of dirsToCreate) {
    mkdirSync(dir, { recursive: true });
  }

  return env;
}

async function makeWritableRecursive(dir: string): Promise<void> {
  let st;
  try {
    st = await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  await chmod(dir, (st.mode & 0o777) | 0o700);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await makeWritableRecursive(full);
    }
  }
}

export async function removeIsolatedEnv(runRoot: string): Promise<void> {
  await makeWritableRecursive(runRoot);
  await rm(runRoot, { recursive: true, force: true });
}
