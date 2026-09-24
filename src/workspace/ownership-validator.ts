import fs from "node:fs";
import path from "node:path";

export class OwnershipValidator {
  private readonly canonicalRoot: string;
  private readonly owns: string[];
  private readonly scopeInclude: string[];
  private readonly scopeExclude: string[];

  constructor(
    rootPath: string,
    owns: string[],
    scopeInclude: string[],
    scopeExclude: string[] = [],
  ) {
    if (!rootPath || typeof rootPath !== "string") {
      throw new Error("Invalid rootPath: must be a non-empty string");
    }

    try {
      this.canonicalRoot = fs.existsSync(rootPath)
        ? fs.realpathSync(rootPath)
        : path.resolve(rootPath);
    } catch {
      this.canonicalRoot = path.resolve(rootPath);
    }

    this.validatePatterns(owns, "owns");
    this.validatePatterns(scopeInclude, "scope.include");
    this.validatePatterns(scopeExclude, "scope.exclude");

    if (owns.length === 0) {
      throw new Error("owns cannot be empty");
    }

    this.owns = [...owns];
    this.scopeInclude = [...scopeInclude];
    this.scopeExclude = [...scopeExclude];

    // Every pattern in owns must be covered by scope.include
    for (const ownPattern of owns) {
      if (!this.isPatternCoveredBy(ownPattern, this.scopeInclude)) {
        throw new Error(
          `owns pattern "${ownPattern}" is not covered by scope.include`,
        );
      }
      // Fail if an owns pattern is entirely subsumed by scope.exclude (making it an impossible/conflicting declaration)
      if (this.isPatternCoveredBy(ownPattern, this.scopeExclude)) {
        throw new Error(
          `owns pattern "${ownPattern}" is completely excluded by scope.exclude`,
        );
      }
    }
  }

  public getRoot(): string {
    return this.canonicalRoot;
  }

  private validatePatterns(patterns: string[], fieldName: string): void {
    for (const p of patterns) {
      if (!p || typeof p !== "string") {
        throw new Error(
          `Invalid pattern in ${fieldName}: pattern must be a non-empty string`,
        );
      }
      if (p.includes("\0")) {
        throw new Error(
          `Invalid pattern "${p}" in ${fieldName}: contains null byte`,
        );
      }
      if (p.includes("\\")) {
        throw new Error(
          `Invalid pattern "${p}" in ${fieldName}: backslashes not allowed, use forward slashes`,
        );
      }
      if (path.isAbsolute(p) || p.startsWith("/")) {
        throw new Error(
          `Invalid pattern "${p}" in ${fieldName}: absolute paths not allowed`,
        );
      }
      const parts = p.split("/");
      if (parts.includes("..") || parts.includes(".")) {
        throw new Error(
          `Invalid pattern "${p}" in ${fieldName}: parent traversal and relative dot segments not allowed`,
        );
      }
      // Only exact paths or terminal /* and /** are allowed
      if (p.includes("*")) {
        if (!p.endsWith("/*") && !p.endsWith("/**")) {
          throw new Error(
            `Invalid glob pattern "${p}" in ${fieldName}: only terminal /* and /** wildcards are supported`,
          );
        }
        const withoutWildcard = p.endsWith("/**")
          ? p.slice(0, -3)
          : p.slice(0, -2);
        if (withoutWildcard.includes("*")) {
          throw new Error(
            `Invalid glob pattern "${p}" in ${fieldName}: multiple or non-terminal wildcards are not supported`,
          );
        }
      }
    }
  }

  private normalizePatternForValidator(p: string): string {
    if (p.endsWith("/")) return p + "**";
    return p;
  }

  private isPatternCoveredBy(pattern: string, covers: string[]): boolean {
    const normPattern = this.normalizePatternForValidator(pattern);
    return covers.some((rawC) => {
      const c = this.normalizePatternForValidator(rawC);
      if (c === normPattern) return true;
      if (c === "/**" || c === "*") return true;
      if (c.endsWith("/**")) {
        const dir = c.slice(0, -3);
        if (dir === "") return true;
        return normPattern === dir || normPattern.startsWith(dir + "/");
      }
      if (c.endsWith("/*")) {
        const dir = c.slice(0, -2);
        if (normPattern.endsWith("/*") || normPattern.endsWith("/**"))
          return false;
        const pDir = path.dirname(normPattern);
        return pDir === dir || (pDir === "." && dir === "");
      }
      return false;
    });
  }

  public isOwned(filePath: string, options?: { checkFs?: boolean }): boolean {
    if (!filePath || typeof filePath !== "string") {
      return false;
    }
    if (filePath.includes("\0") || filePath.includes("\\")) {
      return false;
    }
    if (path.isAbsolute(filePath) || filePath.startsWith("/")) {
      return false;
    }

    const normalized = path.normalize(filePath);
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      path.isAbsolute(normalized)
    ) {
      return false;
    }

    // Documented set difference: must match at least one owns pattern and not match any scopeExclude pattern
    const isExcluded = this.scopeExclude.some((c) =>
      this.matchPattern(c, normalized),
    );
    if (isExcluded) {
      return false;
    }

    const isMatch = this.owns.some((c) => this.matchPattern(c, normalized));
    if (!isMatch) {
      return false;
    }

    if (options?.checkFs) {
      if (!this.validatePathSafety(normalized)) {
        return false;
      }
    }

    return true;
  }

  public validatePathSafety(relativePath: string): boolean {
    if (
      !relativePath ||
      relativePath.includes("\0") ||
      relativePath.includes("\\")
    ) {
      return false;
    }
    const fullPath = path.resolve(this.canonicalRoot, relativePath);

    // Ensure resolved path starts within canonicalRoot
    const rel = path.relative(this.canonicalRoot, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return false;
    }

    // Check actual filesystem symlinks
    try {
      if (fs.existsSync(fullPath)) {
        const real = fs.realpathSync(fullPath);
        const relReal = path.relative(this.canonicalRoot, real);
        if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
          return false;
        }
      } else {
        // Path does not exist yet (or is deleted). Check parent directories up to root.
        let curr = path.dirname(fullPath);
        while (curr.length >= this.canonicalRoot.length) {
          if (fs.existsSync(curr)) {
            const realParent = fs.realpathSync(curr);
            const relParent = path.relative(this.canonicalRoot, realParent);
            if (relParent.startsWith("..") || path.isAbsolute(relParent)) {
              return false;
            }
            break;
          }
          const parent = path.dirname(curr);
          if (parent === curr) break;
          curr = parent;
        }
      }
    } catch {
      return false;
    }

    return true;
  }

  private matchPattern(rawPattern: string, filePath: string): boolean {
    const pattern = this.normalizePatternForValidator(rawPattern);
    if (pattern === filePath) return true;
    if (pattern === "/**" || pattern === "*") return true;

    if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      if (dir === "") return true;
      return filePath === dir || filePath.startsWith(dir + "/");
    }

    if (pattern.endsWith("/*")) {
      const dir = pattern.slice(0, -2);
      const pDir = path.dirname(filePath);
      return pDir === dir || (pDir === "." && dir === "");
    }

    return false;
  }
}
