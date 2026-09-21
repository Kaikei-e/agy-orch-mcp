import type { ArtifactMetadata } from "../domain/artifact.js";
import type { RunManifestV1 } from "../domain/ir.js";
import { version as serverVersion } from "../version.js";

export function createInitialManifest(params: {
  runId: string;
  workspaceRoot: string;
  baseRevision?: string;
  traceId?: string;
}): RunManifestV1 {
  const now = new Date().toISOString();
  return {
    manifest_version: "1",
    run_id: params.runId,
    server_version: serverVersion,
    schema_version: "1",
    artifact_layout_version: "1",
    created_at: now,
    updated_at: now,
    base_revision: params.baseRevision ?? "HEAD",
    status: "running",
    workspace_root: params.workspaceRoot,
    artifacts: [],
    tasks: {},
    gates: {},
    pinned: false,
    owner_pid: process.pid,
    ...(params.traceId ? { trace_id: params.traceId } : {}),
  };
}

export function updateManifestArtifact(
  manifest: RunManifestV1,
  artifact: ArtifactMetadata,
): void {
  const existingIdx = manifest.artifacts.findIndex((a) => a.id === artifact.id);
  if (existingIdx >= 0) {
    manifest.artifacts[existingIdx] = artifact;
  } else {
    manifest.artifacts.push(artifact);
  }
  manifest.updated_at = new Date().toISOString();
}
