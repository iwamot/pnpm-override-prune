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
  // pnpm's nested form is "parent[@version]>child". The separator '>' is
  // followed by a package-name token, never by '=' (that's the '>='
  // comparator) or a digit/space (that's a '>X' comparator inside a range).
  let i = 0;
  while (i < key.length) {
    const idx = key.indexOf(">", i);
    if (idx === -1) {
      return false;
    }
    const next = key[idx + 1];
    if (
      next !== undefined &&
      (next === "=" || next === " " || (next >= "0" && next <= "9"))
    ) {
      i = idx + 1;
      continue;
    }
    return true;
  }
  return false;
}

export interface ParsedKey {
  readonly name: string;
  readonly selectorRaw: string | null;
}

/**
 * Split an override key into a bare package name and an optional selector
 * suffix. For "lodash@<4.17.21" returns { name: "lodash", selectorRaw: "<4.17.21" }.
 * For "@scope/pkg@^1.0.0" returns { name: "@scope/pkg", selectorRaw: "^1.0.0" }.
 * For "lodash" returns { name: "lodash", selectorRaw: null }.
 *
 * Scoped names start with "@", so we use lastIndexOf to find the selector
 * separator.
 */
export function parseKey(key: string): ParsedKey {
  const lastAt = key.lastIndexOf("@");
  if (lastAt <= 0) {
    return { name: key, selectorRaw: null };
  }
  return { name: key.slice(0, lastAt), selectorRaw: key.slice(lastAt + 1) };
}

export function hasProtocolPrefix(spec: string): boolean {
  return PROTOCOL_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

export type SkipReason =
  | "nested-key"
  | "unsupported-selector"
  | "protocol-spec"
  | "non-lower-bound";

export type Categorization =
  | {
      readonly kind: "target";
      readonly name: string;
      readonly selector: Range | null;
      readonly spec: string;
    }
  | { readonly kind: "skip"; readonly reason: SkipReason };

export function categorize(key: string, spec: string): Categorization {
  if (isNestedKey(key)) {
    return { kind: "skip", reason: "nested-key" };
  }
  const { name, selectorRaw } = parseKey(key);
  let selector: Range | null = null;
  if (selectorRaw !== null) {
    try {
      selector = new Range(selectorRaw, { loose: false });
    } catch {
      return { kind: "skip", reason: "unsupported-selector" };
    }
  }
  if (hasProtocolPrefix(spec)) {
    return { kind: "skip", reason: "protocol-spec" };
  }
  if (!isPureLowerBound(spec)) {
    return { kind: "skip", reason: "non-lower-bound" };
  }
  return { kind: "target", name, selector, spec };
}

export function classify(spec: string, resolved: string | null): Result {
  if (resolved === null) {
    return { status: "prune", value: "(unused)" };
  }
  return satisfies(resolved, spec, { includePrerelease: true })
    ? { status: "prune", value: resolved }
    : { status: "keep", value: resolved };
}
