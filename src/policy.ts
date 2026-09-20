export function validateModelSlug(
  value: string | undefined,
  source: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 200) {
    throw new Error(`${source} must be between 1 and 200 characters`);
  }
  if (value.includes("\0") || /\s/.test(value) || value.startsWith("-")) {
    throw new Error(
      `${source} must not contain whitespace, NUL, or start with a dash`,
    );
  }
  return value;
}
