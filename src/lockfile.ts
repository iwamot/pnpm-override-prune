import { parse as parseYaml } from "yaml";

export const SUPPORTED_LOCKFILE_VERSION = "9.0";

const DIRECT_DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type DirectDepType = (typeof DIRECT_DEP_FIELDS)[number];

export class UnsupportedLockfileVersionError extends Error {
  override readonly name = "UnsupportedLockfileVersionError";
  readonly found: string | null;
  constructor(found: string | null) {
    super(
      found === null
        ? "lockfile is missing 'lockfileVersion' field"
        : `lockfile version '${found}' is not supported (expected '${SUPPORTED_LOCKFILE_VERSION}')`,
    );
    this.found = found;
  }
}

export class MalformedLockfileError extends Error {
  override readonly name = "MalformedLockfileError";
  constructor(message: string) {
    super(`malformed lockfile: ${message}`);
  }
}

export interface DirectRequirement {
  readonly importerKey: string;
  readonly depType: DirectDepType;
  readonly specifier: string;
  readonly resolvedVersion: string;
}

export interface ParentRequirement {
  readonly parentKey: string;
  readonly resolvedVersion: string;
}

export interface Lockfile {
  readonly version: string;
  readonly directRequirements: ReadonlyMap<
    string,
    readonly DirectRequirement[]
  >;
  readonly transitiveParents: ReadonlyMap<string, readonly ParentRequirement[]>;
}

export interface SnapshotKey {
  readonly name: string;
  readonly version: string;
}

export function parseSnapshotKey(key: string): SnapshotKey | null {
  // Strip pnpm peer-dependency decorations: "pkg@1.0.0(peer@2.0.0)" → "pkg@1.0.0"
  const peerStart = key.indexOf("(");
  const base = peerStart === -1 ? key : key.slice(0, peerStart);

  // Scoped names start with "@", so use lastIndexOf to find the version separator.
  const lastAt = base.lastIndexOf("@");
  if (lastAt <= 0) {
    return null;
  }
  const name = base.slice(0, lastAt);
  const version = base.slice(lastAt + 1);
  if (name.length === 0 || version.length === 0) {
    return null;
  }
  return { name, version };
}

export function parseResolvedVersion(value: string): string {
  // Strip pnpm peer-dependency decorations from importer "version" fields.
  const peerStart = value.indexOf("(");
  return peerStart === -1 ? value : value.slice(0, peerStart);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function appendToMultiMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

function extractDirectRequirements(
  raw: Record<string, unknown>,
): ReadonlyMap<string, readonly DirectRequirement[]> {
  const map = new Map<string, DirectRequirement[]>();
  const importers = raw.importers;
  if (!isObject(importers)) {
    return map;
  }
  for (const [importerKey, importerValue] of Object.entries(importers)) {
    if (!isObject(importerValue)) {
      continue;
    }
    for (const depType of DIRECT_DEP_FIELDS) {
      const deps = importerValue[depType];
      if (!isObject(deps)) {
        continue;
      }
      for (const [pkgName, depValue] of Object.entries(deps)) {
        if (!isObject(depValue)) {
          continue;
        }
        const specifier = depValue.specifier;
        const version = depValue.version;
        if (typeof specifier !== "string" || typeof version !== "string") {
          continue;
        }
        appendToMultiMap(map, pkgName, {
          importerKey,
          depType,
          specifier,
          resolvedVersion: parseResolvedVersion(version),
        });
      }
    }
  }
  return map;
}

function extractTransitiveParents(
  raw: Record<string, unknown>,
): ReadonlyMap<string, readonly ParentRequirement[]> {
  const map = new Map<string, ParentRequirement[]>();
  const snapshots = raw.snapshots;
  if (!isObject(snapshots)) {
    return map;
  }
  for (const [parentKey, snapshotValue] of Object.entries(snapshots)) {
    if (!isObject(snapshotValue)) {
      continue;
    }
    for (const depField of ["dependencies", "optionalDependencies"] as const) {
      const deps = snapshotValue[depField];
      if (!isObject(deps)) {
        continue;
      }
      for (const [target, resolvedRaw] of Object.entries(deps)) {
        if (typeof resolvedRaw !== "string") {
          continue;
        }
        appendToMultiMap(map, target, {
          parentKey,
          resolvedVersion: parseResolvedVersion(resolvedRaw),
        });
      }
    }
  }
  return map;
}

export function parseLockfile(content: string): Lockfile {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    throw new MalformedLockfileError(
      e instanceof Error ? e.message : "yaml parse error",
    );
  }
  if (!isObject(parsed)) {
    throw new MalformedLockfileError("root must be an object");
  }
  const versionRaw = parsed.lockfileVersion;
  const version = typeof versionRaw === "string" ? versionRaw : null;
  if (version !== SUPPORTED_LOCKFILE_VERSION) {
    throw new UnsupportedLockfileVersionError(version);
  }
  return {
    version,
    directRequirements: extractDirectRequirements(parsed),
    transitiveParents: extractTransitiveParents(parsed),
  };
}
