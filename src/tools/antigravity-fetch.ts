import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ArtifactStore } from "../artifacts/store.js";
import type { FetchRequestV1, FetchResponseV1 } from "../domain/ir.js";
import { validateFetchRequest } from "../validation/schema.js";

export function executeFetch(
  rawArgs: unknown,
  store: ArtifactStore,
): CallToolResult {
  let req: FetchRequestV1;
  try {
    req = validateFetchRequest(rawArgs);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }

  const manifest = store.loadManifest(req.run_id);
  if (!manifest) {
    return {
      content: [
        {
          type: "text",
          text: `Run not found: "${req.run_id}". Check run_id or retention status.`,
        },
      ],
      isError: true,
    };
  }

  let artifact = req.artifact_id
    ? manifest.artifacts.find((a) => a.id === req.artifact_id)
    : undefined;

  if (!artifact && req.selector) {
    artifact = store.resolveSelector(req.run_id, req.selector) ?? undefined;
  }

  if (!artifact) {
    const available = manifest.artifacts
      .map((a) => `${a.id} (${a.kind})`)
      .join(", ");
    return {
      content: [
        {
          type: "text",
          text: `Artifact not found in run "${req.run_id}". Available artifacts: [${available}]`,
        },
      ],
      isError: true,
    };
  }

  const slice = store.readArtifactSlice(req.run_id, artifact, {
    startLine: req.start_line,
    maxLines: req.max_lines,
    maxBytes: req.max_bytes,
  });

  const response: FetchResponseV1 = {
    schema_version: "1",
    run_id: req.run_id,
    artifact: {
      id: artifact.id,
      kind: artifact.kind,
      byte_size: artifact.byte_size,
      sha256: artifact.sha256,
      mime_type: artifact.mime_type,
      is_binary: Boolean(artifact.is_binary),
      has_secrets: Boolean(artifact.has_secrets),
    },
    range: {
      start_line: slice.startLine,
      lines_returned: slice.linesReturned,
      total_lines: slice.totalLines,
      bytes_returned: slice.bytesReturned,
      truncated: slice.truncated,
    },
    content: slice.content,
    notice: slice.truncated
      ? `Slice truncated. Returned ${slice.linesReturned}/${slice.totalLines} lines (${slice.bytesReturned} bytes). Use start_line/max_lines to paginate.`
      : undefined,
  };

  const humanText = `[agy-orch-mcp] Fetched artifact ${artifact.id} (${artifact.kind}) from run ${req.run_id}. Lines ${slice.startLine}-${slice.startLine + slice.linesReturned - 1} of ${slice.totalLines}.\n\n${slice.content}`;

  return {
    content: [{ type: "text", text: humanText }],
    structuredContent: response as unknown as Record<string, unknown>,
    isError: false,
  };
}
