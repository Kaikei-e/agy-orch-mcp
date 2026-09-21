const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: "Private Key",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: "Google API Key",
    regex: /AIza[0-9A-Za-z-_]{35}/g,
  },
  {
    name: "GitHub Token",
    regex:
      /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g,
  },
  {
    name: "AWS Access Key",
    regex:
      /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
  },
  {
    name: "Bearer Token",
    regex: /Bearer\s+[a-zA-Z0-9._~+/-]{16,}={0,2}/gi,
  },
  {
    name: "API Key",
    regex: /(?:sk-ant-api03-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{32,})/g,
  },
  {
    name: "Generic Secret / Key Assignment",
    regex:
      /(?<=\b(?:password|passwd|secret|api_?key|auth_?token|access_?token)\s*[:=]\s*["'])[^"'\r\n]+(?=["'])/gi,
  },
];

export interface RedactionResult {
  redacted: string;
  found: boolean;
  detectedCount: number;
}

export function detectSecrets(text: string): boolean {
  if (!text) return false;
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return true;
  }
  return false;
}

export function redactSecrets(text: string): RedactionResult {
  if (!text) return { redacted: text, found: false, detectedCount: 0 };
  let count = 0;
  let current = text;

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    current = current.replace(pattern.regex, () => {
      count++;
      return `[REDACTED_${pattern.name.toUpperCase().replace(/\s+/g, "_")}]`;
    });
  }

  return {
    redacted: current,
    found: count > 0,
    detectedCount: count,
  };
}

/**
 * Patches containing secrets cannot be silently redacted without corrupting git diff hunk headers
 * and offsets, which causes 'git apply' to fail.
 * Therefore, when a patch contains a secret, we fail closed by marking it unavailable.
 */
export function inspectPatchForSecrets(patchText: string): {
  safe: boolean;
  reason?: string;
} {
  if (detectSecrets(patchText)) {
    return {
      safe: false,
      reason:
        "Patch contains detected secrets. Redaction would corrupt the patch structure; patch integration is rejected for security.",
    };
  }
  return { safe: true };
}
