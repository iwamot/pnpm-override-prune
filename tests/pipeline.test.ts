import { describe, expect, it } from "bun:test";
import type { Lockfile } from "../src/lockfile.ts";
import type {
  DirectDep,
  Override,
  WorkspaceDirectDeps,
} from "../src/manifest.ts";
import {
  collectNeededRegistryPackages,
  collectPackagesForOverride,
  evaluateOverride,
  gatherSpecsForTarget,
} from "../src/pipeline.ts";
import type { PackageMetadata } from "../src/registry.ts";

function makeLockfile(args: {
  transitive?: Record<string, Array<{ parent: string; resolved: string }>>;
}): Lockfile {
  const transMap = new Map<
    string,
    { parentKey: string; resolvedVersion: string }[]
  >();
  for (const [target, parents] of Object.entries(args.transitive ?? {})) {
    transMap.set(
      target,
      parents.map((p) => ({
        parentKey: p.parent,
        resolvedVersion: p.resolved,
      })),
    );
  }
  return {
    version: "9.0",
    importerPaths: ["."],
    transitiveParents: transMap,
  };
}

function makeWorkspaceDirectDeps(
  args: Record<string, string>,
): WorkspaceDirectDeps {
  const map = new Map<string, DirectDep[]>();
  for (const [name, spec] of Object.entries(args)) {
    map.set(name, [{ importerKey: ".", depType: "dependencies", spec }]);
  }
  return map;
}

const NO_DIRECT: WorkspaceDirectDeps = new Map();

function makeMetadata(
  name: string,
  versions: Record<string, Record<string, string>>,
): PackageMetadata {
  const map = new Map<
    string,
    { version: string; dependencies: ReadonlyMap<string, string> }
  >();
  for (const [version, deps] of Object.entries(versions)) {
    map.set(version, {
      version,
      dependencies: new Map(Object.entries(deps)),
    });
  }
  return { name, versions: map };
}

const PKG_OVERRIDE = (key: string, spec: string): Override => ({
  key,
  spec,
  source: "package.json:pnpm.overrides",
});

