import { describe, expect, it } from "bun:test";
import {
  computeNaturalResolution,
  pickVersion,
  type VersionPool,
} from "../src/resolve.ts";

function pool(
  versions: readonly string[],
  extra: { latest?: string; deprecated?: readonly string[] } = {},
): VersionPool {
  return {
    versions,
    latest: extra.latest ?? null,
    deprecated: new Set(extra.deprecated ?? []),
  };
}

describe("computeNaturalResolution", () => {
  it("resolves every parent against admitted versions before falling back to published versions", () => {
    const versions = ["1.2.3", "1.5.9", "1.6.0", "2.0.0", "10.0.0"];
    // Membership in this finite version domain is independent of semver parsing.
    const requirements = [
      { spec: ">=1.2.3", members: [0, 1, 2, 3, 4] },
      { spec: "<2.0.0", members: [0, 1, 2] },
      { spec: "^1.2.3", members: [0, 1, 2] },
      { spec: "~1.5.0", members: [1] },
      { spec: "2.0.0", members: [3] },
      { spec: ">=20.0.0", members: [] },
    ];
    // Each published version is either absent, fallback-only, or admitted.
    for (let inventory = 0; inventory < 3 ** versions.length; inventory++) {
      const availability = versions.map(
        (_, index) => Math.floor(inventory / 3 ** index) % 3,
      );
      const admitted = pool(
        versions.filter((_, index) => availability[index] === 2),
      );
      const published = pool(
        versions.filter((_, index) => availability[index] !== 0),
      );
      for (let mask = 0; mask < 2 ** requirements.length; mask++) {
        const parents = requirements.filter(
          (_, index) => (mask & (1 << index)) !== 0,
        );
        const ranks = parents.flatMap(({ members }) => {
          const rank =
            members.findLast((index) => availability[index] === 2) ??
            members.findLast((index) => availability[index] === 1);
          return rank === undefined ? [] : [rank];
        });
        const expected = versions[Math.min(...ranks)] ?? null;
        const specs = parents.map(({ spec }) => spec);
        expect(computeNaturalResolution(specs, admitted, published)).toBe(
          expected,
        );
        expect(
          computeNaturalResolution(
            [...specs].reverse().concat(specs),
            admitted,
            published,
          ),
        ).toBe(expected);
      }
    }
  });

  it("ignores pre-release versions when ranges are stable", () => {
    expect(
      computeNaturalResolution(
        [">=1.0.0"],
        pool(["1.0.0", "1.1.0-beta.1", "1.0.5"]),
      ),
    ).toBe("1.0.5");
  });

  it("handles invalid candidate versions by filtering them out", () => {
    // satisfies() returns false on invalid versions instead of throwing.
    expect(
      computeNaturalResolution(
        [">=1.0.0"],
        pool(["not-a-version", "1.5.0", "2.0.0"]),
      ),
    ).toBe("2.0.0");
  });

  it("handles invalid parent specs by filtering all candidates out", () => {
    // satisfies() returns false on invalid specs, so nothing matches.
    expect(
      computeNaturalResolution(["not-a-spec"], pool(["1.0.0", "2.0.0"])),
    ).toBeNull();
  });
});

describe("pickVersion", () => {
  it("selects by latest tag, deprecation preference, and semantic version rank", () => {
    const versions = ["1.0.0", "1.1.0", "2.0.0-beta.1", "2.0.0", "10.0.0"];
    // Explicit membership keeps the oracle independent of semver parsing.
    const requirements = [
      { spec: "*", members: [0, 1, 3, 4], tagged: [0, 1, 2, 3, 4] },
      { spec: "^1.0.0", members: [0, 1], tagged: [0, 1] },
      { spec: ">=2.0.0", members: [3, 4], tagged: [3, 4] },
      { spec: "~1.1.0", members: [1], tagged: [1] },
      { spec: ">=2.0.0-beta.1 <2.0.0", members: [2], tagged: [2] },
      { spec: "^20.0.0", members: [], tagged: [] },
    ];
    for (let inventory = 0; inventory < 2 ** versions.length; inventory++) {
      const present = versions.map(
        (_, rank) => (inventory & (1 << rank)) !== 0,
      );
      const offered = versions.filter((_, rank) => present[rank]);
      for (
        let deprecatedMask = 0;
        deprecatedMask < 2 ** versions.length;
        deprecatedMask++
      ) {
        const deprecated = versions.filter(
          (_, rank) => (deprecatedMask & (1 << rank)) !== 0,
        );
        for (let latestRank = -1; latestRank < versions.length; latestRank++) {
          if (latestRank !== -1 && !present[latestRank]) {
            continue;
          }
          for (const { spec, members, tagged } of requirements) {
            // A tagged match outranks all alternatives; otherwise prefer fresh
            // matches, with descending semantic rank as the tie-breaker.
            const descending = members.toReversed();
            const preference = [
              ...(tagged.includes(latestRank) ? [latestRank] : []),
              ...descending.filter(
                (rank) => (deprecatedMask & (1 << rank)) === 0,
              ),
              ...descending,
            ];
            const winner = preference.find((rank) => present[rank]);
            const expected =
              winner === undefined ? null : (versions[winner] ?? null);
            for (const order of [offered, offered.toReversed()]) {
              expect(
                pickVersion(spec, {
                  versions: order,
                  latest: versions[latestRank] ?? null,
                  deprecated: new Set(deprecated),
                }),
              ).toBe(expected);
            }
          }
        }
      }
    }
  });
});
