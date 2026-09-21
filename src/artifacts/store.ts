import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
  lstatSync,
  statSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import path from "node:path";

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

function syncSleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* fallback */
    }
  }
}
import type { ArtifactKind, ArtifactMetadata } from "../domain/artifact.js";
import type { ArtifactSelector, RunManifestV1 } from "../domain/ir.js";
import { DEFAULT_SERVER_LIMITS, type ServerLimits } from "../domain/limits.js";
import { createInitialManifest, updateManifestArtifact } from "./manifest.js";
import { inspectPatchForSecrets, redactSecrets } from "./redaction.js";
import { resolveSafePath } from "../validation/paths.js";

export interface SaveArtifactOptions {
  id?: string;
  runId: string;
  kind: ArtifactKind;
  relativePath: string;
  content: string | Buffer;
  taskId?: string;
  gateId?: string;
  attempt?: number;
  mimeType?: string;
  isBinary?: boolean;
}

export interface ReadArtifactSliceOptions {
  startLine?: number;
  maxLines?: number;
  maxBytes?: number;
  byteOffset?: number;
}

export interface ArtifactSliceResult {
  content: string;
  startLine: number;
  linesReturned: number;
  totalLines: number;
  bytesReturned: number;
  truncated: boolean;
}

export class ArtifactStore {
  private readonly storageRoot: string;
  private readonly limits: ServerLimits;

  constructor(
    workspaceRoot: string,
    customStorageDir?: string,
    limits: ServerLimits = DEFAULT_SERVER_LIMITS,
  ) {
    this.limits = limits;
    if (customStorageDir) {
      this.storageRoot = path.resolve(customStorageDir);
    } else {
      const stateHome =
        process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
      this.storageRoot = path.join(
        stateHome,
        "agy-orch",
        createHash("md5").update(workspaceRoot).digest("hex").substring(0, 8),
      );
    }
    if (!existsSync(this.storageRoot)) {
      mkdirSync(this.storageRoot, { recursive: true, mode: 0o700 });
    }
  }

  getStorageRoot(): string {
    return this.storageRoot;
  }

