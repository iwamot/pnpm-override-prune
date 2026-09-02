import { parse as parseYaml } from "yaml";

export type WorkspaceFilename = "pnpm-workspace.yaml" | "aube-workspace.yaml";
export type PackageJsonContainer =
  | "package.json:overrides"
  | "package.json:pnpm.overrides"
  | "package.json:aube.overrides"
  | "package.json:resolutions";
export type OverrideSource = PackageJsonContainer | WorkspaceFilename;

// Every place a root package.json can hold overrides, as the key path to the
// mapping. pnpm 9/10 read `pnpm.overrides` and Yarn's `resolutions`; aube reads
// all four. Which one wins at install time is not modelled: each entry is
// audited on its own, so a stale duplicate in any location is still reported.
export const PACKAGE_JSON_CONTAINERS: ReadonlyMap<
  PackageJsonContainer,
  readonly string[]
> = new Map([
  ["package.json:overrides", ["overrides"]],
  ["package.json:pnpm.overrides", ["pnpm", "overrides"]],
  ["package.json:aube.overrides", ["aube", "overrides"]],
  ["package.json:resolutions", ["resolutions"]],
]);

export interface Override {
  readonly key: string;
  readonly spec: string;
  readonly source: OverrideSource;
}

export type DirectDepType =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

const DIRECT_DEP_FIELDS: readonly DirectDepType[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export interface DirectDep {
  readonly importerKey: string;
  readonly depType: DirectDepType;
  readonly spec: string;
}

export type WorkspaceDirectDeps = ReadonlyMap<string, readonly DirectDep[]>;

export class MalformedManifestError extends Error {
  override readonly name = "MalformedManifestError";
  constructor(message: string) {
    super(`malformed manifest: ${message}`);
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function packageJsonMappingAt(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | null {
  let node: unknown = root;
  for (const key of path) {
    if (!isObject(node)) {
      return null;
    }
    node = node[key];
  }
  return isObject(node) ? node : null;
}

function collectOverridesFromMap(
  obj: Record<string, unknown>,
  source: OverrideSource,
  parentKey = "",
): Override[] {
  const result: Override[] = [];
  for (const [child, spec] of Object.entries(obj)) {
    const key = parentKey === "" ? child : `${parentKey}>${child}`;
    if (typeof spec === "string") {
      result.push({ key, spec, source });
    } else if (isObject(spec)) {
      // npm's nested object form `{ parent: { child: spec } }` means the same
      // as pnpm's `"parent>child": spec`, so it is flattened onto that key and
      // reported under the same nested-key skip instead of vanishing.
      result.push(...collectOverridesFromMap(spec, source, key));
    }
  }
  return result;
}

export function parsePackageJsonOverrides(
  content: string,
): readonly Override[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new MalformedManifestError(
      e instanceof Error ? e.message : "json parse error",
    );
  }
  if (!isObject(parsed)) {
    return [];
  }
  const result: Override[] = [];
  for (const [source, path] of PACKAGE_JSON_CONTAINERS) {
    const mapping = packageJsonMappingAt(parsed, path);
    if (mapping !== null) {
      result.push(...collectOverridesFromMap(mapping, source));
    }
  }
  return result;
}

export function buildWorkspaceDirectDeps(
  importerContents: ReadonlyMap<string, string>,
): WorkspaceDirectDeps {
  const map = new Map<string, DirectDep[]>();
  for (const [importerKey, content] of importerContents) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new MalformedManifestError(
        e instanceof Error ? e.message : "json parse error",
      );
    }
    if (!isObject(parsed)) {
      continue;
    }
    for (const depType of DIRECT_DEP_FIELDS) {
      const deps = parsed[depType];
      if (!isObject(deps)) {
        continue;
      }
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec !== "string") {
          continue;
        }
        const entry: DirectDep = { importerKey, depType, spec };
        const existing = map.get(name);
        if (existing === undefined) {
          map.set(name, [entry]);
        } else {
          existing.push(entry);
        }
      }
    }
  }
  return map;
}

export function parseWorkspaceOverrides(
  content: string,
  source: WorkspaceFilename,
): readonly Override[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    throw new MalformedManifestError(
      e instanceof Error ? e.message : "yaml parse error",
    );
  }
  if (!isObject(parsed)) {
    return [];
  }
  const overrides = parsed.overrides;
  if (!isObject(overrides)) {
    return [];
  }
  return collectOverridesFromMap(overrides, source);
}
