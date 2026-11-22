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

  it("admits the union of matching exclusions regardless of rule order or repetition", () => {
    const versions = ["1.0.0", "1.1.0", "1.2.0"];
    const rules = [
      { pattern: "pkg", names: ["pkg"], versions },
      { pattern: "p*", names: ["pkg", "pkg-extra", "p.g"], versions },
      { pattern: "@myorg/*", names: ["@myorg/pkg"], versions },
      { pattern: "p.g", names: ["p.g"], versions },
      {
        pattern: "pkg@1.2.0 || 1.1.0 || 0.9.0",
        names: ["pkg"],
        versions: ["1.2.0", "1.1.0", "0.9.0"],
      },
      { pattern: "pkg@1.0.0", names: ["pkg"], versions: ["1.0.0"] },
      {
        pattern: "@myorg/pkg@1.1.0",
        names: ["@myorg/pkg"],
        versions: ["1.1.0"],
      },
    ];
    const names = [
      "pkg",
      "pkg-extra",
      "p.g",
      "@myorg/pkg",
      "@other/pkg",
      "other",
      "x-pkg",
    ];
    for (let mask = 0; mask < 2 ** rules.length; mask++) {
      const selected = rules.filter((_, index) => (mask & (1 << index)) !== 0);
      for (const mature of [[], ["1.0.0"]]) {
        const metadata = meta({
          versions,
          publishedAt: Object.fromEntries(
            versions.map(
              (version) =>
                [
                  version,
                  mature.includes(version)
                    ? "2026-09-01T00:00:00Z"
                    : "2026-09-22T11:00:00Z",
                ] as const,
            ),
          ),
        });
        for (const ordered of [
          selected,
          selected.toReversed().concat(selected),
        ]) {
          const active = policy(
            1440,
            ordered.map(({ pattern }) => pattern),
          );
          for (const name of names) {
            // The finite membership table defines exemptions without regex or semver calls.
            const admitted = new Set([
              ...mature,
              ...selected
                .filter((rule) => rule.names.includes(name))
                .flatMap((rule) => rule.versions),
            ]);
            expect(eligibleVersions(metadata, active, name)).toEqual(
              versions.filter((version) => admitted.has(version)),
            );
          }
        }
      }
    }
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
  it("is the published pool when nothing is filtered", () => {
    const m = meta({ versions: ["1.0.0"], latest: "1.0.0" });
    expect(admittedPool(m, policy(1440), "pkg")).toEqual(publishedPool(m));
  });

  it("preserves pool metadata and repoints latest within its release stage and version ceiling", () => {
    // This order and release-stage membership define the model without semver calls.
    const versions = [
      "1.0.0",
      "1.1.0-beta.1",
      "1.1.0-beta.2",
      "2.0.0",
      "10.0.0",
      "20.0.0",
    ];
    const prereleases = new Set(["1.1.0-beta.1", "1.1.0-beta.2"]);
    const active = policy(1440);
    for (let matureMask = 0; matureMask < 2 ** versions.length; matureMask++) {
      const mature = versions.filter(
        (_, index) => (matureMask & (1 << index)) !== 0,
      );
      const publishedAt = Object.fromEntries(
        versions.map(
          (version) =>
            [
              version,
              mature.includes(version)
                ? "2026-09-21T12:00:00Z"
                : "2026-09-22T11:00:00Z",
            ] as const,
        ),
      );
      for (
        let deprecatedMask = 0;
        deprecatedMask < 2 ** versions.length;
        deprecatedMask++
      ) {
        const deprecated = versions.filter(
          (_, index) => (deprecatedMask & (1 << index)) !== 0,
        );
        for (const latest of [null, ...versions]) {
          const predecessors =
            latest === null
              ? []
              : versions
                  .slice(0, versions.indexOf(latest) + 1)
                  .filter(
                    (version) =>
                      mature.includes(version) &&
                      prereleases.has(version) === prereleases.has(latest),
                  );
          const preferred = predecessors.filter(
            (version) => !deprecated.includes(version),
          );
          const expectedLatest =
            latest !== null && mature.includes(latest)
              ? latest
              : (preferred.at(-1) ?? predecessors.at(-1) ?? null);
          for (const ordered of [versions, [...versions].reverse()]) {
            const metadata = meta({
              versions: ordered,
              ...(latest === null ? {} : { latest }),
              deprecated,
              publishedAt,
            });
            expect(admittedPool(metadata, active, "pkg")).toEqual({
              versions: ordered.filter((version) => mature.includes(version)),
              latest: expectedLatest,
              deprecated: new Set(deprecated),
            });
          }
        }
      }
    }
  });
});
