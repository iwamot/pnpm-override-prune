export interface PackageVersionMeta {
  readonly version: string;
  /** Merged map of dependencies + peerDependencies + optionalDependencies. */
  readonly dependencies: ReadonlyMap<string, string>;
}

export interface PackageMetadata {
  readonly name: string;
  readonly versions: ReadonlyMap<string, PackageVersionMeta>;
  /** When the registry last changed the package; null when not reported. */
  readonly modified: Date | null;
  /**
   * Publish time per version, from the full packument's `time` field. Null
   * for the abbreviated packument and for registries that omit the field.
   */
  readonly publishedAt: ReadonlyMap<string, Date> | null;
}

/**
 * The abbreviated packument carries the per-version dependency fields this
 * tool reads without readmes and other metadata. The full one adds `time`,
 * needed only when the release-age policy has to date the versions.
 */
export type PackumentForm = "abbreviated" | "full";

export class MalformedRegistryResponseError extends Error {
  override readonly name = "MalformedRegistryResponseError";
  constructor(message: string) {
    super(`malformed registry response: ${message}`);
  }
}

/**
 * The fallbacks in the abbreviated form keep a registry that only serves the
 * full document from refusing the request.
 */
export const PACKUMENT_ACCEPT: Readonly<Record<PackumentForm, string>> = {
  abbreviated:
    "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
  full: "application/json",
};

export function requestHeaders(
  authorization: string | null,
  form: PackumentForm = "abbreviated",
): Record<string, string> {
  const headers: Record<string, string> = { accept: PACKUMENT_ACCEPT[form] };
  if (authorization !== null) {
    headers.authorization = authorization;
  }
  return headers;
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

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parsePublishTimes(
  time: unknown,
  versions: ReadonlyMap<string, PackageVersionMeta>,
): ReadonlyMap<string, Date> | null {
  if (!isObject(time)) {
    return null;
  }
  const publishedAt = new Map<string, Date>();
  for (const version of versions.keys()) {
    const date = parseDate(time[version]);
    if (date !== null) {
      publishedAt.set(version, date);
    }
  }
  return publishedAt;
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
  return {
    name,
    versions,
    modified: parseDate(raw.modified),
    publishedAt: parsePublishTimes(raw.time, versions),
  };
}