describe("gatherSpecsForTarget", () => {
  it("collects specs from workspace direct deps", () => {
    const lockfile = makeLockfile({});
    const direct = makeWorkspaceDirectDeps({ foo: "^1.0.0" });
    expect(gatherSpecsForTarget("foo", lockfile, direct, new Map())).toEqual({
      specs: ["^1.0.0"],
      protocolSpecs: [],
    });
  });

  it("sets aside workspace direct deps with protocol-prefixed specs", () => {
    const lockfile = makeLockfile({});
    const direct = makeWorkspaceDirectDeps({ foo: "workspace:*" });
    expect(gatherSpecsForTarget("foo", lockfile, direct, new Map())).toEqual({
      specs: [],
      protocolSpecs: ["workspace:*"],
    });
  });

  it("collects specs from transitive parents via registry data", () => {
    const lockfile = makeLockfile({
      transitive: {
        target: [
          { parent: "parentA@1.0.0", resolved: "1.0.0" },
          { parent: "parentB@2.0.0", resolved: "1.0.0" },
        ],
      },
    });
    const registry = new Map<string, PackageMetadata>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { target: ">=1.0.0" } })],
      ["parentB", makeMetadata("parentB", { "2.0.0": { target: "<2.0.0" } })],
    ]);
    expect(
      gatherSpecsForTarget("target", lockfile, NO_DIRECT, registry),
    ).toEqual({ specs: [">=1.0.0", "<2.0.0"], protocolSpecs: [] });
  });

  it("combines direct and transitive specs", () => {
    const lockfile = makeLockfile({
      transitive: {
        target: [{ parent: "parentA@1.0.0", resolved: "1.5.0" }],
      },
    });
    const direct = makeWorkspaceDirectDeps({ target: "^1.0.0" });
    const registry = new Map<string, PackageMetadata>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { target: ">=1.2.0" } })],
    ]);
    expect(gatherSpecsForTarget("target", lockfile, direct, registry)).toEqual({
      specs: ["^1.0.0", ">=1.2.0"],
      protocolSpecs: [],
    });
  });

  it("skips parents whose snapshot key cannot be parsed", () => {
    const lockfile = makeLockfile({
      transitive: {
        target: [{ parent: "no-at-sign", resolved: "1.0.0" }],
      },
    });
    expect(
      gatherSpecsForTarget("target", lockfile, NO_DIRECT, new Map()),
    ).toEqual({ specs: [], protocolSpecs: [] });
  });

  it("skips parents whose registry metadata is missing", () => {
    const lockfile = makeLockfile({
      transitive: {
        target: [{ parent: "parentA@1.0.0", resolved: "1.0.0" }],
      },
    });
    expect(
      gatherSpecsForTarget("target", lockfile, NO_DIRECT, new Map()),
    ).toEqual({ specs: [], protocolSpecs: [] });
  });

  it("skips parents whose version meta is missing", () => {
    const lockfile = makeLockfile({
      transitive: {
        target: [{ parent: "parentA@9.9.9", resolved: "1.0.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { target: ">=1.0.0" } })],
    ]);
    expect(
      gatherSpecsForTarget("target", lockfile, NO_DIRECT, registry),
    ).toEqual({ specs: [], protocolSpecs: [] });
  });

  it("skips parents that don't list the target in their dependencies", () => {
    const lockfile = makeLockfile({
      transitive: {
        target: [{ parent: "parentA@1.0.0", resolved: "1.0.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { other: ">=1.0.0" } })],
    ]);
    expect(
      gatherSpecsForTarget("target", lockfile, NO_DIRECT, registry),
    ).toEqual({ specs: [], protocolSpecs: [] });
  });

  it("returns nothing when target is not present anywhere", () => {
    expect(
      gatherSpecsForTarget("missing", makeLockfile({}), NO_DIRECT, new Map()),
    ).toEqual({ specs: [], protocolSpecs: [] });
  });

  it("drops parents whose fetch failed", () => {
    const lockfile = makeLockfile({
      transitive: {
        target: [{ parent: "parentA@1.0.0", resolved: "1.0.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata | null>([
      ["parentA", null],
    ]);
    expect(
      gatherSpecsForTarget("target", lockfile, NO_DIRECT, registry),
    ).toEqual({ specs: [], protocolSpecs: [] });
  });
});

describe("evaluateOverride", () => {
  it("skips entries categorized as nested-key with a reason", () => {
    const result = evaluateOverride(
      PKG_OVERRIDE("foo>bar", ">=1.0.0"),
      makeLockfile({}),
      NO_DIRECT,
      new Map(),
    );
    expect(result).toEqual({ status: "skip", value: "(nested key)" });
  });

  it("skips entries with protocol-prefixed spec", () => {
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", "catalog:default"),
      makeLockfile({}),
      NO_DIRECT,
      new Map(),
    );
    expect(result).toEqual({ status: "skip", value: "(protocol spec)" });
  });

  it("skips entries with non-lower-bound spec", () => {
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", "^1.0.0"),
      makeLockfile({}),
      NO_DIRECT,
      new Map(),
    );
    expect(result).toEqual({ status: "skip", value: "(non-lower-bound)" });
  });

  it("prunes entries with no surviving constraints (unused)", () => {
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=1.0.0"),
      makeLockfile({}),
      NO_DIRECT,
      new Map(),
    );
    expect(result).toEqual({ status: "prune", value: "(unused)" });
  });

  it("returns error, not prune, when a parent fetch failed", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "parentA@1.0.0", resolved: "1.0.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata | null>([
      ["parentA", null],
      ["foo", makeMetadata("foo", { "1.0.0": {}, "1.2.0": {} })],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=1.0.0"),
      lockfile,
      NO_DIRECT,
      registry,
    );
    expect(result).toEqual({
      status: "error",
      value: "(fetch failed: parentA)",
    });
  });

  it("returns error when the target fetch failed", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "parentA@1.0.0", resolved: "1.0.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata | null>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { foo: "^1.0.0" } })],
      ["foo", null],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=1.0.0"),
      lockfile,
      NO_DIRECT,
      registry,
    );
    expect(result).toEqual({ status: "error", value: "(fetch failed: foo)" });
  });

  it("returns error when target has no registry metadata", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "parentA@1.0.0", resolved: "1.0.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { foo: "^1.0.0" } })],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=1.0.0"),
      lockfile,
      NO_DIRECT,
      registry,
    );
    expect(result).toEqual({ status: "error", value: "(registry miss)" });
  });

  it("prunes when natural resolution satisfies the override floor", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "parentA@1.0.0", resolved: "2.5.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { foo: ">=2.0.0" } })],
      [
        "foo",
        makeMetadata("foo", {
          "1.0.0": {},
          "2.0.0": {},
          "2.5.0": {},
        }),
      ],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=2.0.0"),
      lockfile,
      NO_DIRECT,
      registry,
    );
    expect(result).toEqual({ status: "prune", value: "2.5.0" });
  });

  it("keeps when natural resolution falls below the override floor", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "parentA@1.0.0", resolved: "1.5.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { foo: "^1.0.0" } })],
      [
        "foo",
        makeMetadata("foo", {
          "1.0.0": {},
          "1.5.0": {},
          "2.0.0": {},
        }),
      ],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=2.0.0"),
      lockfile,
      NO_DIRECT,
      registry,
    );
    expect(result).toEqual({ status: "keep", value: "1.5.0" });
  });

  it("uses workspace direct dep spec to evaluate the override floor", () => {
    const lockfile = makeLockfile({});
    const direct = makeWorkspaceDirectDeps({ foo: "^2.0.0" });
    const registry = new Map<string, PackageMetadata>([
      [
        "foo",
        makeMetadata("foo", {
          "1.0.0": {},
          "2.0.0": {},
          "2.5.0": {},
        }),
      ],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=2.0.0"),
      lockfile,
      direct,
      registry,
    );
    expect(result).toEqual({ status: "prune", value: "2.5.0" });
  });

  it("keeps when workspace direct dep spec resolves below the override floor", () => {
    const lockfile = makeLockfile({});
    const direct = makeWorkspaceDirectDeps({ foo: "1.0.0" });
    const registry = new Map<string, PackageMetadata>([
      [
        "foo",
        makeMetadata("foo", {
          "1.0.0": {},
          "1.5.0": {},
          "2.0.0": {},
        }),
      ],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=2.0.0"),
      lockfile,
      direct,
      registry,
    );
    expect(result).toEqual({ status: "keep", value: "1.0.0" });
  });

  it("skips when the only direct dep spec is protocol-prefixed instead of calling it unused", () => {
    // pnpm.overrides: { lodash: ">=4.17.21" } with "lodash": "catalog:" in the
    // importer. The catalog may pin ^3.10.0, in which case the override is
    // what lifts the tree to 4.x — "(unused)" would be a destructive verdict.
    const lockfile = makeLockfile({});
    const direct = makeWorkspaceDirectDeps({ lodash: "catalog:" });
    const result = evaluateOverride(
      PKG_OVERRIDE("lodash", ">=4.17.21"),
      lockfile,
      direct,
      new Map(),
    );
    expect(result).toEqual({
      status: "skip",
      value: "(constrained by catalog: spec)",
    });
  });

  it("skips even when other specs exist, since the protocol spec's range is unknown", () => {
    const lockfile = makeLockfile({
      transitive: {
        target: [{ parent: "parentA@1.0.0", resolved: "2.0.0" }],
      },
    });
    const direct: WorkspaceDirectDeps = new Map([
      [
        "target",
        [
          {
            importerKey: "packages/a",
            depType: "dependencies",
            spec: "^2.0.0",
          },
          {
            importerKey: "packages/b",
            depType: "dependencies",
            spec: "workspace:*",
          },
          {
            importerKey: "packages/c",
            depType: "dependencies",
            spec: "catalog:",
          },
        ],
      ],
    ]);
    const registry = new Map<string, PackageMetadata>([
      ["target", makeMetadata("target", { "2.0.0": {} })],
      ["parentA", makeMetadata("parentA", { "1.0.0": { target: ">=2.0.0" } })],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("target", ">=2.0.0"),
      lockfile,
      direct,
      registry,
    );
    expect(result).toEqual({
      status: "skip",
      value: "(constrained by workspace:, catalog: spec)",
    });
  });

  it("skips versioned keys with non-semver-range selector", () => {
    const result = evaluateOverride(
      PKG_OVERRIDE("ajv@latest", ">=8.18.0"),
      makeLockfile({}),
      NO_DIRECT,
      new Map(),
    );
    expect(result).toEqual({ status: "skip", value: "(unsupported selector)" });
  });

  it("prunes versioned key when no parent spec intersects the selector", () => {
    const lockfile = makeLockfile({});
    // Workspace requests lodash ^5.0.0; selector is <4.17.21 — disjoint.
    const direct = makeWorkspaceDirectDeps({ lodash: "^5.0.0" });
    const registry = new Map<string, PackageMetadata>([
      ["lodash", makeMetadata("lodash", { "5.0.0": {} })],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("lodash@<4.17.21", ">=4.17.21"),
      lockfile,
      direct,
      registry,
    );
    expect(result).toEqual({ status: "prune", value: "(selector miss)" });
  });

  it("prunes versioned key when the natural resolution under intersecting specs satisfies the spec", () => {
    // Mirrors the pnpm/pnpm#5949 scenario: parent ^5.0.0 intersects selector
    // <5.1.2; natural resolution under that parent spec is 5.1.5, which
    // already meets the override floor >=5.1.2.
    const lockfile = makeLockfile({});
    const direct = makeWorkspaceDirectDeps({ "glob-parent": "^5.0.0" });
    const registry = new Map<string, PackageMetadata>([
      [
        "glob-parent",
        makeMetadata("glob-parent", {
          "5.0.0": {},
          "5.1.0": {},
          "5.1.2": {},
          "5.1.5": {},
        }),
      ],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("glob-parent@<5.1.2", ">=5.1.2"),
      lockfile,
      direct,
      registry,
    );
    expect(result).toEqual({ status: "prune", value: "5.1.5" });
  });

  it("keeps versioned key when intersecting parent's natural resolution falls below the spec", () => {
    // Parent pinned to 4.17.10 — only 4.17.10 satisfies. Override demands
    // >=4.17.23; natural is below, so removal would change the lockfile.
    const lockfile = makeLockfile({});
    const direct = makeWorkspaceDirectDeps({ lodash: "4.17.10" });
    const registry = new Map<string, PackageMetadata>([
      [
        "lodash",
        makeMetadata("lodash", {
          "4.17.10": {},
          "4.17.23": {},
        }),
      ],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("lodash@>=4.0.0 <=4.17.22", ">=4.17.23"),
      lockfile,
      direct,
      registry,
    );
    expect(result).toEqual({ status: "keep", value: "4.17.10" });
  });

  it("treats parent specs that fail intersects() as non-matching (prunes when only such specs remain)", () => {
    // Registry returns a non-semver parent dep spec (e.g., a git url).
    // intersects() throws on it; we catch and skip the parent. With no
    // intersecting parents the override is inert -> selector miss.
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "parentA@1.0.0", resolved: "1.0.0" }],
      },
    });
    const registry = new Map<string, PackageMetadata>([
      [
        "parentA",
        makeMetadata("parentA", {
          "1.0.0": { foo: "git+https://example.com/foo.git" },
        }),
      ],
      ["foo", makeMetadata("foo", { "1.0.0": {} })],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo@<2.0.0", ">=1.5.0"),
      lockfile,
      NO_DIRECT,
      registry,
    );
    expect(result).toEqual({ status: "prune", value: "(selector miss)" });
  });

  it("evaluates the lodash 6-entry audit-fix pattern against a single dependency tree", () => {
    // Models the user-flagged scenario where pnpm audit --fix has accreted
    // multiple overrides for the same package. Workspace requests ^4.0.0;
    // registry's latest in 4.x is 4.17.21. We expect each entry to fall out
    // independently per the per-entry rule.
    const lockfile = makeLockfile({});
    const direct = makeWorkspaceDirectDeps({ lodash: "^4.0.0" });
    const registry = new Map<string, PackageMetadata>([
      [
        "lodash",
        makeMetadata("lodash", {
          "3.10.1": {},
          "4.0.0": {},
          "4.17.10": {},
          "4.17.19": {},
          "4.17.21": {},
        }),
      ],
    ]);
    const evaluate = (key: string, spec: string) =>
      evaluateOverride(PKG_OVERRIDE(key, spec), lockfile, direct, registry);
    // V = max(^4.0.0) = 4.17.21
    // Selector <4.17.21: V doesn't satisfy -> override doesn't intersect for parent? Actually
    // ^4.0.0 (>=4.0.0 <5.0.0) DOES intersect <4.17.21, so per-parent natural is 4.17.21 itself.
    // 4.17.21 satisfies >=4.17.21 -> PRUNE.
    expect(evaluate("lodash@<4.17.21", ">=4.17.21")).toEqual({
      status: "prune",
      value: "4.17.21",
    });
    // Selector >=3.7.0 <4.17.19 intersects ^4.0.0 (>=4.0.0 <4.17.19 region).
    // Natural under intersecting parent is still max(^4.0.0) = 4.17.21,
    // which satisfies >=4.17.19 -> PRUNE.
    expect(evaluate("lodash@>=3.7.0 <4.17.19", ">=4.17.19")).toEqual({
      status: "prune",
      value: "4.17.21",
    });
    // Selector >=4.0.0 <4.17.21 intersects ^4.0.0; natural 4.17.21
    // satisfies >=4.17.21 -> PRUNE.
    expect(evaluate("lodash@>=4.0.0 <4.17.21", ">=4.17.21")).toEqual({
      status: "prune",
      value: "4.17.21",
    });
    // Selector >=4.0.0 <=4.17.22 intersects ^4.0.0; natural 4.17.21
    // does NOT satisfy >=4.17.23 -> KEEP.
    expect(evaluate("lodash@>=4.0.0 <=4.17.22", ">=4.17.23")).toEqual({
      status: "keep",
      value: "4.17.21",
    });
    // Selector >=4.0.0 <=4.17.23 intersects ^4.0.0; natural 4.17.21
    // does NOT satisfy >=4.18.0 -> KEEP.
    expect(evaluate("lodash@>=4.0.0 <=4.17.23", ">=4.18.0")).toEqual({
      status: "keep",
      value: "4.17.21",
    });
    // Selector <=4.17.23 intersects ^4.0.0; natural 4.17.21 doesn't satisfy
    // >=4.18.0 -> KEEP.
    expect(evaluate("lodash@<=4.17.23", ">=4.18.0")).toEqual({
      status: "keep",
      value: "4.17.21",
    });
  });

  it("keeps when conflicting specs would force a per-importer downgrade", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "parentA@1.0.0", resolved: "1.5.0" }],
      },
    });
    const direct = makeWorkspaceDirectDeps({ foo: "1.0.0" });
    const registry = new Map<string, PackageMetadata>([
      ["parentA", makeMetadata("parentA", { "1.0.0": { foo: "^1.5.0" } })],
      [
        "foo",
        makeMetadata("foo", {
          "1.0.0": {},
          "1.5.0": {},
          "2.0.0": {},
        }),
      ],
    ]);
    const result = evaluateOverride(
      PKG_OVERRIDE("foo", ">=2.0.0"),
      lockfile,
      direct,
      registry,
    );
    expect(result).toEqual({ status: "keep", value: "1.0.0" });
  });
});

