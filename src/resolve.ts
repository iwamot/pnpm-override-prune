import { compare, maxSatisfying } from "semver";

/**
 * For each importer/parent spec, compute the highest published version that
 * spec would resolve to on its own. Return the lowest of those — i.e. the
 * worst-case version some consumer would land on if the override were removed.
 *
 * pnpm doesn't always hoist to a single version; when specs disagree, multiple
 * versions get installed. Reporting the lowest means PRUNE only when *every*
 * consumer would land at or above the override floor.
 *
 * Returns null when there are no parent specs or no candidates. Specs that no
 * candidate satisfies are skipped (treated as inert constraints).
 */
export function computeNaturalResolution(
  parentSpecs: readonly string[],
  candidateVersions: readonly string[],
): string | null {
  if (parentSpecs.length === 0 || candidateVersions.length === 0) {
    return null;
  }
  let lowest: string | null = null;
  for (const spec of parentSpecs) {
    const max = maxSatisfying(candidateVersions, spec, {
      includePrerelease: false,
    });
    if (max === null) {
      continue;
    }
    if (lowest === null || compare(max, lowest) < 0) {
      lowest = max;
    }
  }
  return lowest;
}
