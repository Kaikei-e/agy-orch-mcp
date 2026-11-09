import assert from "node:assert/strict";
import test from "node:test";
import { auditPermissions } from "../dist/settings-audit.js";

test("auditPermissions detects high, medium, and low findings in severity order", () => {
  const longRule = `command(rg ${"a".repeat(210)})`;
  const fixture = {
    permissions: {
      allow: [
        "command(pnpm test)",
        "command(pnpm test)",
        longRule,
        "command(cat /tmp/scratch-123.txt)",
        "command(ps -p 98765)",
        "command(git log abc1234..HEAD)",
        "command(cd pkg && pnpm test)",
        "command(rg foo | head)",
        "command(echo $(uname))",
        "command(*)",
        "command(git)",
        "command(gh)",
        "command(gh api)",
        "command(gh api repos/owner/repo/releases)",
        "command(gh api --method GET repos/owner/repo/releases)",
        "command(git push)",
        "command(gh pr create --repo owner/repo)",
      ],
    },
  };

  const findings = auditPermissions(fixture);
  assert.ok(findings.length > 0);

  const severityOrder = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < findings.length; i++) {
    assert.ok(
      severityOrder[findings[i - 1].severity] <=
        severityOrder[findings[i].severity],
      `findings not sorted by severity at index ${i}`,
    );
  }

  const highRules = findings
    .filter((f) => f.severity === "high")
    .map((f) => f.rule);
  assert.deepEqual(highRules, [
    "command(*)",
    "command(git)",
    "command(gh)",
    "command(gh api)",
    "command(gh api repos/owner/repo/releases)",
    "command(git push)",
    "command(gh pr create --repo owner/repo)",
  ]);
  assert.ok(
    !findings.some(
      (f) =>
        f.rule === "command(gh api --method GET repos/owner/repo/releases)",
    ),
  );

  const mediumRules = findings
    .filter((f) => f.severity === "medium")
    .map((f) => f.rule);
  for (const expectedMedium of [
    "command(cat /tmp/scratch-123.txt)",
    "command(ps -p 98765)",
    "command(git log abc1234..HEAD)",
    "command(cd pkg && pnpm test)",
    "command(rg foo | head)",
    "command(echo $(uname))",
  ]) {
    assert.ok(
      mediumRules.includes(expectedMedium),
      `missing medium finding for: ${expectedMedium}`,
    );
  }

  const lowFindings = findings.filter((f) => f.severity === "low");
  assert.ok(lowFindings.some((f) => f.rule === "command(pnpm test)"));
  assert.ok(lowFindings.some((f) => f.rule === longRule));
  assert.ok(lowFindings.some((f) => /deny/i.test(f.reason)));

  for (const finding of findings) {
    assert.ok(finding.reason.length > 0);
  }
});

test("auditPermissions returns empty array for clean settings with deny list", () => {
  const clean = {
    permissions: {
      allow: [
        "command(pnpm test)",
        "command(git status)",
        "command(gh api --method GET repos/owner/repo)",
      ],
      deny: ["command(git push)"],
    },
  };
  assert.deepEqual(auditPermissions(clean), []);
});
