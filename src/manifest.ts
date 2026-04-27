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
