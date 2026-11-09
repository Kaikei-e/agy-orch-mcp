import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENIED = /user denied permission to run command:\n([^\n]+)/;
const MAX_COMMANDS = 10;
const MAX_COMMAND_CHARS = 500;

interface TranscriptStep {
  type?: unknown;
  created_at?: unknown;
  content?: unknown;
  error?: unknown;
  tool_calls?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeArgString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      return value;
    }
  }
  return value;
}

export function transcriptPath(
  conversationId: string,
  home = homedir(),
): string {
  return path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

/**
 * agy's result envelope only reports `{action: "command"}` for denials; the
 * rejected command line exists solely in the conversation transcript.
 */
export function readDeniedCommands(
  conversationId: string,
  sinceMs: number,
  home = homedir(),
): string[] {
  if (!UUID.test(conversationId)) return [];
  let text: string;
  try {
    text = readFileSync(transcriptPath(conversationId, home), "utf8");
  } catch {
    return [];
  }
  const commands = new Set<string>();
  let lastPlanner: TranscriptStep | undefined;
  let hasLaterGeneric = false;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let step: TranscriptStep;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (step.type === "PLANNER_RESPONSE") {
      lastPlanner = step;
      hasLaterGeneric = false;
    } else if (step.type === "GENERIC") {
      hasLaterGeneric = true;
    }

    if (
      typeof step.error === "string" &&
      step.error.includes("denied permission")
    ) {
      // Transcript timestamps have second precision.
      const created = Date.parse(String(step.created_at));
      if (created >= sinceMs - 1_000 && commands.size < MAX_COMMANDS) {
        const match = DENIED.exec(step.error);
        if (match?.[1]) {
          const cmd = match[1].trim().slice(0, MAX_COMMAND_CHARS);
          if (cmd) commands.add(cmd);
        }
      }
    }
  }

  if (lastPlanner && !hasLaterGeneric && commands.size < MAX_COMMANDS) {
    const created = Date.parse(String(lastPlanner.created_at));
    if (created >= sinceMs - 1_000 && Array.isArray(lastPlanner.tool_calls)) {
      for (const item of lastPlanner.tool_calls) {
        if (commands.size >= MAX_COMMANDS) break;
        const call = asRecord(item);
        if (!call || call.name !== "run_command") continue;
        const args = asRecord(call.args);
        const decoded = decodeArgString(args?.CommandLine);
        const cmd = decoded?.trim().slice(0, MAX_COMMAND_CHARS);
        if (cmd) commands.add(cmd);
      }
    }
  }

  return [...commands];
}

export function readLastPlannerText(
  conversationId: string,
  sinceMs: number,
  home = homedir(),
): string | undefined {
  if (!UUID.test(conversationId)) return undefined;
  let text: string;
  try {
    text = readFileSync(transcriptPath(conversationId, home), "utf8");
  } catch {
    return undefined;
  }
  let lastContent: string | undefined;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let step: TranscriptStep;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (step.type !== "PLANNER_RESPONSE") continue;
    const created = Date.parse(String(step.created_at));
    if (!(created >= sinceMs - 1_000)) continue;
    if (typeof step.content === "string" && step.content.trim().length > 0) {
      lastContent = step.content;
    }
  }
  return lastContent;
}
