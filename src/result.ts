import { pathToFileURL } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { CommandRecord, RunResult } from "./run-result.js";

interface OutlineEntry {
  level: number;
  heading: string;
  start_line: number;
  end_line: number;
}

function buildResponseOutline(fullResponse: string): OutlineEntry[] {
  const lines = fullResponse.split(/\r?\n/);
  const raw: Array<{ level: number; heading: string; start_line: number }> = [];
  let fenceChar: string | undefined;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fenceChar !== undefined) {
      const closeMatch = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (
        closeMatch &&
        closeMatch[1]![0] === fenceChar &&
        closeMatch[1]!.length >= fenceLen
      ) {
        fenceChar = undefined;
        fenceLen = 0;
      }
      continue;
    }

    const openBacktick = /^\s*(`{3,})[^`]*$/.exec(line);
    if (openBacktick) {
      fenceChar = "`";
      fenceLen = openBacktick[1]!.length;
      continue;
    }
    const openTilde = /^\s*(~{3,}).*$/.exec(line);
    if (openTilde) {
      fenceChar = "~";
      fenceLen = openTilde[1]!.length;
      continue;
    }

    const headingMatch = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(
      line,
    );
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const heading = (headingMatch[2] ?? "").trim().slice(0, 120);
      raw.push({ level, heading, start_line: i + 1 });
    }
  }

  const totalLines = lines.length;
  return raw.slice(0, 80).map((entry, idx) => ({
    level: entry.level,
    heading: entry.heading,
    start_line: entry.start_line,
    end_line: idx + 1 < raw.length ? raw[idx + 1]!.start_line - 1 : totalLines,
  }));
}

function applyVerifiedOutputsBudget(
  data: Record<string, unknown>,
  records: CommandRecord[],
  budget: number,
): void {
  if (
    data.verified_outputs === undefined ||
    JSON.stringify(data.verified_outputs).length <= budget
  ) {
    return;
  }

  const withoutEarlyTails = records.map((rec, i) => {
    if (i < records.length - 10 && rec.output_tail !== undefined) {
      const copy = { ...rec };
      delete copy.output_tail;
      return copy;
    }
    return rec;
  });
  data.verified_outputs = withoutEarlyTails;
  if (JSON.stringify(data.verified_outputs).length <= budget) return;

  if (withoutEarlyTails.length > 40) {
    data.verified_outputs = withoutEarlyTails.slice(-40);
    data.verified_outputs_omitted = withoutEarlyTails.length - 40;
    if (JSON.stringify(data.verified_outputs).length <= budget) return;
  }

  delete data.verified_outputs;
  data.verified_outputs_omitted = records.length;
}

/** Bound both MCP representations, including error/metadata, not just the answer. */
export function toToolResult(result: RunResult, limit: number): CallToolResult {
  const data: Record<string, unknown> = {
    ok: result.ok,
    status: result.status.slice(0, 100),
    exit_code: result.exitCode,
    ...(result.conversationId
      ? { conversation_id: result.conversationId.slice(0, 200) }
      : {}),
    ...(result.resumable !== undefined ? { resumable: result.resumable } : {}),
    ...(result.terminatedTasks?.length
      ? { terminated_tasks: result.terminatedTasks }
      : {}),
    ...(result.durationSec !== undefined
      ? { duration_seconds: result.durationSec }
      : {}),
    ...(result.turnSeconds !== undefined
      ? { turn_seconds: result.turnSeconds }
      : {}),
    ...(result.queueWaitSeconds !== undefined
      ? { queue_wait_seconds: result.queueWaitSeconds }
      : {}),
    ...(result.error ? { error: result.error.slice(0, 2_000) } : {}),
    ...(result.preflightWarnings?.length
      ? { preflight_warnings: result.preflightWarnings }
      : {}),
    ...(result.deniedActions?.length
      ? { denied_actions: result.deniedActions }
      : {}),
    ...(result.deniedCommands?.length
      ? { denied_commands: result.deniedCommands }
      : {}),
    ...(result.verifiedOutputs?.length
      ? { verified_outputs: result.verifiedOutputs }
      : {}),
    ...(result.workspaceChanges?.length
      ? { workspace_changes: result.workspaceChanges }
      : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.context ? { context: result.context } : {}),
    ...(result.handoff !== undefined ? { handoff: result.handoff } : {}),
    ...(result.handoffError ? { handoff_error: result.handoffError } : {}),
    ...(result.partialResponse
      ? { partial_response: result.partialResponse }
      : {}),
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

  const verifiedOutputsBudget = Math.floor(limit * 0.3);
  let text = JSON.stringify(data);
  if (text.length <= limit && result.verifiedOutputs?.length) {
    applyVerifiedOutputsBudget(
      data,
      result.verifiedOutputs,
      verifiedOutputsBudget,
    );
    text = JSON.stringify(data);
  }

  if (text.length > limit) {
    data.truncated = true;
    data.truncation_notice = result.responseArtifact
      ? "Output shortened; the full response is saved at response_artifact.path. Read only the parts you need from that file."
      : "Output shortened; ask a narrower question or raise AGY_MCP_MAX_OUTPUT_CHARS.";
    for (const key of [
      "denied_actions",
      "denied_commands",
      "usage",
      "workspace_changes",
    ]) {
      if (JSON.stringify(data).length <= limit) break;
      if (data[key] !== undefined) {
        delete data[key];
        data[`${key}_omitted`] = true;
      }
    }
    if (result.verifiedOutputs?.length) {
      applyVerifiedOutputsBudget(
        data,
        result.verifiedOutputs,
        verifiedOutputsBudget,
      );
    }

    // JSON escaping can expand control characters several-fold. Bound every
    // string that came from agy, including status and conversation_id, so the
    // configured limit remains a hard cap even for malformed CLI output.
    for (const key of [
      "response",
      "partial_response",
      "stderr",
      "error",
      "handoff_error",
      "conversation_id",
      "status",
      "truncation_notice",
    ]) {
      if (JSON.stringify(data).length <= limit) break;
      if (data[key] === undefined) continue;
      const original =
        typeof data[key] === "string" ? (data[key] as string) : "";
      data[key] = "";
      if (key === "response" && original.length > 0) {
        const outline = buildResponseOutline(original);
        data.response_outline = outline;
        if (JSON.stringify(data).length > limit) {
          delete data.response_outline;
          data.response_outline_omitted = true;
        }
      }
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

    for (const key of [
      "preflight_warnings",
      "handoff",
      "terminated_tasks",
      "verified_outputs",
    ]) {
      if (JSON.stringify(data).length <= limit) break;
      if (data[key] !== undefined) {
        delete data[key];
        if (key === "verified_outputs" && result.verifiedOutputs?.length) {
          data.verified_outputs_omitted = result.verifiedOutputs.length;
        } else {
          data[`${key}_omitted`] = true;
        }
      }
    }
    text = JSON.stringify(data);
  }

  const content: CallToolResult["content"] = [{ type: "text", text }];
  if (result.responseArtifact) {
    content.push({
      type: "resource_link",
      uri: pathToFileURL(result.responseArtifact.path).href,
      name: "response.txt",
      mimeType: "text/plain",
      description: `Full agy response, ${result.response.length} characters`,
    });
  }
  return {
    content,
    structuredContent: data,
    isError: !result.ok,
  };
}
