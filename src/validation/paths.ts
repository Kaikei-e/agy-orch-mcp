import { realpathSync } from "node:fs";
import path from "node:path";

export function assertNoNul(value: string, fieldName = "path"): void {
  if (value.includes("\0")) {
    throw new Error(`${fieldName} must not contain NUL bytes`);
  }
}

export function isSafeRelativePath(rel: string): boolean {
  if (!rel || rel.includes("\0")) return false;
  const normalized = path.normalize(rel);
  if (path.isAbsolute(normalized)) return false;
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`))
    return false;
  return true;
}

export function resolveSafePath(
  root: string,
  target: string,
  options: { mustExist?: boolean } = {},
): string {
  assertNoNul(root, "root");
  assertNoNul(target, "target");

  const resolvedRoot = path.resolve(root);
  const canonicalRoot = realpathSync(resolvedRoot);

  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(canonicalRoot, target);

  if (options.mustExist) {
    const canonicalTarget = realpathSync(resolvedTarget);
    const rel = path.relative(canonicalRoot, canonicalTarget);
    if (
      rel === ".." ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      throw new Error(`Path escapes workspace root: ${target}`);
    }
    return canonicalTarget;
  }

  const rel = path.relative(canonicalRoot, resolvedTarget);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${target}`);
  }
  return resolvedTarget;
}

export function isSubpathOrEqual(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
