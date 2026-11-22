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
      const mapping = (source: (typeof sources)[number]) => ({
        invalidNumber: 42,
        invalidObject: { nested: true },
        ...Object.fromEntries(
          expected
            .filter((entry) => entry.source === source)
            .map(({ key, spec }) => [key, spec] as const),
        ),
      });
      const fields = [
        ["overrides", mapping("package.json:overrides")],
        ["pnpm", { overrides: mapping("package.json:pnpm.overrides") }],
        ["aube", { overrides: mapping("package.json:aube.overrides") }],
        ["resolutions", mapping("package.json:resolutions")],
        ["dependencies", { foo: "^9.0.0", "@scope/pkg": "^9.0.0" }],
        ["name", "demo"],
      ] as const;
      for (const ordered of [fields, [...fields].reverse()]) {
        for (const [source, field] of [
          [null, null],
          ["package.json:overrides", "overrides"],
          ["package.json:pnpm.overrides", "pnpm"],
          ["package.json:aube.overrides", "aube"],
          ["package.json:resolutions", "resolutions"],
        ] as const) {
          const document = Object.fromEntries(ordered);
          if (field !== null) {
            document[field] = "not-a-map";
          }
          expect(parsePackageJsonOverrides(JSON.stringify(document))).toEqual(
            expected.filter((entry) => entry.source !== source),
          );
        }
      }
    }
  });

  it("ignores unavailable containers and non-object roots across all override sources", () => {
    const nonMappings = [null, [], ["array-entry"], 42, "oops", true];
    for (const root of nonMappings) {
      expect(parsePackageJsonOverrides(JSON.stringify(root))).toEqual([]);
    }
    for (const value of [undefined, ...nonMappings]) {
      for (const document of [
        { overrides: value },
        { pnpm: value },
        { pnpm: { overrides: value } },
        { aube: value },
        { aube: { overrides: value } },
        { resolutions: value },
      ]) {
        expect(parsePackageJsonOverrides(JSON.stringify(document))).toEqual([]);
      }
    }
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

  it("throws MalformedManifestError on invalid JSON", () => {
    expect(() => parsePackageJsonOverrides("{invalid")).toThrow(
      MalformedManifestError,
    );
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
        [
          "overrides",
          {
            invalidNumber: 42,
            invalidObject: { nested: true },
            ...Object.fromEntries(selected),
          },
        ],
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

  it("ignores absent or non-mapping overrides and non-mapping documents in either workspace", () => {
    const nonMappings = [null, [], ["array-entry"], 42, "oops", true];
    const documents = [
      ...nonMappings,
      ...[undefined, ...nonMappings].map((overrides) => ({ overrides })),
    ];
    for (const source of [
      "pnpm-workspace.yaml",
      "aube-workspace.yaml",
    ] as const) {
      expect(parseWorkspaceOverrides("", source)).toEqual([]);
      for (const document of documents) {
        for (const content of [stringify(document), JSON.stringify(document)]) {
          expect(parseWorkspaceOverrides(content, source)).toEqual([]);
        }
      }
    }
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
                selected.some(
                  (edge) =>
                    edge.importerKey === importerKey &&
                    edge.depType === depType,
                )
                  ? {
                      invalidNumber: 42,
                      invalidObject: { nested: true },
                      ...Object.fromEntries(
                        selected
                          .filter(
                            (edge) =>
                              edge.importerKey === importerKey &&
                              edge.depType === depType,
                          )
                          .map(({ name, spec }) => [name, spec] as const),
                      ),
                    }
                  : "not-a-map",
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
  it("preserves independent release-age settings across combinations and document layouts", () => {
    const ages = [
      [[], 1440],
      [[["minimumReleaseAge", 0]], 0],
      [[["minimumReleaseAge", 60]], 60],
      [[["minimumReleaseAge", 2880]], 2880],
      [[["minimumReleaseAge", "soon"]], 1440],
    ] as const;
    const exclusions = [
      [[], []],
      [[["minimumReleaseAgeExclude", "webpack"]], ["webpack"]],
      [[["minimumReleaseAgeExclude", ""]], [""]],
      [[["minimumReleaseAgeExclude", []]], []],
      [
        [["minimumReleaseAgeExclude", ["webpack", "@myorg/*", 7, "webpack"]]],
        ["webpack", "@myorg/*", "webpack"],
      ],
    ] as const;
    expect(parseWorkspaceReleaseAge("")).toEqual(DEFAULT_RELEASE_AGE_SETTINGS);
    for (const [ageFields, minimumReleaseAge] of ages) {
      for (const [excludeFields, minimumReleaseAgeExclude] of exclusions) {
        const fields = [
          ...ageFields,
          ...excludeFields,
          ["packages", ["apps/*"]],
          [
            "custom",
            { minimumReleaseAge: 9999, minimumReleaseAgeExclude: ["decoy"] },
          ],
        ] as const;
        const expected = { minimumReleaseAge, minimumReleaseAgeExclude };
        for (const ordered of [fields, fields.toReversed()]) {
          const document = Object.fromEntries(ordered);
          for (const content of [
            stringify(document),
            JSON.stringify(document),
          ]) {
            expect(parseWorkspaceReleaseAge(content)).toEqual(expected);
          }
        }
      }
    }
  });

  it("rejects unparseable yaml", () => {
    expect(() => parseWorkspaceReleaseAge("overrides: [\n")).toThrow(
      MalformedManifestError,
    );
  });
});
