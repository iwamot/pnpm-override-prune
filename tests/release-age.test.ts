import { describe, expect, it } from "bun:test";
import type { PackageMetadata } from "../src/registry.ts";
import {
  admittedPool,
  createReleasePolicy,
  DEFAULT_RELEASE_AGE_SETTINGS,
  eligibleVersions,
  InvalidReleaseAgeExcludeError,
  needsPublishTimes,
  publishedPool,
  type ReleasePolicy,
} from "../src/release-age.ts";

const NOW = new Date("2026-09-22T12:00:00Z");
const ONE_DAY_AGO = new Date("2026-09-21T12:00:00Z");

function policy(
  minimumReleaseAge: number,
  minimumReleaseAgeExclude: readonly string[] = [],
): ReleasePolicy {
  return createReleasePolicy(
    { minimumReleaseAge, minimumReleaseAgeExclude },
    NOW,
  );
}

function meta(args: {
  versions: readonly string[];
  latest?: string;
  deprecated?: readonly string[];
  modified?: string;
  publishedAt?: Record<string, string>;
}): PackageMetadata {
  return {
    name: "pkg",
    versions: new Map(
      args.versions.map((v) => [
        v,
        {
          version: v,
          dependencies: new Map(),
          deprecated: (args.deprecated ?? []).includes(v),
        },
      ]),
    ),
    latest: args.latest ?? null,
    modified: args.modified === undefined ? null : new Date(args.modified),
    publishedAt:
      args.publishedAt === undefined
        ? null
        : new Map(
            Object.entries(args.publishedAt).map(([v, t]) => [v, new Date(t)]),
          ),
  };
}

describe("createReleasePolicy", () => {
  it("defaults to pnpm's one-day minimum", () => {
    expect(DEFAULT_RELEASE_AGE_SETTINGS.minimumReleaseAge).toBe(1440);
    expect(
      createReleasePolicy(DEFAULT_RELEASE_AGE_SETTINGS, NOW).cutoff,
    ).toEqual(ONE_DAY_AGO);
  });

  it("disables the check when the minimum is zero", () => {
    expect(policy(0).cutoff).toBeNull();
  });

  it("rejects a version union that is not exact versions", () => {
    expect(() => policy(1440, ["webpack@^5"])).toThrow(
      new InvalidReleaseAgeExcludeError(
        'use exact versions only: "webpack@^5"',
      ),
    );
  });

  it("rejects a name pattern combined with a version union", () => {
    expect(() => policy(1440, ["@myorg/*@1.0.0"])).toThrow(
      InvalidReleaseAgeExcludeError,
    );
  });
});

describe("eligibleVersions", () => {
  const dated = meta({
    versions: ["1.0.0", "1.1.0", "1.2.0"],
    publishedAt: {
      "1.0.0": "2026-09-01T00:00:00Z",
      "1.1.0": "2026-09-21T12:00:00Z",
      "1.2.0": "2026-09-22T11:00:00Z",
    },
  });

  it("keeps exactly the dated versions old enough at any policy duration and time origin", () => {
    const versions = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"];
    for (const now of [new Date(0), NOW]) {
      for (const minimumReleaseAge of [1, 60, 1440, 10080]) {
        const cutoff = now.getTime() - minimumReleaseAge * 60_000;
        const publishedAt = Object.fromEntries(
          [-1, 0, 1].map(
            (offset, index) =>
              [
                `1.${index}.0`,
                new Date(cutoff + offset).toISOString(),
              ] as const,
          ),
        );
        const dated = meta({ versions, publishedAt });
        const settings = { minimumReleaseAge, minimumReleaseAgeExclude: [] };
        const active = createReleasePolicy(settings, now);
        expect(eligibleVersions(dated, active, "pkg")).toEqual(
          versions.slice(0, 2),
        );
        expect(eligibleVersions(meta({ versions }), active, "pkg")).toEqual(
          versions,
        );
        const disabled = createReleasePolicy(
          { ...settings, minimumReleaseAge: 0 },
          now,
        );
        expect(eligibleVersions(dated, disabled, "pkg")).toEqual(versions);
      }
    }
  });

  it("exempts a package named in the exclude list", () => {
    expect(eligibleVersions(dated, policy(1440, ["pkg"]), "pkg")).toHaveLength(
      3,
    );
    expect(
      eligibleVersions(dated, policy(1440, ["other"]), "pkg"),
    ).toHaveLength(2);
  });

  it("matches exclude patterns with wildcards", () => {
    expect(eligibleVersions(dated, policy(1440, ["p*"]), "pkg")).toHaveLength(
      3,
    );
    expect(
      eligibleVersions(dated, policy(1440, ["@myorg/*"]), "@myorg/pkg"),
    ).toHaveLength(3);
    expect(
      eligibleVersions(dated, policy(1440, ["@myorg/*"]), "@other/pkg"),
    ).toHaveLength(2);
    expect(eligibleVersions(dated, policy(1440, ["p.g"]), "pkg")).toHaveLength(
      2,
    );
  });

  it("exempts only the listed versions of a version union", () => {
    expect(
      eligibleVersions(dated, policy(1440, ["pkg@1.2.0 || 0.9.0"]), "pkg"),
    ).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
    expect(eligibleVersions(dated, policy(1440, ["pkg@0.9.0"]), "pkg")).toEqual(
      ["1.0.0", "1.1.0"],
    );
  });

  it("lets a whole-package rule win over a version rule", () => {
    expect(
      eligibleVersions(dated, policy(1440, ["pkg@0.9.0", "pkg"]), "pkg"),
    ).toHaveLength(3);
  });
});

