import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUARD_ENV,
  SUBAGENT_MODEL_ENV,
  evaluateCommand,
  resolveSubagentTier,
  subagentSessionMessage,
} from "./guard.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapStringArg(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const unwrapped: unknown = JSON.parse(value);
      if (typeof unwrapped === "string") {
        return unwrapped;
      }
    } catch {
      // Keep original string if it is not a valid JSON string literal.
    }
  }
  return value;
}

function runMain(): void {
  const subagentModel = process.env[SUBAGENT_MODEL_ENV]?.trim();
  const guardActive = Boolean(process.env[GUARD_ENV]);
  try {
    const rawStdin = readFileSync(0, "utf8");
    const payload: unknown = JSON.parse(rawStdin);
    if (isRecord(payload) && payload.hookEventName === "SessionStart") {
      if (subagentModel) {
        process.stdout.write(
          `${JSON.stringify({
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: subagentSessionMessage(subagentModel),
                },
              },
            ],
          })}\n`,
        );
      }
      return;
    }

    const toolCall =
      isRecord(payload) && isRecord(payload.toolCall)
        ? payload.toolCall
        : undefined;
    const toolName = toolCall?.name;
    const args =
      toolCall && isRecord(toolCall.args) ? toolCall.args : undefined;

    if (toolName === "swarm") {
      if (
        subagentModel &&
        unwrapStringArg(args?.action) === "add" &&
        !unwrapStringArg(args?.model)?.trim()
      ) {
        process.stdout.write(
          `${JSON.stringify({
            decision: "allow",
            overwrite: { model: subagentModel },
          })}\n`,
        );
      }
      return;
    }

    if (toolName === "invoke_subagent") {
      const rawModel = unwrapStringArg(args?.Model)?.trim();
      const typeName = unwrapStringArg(args?.TypeName)?.trim();
      if (
        subagentModel &&
        typeName !== "image-generator" &&
        (!rawModel || rawModel === "inherit")
      ) {
        process.stdout.write(
          `${JSON.stringify({
            decision: "allow",
            overwrite: { Model: resolveSubagentTier(subagentModel) },
          })}\n`,
        );
      }
      return;
    }

    if (!guardActive && Boolean(subagentModel)) {
      return;
    }

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

    const commandLine = unwrapStringArg(rawCommandLine) ?? rawCommandLine;

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
    if (!guardActive && Boolean(subagentModel)) {
      return;
    }
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
