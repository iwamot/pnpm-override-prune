import { describe, expect, it } from "bun:test";
import { stringify } from "yaml";
import {
  buildWorkspaceDirectDeps,
  MalformedManifestError,
  parsePackageJsonOverrides,
  parseWorkspaceOverrides,
  parseWorkspaceReleaseAge,
} from "../src/manifest.ts";
import { DEFAULT_RELEASE_AGE_SETTINGS } from "../src/release-age.ts";

describe("parsePackageJsonOverrides", () => {
  it("preserves every selected entry and its source regardless of container field order", () => {
    const sources = [
      "package.json:overrides",
      "package.json:pnpm.overrides",
      "package.json:aube.overrides",
      "package.json:resolutions",
    ] as const;
    const entries = sources.flatMap((source, index) =>
      ["foo", "@scope/pkg"].map((key, minor) => ({
        key,
        spec: `>=${index + 1}.${minor}.0`,
        source,
      })),
    );
    for (let mask = 0; mask < 2 ** entries.length; mask++) {
      const expected = entries.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const mapping = (source: (typeof sources)[number]) =>
        Object.fromEntries(
          expected
            .filter((entry) => entry.source === source)
            .map(({ key, spec }) => [key, spec] as const),
        );
      const fields = [
        ["overrides", mapping("package.json:overrides")],
        ["pnpm", { overrides: mapping("package.json:pnpm.overrides") }],
        ["aube", { overrides: mapping("package.json:aube.overrides") }],
        ["resolutions", mapping("package.json:resolutions")],
        ["dependencies", { foo: "^9.0.0", "@scope/pkg": "^9.0.0" }],
        ["name", "demo"],
      ] as const;
      for (const ordered of [fields, [...fields].reverse()]) {
        const content = JSON.stringify(Object.fromEntries(ordered));
        expect(parsePackageJsonOverrides(content)).toEqual(expected);
      }
    }
  });

  it("returns empty array when pnpm field is absent", () => {
    expect(parsePackageJsonOverrides('{"name":"x"}')).toEqual([]);
  });

  it("returns empty array when pnpm field is not a mapping", () => {
    expect(parsePackageJsonOverrides('{"pnpm":"oops"}')).toEqual([]);
  });

  it("returns empty array when pnpm.overrides is absent", () => {
    expect(parsePackageJsonOverrides('{"pnpm":{}}')).toEqual([]);
  });

  it("returns empty array when pnpm.overrides is not a mapping", () => {
    expect(parsePackageJsonOverrides('{"pnpm":{"overrides":"oops"}}')).toEqual(
      [],
    );
  });

  it("ignores entries whose value is not a string", () => {
    const content = JSON.stringify({
      pnpm: {
        overrides: {
          good: ">=1.0.0",
          weird: { nested: true },
          alsoWeird: 42,
        },
      },
    });
    expect(parsePackageJsonOverrides(content)).toEqual([
      { key: "good", spec: ">=1.0.0", source: "package.json:pnpm.overrides" },
    ]);
  });

  it("flattens npm-style nested object overrides into parent>child keys", () => {
    const content = JSON.stringify({
      overrides: {
        foo: {
          bar: ">=1.0.0",
          baz: { qux: ">=2.0.0" },
        },
      },
    });
    expect(parsePackageJsonOverrides(content)).toEqual([
      { key: "foo>bar", spec: ">=1.0.0", source: "package.json:overrides" },
      {
        key: "foo>baz>qux",
        spec: ">=2.0.0",
        source: "package.json:overrides",
      },
    ]);
  });

  it("returns empty array when root is not an object", () => {
    expect(parsePackageJsonOverrides("[1,2,3]")).toEqual([]);
  });

  it("throws MalformedManifestError on invalid JSON", () => {
    expect(() => parsePackageJsonOverrides("{invalid")).toThrow(
      MalformedManifestError,
    );
  });

  it("returns empty array when top-level overrides is not a mapping", () => {
    expect(parsePackageJsonOverrides('{"overrides":"oops"}')).toEqual([]);
  });

  it("returns empty array when aube field or resolutions is not a mapping", () => {
    expect(parsePackageJsonOverrides('{"aube":"oops"}')).toEqual([]);
    expect(parsePackageJsonOverrides('{"aube":{"overrides":[]}}')).toEqual([]);
    expect(parsePackageJsonOverrides('{"resolutions":"oops"}')).toEqual([]);
  });
});

describe("parseWorkspaceOverrides", () => {
  it("preserves selected overrides and their workspace source across document layouts", () => {
    const entries = [
      ["foo", ">=1.2.3"],
      ["@scope/pkg", "catalog:shared"],
      ["parent@^1>child", ">=2.0.0"],
      ["empty", ""],
    ] as const;
    for (let mask = 0; mask < 2 ** entries.length; mask++) {
      const selected = entries.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const fields = [
        ["packages", ["apps/*"]],
        ["overrides", Object.fromEntries(selected)],
        ["catalog", { "catalog-only": "^99.0.0" }],
        ["custom", { overrides: { "custom-only": ">=99.0.0" } }],
      ] as const;
      for (const source of [
        "pnpm-workspace.yaml",
        "aube-workspace.yaml",
      ] as const) {
        const expected = selected.map(([key, spec]) => ({ key, spec, source }));
        for (const ordered of [fields, fields.toReversed()]) {
          const document = Object.fromEntries(ordered);
          for (const content of [
            stringify(document),
            JSON.stringify(document),
          ]) {
            expect(parseWorkspaceOverrides(content, source)).toEqual(expected);
          }
        }
      }
    }
  });

  it("returns empty array when overrides field is absent", () => {
    expect(
      parseWorkspaceOverrides(
        "minimumReleaseAge: 1440\n",
        "pnpm-workspace.yaml",
      ),
    ).toEqual([]);
  });

  it("returns empty array when overrides field is not a mapping", () => {
    expect(
      parseWorkspaceOverrides("overrides: oops\n", "pnpm-workspace.yaml"),
    ).toEqual([]);
  });

  it("ignores entries whose value is not a string", () => {
    const content = `overrides:
  good: '>=1.0.0'
  weird:
    nested: true
`;
    expect(parseWorkspaceOverrides(content, "pnpm-workspace.yaml")).toEqual([
      {
        key: "good",
        spec: ">=1.0.0",
        source: "pnpm-workspace.yaml",
      },
    ]);
  });

  it("returns empty array when root is not a mapping", () => {
    expect(
      parseWorkspaceOverrides("- a\n- b\n", "pnpm-workspace.yaml"),
    ).toEqual([]);
  });

  it("returns empty array on empty content", () => {
    expect(parseWorkspaceOverrides("", "pnpm-workspace.yaml")).toEqual([]);
  });

  it("throws MalformedManifestError on invalid YAML", () => {
    expect(() =>
      parseWorkspaceOverrides(": : :\n  bad:\n indent", "pnpm-workspace.yaml"),
    ).toThrow(MalformedManifestError);
  });
});

