import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const GH_DENY_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  pr: [
    "create",
    "merge",
    "close",
    "reopen",
    "edit",
    "ready",
    "review",
    "comment",
  ],
  workflow: ["run", "enable", "disable"],
  run: ["rerun", "cancel", "delete"],
  release: ["create", "delete", "edit", "upload"],
  repo: ["create", "delete", "edit", "fork", "rename", "archive"],
  issue: ["create", "close", "reopen", "edit", "comment", "delete"],
  secret: ["set", "delete"],
  variable: ["set", "delete"],
  label: ["create", "edit", "delete"],
};

export const FIXED_DENY_RULES: readonly string[] = Object.freeze([
  "command(git push)",
  ...Object.entries(GH_DENY_ACTIONS).flatMap(([group, actions]) =>
    actions.map((action) => `command(gh ${group} ${action})`),
  ),
]);

export function sessionSettingsJson(): string {
  return JSON.stringify({ permissions: { deny: FIXED_DENY_RULES } });
}

export interface GuardVerdict {
  decision: "deny" | "deny_unless_prior_grant";
  reason: string;
  rule: string;
}

const REMOTE_REASON =
  "Remote-changing git/GitHub operations are reserved for the host. Do not retry; list what you would run in your handoff instead.";
const SHELL_CONSTRUCT_REASON =
  "Redirection and command substitution are unavailable here. Run the command without them and read its output from the tool result; create or edit files with your file tools.";
const GO_TEMPLATE_REASON =
  "If this is denied, drop the Go template and request JSON output (for example `--format json`), then read the fields from it.";
const UNQUOTED_PAREN_REASON =
  "If this is denied, quote the pattern, or use your file search tool for patterns containing ( ) |.";
const ENV_PREFIX_REASON =
  "If this is denied, the inner command is what must be allowed; run an allowed command directly without the environment prefix.";
const ALLOW_LIST_REASON =
  "This command is not in the allow list for this environment. Use an allowed alternative (bare tool names, one simple command per call) or report it as a blocker in your handoff. Do not retry the same command.";

function pathBinaryReason(firstWord: string): string {
  const base = path.posix.basename(firstWord) || "<basename>";
  return `If this is denied, run the tool by its bare name (for example \`${base} ...\`) or through the project runner (\`pnpm exec ${base}\`, \`go run\`, \`uv run\`) instead of a path.`;
}

interface TokenizedCommand {
  segments: string[][];
  hasShellConstruct: boolean;
  hasUnquotedParen: boolean;
}

function isBoundaryChar(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    ch === " " ||
    ch === "\t" ||
    ch === "\r" ||
    ch === "\n" ||
    ch === "|" ||
    ch === ";" ||
    ch === "&"
  );
}

