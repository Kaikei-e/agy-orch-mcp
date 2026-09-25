import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RunResult } from "./agy.js";

/** Bound both MCP representations, including error/metadata, not just the answer. */
export function toToolResult(result: RunResult, limit: number): CallToolResult {
  const data: Record<string, unknown> = {
    ok: result.ok,
    status: result.status.slice(0, 100),
    exit_code: result.exitCode,
    ...(result.conversationId
      ? { conversation_id: result.conversationId.slice(0, 200) }
      : {}),
    ...(result.durationSec !== undefined
      ? { duration_seconds: result.durationSec }
      : {}),
    ...(result.error ? { error: result.error.slice(0, 2_000) } : {}),
    ...(result.deniedActions?.length
      ? { denied_actions: result.deniedActions }
      : {}),
    ...(result.deniedCommands?.length
      ? { denied_commands: result.deniedCommands }
      : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.context ? { context: result.context } : {}),
    ...(result.responseArtifact
      ? { response_artifact: result.responseArtifact }
      : {}),
    ...(!result.ok && result.stderr ? { stderr: result.stderr } : {}),
    ...(result.runId ? { run_id: result.runId } : {}),
    ...(result.traceId ? { trace_id: result.traceId } : {}),
    ...(result.recoveryPointer
      ? { recovery_pointer: result.recoveryPointer }
      : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    response: result.response,
    truncated: Boolean(result.error && result.error.length > 2_000),
  };
  let text = JSON.stringify(data);
  if (text.length > limit) {
    data.truncated = true;
    data.truncation_notice = result.responseArtifact
      ? "Output shortened; the full response is saved at response_artifact.path. Read only the parts you need from that file."
      : "Output shortened; ask a narrower question or raise AGY_MCP_MAX_OUTPUT_CHARS.";
    for (const key of ["denied_actions", "denied_commands", "usage"]) {
      if (JSON.stringify(data).length <= limit) break;
      if (data[key] !== undefined) {
        delete data[key];
        data[`${key}_omitted`] = true;
      }
    }
    // JSON escaping can expand control characters several-fold. Bound every
    // string that came from agy, including status and conversation_id, so the
    // configured limit remains a hard cap even for malformed CLI output.
    for (const key of [
      "response",
      "stderr",
      "error",
      "conversation_id",
      "status",
      "truncation_notice",
    ]) {
      if (JSON.stringify(data).length <= limit) break;
      const original =
        typeof data[key] === "string" ? (data[key] as string) : "";
      data[key] = "";
      if (JSON.stringify(data).length > limit) continue;
      let low = 0;
      let high = original.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        data[key] = original.slice(0, middle);
        if (JSON.stringify(data).length <= limit) low = middle;
        else high = middle - 1;
      }
      data[key] = original.slice(0, low);
    }
    text = JSON.stringify(data);
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
    isError: !result.ok,
  };
}