describe("collectPackagesForOverride", () => {
  it("returns an empty list for skip-categorized overrides", () => {
    expect(
      collectPackagesForOverride(
        PKG_OVERRIDE("foo", "^1.0.0"),
        makeLockfile({}),
      ),
    ).toEqual([]);
  });

  it("returns just the target when there are no transitive parents", () => {
    expect(
      collectPackagesForOverride(
        PKG_OVERRIDE("foo", ">=1.0.0"),
        makeLockfile({}),
      ),
    ).toEqual(["foo"]);
  });

  it("includes parent names parsed from snapshot keys", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [
          { parent: "parentA@1.0.0", resolved: "1.0.0" },
          { parent: "parentB@2.0.0", resolved: "1.0.0" },
        ],
      },
    });
    expect(
      new Set(
        collectPackagesForOverride(PKG_OVERRIDE("foo", ">=1.0.0"), lockfile),
      ),
    ).toEqual(new Set(["foo", "parentA", "parentB"]));
  });

  it("ignores parents whose snapshot key cannot be parsed", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "broken-no-at", resolved: "1.0.0" }],
      },
    });
    expect(
      collectPackagesForOverride(PKG_OVERRIDE("foo", ">=1.0.0"), lockfile),
    ).toEqual(["foo"]);
  });
});