  getRunDir(runId: string): string {
    if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
      throw new Error(`Invalid runId: ${runId}`);
    }
    return path.join(this.storageRoot, "runs", runId);
  }

  private lockFile(targetPath: string): number {
    const lockPath = `${targetPath}.lock`;
    let attempts = 0;
    while (attempts < 5) {
      try {
        const fd = openSync(lockPath, "wx");
        try {
          writeSync(fd, `${process.pid}\n${Date.now()}\n`);
        } catch {
          // write failure shouldn't invalidate lock acquisition
        }
        return fd;
      } catch (err: any) {
        if (err.code === "EEXIST") {
          attempts++;
          try {
            const content = readFileSync(lockPath, "utf8");
            const lines = content.trim().split("\n");
            const pidStr = lines[0];
            const pid = pidStr ? parseInt(pidStr, 10) : NaN;

            if (!Number.isNaN(pid) && isPidAlive(pid)) {
              // Known LIVE owner lock: fail promptly with explicit BUSY error rather than blocking the event loop
              const busyErr = new Error(
                `BUSY: Resource is locked by active process PID ${pid} for ${targetPath}`,
              );
              (busyErr as any).code = "BUSY";
              throw busyErr;
            }

            if (!Number.isNaN(pid) && !isPidAlive(pid)) {
              // Dead owner reclaim: verify lock identity hasn't changed before unlinking,
              // preventing accidental deletion if another contender acquired the lock in the meantime
              try {
                const recheck = readFileSync(lockPath, "utf8");
                if (recheck.trim().split("\n")[0] === pidStr) {
                  unlinkSync(lockPath);
                  continue; // Immediately retry acquiring
                }
              } catch {
                // Ignore unlink/read race
              }
            }

            // Malformed lock (empty or corrupted): check age
            try {
              const stat = statSync(lockPath);
              const ageMs = Date.now() - stat.mtimeMs;
              // Never delete a newly-created lock (< 3000ms) which may be mid-write by a live contender
              if (ageMs > 3000) {
                unlinkSync(lockPath);
                continue;
              }
            } catch {}
          } catch (readErr: any) {
            if (readErr.code === "BUSY") {
              throw readErr;
            }
            // If lock was deleted between openSync and readFileSync, immediately retry
            if (readErr.code === "ENOENT") {
              continue;
            }
          }
          syncSleep(15);
        } else {
          throw err;
        }
      }
    }
    const err = new Error(
      `Failed to acquire lock for ${targetPath}: lock contention or malformed lock`,
    );
    (err as any).code = "LOCK_FAILED";
    throw err;
  }

  private unlockFile(targetPath: string, fd: number): void {
    const lockPath = `${targetPath}.lock`;
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }

  private withLock<T>(targetPath: string, fn: () => T): T {
    const dir = path.dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const fd = this.lockFile(targetPath);
    try {
      return fn();
    } finally {
      this.unlockFile(targetPath, fd);
    }
  }

  initRun(
    runId: string,
    workspaceRoot: string,
    baseRevision?: string,
    traceId?: string,
  ): RunManifestV1 {
    const runDir = this.getRunDir(runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });

    // exclusive run creation via lockfile on manifest
    const manifestPath = path.join(runDir, "manifest.json");
    if (existsSync(manifestPath)) {
      throw new Error(`Run ${runId} already exists`);
    }

    const manifest = createInitialManifest({
      runId,
      workspaceRoot,
      baseRevision,
      traceId,
    });
    this.saveManifest(manifest);
    return manifest;
  }

  loadManifest(runId: string): RunManifestV1 | null {
    const manifestPath = path.join(this.getRunDir(runId), "manifest.json");
    if (!existsSync(manifestPath)) return null;
    return this.withLock(manifestPath, () => {
      try {
        return JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifestV1;
      } catch {
        return null;
      }
    });
  }

  saveManifest(manifest: RunManifestV1): void {
    const runDir = this.getRunDir(manifest.run_id);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(runDir, "manifest.json");
    this.withLock(manifestPath, () => {
      const json = JSON.stringify(manifest, null, 2);
      this.atomicWriteFile(manifestPath, json);
    });
  }

  private atomicWriteFile(targetPath: string, content: string | Buffer): void {
    const dir = path.dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);
    try {
      writeFileSync(tmpPath, content, { mode: 0o600 });
      renameSync(tmpPath, targetPath);
    } catch (err: any) {
      if (err.code === "ENOSPC") {
        throw new Error(`Disk full when writing artifact to ${targetPath}`);
      }
      throw err;
    } finally {
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        /* ignore */
      }
    }
  }

  saveArtifact(options: SaveArtifactOptions): ArtifactMetadata {
    const runDir = this.getRunDir(options.runId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
    }

    const canonicalRunDir = realpathSync(runDir);

    // Use resolveSafePath for symlink exfiltration protection
    const targetPath = resolveSafePath(canonicalRunDir, options.relativePath, {
      mustExist: false,
    });

    if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
      throw new Error(
        `Symlink exfiltration attempt in artifact path: ${options.relativePath}`,
      );
    }

    // Extra symlink checks on parents for directory traversal protection inside runDir
    let current = path.dirname(targetPath);
    while (current !== canonicalRunDir && current.startsWith(canonicalRunDir)) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `Symlink exfiltration attempt in artifact path: ${options.relativePath}`,
        );
      }
      current = path.dirname(current);
    }

    let finalContent: string | Buffer;
    let hasSecrets = false;
    const isBinary = Boolean(options.isBinary);

    if (typeof options.content === "string") {
      if (options.kind === "patch") {
        const check = inspectPatchForSecrets(options.content);
        if (!check.safe) {
          const err = new Error(
            `POLICY_DENIED: ${check.reason ?? "Patch contains detected secrets. Redaction would corrupt diff; rejected for security."}`,
          );
          (err as any).code = "POLICY_DENIED";
          throw err;
        }
        finalContent = options.content;
      } else {
        const redacted = redactSecrets(options.content);
        finalContent = redacted.redacted;
        hasSecrets = redacted.found;
      }
    } else {
      finalContent = options.content;
    }

    const byteSize = Buffer.isBuffer(finalContent)
      ? finalContent.length
      : Buffer.byteLength(finalContent, "utf8");

    const manifestPath = path.join(runDir, "manifest.json");

    // We update manifest and write artifact under the manifest lock to ensure atomic byte accounting
    let metadata: ArtifactMetadata;
    this.withLock(manifestPath, () => {
      const manifestStr = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(manifestStr) as RunManifestV1;

      const currentRunBytes =
        manifest.artifacts.reduce((acc, a) => acc + a.byte_size, 0) + byteSize;
      if (currentRunBytes > this.limits.maxArtifactBytesPerRun) {
        throw new Error(
          `Artifact storage budget exceeded for run ${options.runId}: limit is ${this.limits.maxArtifactBytesPerRun} bytes`,
        );
      }

      const hash = createHash("sha256");
      hash.update(finalContent);
      const sha256 = hash.digest("hex");

      this.atomicWriteFile(targetPath, finalContent);

      const artifactId =
        options.id ?? `art_${options.kind}_${randomUUID().slice(0, 8)}`;
      metadata = {
        id: artifactId,
        kind: options.kind,
        byte_size: byteSize,
        sha256,
        mime_type:
          options.mimeType ??
          (isBinary ? "application/octet-stream" : "text/plain"),
        created_at: new Date().toISOString(),
        relative_path: options.relativePath,
        task_id: options.taskId,
        gate_id: options.gateId,
        attempt: options.attempt,
        has_secrets: hasSecrets,
        is_binary: isBinary,
      };

      updateManifestArtifact(manifest, metadata);
      this.atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
    });

    return metadata!;
  }

  resolveSelector(
    runId: string,
    selector: ArtifactSelector,
  ): ArtifactMetadata | null {
    const manifest = this.loadManifest(runId);
    if (!manifest) return null;

    if (selector === "manifest") {
      return (
        manifest.artifacts.find((a) => a.kind === "manifest") ?? {
          id: "manifest",
          kind: "manifest",
          byte_size: 0,
          sha256: "",
          mime_type: "application/json",
          created_at: manifest.created_at,
          relative_path: "manifest.json",
        }
      );
    }

    if (selector === "digest") {
      return manifest.artifacts.find((a) => a.kind === "digest") ?? null;
    }

    if (selector === "request") {
      return (
        manifest.artifacts.find(
          (a) =>
            a.id === "request" ||
            a.id === "art_request" ||
            a.relative_path === "request.json",
        ) ?? null
      );
    }

    if (selector === "plan") {
      return (
        manifest.artifacts.find(
          (a) =>
            a.id === "plan" ||
            a.kind === "plan" ||
            a.relative_path === "plan.json",
        ) ?? null
      );
    }

    if (selector === "events") {
      return (
        manifest.artifacts.find(
          (a) =>
            a.id === "events" ||
            a.id === "art_events" ||
            a.kind === "events" ||
            a.relative_path === "events.jsonl",
        ) ?? null
      );
    }

    const taskMatch = selector.match(/^task:([^:]+):(stdout|stderr|patch)$/);
    if (taskMatch) {
      const [, taskId, kind] = taskMatch;
      const matches = manifest.artifacts.filter(
        (a) => a.task_id === taskId && a.kind === kind,
      );
      if (matches.length === 0) return null;
      matches.sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0));
      return matches[0] ?? null;
    }

    const gateMatch = selector.match(/^gate:([^:]+):(stdout|stderr)$/);
    if (gateMatch) {
      const [, gateId, kind] = gateMatch;
      const matches = manifest.artifacts.filter(
        (a) => a.gate_id === gateId && a.kind === kind,
      );
      if (matches.length === 0) return null;
      matches.sort((a, b) => (b.attempt ?? 0) - (a.attempt ?? 0));
      return matches[0] ?? null;
    }

    return null;
  }

  readArtifactSlice(
    runId: string,
    metadata: ArtifactMetadata,
    options: ReadArtifactSliceOptions = {},
  ): ArtifactSliceResult {
    if (metadata.is_binary) {
      return {
        content: `[Binary artifact (${metadata.byte_size} bytes, SHA-256: ${metadata.sha256}). Inline inspection not supported.]`,
        startLine: 1,
        linesReturned: 1,
        totalLines: 1,
        bytesReturned: 0,
        truncated: false,
      };
    }

    const runDir = this.getRunDir(runId);
    // Safe read mapping
    const filePath = resolveSafePath(runDir, metadata.relative_path, {
      mustExist: true,
    });

    const rawBuffer = readFileSync(filePath);
    let sliceBuffer = rawBuffer;
    let byteOffset = options.byteOffset ?? 0;

    // Exact byte slicing
    if (byteOffset > 0) {
      if (byteOffset >= rawBuffer.length) {
        return {
          content: "",
          startLine: 1,
          linesReturned: 0,
          totalLines: 0,
          bytesReturned: 0,
          truncated: false,
        };
      }
      sliceBuffer = rawBuffer.subarray(byteOffset);
    }

    // We can't slice blindly across multibyte UTF-8 codepoints. We can use StringDecoder
    const decoder = new StringDecoder("utf8");
    let text = decoder.write(sliceBuffer) + decoder.end();

    const lines = text.split(/\r?\n/);
    const totalLines = lines.length;

    const startLine = Math.max(1, options.startLine ?? 1);
    const maxLines = Math.min(
      Math.max(1, options.maxLines ?? 100),
      this.limits.maxFetchLines,
    );
    const maxBytes = Math.min(
      options.maxBytes ?? this.limits.maxFetchBytes,
      this.limits.maxFetchBytes,
    );

    const startIndex = startLine - 1;
    let selectedLines = lines.slice(startIndex, startIndex + maxLines);

    let content = selectedLines.join("\n");
    let bytesReturned = Buffer.byteLength(content, "utf8");
    let truncated = startIndex + maxLines < totalLines;

    if (bytesReturned > maxBytes) {
      // Safe UTF-8 truncation: encode to buffer, subarray, then use text decoder or StringDecoder to avoid U+FFFD
      const contentBuf = Buffer.from(content, "utf8");
      const trunkBuf = contentBuf.subarray(0, maxBytes);
      const truncDecoder = new StringDecoder("utf8");
      // StringDecoder automatically handles trailing partial bytes securely (they are not emitted, preventing U+FFFD)
      content = truncDecoder.write(trunkBuf);
      bytesReturned = Buffer.byteLength(content, "utf8");
      truncated = true;

      // Calculate how many lines were returned exactly
      selectedLines = content.split(/\r?\n/);
    }

    return {
      content,
      startLine,
      linesReturned: selectedLines.length,
      totalLines,
      bytesReturned,
      truncated,
    };
  }
}
