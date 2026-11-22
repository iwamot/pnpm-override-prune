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
      { spec: "not-a-spec", members: [] },
    ];
    expect(computeNaturalResolution([">=1.0.0"], pool([]))).toBeNull();
    // Neither malformed versions nor prereleases satisfy these stable ranges.
    const irrelevant = ["not-a-version", "100.0.0-beta.1"];
    // Each published stable version is absent, fallback-only, or admitted.
    for (let inventory = 0; inventory < 3 ** versions.length; inventory++) {
      const availability = versions.map(
        (_, index) => Math.floor(inventory / 3 ** index) % 3,
      );
      const admitted = pool([
        ...versions.filter((_, index) => availability[index] === 2),
        ...irrelevant,
      ]);
      const published = pool([
        ...versions.filter((_, index) => availability[index] !== 0),
        ...irrelevant,
      ]);
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
});

describe("pickVersion", () => {
  it("selects by latest tag, skipping deprecated picks, and semantic version rank", () => {
    const versions = [
      "1.0.0",
      "1.1.0",
      "2.0.0-beta.1",
      "2.0.0-beta.2",
      "2.0.0",
      "10.0.0",
    ];
    // The ranks that share a major.minor.patch with each rank, ascending.
    const releaseRanks = [[0], [1], [2, 3, 4], [2, 3, 4], [2, 3, 4], [5]];
    // Explicit membership keeps the oracle independent of semver parsing.
    const requirements = [
      { spec: "*", members: [0, 1, 4, 5], tagged: [0, 1, 2, 3, 4, 5] },
      { spec: "^1.0.0", members: [0, 1], tagged: [0, 1] },
      { spec: ">=2.0.0", members: [4, 5], tagged: [4, 5] },
      { spec: "~1.1.0", members: [1], tagged: [1] },
      { spec: ">=2.0.0-beta.1 <2.0.0", members: [2, 3], tagged: [2, 3] },
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
          const fresh = (rank: number): boolean =>
            present[rank] === true && (deprecatedMask & (1 << rank)) === 0;
          for (const { spec, members, tagged } of requirements) {
            // A tagged match is taken unless it is deprecated; a deprecated
            // pick gives way to the highest fresh match, and under `*` a
            // prerelease tag gives way to a fresh build of its own release
            // first. Descending semantic rank breaks ties.
            const descending = members.toReversed();
            const others = (pick: number): number[] =>
              descending.filter((rank) => rank !== pick && fresh(rank));
            let winner: number | undefined;
            if (tagged.includes(latestRank)) {
              const siblings =
                spec === "*" && !members.includes(latestRank)
                  ? (releaseRanks[latestRank] ?? [])
                      .filter((rank) => rank !== latestRank && fresh(rank))
                      .toReversed()
                  : [];
              winner = fresh(latestRank)
                ? latestRank
                : (siblings[0] ?? others(latestRank)[0] ?? latestRank);
            } else {
              const max = descending.find((rank) => present[rank]);
              winner =
                max === undefined || fresh(max) ? max : (others(max)[0] ?? max);
            }
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
