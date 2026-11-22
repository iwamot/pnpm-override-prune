import { describe, expect, it } from "bun:test";
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
  it("collects entries from workspace overrides field", () => {
    const content = `overrides:
  '@xmldom/xmldom': '>=0.9.10'
  postcss: '>=8.5.10'
`;
    expect(parseWorkspaceOverrides(content, "pnpm-workspace.yaml")).toEqual([
      {
        key: "@xmldom/xmldom",
        spec: ">=0.9.10",
        source: "pnpm-workspace.yaml",
      },
      {
        key: "postcss",
        spec: ">=8.5.10",
        source: "pnpm-workspace.yaml",
      },
    ]);
  });

  it("records aube-workspace.yaml as the source when given", () => {
    const content = `overrides:
  foo: '>=1.0.0'
`;
    expect(parseWorkspaceOverrides(content, "aube-workspace.yaml")).toEqual([
      { key: "foo", spec: ">=1.0.0", source: "aube-workspace.yaml" },
    ]);
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
  it("collects direct deps across all importer fields, indexed by name", () => {
    const root = JSON.stringify({
      dependencies: { foo: "^1.0.0" },
      devDependencies: { bar: "2.0.0" },
      peerDependencies: { baz: ">=3.0.0" },
      optionalDependencies: { qux: "^4.0.0" },
    });
    const result = buildWorkspaceDirectDeps(new Map([[".", root]]));
    expect(result.get("foo")).toEqual([
      { importerKey: ".", depType: "dependencies", spec: "^1.0.0" },
    ]);
    expect(result.get("bar")).toEqual([
      { importerKey: ".", depType: "devDependencies", spec: "2.0.0" },
    ]);
    expect(result.get("baz")).toEqual([
      { importerKey: ".", depType: "peerDependencies", spec: ">=3.0.0" },
    ]);
    expect(result.get("qux")).toEqual([
      { importerKey: ".", depType: "optionalDependencies", spec: "^4.0.0" },
    ]);
  });

  it("merges entries from multiple importers under the same target name", () => {
    const a = JSON.stringify({ dependencies: { foo: "1.0.0" } });
    const b = JSON.stringify({ devDependencies: { foo: "2.0.0" } });
    const result = buildWorkspaceDirectDeps(
      new Map([
        ["packages/a", a],
        ["packages/b", b],
      ]),
    );
    expect(result.get("foo")).toEqual([
      { importerKey: "packages/a", depType: "dependencies", spec: "1.0.0" },
      { importerKey: "packages/b", depType: "devDependencies", spec: "2.0.0" },
    ]);
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
