/**
 * pnpm's `minimumReleaseAge` policy, applied the way pnpm applies it when it
 * resolves a range: versions published after the cutoff are not candidates,
 * unless `minimumReleaseAgeExclude` names the package or the exact version.
 */

import { compare, prerelease, valid as validVersion } from "semver";
import type { PackageMetadata } from "./registry.ts";
import type { VersionPool } from "./resolve.ts";

export interface ReleaseAgeSettings {
  /** Minutes a version must have been published for. 0 disables the check. */
  readonly minimumReleaseAge: number;
  readonly minimumReleaseAgeExclude: readonly string[];
}

/** pnpm 11's built-in default: one day. */
export const DEFAULT_RELEASE_AGE_SETTINGS: ReleaseAgeSettings = {
  minimumReleaseAge: 1440,
  minimumReleaseAgeExclude: [],
};

export class InvalidReleaseAgeExcludeError extends Error {
  override readonly name = "InvalidReleaseAgeExcludeError";
  constructor(message: string) {
    super(`invalid value in minimumReleaseAgeExclude: ${message}`);
  }
}

interface ExcludeRule {
  readonly namePattern: RegExp;
  /** Empty means every version of the matched package. */
  readonly versions: readonly string[];
}

export interface ReleasePolicy {
  /** Versions published after this instant are not candidates. */
  readonly cutoff: Date | null;
  readonly exclude: readonly ExcludeRule[];
}

function namePatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * One `minimumReleaseAgeExclude` entry: a package name (with `*` wildcards),
 * or `name@1.2.3 || 1.2.4` naming exact versions of one package.
 */
function parseExcludeRule(pattern: string): ExcludeRule {
  const at = pattern.indexOf("@", pattern.startsWith("@") ? 1 : 0);
  if (at === -1) {
    return { namePattern: namePatternToRegExp(pattern), versions: [] };
  }
  const name = pattern.slice(0, at);
  if (name.includes("*")) {
    throw new InvalidReleaseAgeExcludeError(
      `name patterns are not allowed with version unions: "${pattern}"`,
    );
  }
  const versions = pattern
    .slice(at + 1)
    .split("||")
    .map((raw) => validVersion(raw.trim()));
  const parsed: string[] = [];
  for (const version of versions) {
    if (version === null) {
      throw new InvalidReleaseAgeExcludeError(
        `use exact versions only: "${pattern}"`,
      );
    }
    parsed.push(version);
  }
  return { namePattern: namePatternToRegExp(name), versions: parsed };
}

export function createReleasePolicy(
  settings: ReleaseAgeSettings,
  now: Date,
): ReleasePolicy {
  const cutoff =
    settings.minimumReleaseAge > 0
      ? new Date(now.getTime() - settings.minimumReleaseAge * 60_000)
      : null;
  return {
    cutoff,
    exclude: settings.minimumReleaseAgeExclude.map(parseExcludeRule),
  };
}

/** `true` when every version is exempt; otherwise the exempt versions. */
function exemptVersions(
  policy: ReleasePolicy,
  name: string,
): true | readonly string[] {
  const versions: string[] = [];
  for (const rule of policy.exclude) {
    if (!rule.namePattern.test(name)) {
      continue;
    }
    if (rule.versions.length === 0) {
      return true;
    }
    versions.push(...rule.versions);
  }
  return versions;
}

/**
 * Whether applying the policy to this package needs per-version publish
 * times that the abbreviated packument doesn't carry. `modified` is an upper
 * bound on every version's publish time, so a package untouched since the
 * cutoff has nothing to filter. Mirrors pnpm's own refetch rule.
 */
export function needsPublishTimes(
  meta: PackageMetadata,
  policy: ReleasePolicy,
  name: string,
): boolean {
  if (policy.cutoff === null || meta.publishedAt !== null) {
    return false;
  }
  if (exemptVersions(policy, name) === true) {
    return false;
  }
  return meta.modified === null || meta.modified > policy.cutoff;
}

/** Everything the registry publishes, as pnpm sees it without a policy. */
export function publishedPool(meta: PackageMetadata): VersionPool {
  const deprecated = new Set<string>();
  for (const [version, versionMeta] of meta.versions) {
    if (versionMeta.deprecated) {
      deprecated.add(version);
    }
  }
  return {
    versions: Array.from(meta.versions.keys()),
    latest: meta.latest,
    deprecated,
  };
}

function isPrerelease(version: string): boolean {
  return prerelease(version) !== null;
}

/**
 * Where the `latest` tag lands once the policy hides its version: the highest
 * admitted version at or below it with the same prerelease-ness, preferring
 * a non-deprecated one. Mirrors how pnpm repoints dist-tags when filtering
 * a packument by publish date.
 */
function repointLatest(
  pool: VersionPool,
  admitted: readonly string[],
): string | null {
  const latest = pool.latest;
  if (latest === null || admitted.includes(latest)) {
    return latest;
  }
  const eligible = admitted.filter(
    (v) => compare(v, latest) <= 0 && isPrerelease(v) === isPrerelease(latest),
  );
  const preferred = eligible.filter((v) => !pool.deprecated.has(v));
  const choices = preferred.length > 0 ? preferred : eligible;
  let best: string | null = null;
  for (const v of choices) {
    if (best === null || compare(v, best) > 0) {
      best = v;
    }
  }
  return best;
}

/** The versions the policy admits, as pnpm sees them after filtering. */
export function admittedPool(
  meta: PackageMetadata,
  policy: ReleasePolicy,
  name: string,
): VersionPool {
  const published = publishedPool(meta);
  const versions = eligibleVersions(meta, policy, name);
  if (versions.length === published.versions.length) {
    return published;
  }
  return {
    versions,
    latest: repointLatest(published, versions),
    deprecated: published.deprecated,
  };
}

/**
 * Versions the policy admits as resolution candidates. Without publish times
 * the check is skipped, as pnpm does by default for registries that omit the
 * `time` field.
 */
export function eligibleVersions(
  meta: PackageMetadata,
  policy: ReleasePolicy,
  name: string,
): readonly string[] {
  const all = Array.from(meta.versions.keys());
  const cutoff = policy.cutoff;
  const publishedAt = meta.publishedAt;
  if (cutoff === null || publishedAt === null) {
    return all;
  }
  const exempt = exemptVersions(policy, name);
  if (exempt === true) {
    return all;
  }
  return all.filter((version) => {
    if (exempt.includes(version)) {
      return true;
    }
    const time = publishedAt.get(version);
    return time !== undefined && time <= cutoff;
  });
}
