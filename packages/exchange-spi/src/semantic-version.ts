interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
}

const VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const COMPARATOR = /^(>=|<=|>|<|=)?(.+)$/;

function parse(value: string): SemanticVersion | null {
  const match = VERSION.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: match[4] ?? null };
}

function compare(left: SemanticVersion, right: SemanticVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease
    ? -1
    : left.prerelease > right.prerelease
      ? 1
      : 0;
}

function matchesComparator(
  candidate: SemanticVersion,
  expression: string,
): boolean {
  if (expression.startsWith("^")) {
    const floor = parse(expression.slice(1));
    if (floor === null || compare(candidate, floor) < 0) return false;
    const ceiling: SemanticVersion =
      floor.major > 0
        ? { major: floor.major + 1, minor: 0, patch: 0, prerelease: null }
        : floor.minor > 0
          ? { major: 0, minor: floor.minor + 1, patch: 0, prerelease: null }
          : { major: 0, minor: 0, patch: floor.patch + 1, prerelease: null };
    return compare(candidate, ceiling) < 0;
  }
  if (expression.startsWith("~")) {
    const floor = parse(expression.slice(1));
    if (floor === null || compare(candidate, floor) < 0) return false;
    return compare(candidate, {
      major: floor.major,
      minor: floor.minor + 1,
      patch: 0,
      prerelease: null,
    }) < 0;
  }
  const match = COMPARATOR.exec(expression);
  if (match === null) return false;
  const expected = parse(match[2]!);
  if (expected === null) return false;
  const order = compare(candidate, expected);
  switch (match[1] ?? "=") {
    case ">=": return order >= 0;
    case "<=": return order <= 0;
    case ">": return order > 0;
    case "<": return order < 0;
    default: return order === 0;
  }
}

export function matchesSemanticVersion(
  version: string,
  constraint: string | undefined,
): boolean {
  const candidate = parse(version);
  if (candidate === null) return false;
  if (constraint === undefined) return true;
  const expressions = constraint.trim().split(/\s+/).filter(Boolean);
  return expressions.length > 0 && expressions.every((expression) =>
    matchesComparator(candidate, expression),
  );
}
