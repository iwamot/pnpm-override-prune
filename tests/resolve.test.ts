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
  it("prefers the latest tag when it satisfies the range", () => {
    const p = pool(["1.0.0", "1.1.0", "1.2.0"], { latest: "1.1.0" });
    expect(pickVersion("^1.0.0", p)).toBe("1.1.0");
    expect(pickVersion("*", p)).toBe("1.1.0");
  });

  it("takes the highest satisfying version when latest is outside the range", () => {
    const p = pool(["1.0.0", "1.1.0", "2.0.0"], { latest: "2.0.0" });
    expect(pickVersion("^1.0.0", p)).toBe("1.1.0");
  });

  it("picks a prerelease latest for a bare star, as pnpm does", () => {
    const p = pool(["1.0.0", "2.0.0-beta.1"], { latest: "2.0.0-beta.1" });
    expect(pickVersion("*", p)).toBe("2.0.0-beta.1");
    expect(pickVersion("^1.0.0", p)).toBe("1.0.0");
  });

  it("avoids a deprecated highest version when another satisfies", () => {
    const p = pool(["1.0.0", "1.1.0", "1.2.0"], { deprecated: ["1.2.0"] });
    expect(pickVersion("^1.0.0", p)).toBe("1.1.0");
  });

  it("takes the deprecated version when nothing else satisfies", () => {
    const p = pool(["1.0.0", "1.2.0"], { deprecated: ["1.2.0"] });
    expect(pickVersion("~1.2.0", p)).toBe("1.2.0");
    expect(
      pickVersion("^1.0.0", pool(["1.2.0"], { deprecated: ["1.2.0"] })),
    ).toBe("1.2.0");
  });

  it("still returns a deprecated latest, as pnpm does", () => {
    const p = pool(["1.0.0", "1.1.0"], {
      latest: "1.1.0",
      deprecated: ["1.1.0"],
    });
    expect(pickVersion("^1.0.0", p)).toBe("1.1.0");
  });

  it("returns null when nothing satisfies", () => {
    expect(
      pickVersion("^3.0.0", pool(["1.0.0"], { latest: "1.0.0" })),
    ).toBeNull();
  });
});
