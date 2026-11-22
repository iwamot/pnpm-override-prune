import { describe, expect, it } from "bun:test";
import {
  MalformedRegistryResponseError,
  PACKUMENT_ACCEPT,
  type PackageVersionMeta,
  parsePackageMetadata,
  requestHeaders,
} from "../src/registry.ts";

describe("requestHeaders", () => {
  it("asks for the abbreviated packument with full-document fallbacks", () => {
    expect(requestHeaders(null)).toEqual({
      accept:
        "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
    });
  });

  it("adds the authorization header when credentials are configured", () => {
    expect(requestHeaders("Bearer tok")).toEqual({
      accept: PACKUMENT_ACCEPT.abbreviated,
      authorization: "Bearer tok",
    });
  });

  it("asks for plain JSON when the full packument is wanted", () => {
    expect(requestHeaders(null, "full")).toEqual({
      accept: "application/json",
    });
  });
});

describe("parsePackageMetadata", () => {
  it("reads an abbreviated packument, which has no readme or time fields", () => {
    // Shape served for Accept: application/vnd.npm.install-v1+json.
    const raw = {
      name: "react-dom",
      "dist-tags": { latest: "19.1.0" },
      modified: "2025-03-28T20:39:22.000Z",
      versions: {
        "19.1.0": {
          name: "react-dom",
          version: "19.1.0",
          dependencies: { scheduler: "^0.26.0" },
          peerDependencies: { react: "^19.1.0" },
          dist: {
            tarball:
              "https://registry.npmjs.org/react-dom/-/react-dom-19.1.0.tgz",
          },
        },
      },
    };
    const meta = parsePackageMetadata(raw, "react-dom");
    const v = meta.versions.get("19.1.0");
    expect(v?.dependencies.get("scheduler")).toBe("^0.26.0");
    expect(v?.dependencies.get("react")).toBe("^19.1.0");
    expect(v?.deprecated).toBe(false);
    expect(meta.latest).toBe("19.1.0");
    expect(meta.modified).toEqual(new Date("2025-03-28T20:39:22.000Z"));
    expect(meta.publishedAt).toBeNull();
  });

  it("reads publish times from the full packument's time field", () => {
    const raw = {
      name: "pkg",
      time: {
        created: "2020-01-01T00:00:00.000Z",
        modified: "2026-09-22T00:56:58.317Z",
        "1.0.0": "2020-01-01T00:00:00.000Z",
        "1.1.0": "not a date",
        "9.9.9": "2026-01-01T00:00:00.000Z",
      },
      versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {} },
    };
    const meta = parsePackageMetadata(raw, "pkg");
    expect(meta.publishedAt).toEqual(
      new Map([["1.0.0", new Date("2020-01-01T00:00:00.000Z")]]),
    );
    expect(meta.modified).toBeNull();
  });

  it("flags deprecated versions and ignores a latest tag that names no version", () => {
    const raw = {
      "dist-tags": { latest: "9.9.9" },
      versions: {
        "1.0.0": { deprecated: "use 2.x" },
        "2.0.0": {},
      },
    };
    const meta = parsePackageMetadata(raw, "pkg");
    expect(meta.versions.get("1.0.0")?.deprecated).toBe(true);
    expect(meta.versions.get("2.0.0")?.deprecated).toBe(false);
    expect(meta.latest).toBeNull();
    expect(parsePackageMetadata({ versions: {} }, "pkg").latest).toBeNull();
  });

  it("reports no publish times when the time field is absent or malformed", () => {
    expect(
      parsePackageMetadata({ versions: {}, time: "soon" }, "pkg").publishedAt,
    ).toBeNull();
    expect(
      parsePackageMetadata({ versions: {}, modified: 12 }, "pkg").modified,
    ).toBeNull();
  });

  it("merges every dependency inventory with normal, peer, then optional priority per version", () => {
    const fields = [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;
    const names = ["plain", "@scope/pkg"];
    for (let mask = 0; mask < 2 ** (fields.length * names.length); mask++) {
      for (const reversed of [false, true]) {
        const versions: Record<
          string,
          Record<string, Record<string, string>>
        > = {};
        const expected = new Map<string, PackageVersionMeta>();
        for (const [index, version] of ["1.0.0", "2.0.0"].entries()) {
          // Complementary inventories expose accidental sharing across versions.
          const inventory = index === 0 ? mask : ~mask;
          const pairs = fields.map(
            (field, priority) =>
              [
                field,
                Object.fromEntries(
                  names
                    .filter(
                      (_, keyIndex) =>
                        (inventory &
                          (1 << (priority * names.length + keyIndex))) !==
                        0,
                    )
                    .map(
                      (name) =>
                        [name, `^${index + 1}.${priority + 1}.0`] as const,
                    ),
                ),
              ] as const,
          );
          const present = pairs.filter(
            ([, deps]) => Object.keys(deps).length > 0,
          );
          const record = Object.fromEntries(
            reversed ? present.reverse() : present,
          );
          versions[version] = record;
          expected.set(version, {
            version,
            dependencies: new Map(
              Object.entries({
                ...record.optionalDependencies,
                ...record.peerDependencies,
                ...record.dependencies,
              }),
            ),
            deprecated: false,
          });
        }
        const metadata = parsePackageMetadata({ name: "pkg", versions }, "pkg");
        expect(metadata.name).toBe("pkg");
        expect(metadata.versions).toEqual(expected);
      }
    }
  });

  it("ignores non-mapping dep fields", () => {
    const raw = {
      versions: {
        "1.0.0": {
          dependencies: "oops",
          peerDependencies: { a: ">=1.0.0" },
        },
      },
    };
    const meta = parsePackageMetadata(raw, "x");
    expect(meta.versions.get("1.0.0")?.dependencies.get("a")).toBe(">=1.0.0");
  });

  it("ignores non-string spec entries within a dep map", () => {
    const raw = {
      versions: {
        "1.0.0": {
          dependencies: {
            good: ">=1.0.0",
            weird: 42,
            alsoWeird: { nested: true },
          },
        },
      },
    };
    const meta = parsePackageMetadata(raw, "x");
    const deps = meta.versions.get("1.0.0")?.dependencies;
    expect(deps?.get("good")).toBe(">=1.0.0");
    expect(deps?.has("weird")).toBe(false);
    expect(deps?.has("alsoWeird")).toBe(false);
  });

  it("ignores version entries that are not mappings", () => {
    const raw = {
      versions: {
        "1.0.0": "should-be-object",
        "2.0.0": {},
      },
    };
    const meta = parsePackageMetadata(raw, "x");
    expect(meta.versions.has("1.0.0")).toBe(false);
    expect(meta.versions.has("2.0.0")).toBe(true);
  });

  it("throws when root is not an object", () => {
    expect(() => parsePackageMetadata("not-an-object", "x")).toThrow(
      MalformedRegistryResponseError,
    );
  });

  it("throws when versions field is missing", () => {
    expect(() => parsePackageMetadata({ name: "x" }, "x")).toThrow(
      MalformedRegistryResponseError,
    );
  });

  it("throws when versions field is not a mapping", () => {
    expect(() => parsePackageMetadata({ versions: "oops" }, "x")).toThrow(
      MalformedRegistryResponseError,
    );
  });
});
