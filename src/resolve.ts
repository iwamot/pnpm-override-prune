import { maxSatisfying, satisfies } from "semver";

/**
 * Given parent dependency specs and a list of candidate published versions,
 * compute the highest version that satisfies all parent specs simultaneously.
 *
 * Returns null when there are no parent specs, no candidates, or no version
 * satisfies the intersection. Pre-releases are ignored unless they fall inside
 * a parent spec that explicitly opts them in.
 */
export function computeNaturalResolution(
  parentSpecs: readonly string[],
  candidateVersions: readonly string[],
): string | null {
  if (parentSpecs.length === 0 || candidateVersions.length === 0) {
    return null;
  }
  const filtered = candidateVersions.filter((version) =>
    parentSpecs.every((spec) =>
      satisfies(version, spec, { includePrerelease: false }),
    ),
  );
  return maxSatisfying(filtered, ">=0.0.0", { includePrerelease: false });
}
