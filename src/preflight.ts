import { accessSync, constants, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

const MAX_WARNINGS = 10;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function loadPermissionRules(settingsPath?: string): PermissionRules {
  const target =
    settingsPath ??
    path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { allow: [], deny: [] };
    }
    const permissions = (parsed as Record<string, unknown>).permissions;
    if (
      !permissions ||
      typeof permissions !== "object" ||
      Array.isArray(permissions)
    ) {
      return { allow: [], deny: [] };
    }
    const permObj = permissions as Record<string, unknown>;
    const allow = Array.isArray(permObj.allow)
      ? permObj.allow.filter((item): item is string => typeof item === "string")
      : [];
    const deny = Array.isArray(permObj.deny)
      ? permObj.deny.filter((item): item is string => typeof item === "string")
      : [];
    return { allow, deny };
  } catch {
    return { allow: [], deny: [] };
  }
}

function extractCandidates(prompt: string): string[] {
  const candidates: string[] = [];
  const pattern =
    /(?:^|\r?\n)[ \t]*(`{3,}|~{3,})[^\r\n]*(?:\r?\n([\s\S]*?))?(?:\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)|$)|(`+)([^`\r\n]+?)\3/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt)) !== null) {
    if (match[1] !== undefined) {
      if (match[2]) {
        for (const line of match[2].split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) candidates.push(trimmed);
        }
      }
    } else if (match[4] !== undefined) {
      const trimmed = match[4].trim();
      if (trimmed) candidates.push(trimmed);
    }
  }
  return candidates;
}

function splitUnquotedOperators(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < input.length) {
        current += ch + input[i + 1]!;
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      current += ch + input[i + 1]!;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === "|") {
      if (input[i + 1] === "|") i++;
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    if (ch === "&" && input[i + 1] === "&") {
      i++;
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function firstCommandWord(candidate: string): string | undefined {
  const firstPart = splitUnquotedOperators(candidate)[0];
  if (!firstPart) return undefined;
  const tokens = firstPart.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (ENV_ASSIGNMENT.test(token)) {
      i++;
      continue;
    }
    if (token === "env") {
      i++;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const flag = tokens[i]!;
        i++;
        if (flag === "--") break;
        if (
          (flag === "-u" ||
            flag === "--unset" ||
            flag === "-C" ||
            flag === "--chdir") &&
          i < tokens.length
        ) {
          i++;
        }
      }
      continue;
    }
    if (token === "timeout") {
      i++;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const flag = tokens[i]!;
        i++;
        if (flag === "--") break;
        if (
          (flag === "-k" ||
            flag === "--kill-after" ||
            flag === "-s" ||
            flag === "--signal") &&
          i < tokens.length
        ) {
          i++;
        }
      }
      if (i < tokens.length) i++;
      continue;
    }
    if (token === "nohup") {
      i++;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const flag = tokens[i]!;
        i++;
        if (flag === "--") break;
      }
      continue;
    }
    if (token === "nice") {
      i++;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        const flag = tokens[i]!;
        i++;
        if (flag === "--") break;
        if ((flag === "-n" || flag === "--adjustment") && i < tokens.length) {
          i++;
        }
      }
      continue;
    }
    return token;
  }
  return undefined;
}

function isExecutableOnPath(word: string | undefined): boolean {
  if (
    !word ||
    word === "." ||
    word === ".." ||
    word.includes("/") ||
    word.includes("\\")
  ) {
    return false;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, word);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return true;
      }
    } catch {
      // continue checking remaining PATH entries
    }
  }
  return false;
}

function matchesRule(part: string, rule: string): boolean {
  if (!rule.startsWith("command(") || !rule.endsWith(")")) return false;
  const inner = rule.slice("command(".length, -1).trim();
  if (!inner) return false;
  if (inner === "*") return true;
  if (inner.startsWith("regex:")) {
    const pattern = inner.slice("regex:".length);
    try {
      return new RegExp(`^(?:${pattern})$`).test(part);
    } catch {
      return false;
    }
  }
  const ruleTokens = inner.split(/\s+/);
  const partTokens = part.trim().split(/\s+/);
  if (ruleTokens.length > partTokens.length) return false;
  for (let i = 0; i < ruleTokens.length; i++) {
    if (partTokens[i] !== ruleTokens[i]) return false;
  }
  return true;
}

export function preflightWarnings(
  prompt: string,
  rules: PermissionRules,
  extraDeny?: readonly string[],
): string[] {
  const denyRules = [...rules.deny, ...(extraDeny ?? [])];
  const warnings = new Set<string>();

  for (const candidate of extractCandidates(prompt)) {
    if (!isExecutableOnPath(firstCommandWord(candidate))) continue;
    for (const part of splitUnquotedOperators(candidate)) {
      const matchedDeny = denyRules.find((rule) => matchesRule(part, rule));
      if (matchedDeny !== undefined) {
        warnings.add(
          `\`${part}\` matches deny rule \`${matchedDeny}\`; the worker cannot run it.`,
        );
      } else if (!rules.allow.some((rule) => matchesRule(part, rule))) {
        warnings.add(
          `\`${part}\` is not in permissions.allow; agy will deny it in headless mode.`,
        );
      }
      if (warnings.size >= MAX_WARNINGS) return [...warnings];
    }
  }

  return [...warnings];
}