describe("buildWorkspaceDirectDeps", () => {
  it("preserves every selected dependency with its importer and dependency type", () => {
    const paths = [".", "packages/a"];
    const fields = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;
    const edges = [
      ...paths.flatMap((importerKey, importerIndex) =>
        fields.map((depType, fieldIndex) => ({
          importerKey,
          depType,
          name: (importerIndex + fieldIndex) % 2 === 0 ? "foo" : "@scope/pkg",
          spec: `^${importerIndex + 1}.${fieldIndex}.0`,
        })),
      ),
      {
        importerKey: ".",
        depType: "dependencies" as const,
        name: "@scope/pkg",
        spec: "~3.0.0",
      },
    ];
    for (let mask = 0; mask < 2 ** edges.length; mask++) {
      const selected = edges.filter((_, index) => (mask & (1 << index)) !== 0);
      for (const reversed of [false, true]) {
        const manifests = paths.map((importerKey) => {
          const groups = fields.map(
            (depType) =>
              [
                depType,
                Object.fromEntries(
                  selected
                    .filter(
                      (edge) =>
                        edge.importerKey === importerKey &&
                        edge.depType === depType,
                    )
                    .map(({ name, spec }) => [name, spec] as const),
                ),
              ] as const,
          );
          return [
            importerKey,
            JSON.stringify({
              name: "workspace-fixture",
              overrides: { "override-only": ">=99.0.0" },
              ...Object.fromEntries(reversed ? groups.toReversed() : groups),
            }),
          ] as const;
        });
        const result = buildWorkspaceDirectDeps(
          new Map(reversed ? manifests.toReversed() : manifests),
        );
        const names = [...new Set(selected.map(({ name }) => name))];
        expect([...result.keys()].sort()).toEqual(names.sort());
        for (const name of names) {
          const expected = selected
            .filter((edge) => edge.name === name)
            .map(({ importerKey, depType, spec }) => ({
              importerKey,
              depType,
              spec,
            }));
          // Grouping order is immaterial; every constraint must survive exactly once.
          expect(result.get(name)).toHaveLength(expected.length);
          expect(result.get(name)).toEqual(expect.arrayContaining(expected));
        }
      }
    }
  });

  it("ignores non-string spec values", () => {
    const content = JSON.stringify({
      dependencies: { good: "1.0.0", bad: 42 },
    });
    const result = buildWorkspaceDirectDeps(new Map([[".", content]]));
    expect(result.get("good")).toBeDefined();
    expect(result.get("bad")).toBeUndefined();
  });

  it("ignores importers whose root is not an object", () => {
    const result = buildWorkspaceDirectDeps(new Map([[".", "[]"]]));
    expect(result.size).toBe(0);
  });

  it("throws MalformedManifestError on invalid JSON", () => {
    expect(() =>
      buildWorkspaceDirectDeps(new Map([[".", "{not json"]])),
    ).toThrow(MalformedManifestError);
  });
});

describe("parseWorkspaceReleaseAge", () => {
  it("falls back to pnpm's default when the workspace file sets nothing", () => {
    expect(parseWorkspaceReleaseAge("packages:\n  - apps/*\n")).toEqual(
      DEFAULT_RELEASE_AGE_SETTINGS,
    );
    expect(parseWorkspaceReleaseAge("")).toEqual(DEFAULT_RELEASE_AGE_SETTINGS);
  });

  it("reads the minimum and an exclude list", () => {
    const yaml = [
      "minimumReleaseAge: 60",
      "minimumReleaseAgeExclude:",
      "  - webpack",
      "  - '@myorg/*'",
      "  - 7",
    ].join("\n");
    expect(parseWorkspaceReleaseAge(yaml)).toEqual({
      minimumReleaseAge: 60,
      minimumReleaseAgeExclude: ["webpack", "@myorg/*"],
    });
  });

  it("accepts a single scalar as the exclude list", () => {
    expect(
      parseWorkspaceReleaseAge("minimumReleaseAgeExclude: webpack\n"),
    ).toEqual({
      minimumReleaseAge: 1440,
      minimumReleaseAgeExclude: ["webpack"],
    });
  });

  it("keeps the default when the minimum is not a number", () => {
    expect(
      parseWorkspaceReleaseAge("minimumReleaseAge: soon\n").minimumReleaseAge,
    ).toBe(1440);
  });

  it("rejects unparseable yaml", () => {
    expect(() => parseWorkspaceReleaseAge("overrides: [\n")).toThrow(
      MalformedManifestError,
    );
  });
});
