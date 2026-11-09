export const HANDOFF_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "changes",
    "verification",
    "facts",
    "side_effects",
    "blockers",
  ],
  properties: {
    summary: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "change"],
        properties: {
          path: { type: "string" },
          change: { type: "string" },
        },
      },
    },
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "outcome", "detail"],
        properties: {
          command: { type: "string" },
          outcome: { type: "string", enum: ["pass", "fail", "not_run"] },
          detail: { type: "string" },
        },
      },
    },
    facts: {
      type: "array",
      items: { type: "string" },
    },
    side_effects: {
      type: "array",
      description:
        "Writes outside the workspace, tools installed, containers or processes left running",
      items: { type: "string" },
    },
    blockers: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

const ARRAY_FIELDS = [
  "changes",
  "verification",
  "facts",
  "side_effects",
  "blockers",
] as const;

export function parseHandoff(response: string): {
  handoff?: unknown;
  error?: string;
} {
  const trimmed = response.trim();
  if (!trimmed) return { error: "empty handoff response" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const matches = [...trimmed.matchAll(/```json\s+([\s\S]*?)\s*```/gi)];
    if (matches.length === 0) {
      return { error: "invalid JSON in handoff response" };
    }
    if (matches.length > 1) {
      return { error: "multiple json code blocks in handoff response" };
    }
    try {
      parsed = JSON.parse(matches[0]![1]!.trim());
    } catch {
      return { error: "invalid JSON inside fenced block" };
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "handoff must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.summary !== "string") {
    return { error: "handoff.summary must be a string" };
  }
  for (const key of ARRAY_FIELDS) {
    if (!Array.isArray(obj[key])) {
      return { error: `handoff.${key} must be an array` };
    }
  }
  return { handoff: obj };
}
