import { compare, maxSatisfying, satisfies } from "semver";

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
 * version, preferring a non-deprecated one when the highest is deprecated.
 * Mirrors pnpm's `pickVersionByVersionRange`.
 */
export function pickVersion(spec: string, pool: VersionPool): string | null {
  const latest = pool.latest;
  if (latest !== null && (spec === "*" || satisfies(latest, spec))) {
    return latest;
  }
  const max = maxSatisfyingIn(pool.versions, spec);
  if (max !== null && pool.deprecated.has(max) && pool.versions.length > 1) {
    const alternative = maxSatisfyingIn(
      pool.versions.filter((v) => !pool.deprecated.has(v)),
      spec,
    );
    if (alternative !== null) {
      return alternative;
    }
  }
  return max;
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
