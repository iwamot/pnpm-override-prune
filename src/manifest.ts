import { parse as parseYaml } from "yaml";

export type WorkspaceFilename = "pnpm-workspace.yaml" | "aube-workspace.yaml";
export type PackageJsonContainer =
  | "package.json:pnpm.overrides"
  | "package.json:overrides";
export type OverrideSource = PackageJsonContainer | WorkspaceFilename;

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

function collectOverridesFromMap(
  obj: Record<string, unknown>,
  source: OverrideSource,
): Override[] {
  const result: Override[] = [];
  for (const [key, spec] of Object.entries(obj)) {
    if (typeof spec === "string") {
      result.push({ key, spec, source });
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
  const pnpmField = parsed.pnpm;
  if (isObject(pnpmField)) {
    const pnpmOverrides = pnpmField.overrides;
    if (isObject(pnpmOverrides)) {
      result.push(
        ...collectOverridesFromMap(
          pnpmOverrides,
          "package.json:pnpm.overrides",
        ),
      );
    }
  }
  const topLevelOverrides = parsed.overrides;
  if (isObject(topLevelOverrides)) {
    result.push(
      ...collectOverridesFromMap(topLevelOverrides, "package.json:overrides"),
    );
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