function tokenizeCommand(commandLine: string): TokenizedCommand {
  const segments: string[][] = [];
  let currentSegment: string[] = [];
  let currentWord = "";
  let inWord = false;
  let quote: "none" | "single" | "double" = "none";
  let hasShellConstruct = false;
  let hasUnquotedParen = false;

  const flushWord = (): void => {
    if (inWord) {
      currentSegment.push(currentWord);
      currentWord = "";
      inWord = false;
    }
  };

  const flushSegment = (): void => {
    flushWord();
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
  };

  const len = commandLine.length;
  let i = 0;
  while (i < len) {
    const ch = commandLine[i]!;

    if (quote === "single") {
      if (ch === "'") {
        quote = "none";
      } else {
        currentWord += ch;
      }
      i++;
      continue;
    }

    if (quote === "double") {
      if (ch === "\\") {
        if (i + 1 < len) {
          const next = commandLine[i + 1]!;
          if (next !== "\n") currentWord += next;
          i += 2;
        } else {
          currentWord += "\\";
          i++;
        }
        continue;
      }
      if (ch === '"') {
        quote = "none";
        i++;
        continue;
      }
      if (
        ch === "`" ||
        ((ch === "$" || ch === "<" || ch === ">") && commandLine[i + 1] === "(")
      ) {
        hasShellConstruct = true;
      }
      currentWord += ch;
      i++;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < len) {
        const next = commandLine[i + 1]!;
        if (next !== "\n") {
          inWord = true;
          currentWord += next;
        }
        i += 2;
      } else {
        inWord = true;
        currentWord += "\\";
        i++;
      }
      continue;
    }

    if (ch === "'") {
      inWord = true;
      quote = "single";
      i++;
      continue;
    }

    if (ch === '"') {
      inWord = true;
      quote = "double";
      i++;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      flushWord();
      i++;
      continue;
    }

    if (ch === "\n" || ch === ";") {
      flushSegment();
      i++;
      continue;
    }

    if (ch === "|") {
      flushSegment();
      i += commandLine[i + 1] === "|" ? 2 : 1;
      continue;
    }

    // Recognize exact fd duplications before `&` or `>` splitting/denial.
    if (
      !inWord &&
      (commandLine.startsWith("2>&1", i) ||
        commandLine.startsWith("1>&2", i)) &&
      isBoundaryChar(commandLine[i + 4])
    ) {
      i += 4;
      continue;
    }

    if (
      commandLine.startsWith(">&2", i) &&
      isBoundaryChar(commandLine[i + 3])
    ) {
      flushWord();
      i += 3;
      continue;
    }

    if (ch === "&") {
      if (commandLine[i + 1] === ">") {
        hasShellConstruct = true;
        i += 2;
        continue;
      }
      flushSegment();
      i += commandLine[i + 1] === "&" ? 2 : 1;
      continue;
    }

    if (ch === "`") {
      hasShellConstruct = true;
      inWord = true;
      currentWord += ch;
      i++;
      continue;
    }

    if (
      (ch === "$" || ch === "<" || ch === ">") &&
      commandLine[i + 1] === "("
    ) {
      hasShellConstruct = true;
      inWord = true;
      currentWord += `${ch}(`;
      i += 2;
      continue;
    }

    if (ch === ">" || ch === "<") {
      hasShellConstruct = true;
      inWord = true;
      currentWord += ch;
      i++;
      continue;
    }

    if (ch === "(" || ch === ")") {
      hasUnquotedParen = true;
      if (!inWord && currentSegment.length === 0 && ch === "(") {
        i++;
        continue;
      }
      inWord = true;
      currentWord += ch;
      i++;
      continue;
    }

    inWord = true;
    currentWord += ch;
    i++;
  }

  flushSegment();
  return { segments, hasShellConstruct, hasUnquotedParen };
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface StrippedSegment {
  words: string[];
  hadEnvPrefix: boolean;
}