describe("collectNeededRegistryPackages", () => {
  it("includes target and parent names for each target override", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [
          { parent: "parentA@1.0.0", resolved: "1.0.0" },
          { parent: "parentB@2.0.0", resolved: "1.0.0" },
        ],
      },
    });
    const overrides: Override[] = [PKG_OVERRIDE("foo", ">=1.0.0")];
    const needed = collectNeededRegistryPackages(overrides, lockfile);
    expect(new Set(needed)).toEqual(new Set(["foo", "parentA", "parentB"]));
  });

  it("skips overrides categorized as skip", () => {
    const overrides: Override[] = [
      PKG_OVERRIDE("foo>bar", ">=1.0.0"),
      PKG_OVERRIDE("baz", "^1.0.0"),
    ];
    expect(collectNeededRegistryPackages(overrides, makeLockfile({}))).toEqual(
      [],
    );
  });

  it("dedupes when the same parent appears across overrides", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "parentA@1.0.0", resolved: "1.0.0" }],
        bar: [{ parent: "parentA@1.0.0", resolved: "2.0.0" }],
      },
    });
    const overrides: Override[] = [
      PKG_OVERRIDE("foo", ">=1.0.0"),
      PKG_OVERRIDE("bar", ">=2.0.0"),
    ];
    const needed = collectNeededRegistryPackages(overrides, lockfile);
    expect(new Set(needed)).toEqual(new Set(["foo", "bar", "parentA"]));
  });

  it("skips parents whose snapshot keys can't be parsed", () => {
    const lockfile = makeLockfile({
      transitive: {
        foo: [{ parent: "broken-no-at", resolved: "1.0.0" }],
      },
    });
    const overrides: Override[] = [PKG_OVERRIDE("foo", ">=1.0.0")];
    expect(new Set(collectNeededRegistryPackages(overrides, lockfile))).toEqual(
      new Set(["foo"]),
    );
  });

  it("handles target without transitive parents", () => {
    const overrides: Override[] = [PKG_OVERRIDE("foo", ">=1.0.0")];
    expect(collectNeededRegistryPackages(overrides, makeLockfile({}))).toEqual([
      "foo",
    ]);
  });
});
