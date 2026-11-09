import { FIXED_DENY_RULES, evaluateCommand } from "./guard.js";

export interface AuditFinding {
  rule: string;
  severity: "high" | "medium" | "low";
  reason: string;
}

const FIXED_DENY_PREFIXES: readonly string[] = FIXED_DENY_RULES.map((rule) =>
  rule.slice("command(".length, -1),
);

const COMMIT_RANGE_RE =
  /\b(?:[0-9a-fA-F]{4,40}\.{2,3}[A-Za-z0-9_./~^-]+|[A-Za-z0-9_./~^-]+\.{2,3}[0-9a-fA-F]{4,40})\b/;
const PS_NUMERIC_PID_RE =
  /^(?:.*\/)?ps(?:\s+.*)?\s+(?:-[A-Za-z]*p\s*|--pid(?:=|\s+))?\d+(?:,\d+)*(?:\s|$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractCommandInner(rule: string): string | undefined {
  if (rule.startsWith("command(") && rule.endsWith(")")) {
    return rule.slice("command(".length, -1).trim();
  }
  return undefined;
}

function checkHighSeverity(
  rule: string,
  inner: string | undefined,
): AuditFinding | undefined {
  if (inner === undefined) return undefined;

  if (inner === "*" || inner === "regex:.*") {
    return {
      rule,
      severity: "high",
      reason:
        "Allowing command(*) permits any command to run without restriction.",
    };
  }

  if (inner === "git") {
    return {
      rule,
      severity: "high",
      reason:
        "Allowing bare git permits remote-changing subcommands such as git push.",
    };
  }

  if (inner === "gh") {
    return {
      rule,
      severity: "high",
      reason: "Allowing bare gh permits remote-changing GitHub CLI operations.",
    };
  }

  if (inner === "gh api" || inner.startsWith("gh api ")) {
    if (evaluateCommand(inner).rule === "remote") {
      return {
        rule,
        severity: "high",
        reason:
          "Allowing gh api without an explicit GET method permits mutating GitHub API calls.",
      };
    }
    return undefined;
  }

  if (
    FIXED_DENY_PREFIXES.some(
      (prefix) => inner === prefix || inner.startsWith(`${prefix} `),
    ) ||
    evaluateCommand(inner).rule === "remote"
  ) {
    return {
      rule,
      severity: "high",
      reason:
        "This allow rule permits a remote-changing git or GitHub operation.",
    };
  }

  return undefined;
}

function checkMediumSeverity(
  rule: string,
  inner: string | undefined,
): AuditFinding | undefined {
  const target = inner ?? rule;

  if (
    target.includes("&&") ||
    target.includes("||") ||
    target.includes(";") ||
    target.includes("|") ||
    target.includes("$(") ||
    target.includes("`")
  ) {
    return {
      rule,
      severity: "medium",
      reason:
        "Compound shell commands containing chains, pipes, or command substitutions are one-off rules unlikely to match again.",
    };
  }

  if (rule.includes("/tmp/")) {
    return {
      rule,
      severity: "medium",
      reason:
        "Rules referencing paths under /tmp/ target temporary files that are unlikely to match future runs.",
    };
  }

  if (PS_NUMERIC_PID_RE.test(target)) {
    return {
      rule,
      severity: "medium",
      reason:
        "Rules running ps with a numeric PID are one-off entries that will not match future process IDs.",
    };
  }

  if (COMMIT_RANGE_RE.test(target)) {
    return {
      rule,
      severity: "medium",
      reason:
        "Rules containing specific git commit ranges are one-off entries unlikely to match future commits.",
    };
  }

  return undefined;
}

export function auditPermissions(settings: unknown): AuditFinding[] {
  const perms =
    isRecord(settings) && isRecord(settings.permissions)
      ? settings.permissions
      : undefined;
  const allowRules = Array.isArray(perms?.allow)
    ? perms.allow.filter((r): r is string => typeof r === "string")
    : [];
  const denyRules = Array.isArray(perms?.deny)
    ? perms.deny.filter((r): r is string => typeof r === "string")
    : [];

  const highFindings: AuditFinding[] = [];
  const mediumFindings: AuditFinding[] = [];
  const lowFindings: AuditFinding[] = [];

  for (const rule of allowRules) {
    const inner = extractCommandInner(rule);
    const high = checkHighSeverity(rule, inner);
    if (high) {
      highFindings.push(high);
      continue;
    }
    const medium = checkMediumSeverity(rule, inner);
    if (medium) {
      mediumFindings.push(medium);
    }
  }

  const seenAllow = new Set<string>();
  const reportedDuplicates = new Set<string>();
  for (const rule of allowRules) {
    if (seenAllow.has(rule) && !reportedDuplicates.has(rule)) {
      reportedDuplicates.add(rule);
      lowFindings.push({
        rule,
        severity: "low",
        reason:
          "This permission rule appears multiple times in the allow list.",
      });
    }
    seenAllow.add(rule);
  }

  const seenDeny = new Set<string>();
  for (const rule of denyRules) {
    if (seenDeny.has(rule) && !reportedDuplicates.has(rule)) {
      reportedDuplicates.add(rule);
      lowFindings.push({
        rule,
        severity: "low",
        reason: "This permission rule appears multiple times in the deny list.",
      });
    }
    seenDeny.add(rule);
  }

  const reportedLong = new Set<string>();
  for (const rule of [...allowRules, ...denyRules]) {
    if (rule.length > 200 && !reportedLong.has(rule)) {
      reportedLong.add(rule);
      lowFindings.push({
        rule,
        severity: "low",
        reason:
          "Rules longer than 200 characters are overly specific and unlikely to be reusable.",
      });
    }
  }

  if (denyRules.length === 0) {
    lowFindings.push({
      rule: "permissions.deny",
      severity: "low",
      reason:
        "No deny list is configured in permissions to block unsafe commands.",
    });
  }

  return [...highFindings, ...mediumFindings, ...lowFindings];
}