describe("needsPublishTimes", () => {
  it("fetches dates only when the policy needs information that local metadata cannot provide", () => {
    const exemptions = [
      { exclude: [], wholePackage: false },
      { exclude: ["pkg"], wholePackage: true },
      { exclude: ["p*"], wholePackage: true },
      { exclude: ["other"], wholePackage: false },
      { exclude: ["pkg@1.0.0"], wholePackage: false },
    ];
    for (const now of [new Date(0), NOW]) {
      for (const minimumReleaseAge of [0, 1, 60, 1440]) {
        const cutoff = now.getTime() - minimumReleaseAge * 60_000;
        for (const offset of [null, -1, 0, 1]) {
          for (const dated of [false, true]) {
            const metadata = meta({
              versions: ["1.0.0"],
              ...(offset === null
                ? {}
                : { modified: new Date(cutoff + offset).toISOString() }),
              ...(dated ? { publishedAt: {} } : {}),
            });
            for (const { exclude, wholePackage } of exemptions) {
              const active = createReleasePolicy(
                { minimumReleaseAge, minimumReleaseAgeExclude: exclude },
                now,
              );
              const recentOrUnknown = offset === null || offset === 1;
              expect(needsPublishTimes(metadata, active, "pkg")).toBe(
                minimumReleaseAge !== 0 &&
                  !dated &&
                  !wholePackage &&
                  recentOrUnknown,
              );
            }
          }
        }
      }
    }
  });
});

describe("publishedPool", () => {
  it("carries every version, the latest tag, and deprecations", () => {
    const m = meta({
      versions: ["1.0.0", "1.1.0"],
      latest: "1.1.0",
      deprecated: ["1.0.0"],
    });
    expect(publishedPool(m)).toEqual({
      versions: ["1.0.0", "1.1.0"],
      latest: "1.1.0",
      deprecated: new Set(["1.0.0"]),
    });
  });
});

describe("admittedPool", () => {
  const times = {
    "1.0.0": "2026-09-01T00:00:00Z",
    "1.1.0": "2026-09-10T00:00:00Z",
    "1.2.0": "2026-09-22T11:00:00Z",
    "2.0.0-beta.1": "2026-09-22T11:30:00Z",
  };

  it("is the published pool when nothing is filtered", () => {
    const m = meta({ versions: ["1.0.0"], latest: "1.0.0" });
    expect(admittedPool(m, policy(1440), "pkg")).toEqual(publishedPool(m));
  });

  it("keeps the latest tag when its version is mature", () => {
    const m = meta({
      versions: Object.keys(times),
      latest: "1.1.0",
      publishedAt: times,
    });
    expect(admittedPool(m, policy(1440), "pkg")).toEqual({
      versions: ["1.0.0", "1.1.0"],
      latest: "1.1.0",
      deprecated: new Set(),
    });
  });

  it("moves latest back to the highest mature version below it", () => {
    const m = meta({
      versions: Object.keys(times),
      latest: "1.2.0",
      publishedAt: times,
    });
    expect(admittedPool(m, policy(1440), "pkg").latest).toBe("1.1.0");
  });

  it("prefers a non-deprecated version when moving latest", () => {
    const m = meta({
      versions: Object.keys(times),
      latest: "1.2.0",
      deprecated: ["1.1.0"],
      publishedAt: times,
    });
    expect(admittedPool(m, policy(1440), "pkg").latest).toBe("1.0.0");
  });

  it("falls back to a deprecated version when only those remain", () => {
    const m = meta({
      versions: Object.keys(times),
      latest: "1.2.0",
      deprecated: ["1.0.0", "1.1.0"],
      publishedAt: times,
    });
    expect(admittedPool(m, policy(1440), "pkg").latest).toBe("1.1.0");
  });

  it("keeps a prerelease latest on prereleases only", () => {
    const m = meta({
      versions: Object.keys(times),
      latest: "2.0.0-beta.1",
      publishedAt: times,
    });
    expect(admittedPool(m, policy(1440), "pkg").latest).toBeNull();
  });

  it("drops latest when no mature version is at or below it", () => {
    const m = meta({
      versions: ["1.2.0", "1.3.0"],
      latest: "1.2.0",
      publishedAt: {
        "1.2.0": "2026-09-22T11:00:00Z",
        "1.3.0": "2026-09-01T00:00:00Z",
      },
    });
    expect(admittedPool(m, policy(1440), "pkg")).toEqual({
      versions: ["1.3.0"],
      latest: null,
      deprecated: new Set(),
    });
  });

  it("has no latest when the registry reports none", () => {
    const m = meta({ versions: Object.keys(times), publishedAt: times });
    expect(admittedPool(m, policy(1440), "pkg").latest).toBeNull();
  });
});