function stripSegmentWrappers(segment: readonly string[]): StrippedSegment {
  let idx = 0;
  let hadEnvPrefix = false;
  const len = segment.length;

  while (idx < len) {
    const word = segment[idx]!;
    if (ENV_ASSIGNMENT.test(word)) {
      hadEnvPrefix = true;
      idx++;
      continue;
    }

    if (word === "env") {
      hadEnvPrefix = true;
      idx++;
      while (idx < len) {
        const w = segment[idx]!;
        if (w === "--") {
          idx++;
          while (idx < len && ENV_ASSIGNMENT.test(segment[idx]!)) idx++;
          break;
        }
        if (
          w === "-i" ||
          w === "--ignore-environment" ||
          w === "-0" ||
          w === "--null" ||
          w === "-v" ||
          w === "--debug"
        ) {
          idx++;
          continue;
        }
        if (
          w === "-u" ||
          w === "--unset" ||
          w === "-C" ||
          w === "--chdir" ||
          w === "-S" ||
          w === "--split-string"
        ) {
          idx += 2;
          continue;
        }
        if (
          w.startsWith("-u") ||
          w.startsWith("--unset=") ||
          w.startsWith("-C") ||
          w.startsWith("--chdir=") ||
          w.startsWith("-S") ||
          w.startsWith("--split-string=")
        ) {
          idx++;
          continue;
        }
        if (ENV_ASSIGNMENT.test(w)) {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }

    if (word === "timeout") {
      idx++;
      while (idx < len && segment[idx]!.startsWith("-")) {
        const w = segment[idx]!;
        if (w === "--") {
          idx++;
          break;
        }
        if (
          w === "-k" ||
          w === "--kill-after" ||
          w === "-s" ||
          w === "--signal"
        ) {
          idx += 2;
          continue;
        }
        idx++;
      }
      if (idx < len) idx++;
      continue;
    }

    if (word === "nohup") {
      idx++;
      if (segment[idx] === "--") idx++;
      continue;
    }

    if (word === "nice") {
      idx++;
      while (idx < len && segment[idx]!.startsWith("-")) {
        const w = segment[idx]!;
        if (w === "--") {
          idx++;
          break;
        }
        if (w === "-n" || w === "--adjustment") {
          idx += 2;
          continue;
        }
        if (
          w.startsWith("-n") ||
          w.startsWith("--adjustment=") ||
          /^-\d+$/.test(w)
        ) {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }

    if (word === "time") {
      idx++;
      while (
        idx < len &&
        (segment[idx] === "-p" || segment[idx] === "--portability")
      ) {
        idx++;
      }
      if (segment[idx] === "--") idx++;
      continue;
    }

    if (word === "stdbuf") {
      idx++;
      while (
        idx < len &&
        segment[idx]!.startsWith("-") &&
        segment[idx] !== "-"
      ) {
        const w = segment[idx]!;
        if (w === "--") {
          idx++;
          break;
        }
        if (
          w === "-i" ||
          w === "-o" ||
          w === "-e" ||
          w === "--input" ||
          w === "--output" ||
          w === "--error"
        ) {
          idx += 2;
          continue;
        }
        idx++;
      }
      continue;
    }

    if (word === "xargs" || word.endsWith("/xargs")) {
      idx++;
      while (idx < len && segment[idx]!.startsWith("-")) {
        const w = segment[idx]!;
        if (w === "--") {
          idx++;
          break;
        }
        if (
          w === "-n" ||
          w === "-I" ||
          w === "-L" ||
          w === "-P" ||
          w === "-d" ||
          w === "-s" ||
          w === "-E" ||
          w === "-a" ||
          w === "--max-args" ||
          w === "--replace" ||
          w === "--max-lines" ||
          w === "--max-procs" ||
          w === "--delimiter" ||
          w === "--max-chars" ||
          w === "--eof" ||
          w === "--arg-file" ||
          w === "--process-slot-var"
        ) {
          idx += 2;
          continue;
        }
        idx++;
      }
      continue;
    }

    if (word === "command") {
      idx++;
      while (idx < len && segment[idx]!.startsWith("-")) {
        const w = segment[idx]!;
        if (w === "--") {
          idx++;
          break;
        }
        if (w === "-p") {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }

    if (word === "exec") {
      idx++;
      while (idx < len && segment[idx]!.startsWith("-")) {
        const w = segment[idx]!;
        if (w === "--") {
          idx++;
          break;
        }
        if (w === "-a") {
          idx += 2;
          continue;
        }
        idx++;
      }
      continue;
    }

    break;
  }

  return {
    words: segment.slice(idx),
    hadEnvPrefix,
  };
}

function hasExplicitGetMethod(args: readonly string[]): boolean {
  let sawGet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.toLowerCase() === "--method" || arg === "-X" || arg === "-x") {
      const val = args[i + 1];
      if (!val || val.toUpperCase() !== "GET") return false;
      sawGet = true;
      i++;
      continue;
    }
    if (/^--method=/i.test(arg)) {
      const val = arg.slice("--method=".length);
      if (val.toUpperCase() !== "GET") return false;
      sawGet = true;
      continue;
    }
    if (/^-X.+/i.test(arg)) {
      const val = arg.slice(2);
      if (val.toUpperCase() !== "GET") return false;
      sawGet = true;
      continue;
    }
  }
  return sawGet;
}

function isRemoteCommandWords(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const cmd = words[0]!;

  if (cmd === "git" || cmd.endsWith("/git")) {
    let i = 1;
    while (i < words.length) {
      const w = words[i]!;
      if (
        w === "-C" ||
        w === "-c" ||
        w === "--git-dir" ||
        w === "--work-tree" ||
        w === "--namespace" ||
        w === "--super-prefix" ||
        w === "--config-env"
      ) {
        i += 2;
        continue;
      }
      if (
        w.startsWith("-C") ||
        w.startsWith("-c") ||
        w.startsWith("--git-dir=") ||
        w.startsWith("--work-tree=") ||
        w.startsWith("--namespace=") ||
        w.startsWith("--super-prefix=") ||
        w.startsWith("--config-env=") ||
        w.startsWith("--exec-path") ||
        w === "--no-pager" ||
        w === "-P" ||
        w === "--paginate" ||
        w === "-p" ||
        w === "--bare" ||
        w === "--no-replace-objects" ||
        w === "--literal-pathspecs" ||
        w === "--glob-pathspecs" ||
        w === "--noglob-pathspecs" ||
        w === "--icase-pathspecs" ||
        w === "--no-optional-locks"
      ) {
        i++;
        continue;
      }
      break;
    }
    return words[i] === "push";
  }

  if (cmd === "gh" || cmd.endsWith("/gh")) {
    let i = 1;
    while (i < words.length) {
      const w = words[i]!;
      if (w === "-R" || w === "--repo" || w === "-H" || w === "--hostname") {
        i += 2;
        continue;
      }
      if (
        w.startsWith("-R") ||
        w.startsWith("--repo=") ||
        w.startsWith("-H") ||
        w.startsWith("--hostname=")
      ) {
        i++;
        continue;
      }
      break;
    }
    const group = words[i];
    if (!group) return false;
    if (group === "api") {
      return !hasExplicitGetMethod(words.slice(i + 1));
    }
    const actions = GH_DENY_ACTIONS[group];
    if (!actions) return false;
    i++;
    while (i < words.length) {
      const w = words[i]!;
      if (w === "-R" || w === "--repo" || w === "-H" || w === "--hostname") {
        i += 2;
        continue;
      }
      if (
        w.startsWith("-R") ||
        w.startsWith("--repo=") ||
        w.startsWith("-H") ||
        w.startsWith("--hostname=")
      ) {
        i++;
        continue;
      }
      break;
    }
    const action = words[i];
    return Boolean(action && actions.includes(action));
  }

  return false;
}

const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const MAX_SHELL_RECURSION_DEPTH = 3;

function extractShellDashCScript(words: readonly string[]): string | undefined {
  if (words.length < 3) return undefined;
  const base = path.posix.basename(words[0]!);
  if (!SHELL_WRAPPERS.has(base)) return undefined;

  let i = 1;
  while (i < words.length) {
    const w = words[i]!;
    if (w === "--") return undefined;
    if (w.startsWith("--")) {
      if (w === "--rcfile" || w === "--init-file") {
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (w === "-o" || w === "+o" || w === "-O" || w === "+O") {
      i += 2;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      const flags = w.slice(1);
      if (/^[A-Za-z]+$/.test(flags) && flags.includes("c")) {
        return words[i + 1];
      }
      i++;
      continue;
    }
    if (w.startsWith("+") && w.length > 1) {
      i++;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function evaluateCommandAtDepth(
  commandLine: string,
  depth: number,
): GuardVerdict {
  if (depth > MAX_SHELL_RECURSION_DEPTH) {
    return {
      decision: "deny",
      reason: SHELL_CONSTRUCT_REASON,
      rule: "shell-construct",
    };
  }

  const { segments, hasShellConstruct, hasUnquotedParen } =
    tokenizeCommand(commandLine);
  const stripped = segments.map((segment) => {
    const res = stripSegmentWrappers(segment);
    const script = extractShellDashCScript(res.words);
    const subVerdict =
      script !== undefined
        ? evaluateCommandAtDepth(script, depth + 1)
        : undefined;
    return { ...res, subVerdict };
  });

  for (const seg of stripped) {
    if (isRemoteCommandWords(seg.words)) {
      return {
        decision: "deny",
        reason: REMOTE_REASON,
        rule: "remote",
      };
    }
    if (seg.subVerdict?.rule === "remote") {
      return seg.subVerdict;
    }
  }

  if (hasShellConstruct) {
    return {
      decision: "deny",
      reason: SHELL_CONSTRUCT_REASON,
      rule: "shell-construct",
    };
  }

  for (const seg of stripped) {
    if (seg.subVerdict?.rule === "shell-construct") {
      return seg.subVerdict;
    }
  }

  for (const seg of stripped) {
    const firstWord = seg.words[0];
    if (firstWord && firstWord.includes("/")) {
      return {
        decision: "deny_unless_prior_grant",
        reason: pathBinaryReason(firstWord),
        rule: "path-binary",
      };
    }
    if (seg.subVerdict?.rule === "path-binary") {
      return seg.subVerdict;
    }
  }

  if (
    commandLine.includes("{{") ||
    stripped.some(
      (seg) =>
        seg.words.some((w) => w.includes("{{")) ||
        seg.subVerdict?.rule === "go-template",
    )
  ) {
    return {
      decision: "deny_unless_prior_grant",
      reason: GO_TEMPLATE_REASON,
      rule: "go-template",
    };
  }

  if (
    hasUnquotedParen ||
    stripped.some((seg) => seg.subVerdict?.rule === "unquoted-paren")
  ) {
    return {
      decision: "deny_unless_prior_grant",
      reason: UNQUOTED_PAREN_REASON,
      rule: "unquoted-paren",
    };
  }

  if (
    stripped.some(
      (seg) => seg.hadEnvPrefix || seg.subVerdict?.rule === "env-prefix",
    )
  ) {
    return {
      decision: "deny_unless_prior_grant",
      reason: ENV_PREFIX_REASON,
      rule: "env-prefix",
    };
  }

  return {
    decision: "deny_unless_prior_grant",
    reason: ALLOW_LIST_REASON,
    rule: "allow-list",
  };
}

export function evaluateCommand(commandLine: string): GuardVerdict {
  return evaluateCommandAtDepth(commandLine, 0);
}

export const GUARD_ENV = "AGY_ORCH_MCP_GUARD";
export const SUBAGENT_MODEL_ENV = "AGY_ORCH_MCP_SUBAGENT_MODEL";
export const GUARD_HOOK_NAME = "agy-orch-mcp-guard";
export type GuardStatus = "installed" | "missing" | "outdated";
export type SubagentTier = "flash_lite" | "flash" | "pro";

export function resolveSubagentTier(subagentModel: string): SubagentTier {
  if (/flash[-_]lite/i.test(subagentModel)) return "flash_lite";
  if (/flash/i.test(subagentModel)) return "flash";
  return "pro";
}

export function subagentSessionMessage(subagentModel: string): string {
  const tier = resolveSubagentTier(subagentModel);
  return (
    `Subagent/Swarm model policy (agy-orch-mcp): ` +
    `When spawning native swarm workers (\`swarm\` with \`action: "add"\`), pass \`model: "${subagentModel}"\` unless the user prompt explicitly requests another model. ` +
    `When invoking subagents (\`invoke_subagent\`), pass \`Model: "${tier}"\` instead of \`"inherit"\` unless the user prompt explicitly requests another tier.`
  );
}

export function defaultHooksPath(home = homedir()): string {
  return path.join(home, ".gemini", "config", "hooks.json");
}

function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function guardHookCommand(
  nodeBin: string,
  hookScriptPath: string,
): string {
  return `if [ -n "$${GUARD_ENV}" ] || [ -n "$${SUBAGENT_MODEL_ENV}" ]; then exec ${posixSingleQuote(nodeBin)} ${posixSingleQuote(hookScriptPath)}; else cat >/dev/null; fi`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PRE_TOOL_MATCHERS = ["run_command", "swarm", "invoke_subagent"] as const;

function buildGuardEntry(command: string): Record<string, unknown> {
  return {
    SessionStart: [
      {
        type: "command",
        command,
        timeout: 10,
      },
    ],
    PreToolUse: PRE_TOOL_MATCHERS.map((matcher) => ({
      matcher,
      hooks: [
        {
          type: "command",
          command,
          timeout: 10,
        },
      ],
    })),
  };
}

function isMatchingHookHandler(
  hook: unknown,
  expectedCommand: string,
): boolean {
  if (!isRecord(hook) || Object.keys(hook).length !== 3) return false;
  return (
    hook.type === "command" &&
    hook.command === expectedCommand &&
    hook.timeout === 10
  );
}

function isMatchingGuardEntry(
  entry: unknown,
  expectedCommand: string,
): boolean {
  if (!isRecord(entry) || Object.keys(entry).length !== 2) return false;
  const sessionStart = entry.SessionStart;
  if (
    !Array.isArray(sessionStart) ||
    sessionStart.length !== 1 ||
    !isMatchingHookHandler(sessionStart[0], expectedCommand)
  ) {
    return false;
  }
  const preToolUse = entry.PreToolUse;
  if (
    !Array.isArray(preToolUse) ||
    preToolUse.length !== PRE_TOOL_MATCHERS.length
  ) {
    return false;
  }
  for (let i = 0; i < PRE_TOOL_MATCHERS.length; i++) {
    const rule = preToolUse[i];
    if (
      !isRecord(rule) ||
      Object.keys(rule).length !== 2 ||
      rule.matcher !== PRE_TOOL_MATCHERS[i] ||
      !Array.isArray(rule.hooks) ||
      rule.hooks.length !== 1 ||
      !isMatchingHookHandler(rule.hooks[0], expectedCommand)
    ) {
      return false;
    }
  }
  return true;
}

export function guardStatus(
  hooksPath: string,
  expectedCommand: string,
): GuardStatus {
  let raw: string;
  try {
    raw = readFileSync(hooksPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "outdated";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "outdated";
  }

  if (!isRecord(parsed) || !(GUARD_HOOK_NAME in parsed)) {
    return "missing";
  }

  return isMatchingGuardEntry(parsed[GUARD_HOOK_NAME], expectedCommand)
    ? "installed"
    : "outdated";
}

function utcTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function atomicWriteJson(
  targetPath: string,
  data: Record<string, unknown>,
  mode: number,
): void {
  const dir = path.dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const content = `${JSON.stringify(data, null, 2)}\n`;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", mode });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw err;
  }
}

export function installGuard(
  hooksPath: string,
  command: string,
): { status: "installed" | "unchanged"; backupPath?: string } {
  let existed = false;
  let mode = 0o644;
  let existingObj: Record<string, unknown> = {};

  try {
    const raw = readFileSync(hooksPath, "utf8");
    mode = statSync(hooksPath).mode & 0o777;
    existed = true;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(
        `Invalid hooks.json at ${hooksPath}: root must be a JSON object`,
      );
    }
    existingObj = parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  if (existed && isMatchingGuardEntry(existingObj[GUARD_HOOK_NAME], command)) {
    return { status: "unchanged" };
  }

  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${hooksPath}.agy-orch-mcp-${utcTimestamp()}.bak`;
    copyFileSync(hooksPath, backupPath);
  }

  const nextObj: Record<string, unknown> = {
    ...existingObj,
    [GUARD_HOOK_NAME]: buildGuardEntry(command),
  };
  atomicWriteJson(hooksPath, nextObj, mode);

  return backupPath !== undefined
    ? { status: "installed", backupPath }
    : { status: "installed" };
}

export function uninstallGuard(hooksPath: string): boolean {
  let raw: string;
  let mode: number;
  try {
    raw = readFileSync(hooksPath, "utf8");
    mode = statSync(hooksPath).mode & 0o777;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(
      `Invalid hooks.json at ${hooksPath}: root must be a JSON object`,
    );
  }

  if (!(GUARD_HOOK_NAME in parsed)) {
    return false;
  }

  const backupPath = `${hooksPath}.agy-orch-mcp-${utcTimestamp()}.bak`;
  copyFileSync(hooksPath, backupPath);

  const nextObj: Record<string, unknown> = { ...parsed };
  delete nextObj[GUARD_HOOK_NAME];
  atomicWriteJson(hooksPath, nextObj, mode);
  return true;
}
