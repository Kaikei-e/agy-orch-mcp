import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCommand } from "./guard.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runMain(): void {
  try {
    const rawStdin = readFileSync(0, "utf8");
    const payload: unknown = JSON.parse(rawStdin);
    const toolCall =
      isRecord(payload) && isRecord(payload.toolCall)
        ? payload.toolCall
        : undefined;
    const toolName = toolCall?.name;
    const args =
      toolCall && isRecord(toolCall.args) ? toolCall.args : undefined;
    const rawCommandLine = args?.CommandLine;

    if (
      toolName !== "run_command" ||
      typeof rawCommandLine !== "string" ||
      rawCommandLine.length === 0
    ) {
      process.stdout.write(
        `${JSON.stringify({
          decision: "deny_unless_prior_grant",
          reason: "guard hook: no command line",
        })}\n`,
      );
      return;
    }

    let commandLine = rawCommandLine;
    if (commandLine.startsWith('"') && commandLine.endsWith('"')) {
      try {
        const unwrapped: unknown = JSON.parse(commandLine);
        if (typeof unwrapped === "string") {
          commandLine = unwrapped;
        }
      } catch {
        // Keep original string if it is not a valid JSON string literal.
      }
    }

    if (commandLine.length === 0) {
      process.stdout.write(
        `${JSON.stringify({
          decision: "deny_unless_prior_grant",
          reason: "guard hook: no command line",
        })}\n`,
      );
      return;
    }

    const { decision, reason } = evaluateCommand(commandLine);
    process.stdout.write(`${JSON.stringify({ decision, reason })}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({
        decision: "deny_unless_prior_grant",
        reason: `guard hook error: ${message}`,
      })}\n`,
    );
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(selfPath);
  } catch {
    return path.resolve(entry) === path.resolve(selfPath);
  }
}

if (isMainModule()) {
  runMain();
}
