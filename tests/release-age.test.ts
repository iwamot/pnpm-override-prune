import { describe, expect, it } from "bun:test";
import type { PackageMetadata } from "../src/registry.ts";
import {
  createReleasePolicy,
  DEFAULT_RELEASE_AGE_SETTINGS,
  eligibleVersions,
  InvalidReleaseAgeExcludeError,
  needsPublishTimes,
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
  modified?: string;
  publishedAt?: Record<string, string>;
}): PackageMetadata {
  return {
    name: "pkg",
    versions: new Map(
      args.versions.map((v) => [v, { version: v, dependencies: new Map() }]),
    ),
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

  it("drops versions published after the cutoff, keeping the boundary", () => {
    expect(eligibleVersions(dated, policy(1440), "pkg")).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
  });

  it("keeps everything when the check is disabled", () => {
    expect(eligibleVersions(dated, policy(0), "pkg")).toEqual([
      "1.0.0",
      "1.1.0",
      "1.2.0",
    ]);
  });

  it("keeps everything without publish times", () => {
    const undated = meta({ versions: ["1.0.0", "1.2.0"] });
    expect(eligibleVersions(undated, policy(1440), "pkg")).toEqual([
      "1.0.0",
      "1.2.0",
    ]);
  });

  it("drops a version the time field does not date", () => {
    const partial = meta({
      versions: ["1.0.0", "1.1.0"],
      publishedAt: { "1.0.0": "2026-09-01T00:00:00Z" },
    });
    expect(eligibleVersions(partial, policy(1440), "pkg")).toEqual(["1.0.0"]);
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
  it("is false when the check is disabled", () => {
    const recent = meta({
      versions: ["1.0.0"],
      modified: "2026-09-22T11:00:00Z",
    });
    expect(needsPublishTimes(recent, policy(0), "pkg")).toBe(false);
  });

  it("is false when the versions are already dated", () => {
    const dated = meta({
      versions: ["1.0.0"],
      modified: "2026-09-22T11:00:00Z",
      publishedAt: { "1.0.0": "2026-09-22T11:00:00Z" },
    });
    expect(needsPublishTimes(dated, policy(1440), "pkg")).toBe(false);
  });

  it("is false for a package the exclude list exempts", () => {
    const recent = meta({
      versions: ["1.0.0"],
      modified: "2026-09-22T11:00:00Z",
    });
    expect(needsPublishTimes(recent, policy(1440, ["pkg"]), "pkg")).toBe(false);
  });

  it("is true for a package the exclude list only partly exempts", () => {
    const recent = meta({
      versions: ["1.0.0"],
      modified: "2026-09-22T11:00:00Z",
    });
    expect(needsPublishTimes(recent, policy(1440, ["pkg@1.0.0"]), "pkg")).toBe(
      true,
    );
  });

  it("is false when nothing changed since the cutoff", () => {
    const stale = meta({
      versions: ["1.0.0"],
      modified: "2026-09-21T12:00:00Z",
    });
    expect(needsPublishTimes(stale, policy(1440), "pkg")).toBe(false);
  });

  it("is true when the package changed after the cutoff", () => {
    const recent = meta({
      versions: ["1.0.0"],
      modified: "2026-09-21T12:00:01Z",
    });
    expect(needsPublishTimes(recent, policy(1440), "pkg")).toBe(true);
  });

  it("is true when the registry does not say when it changed", () => {
    expect(
      needsPublishTimes(meta({ versions: ["1.0.0"] }), policy(1440), "pkg"),
    ).toBe(true);
  });
});
