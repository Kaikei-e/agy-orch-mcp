import {
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import type { RunManifestV1 } from "../domain/ir.js";
import type { ArtifactStore } from "./store.js";

export interface RetentionPolicy {
  maxRuns: number; // default: 100
  maxAgeMs: number; // default: 7 days
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxRuns: 100,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export interface RetentionResult {
  sweptRuns: number;
  deletedRuns: string[];
  interruptedRecovered: string[];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

export function enforceRetentionAndRecovery(
  store: ArtifactStore,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): RetentionResult {
  const root = store.getStorageRoot();
  const runsDir = path.join(root, "runs");
  if (!existsSync(runsDir)) {
    return { sweptRuns: 0, deletedRuns: [], interruptedRecovered: [] };
  }

  const trashDir = path.join(root, "trash");
  if (!existsSync(trashDir)) {
    mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  }

  const entries = readdirSync(runsDir);
  const runs: Array<{
    runId: string;
    manifest: RunManifestV1 | null;
    createdAtMs: number;
  }> = [];
  const interruptedRecovered: string[] = [];

  for (const entry of entries) {
    const runDir = path.join(runsDir, entry);
    try {
      const stat = statSync(runDir);
      if (!stat.isDirectory()) continue;

      const manifest = store.loadManifest(entry);
      if (manifest) {
        // Crash recovery: check dead owner pid
        if (manifest.status === "running") {
          const ownerPid = manifest.owner_pid;
          const markInterrupted = () => {
            manifest.status = "interrupted";
            if (manifest.tasks) {
              for (const [, taskInfo] of Object.entries(manifest.tasks)) {
                if (taskInfo.status === "running") {
                  taskInfo.status = "interrupted";
                }
              }
            }
            manifest.updated_at = new Date().toISOString();
            store.saveManifest(manifest);
            interruptedRecovered.push(entry);
          };

          if (ownerPid && ownerPid !== process.pid && !isPidAlive(ownerPid)) {
            markInterrupted();
          } else if (!ownerPid) {
            // Legacy/missing pid marker, we can't be sure it's alive, but if it's old we assume dead
            const ageMs = Date.now() - new Date(manifest.created_at).getTime();
            if (ageMs > 24 * 60 * 60 * 1000) {
              // older than 24h
              markInterrupted();
            }
          }
        }

        runs.push({
          runId: entry,
          manifest,
          createdAtMs: new Date(manifest.created_at).getTime() || stat.mtimeMs,
        });
      }
    } catch {
      // Ignore transient errors
    }
  }

  // Sort newest first
  runs.sort((a, b) => b.createdAtMs - a.createdAtMs);

  const now = Date.now();
  const deletedRuns: string[] = [];

  // Exclude active or pinned runs from deletion
  const eligibleForDeletion = runs.filter(
    (r) => r.manifest && r.manifest.status !== "running" && !r.manifest.pinned,
  );

  for (let i = 0; i < eligibleForDeletion.length; i++) {
    const run = eligibleForDeletion[i];
    if (!run) continue;
    const isExceedingCount = i >= policy.maxRuns;
    const isExceedingAge = now - run.createdAtMs > policy.maxAgeMs;

    if (isExceedingCount || isExceedingAge) {
      const runDir = path.join(runsDir, run.runId);
      const trashDest = path.join(trashDir, `${run.runId}-${Date.now()}`);
      try {
        renameSync(runDir, trashDest);
        deletedRuns.push(run.runId);
      } catch {
        // Ignore deletion failure
      }
    }
  }

  return {
    sweptRuns: runs.length,
    deletedRuns,
    interruptedRecovered,
  };
}
