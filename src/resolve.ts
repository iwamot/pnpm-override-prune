import { compare, major, maxSatisfying, minor, patch, satisfies } from "semver";

/** The versions a spec may resolve to, with what pnpm's picker reads. */
export interface VersionPool {
  readonly versions: readonly string[];
  /** The `latest` dist-tag, or null when it points outside the pool. */
  readonly latest: string | null;
  readonly deprecated: ReadonlySet<string>;
}

function maxSatisfyingIn(
  versions: readonly string[],
  spec: string,
): string | null {
  return maxSatisfying(versions, spec, { includePrerelease: false });
}

/**
 * The version pnpm resolves a range to, given the versions on offer: the
 * `latest` tag when it satisfies the range, otherwise the highest satisfying
 * version. Either pick gives way to a non-deprecated version the range also
 * allows when it is deprecated itself. Mirrors pnpm's
 * `pickVersionByVersionRange` from 11.28.13 and 12.23.0, which skip a
 * deprecated `latest` as well; earlier pnpm and aube keep it, and land on a
 * version at least as high as this one, so an entry this reads as prunable is
 * prunable for them too.
 */
export function pickVersion(spec: string, pool: VersionPool): string | null {
  const latest = pool.latest;
  if (latest !== null && (spec === "*" || satisfies(latest, spec))) {
    return nonDeprecatedPick(spec, pool, latest) ?? latest;
  }
  const max = maxSatisfyingIn(pool.versions, spec);
  if (max === null) {
    return null;
  }
  return nonDeprecatedPick(spec, pool, max) ?? max;
}

/**
 * The version pnpm takes instead of a deprecated pick: the highest
 * non-deprecated one the range allows. A `latest` that is a prerelease
 * satisfies `*` only because the tag says so, so a sibling build of the same
 * release is tried first. Null when the pick is not deprecated or nothing
 * else qualifies.
 */
function nonDeprecatedPick(
  spec: string,
  pool: VersionPool,
  picked: string,
): string | null {
  if (!pool.deprecated.has(picked) || pool.versions.length <= 1) {
    return null;
  }
  const fresh = pool.versions.filter(
    (v) => v !== picked && !pool.deprecated.has(v),
  );
  if (spec === "*" && !satisfies(picked, spec)) {
    const sameRelease = fresh
      .filter((v) => sameReleaseAs(v, picked))
      .sort(compare)
      .at(-1);
    if (sameRelease !== undefined) {
      return sameRelease;
    }
  }
  return maxSatisfyingIn(fresh, spec);
}

function sameReleaseAs(a: string, b: string): boolean {
  return (
    major(a) === major(b) && minor(a) === minor(b) && patch(a) === patch(b)
  );
}

/**
 * For each importer/parent spec, compute the version that spec would resolve
 * to on its own. Return the lowest of those — i.e. the worst-case version some
 * consumer would land on if the override were removed.
 *
 * pnpm doesn't always hoist to a single version; when specs disagree, multiple
 * versions get installed. Reporting the lowest means PRUNE only when *every*
 * consumer would land at or above the override floor.
 *
 * `candidates` holds the versions the release-age policy admits; `fallback`
 * holds every published version. A spec no candidate satisfies resolves
 * from the fallback, as pnpm does outside strict mode.
 *
 * Returns null when there are no parent specs or no versions. Specs that no
 * version satisfies are skipped (treated as inert constraints).
 */
export function computeNaturalResolution(
  parentSpecs: readonly string[],
  candidates: VersionPool,
  fallback: VersionPool = candidates,
): string | null {
  if (parentSpecs.length === 0 || fallback.versions.length === 0) {
    return null;
  }
  let lowest: string | null = null;
  for (const spec of parentSpecs) {
    const picked = pickVersion(spec, candidates) ?? pickVersion(spec, fallback);
    if (picked === null) {
      continue;
    }
    if (lowest === null || compare(picked, lowest) < 0) {
      lowest = picked;
    }
  }
  return lowest;
}
