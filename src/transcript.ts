import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENIED = /user denied permission to run command:\n([^\n]+)/;
const MAX_COMMANDS = 10;
const MAX_COMMAND_CHARS = 500;

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
  for (const line of text.split("\n")) {
    if (!line.includes("denied permission")) continue;
    let step: { error?: unknown; created_at?: unknown };
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    // Transcript timestamps have second precision.
    const created = Date.parse(String(step.created_at));
    if (!(created >= sinceMs - 1_000)) continue;
    const match = typeof step.error === "string" && DENIED.exec(step.error);
    if (match && match[1])
      commands.add(match[1].trim().slice(0, MAX_COMMAND_CHARS));
    if (commands.size >= MAX_COMMANDS) break;
  }
  return [...commands];
}
