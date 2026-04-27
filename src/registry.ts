export interface PackageVersionMeta {
  readonly version: string;
  /** Merged map of dependencies + peerDependencies + optionalDependencies. */
  readonly dependencies: ReadonlyMap<string, string>;
}

export interface PackageMetadata {
  readonly name: string;
  readonly versions: ReadonlyMap<string, PackageVersionMeta>;
}

export class MalformedRegistryResponseError extends Error {
  override readonly name = "MalformedRegistryResponseError";
  constructor(message: string) {
    super(`malformed registry response: ${message}`);
  }
}

const DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function mergeDepFields(
  versionRecord: Record<string, unknown>,
): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  for (const field of DEP_FIELDS) {
    const deps = versionRecord[field];
    if (!isObject(deps)) {
      continue;
    }
    for (const [depName, depSpec] of Object.entries(deps)) {
      if (typeof depSpec !== "string") {
        continue;
      }
      // First write wins so dependencies takes precedence over peers/optional.
      if (!merged.has(depName)) {
        merged.set(depName, depSpec);
      }
    }
  }
  return merged;
}

export function parsePackageMetadata(
  raw: unknown,
  name: string,
): PackageMetadata {
  if (!isObject(raw)) {
    throw new MalformedRegistryResponseError("root must be an object");
  }
  const versionsRaw = raw.versions;
  if (!isObject(versionsRaw)) {
    throw new MalformedRegistryResponseError("'versions' field is missing");
  }
  const versions = new Map<string, PackageVersionMeta>();
  for (const [version, versionData] of Object.entries(versionsRaw)) {
    if (!isObject(versionData)) {
      continue;
    }
    versions.set(version, {
      version,
      dependencies: mergeDepFields(versionData),
    });
  }
  return { name, versions };
}
