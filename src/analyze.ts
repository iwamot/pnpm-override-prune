import { Range, satisfies } from "semver";

export type Status = "prune" | "keep" | "skip" | "error";

export interface Result {
  readonly status: Status;
  readonly value: string;
}

const PROTOCOL_PREFIXES: readonly string[] = [
  "catalog:",
  "workspace:",
  "file:",
  "link:",
  "portal:",
  "npm:",
  "github:",
  "git:",
  "git+",
  "http:",
  "https:",
];

export function isPureLowerBound(spec: string): boolean {
  if (spec.length === 0) {
    return false;
  }
  let range: Range;
  try {
    range = new Range(spec, { loose: false });
  } catch {
    return false;
  }
  return range.set.every((group) =>
    group.every((c) => c.operator === ">=" || c.operator === ">"),
  );
}

export function isNestedKey(key: string): boolean {
  return key.includes(">");
}

export function isVersionedKey(key: string): boolean {
  // Detect keys carrying a version constraint, e.g. "ajv@^8.0.0" or
  // "@scope/pkg@^1.0.0". For "@scope/pkg" the only "@" is the scope marker
  // at index 0, so we require the separator to appear after position 0.
  return key.lastIndexOf("@") > 0;
}

export function hasProtocolPrefix(spec: string): boolean {
  return PROTOCOL_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

export type SkipReason =
  | "nested-key"
  | "versioned-key"
  | "protocol-spec"
  | "non-lower-bound";

export type Categorization =
  | { readonly kind: "target"; readonly spec: string }
  | { readonly kind: "skip"; readonly reason: SkipReason };

export function categorize(key: string, spec: string): Categorization {
  if (isNestedKey(key)) {
    return { kind: "skip", reason: "nested-key" };
  }
  if (isVersionedKey(key)) {
    return { kind: "skip", reason: "versioned-key" };
  }
  if (hasProtocolPrefix(spec)) {
    return { kind: "skip", reason: "protocol-spec" };
  }
  if (!isPureLowerBound(spec)) {
    return { kind: "skip", reason: "non-lower-bound" };
  }
  return { kind: "target", spec };
}

export function classify(spec: string, resolved: string | null): Result {
  if (resolved === null) {
    return { status: "prune", value: "(unused)" };
  }
  return satisfies(resolved, spec, { includePrerelease: true })
    ? { status: "prune", value: resolved }
    : { status: "keep", value: resolved };
}
