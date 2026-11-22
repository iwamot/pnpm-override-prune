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
  targetOf,
} from "../src/pipeline.ts";
import type { PackageMetadata, PackageVersionMeta } from "../src/registry.ts";
import { createReleasePolicy } from "../src/release-age.ts";

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
  publishedAt: Record<string, string> | null = null,
): PackageMetadata {
  const map = new Map<string, PackageVersionMeta>();
  for (const [version, deps] of Object.entries(versions)) {
    map.set(version, {
      version,
      dependencies: new Map(Object.entries(deps)),
      deprecated: false,
    });
  }
  return {
    name,
    versions: map,
    latest: null,
    modified: null,
    publishedAt:
      publishedAt === null
        ? null
        : new Map(
            Object.entries(publishedAt).map(([v, t]) => [v, new Date(t)]),
          ),
  };
}

const PKG_OVERRIDE = (key: string, spec: string): Override => ({
  key,
  spec,
  source: "package.json:pnpm.overrides",
});

describe("gatherSpecsForTarget", () => {
  it("collects each target's direct and transitive constraints while separating direct protocols", () => {
    const directCases = [
      { spec: "^1.0.0", protocol: false },
      { spec: "workspace:*", protocol: true },
      { spec: "catalog:", protocol: true },
    ];
    const parentCases = [
      { name: "@scope/parent", version: "1.0.0", spec: "^1.0.0" },
      { name: "parentB", version: "2.0.0", spec: "<3.0.0" },
    ];
    for (const target of ["foo", "@scope/target"]) {
      for (const decoration of ["", "(peer@4.0.0)"]) {
        const registry = new Map(
          parentCases.map(
            ({ name, version, spec }) =>
              [
                name,
                makeMetadata(name, {
                  [version]: { [target]: spec, unrelated: "^9.0.0" },
                }),
              ] as const,
          ),
        );
        for (
          let directMask = 0;
          directMask < 2 ** directCases.length;
          directMask++
        ) {
          const selectedDirect = directCases.filter(
            (_, index) => (directMask & (1 << index)) !== 0,
          );
          const direct = new Map<string, DirectDep[]>([
            [
              target,
              selectedDirect.map(({ spec }, index) => ({
                importerKey: `packages/${index}`,
                depType: "dependencies",
                spec,
              })),
            ],
          ]);
          for (
            let parentMask = 0;
            parentMask < 2 ** parentCases.length;
            parentMask++
          ) {
            const selectedParents = parentCases.filter(
              (_, index) => (parentMask & (1 << index)) !== 0,
            );
            const lockfile = makeLockfile({
              transitive: {
                [target]: selectedParents.map(({ name, version }) => ({
                  parent: `${name}@${version}${decoration}`,
                  resolved: "5.0.0",
                })),
              },
            });
            const actual = gatherSpecsForTarget(
              target,
              lockfile,
              direct,
              registry,
            );
            expect(new Set(actual.specs)).toEqual(
              new Set([
                ...selectedDirect
                  .filter(({ protocol }) => !protocol)
                  .map(({ spec }) => spec),
                ...selectedParents.map(({ spec }) => spec),
              ]),
            );
            expect(new Set(actual.protocolSpecs)).toEqual(
              new Set(
                selectedDirect
                  .filter(({ protocol }) => protocol)
                  .map(({ spec }) => spec),
              ),
            );
            expect(
              gatherSpecsForTarget("absent", lockfile, direct, registry),
            ).toEqual({ specs: [], protocolSpecs: [] });
          }
        }
      }
    }
  });

  it("ignores unavailable parent constraints without losing usable direct or parent constraints", () => {
    const unusable = [
      "broken",
      "missing@1.0.0",
      "failed@1.0.0",
      "wrong-version@9.9.9",
      "not-depending@1.0.0",
    ];
    const registry = new Map<string, PackageMetadata | null>([
      ["valid", makeMetadata("valid", { "1.0.0": { target: "^2.0.0" } })],
      ["broken", makeMetadata("broken", { "1.0.0": { target: ">=99.0.0" } })],
      ["failed", null],
      [
        "wrong-version",
        makeMetadata("wrong-version", { "1.0.0": { target: ">=99.0.0" } }),
      ],
      [
        "not-depending",
        makeMetadata("not-depending", { "1.0.0": { other: ">=99.0.0" } }),
      ],
    ]);
    for (let mask = 0; mask < 2 ** unusable.length; mask++) {
      const selected = unusable.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      for (const withUsable of [false, true]) {
        const parents = withUsable ? [...selected, "valid@1.0.0"] : selected;
        const direct: WorkspaceDirectDeps = withUsable
          ? new Map([
              [
                "target",
                [
                  { importerKey: ".", depType: "dependencies", spec: "^3.0.0" },
                  {
                    importerKey: "packages/a",
                    depType: "dependencies",
                    spec: "workspace:*",
                  },
                ],
              ],
            ])
          : NO_DIRECT;
        for (const ordered of [parents, parents.toReversed()]) {
          const lockfile = makeLockfile({
            transitive: {
              target: ordered.map((parent) => ({ parent, resolved: "1.0.0" })),
            },
          });
          const actual = gatherSpecsForTarget(
            "target",
            lockfile,
            direct,
            registry,
          );
          expect(new Set(actual.specs)).toEqual(
            new Set(withUsable ? ["^3.0.0", "^2.0.0"] : []),
          );
          expect(new Set(actual.protocolSpecs)).toEqual(
            new Set(withUsable ? ["workspace:*"] : []),
          );
        }
      }
    }
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

  it("reports every relevant fetch failure before issuing a verdict and ignores unrelated failures", () => {
    const parents = ["parentA", "@scope/parentB"];
    const contexts = [
      [null, NO_DIRECT, { status: "prune", value: "(unused)" }],
      ["^1.0.0", NO_DIRECT, { status: "prune", value: "1.2.0" }],
      [
        "^1.0.0",
        makeWorkspaceDirectDeps({ foo: "workspace:*" }),
        { status: "skip", value: "(constrained by workspace: spec)" },
      ],
    ] as const;
    for (let mask = 0; mask < 8; mask++) {
      const failedNames = new Set(
        ["foo", ...parents].filter((_, index) => (mask & (1 << index)) !== 0),
      );
      for (const ordered of [parents, parents.toReversed()]) {
        const lockfile = makeLockfile({
          transitive: {
            foo: ordered.map((name) => ({
              parent: `${name}@1.0.0`,
              resolved: "1.0.0",
            })),
          },
        });
        for (const [parentSpec, direct, verdict] of contexts) {
          const registry = new Map<string, PackageMetadata | null>([
            ["foo", makeMetadata("foo", { "1.0.0": {}, "1.2.0": {} })],
            ...parents.map(
              (name) =>
                [
                  name,
                  makeMetadata(name, {
                    "1.0.0": parentSpec === null ? {} : { foo: parentSpec },
                  }),
                ] as const,
            ),
            ["unrelated", null],
          ]);
          for (const name of failedNames) {
            registry.set(name, null);
          }
          const failures = ["foo", ...ordered].filter((name) =>
            failedNames.has(name),
          );
          const expected =
            failures.length === 0
              ? verdict
              : {
                  status: "error" as const,
                  value: `(fetch failed: ${failures.join(", ")})`,
                };
          expect(
            evaluateOverride(
              PKG_OVERRIDE("foo", ">=1.0.0"),
              lockfile,
              direct,
              registry,
            ),
          ).toEqual(expected);
        }
      }
    }
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

  it("keeps protocol-constrained overrides for review and lists each protocol once in encounter order", () => {
    const protocols = [
      ["catalog:default", "catalog:"],
      ["workspace:*", "workspace:"],
      ["file:../a[1]/日本語*?", "file:"],
      ["link:../a:b", "link:"],
      ["portal:../local", "portal:"],
      ["npm:@scope/pkg@^2.0.0", "npm:"],
      ["github:user/repo", "github:"],
      ["git:repo", "git:"],
      ["git+ssh://host/repo.git", "git+ssh:"],
      ["http://host/pkg.tgz", "http:"],
      ["https://host/pkg.tgz", "https:"],
    ] as const;
    for (const first of protocols) {
      for (const second of [null, ...protocols]) {
        const pair = second === null ? [first] : [first, second];
        for (const ordered of [pair, pair.toReversed()]) {
          const labels = ordered.map(([, label]) => label);
          const expectedLabels =
            labels[0] === labels[1] ? labels.slice(0, 1) : labels;
          for (const hasOtherConstraints of [false, true]) {
            const specs: string[] = [...ordered, ...ordered].map(
              ([spec]) => spec,
            );
            if (hasOtherConstraints) {
              specs.unshift("^2.0.0");
            }
            const direct: WorkspaceDirectDeps = new Map([
              [
                "target",
                specs.map((spec, index) => ({
                  importerKey: `packages/${index}`,
                  depType: "dependencies" as const,
                  spec,
                })),
              ],
            ]);
            const lockfile = makeLockfile(
              hasOtherConstraints
                ? {
                    transitive: {
                      target: [{ parent: "parentA@1.0.0", resolved: "2.0.0" }],
                    },
                  }
                : {},
            );
            const registry = new Map<string, PackageMetadata>(
              hasOtherConstraints
                ? [
                    ["target", makeMetadata("target", { "2.0.0": {} })],
                    [
                      "parentA",
                      makeMetadata("parentA", {
                        "1.0.0": { target: ">=2.0.0" },
                      }),
                    ],
                  ]
                : [],
            );
            expect(
              evaluateOverride(
                PKG_OVERRIDE("target", ">=2.0.0"),
                lockfile,
                direct,
                registry,
              ),
            ).toEqual({
              status: "skip",
              value: `(constrained by ${expectedLabels.join(", ")} spec)`,
            });
          }
        }
      }
    }
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

  it("compares natural resolution with override floors for flat and selector-qualified keys", () => {
    const versions = ["1.0.0", "1.5.0", "2.0.0", "2.5.0"];
    const requirements = [
      { spec: "^1.0.0", rank: 1 },
      { spec: "^2.0.0", rank: 3 },
      { spec: "1.0.0", rank: 0 },
    ];
    // Range intersections are specified independently of semver.intersects.
    const selectors = [
      [null, [0, 1, 2]],
      ["<1.2.0", [0, 2]],
      [">=1.2.0 <2.0.0", [0]],
      ["^2.0.0", [1]],
      ["<1.0.0", []],
      ["1.0.0 || 2.0.0", [0, 1, 2]],
    ] as const;
    const floors = [
      [">=1.0.0", 0],
      [">=1.5.0", 1],
      [">=2.0.0", 2],
      [">=3.0.0", 4],
    ] as const;
    for (let mask = 1; mask < 2 ** requirements.length; mask++) {
      const selected = requirements.flatMap((entry, index) =>
        (mask & (1 << index)) !== 0 ? [{ ...entry, index }] : [],
      );
      for (const transitive of [false, true]) {
        const lockfile = makeLockfile(
          transitive
            ? {
                transitive: {
                  foo: selected.map(({ index }) => ({
                    parent: `parent${index}@1.0.0`,
                    resolved: "1.0.0",
                  })),
                },
              }
            : {},
        );
        const registry = new Map<string, PackageMetadata>([
          [
            "foo",
            makeMetadata(
              "foo",
              Object.fromEntries(
                versions.map((version) => [version, {}] as const),
              ),
            ),
          ],
          ...selected.map(
            ({ spec, index }) =>
              [
                `parent${index}`,
                makeMetadata(`parent${index}`, { "1.0.0": { foo: spec } }),
              ] as const,
          ),
        ]);
        const direct: WorkspaceDirectDeps = transitive
          ? NO_DIRECT
          : new Map([
              [
                "foo",
                selected.map(({ spec, index }) => ({
                  importerKey: `packages/${index}`,
                  depType: "dependencies" as const,
                  spec,
                })),
              ],
            ]);
        for (const [selector, matches] of selectors) {
          const matching = selected.filter(({ index }) =>
            matches.some((match) => match === index),
          );
          const rank = Math.min(...matching.map((entry) => entry.rank));
          for (const [spec, floor] of floors) {
            const expected =
              matching.length === 0
                ? { status: "prune" as const, value: "(selector miss)" }
                : {
                    status:
                      rank >= floor ? ("prune" as const) : ("keep" as const),
                    value: versions[rank] ?? "",
                  };
            expect(
              evaluateOverride(
                PKG_OVERRIDE(
                  selector === null ? "foo" : `foo@${selector}`,
                  spec,
                ),
                lockfile,
                direct,
                registry,
              ),
            ).toEqual(expected);
          }
        }
      }
    }
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

describe("registry package collection", () => {
  it("collects exactly the targets and immediate parents of active overrides without duplicates", () => {
    const targets = ["foo", "@scope/target"];
    const edges = [
      { target: "foo", parent: "shared", version: "1.0.0" },
      { target: "foo", parent: "shared", version: "2.0.0" },
      { target: "foo", parent: "@scope/parent", version: "2.0.0" },
      { target: "@scope/target", parent: "shared", version: "1.0.0" },
      { target: "@scope/target", parent: "foo", version: "3.0.0" },
    ];
    const options = (target: string) => [
      { target, override: null, active: false },
      { target, override: PKG_OVERRIDE(target, ">=1.0.0"), active: true },
      {
        target,
        override: PKG_OVERRIDE(`${target}@<2.0.0`, ">=1.0.0"),
        active: true,
      },
      { target, override: PKG_OVERRIDE(target, "^1.0.0"), active: false },
      {
        target,
        override: PKG_OVERRIDE(`${target}>child`, ">=1.0.0"),
        active: false,
      },
      { target, override: PKG_OVERRIDE(target, "workspace:*"), active: false },
      {
        target,
        override: PKG_OVERRIDE(`${target}@latest`, ">=1.0.0"),
        active: false,
      },
    ];
    for (let mask = 0; mask < 2 ** edges.length; mask++) {
      const selected = edges.filter((_, index) => (mask & (1 << index)) !== 0);
      const transitive = Object.fromEntries(
        targets.map(
          (target) =>
            [
              target,
              selected
                .filter((edge) => edge.target === target)
                .map((edge) => ({
                  parent: `${edge.parent}@${edge.version}(peer@4.0.0)`,
                  resolved: "1.0.0",
                })),
            ] as const,
        ),
      );
      const lockfile = makeLockfile({ transitive });
      for (const first of options("foo")) {
        for (const second of options("@scope/target")) {
          const expected = new Set<string>();
          const overrides: Override[] = [];
          for (const { target, override, active } of [first, second]) {
            if (override === null) continue;
            overrides.push(override);
            const names = active
              ? [
                  target,
                  ...selected
                    .filter((edge) => edge.target === target)
                    .map((edge) => edge.parent),
                ]
              : [];
            const own = collectPackagesForOverride(override, lockfile);
            expect(new Set(own)).toEqual(new Set(names));
            expect(own).toHaveLength(new Set(names).size);
            for (const name of names) expected.add(name);
          }
          for (const ordered of [
            overrides,
            [...overrides].reverse().concat(overrides),
          ]) {
            const actual = collectNeededRegistryPackages(ordered, lockfile);
            expect(new Set(actual)).toEqual(expected);
            expect(actual).toHaveLength(expected.size);
          }
        }
      }
    }
  });
});

describe("collectPackagesForOverride", () => {
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
});

describe("evaluateOverride with a release-age policy", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const registry = new Map<string, PackageMetadata>([
    [
      "foo",
      makeMetadata(
        "foo",
        { "1.0.0": {}, "1.1.0": {} },
        {
          "1.0.0": "2026-09-01T00:00:00Z",
          "1.1.0": "2026-09-22T11:00:00Z",
        },
      ),
    ],
  ]);

  it("applies release policy to both direct and transitive verdicts across override floors", () => {
    const policies = [
      [1440, [], "1.0.0", "keep"],
      [0, [], "1.1.0", "prune"],
      [60, [], "1.1.0", "prune"],
      [61, [], "1.0.0", "keep"],
      [1440, ["foo"], "1.1.0", "prune"],
      [1440, ["foo@1.1.0"], "1.1.0", "prune"],
      [1440, ["f*"], "1.1.0", "prune"],
      [1440, ["bar"], "1.0.0", "keep"],
    ] as const;
    const contexts = [
      [makeLockfile({}), makeWorkspaceDirectDeps({ foo: "^1.0.0" })],
      [
        makeLockfile({
          transitive: {
            foo: [{ parent: "parent@1.0.0", resolved: "1.0.0" }],
          },
        }),
        NO_DIRECT,
      ],
    ] as const;
    const metadata = new Map(registry);
    metadata.set(
      "parent",
      makeMetadata("parent", { "1.0.0": { foo: "^1.0.0" } }),
    );
    for (const [
      minimumReleaseAge,
      minimumReleaseAgeExclude,
      value,
      upperStatus,
    ] of policies) {
      const policy = createReleasePolicy(
        { minimumReleaseAge, minimumReleaseAgeExclude },
        now,
      );
      for (const [lockfile, direct] of contexts) {
        for (const [spec, status] of [
          [">=1.0.0", "prune"],
          [">=1.1.0", upperStatus],
        ] as const) {
          expect(
            evaluateOverride(
              PKG_OVERRIDE("foo", spec),
              lockfile,
              direct,
              metadata,
              policy,
            ),
          ).toEqual({ status, value });
        }
      }
    }
  });
});

describe("targetOf", () => {
  it("names the package an override pins", () => {
    expect(targetOf(PKG_OVERRIDE("foo", ">=1.0.0"))).toBe("foo");
    expect(targetOf(PKG_OVERRIDE("foo@<1.0.0", ">=1.0.0"))).toBe("foo");
  });

  it("is null for an entry the audit skips", () => {
    expect(targetOf(PKG_OVERRIDE("parent>child", "1.2.3"))).toBeNull();
  });
});
