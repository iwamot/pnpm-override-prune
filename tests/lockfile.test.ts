import { describe, expect, it } from "bun:test";
import { stringify } from "yaml";
import {
  extractMainDocument,
  MalformedLockfileError,
  parseLockfile,
  parseResolvedVersion,
  parseSnapshotKey,
  UnsupportedLockfileVersionError,
} from "../src/lockfile.ts";

describe("lockfile package identities", () => {
  it("recovers package identities regardless of peer decorations", () => {
    const names = ["pkg", "speech-rule-engine", "@scope/pkg"];
    const versions = ["0.0.0", "1.2.3", "2.0.0-rc.1+build.7"];
    const peerGroups = [
      [],
      ["peer@3.0.0"],
      ["@scope/peer@4.0.0"],
      ["peer@3.0.0", "@scope/peer@4.0.0"],
      ["@scope/peer@4.0.0", "peer@3.0.0"],
    ];
    for (const name of names) {
      for (const version of versions) {
        for (const peers of peerGroups) {
          const decorated = version + peers.map((peer) => `(${peer})`).join("");
          expect(parseSnapshotKey(`${name}@${decorated}`)).toEqual({
            name,
            version,
          });
          expect(parseResolvedVersion(decorated)).toBe(version);
        }
      }
    }
  });

  it("rejects incomplete package identities even when peer suffixes contain separators", () => {
    for (const base of ["", "foo", "@scope", "foo@", "@scope/pkg@"]) {
      for (const suffix of ["", "(peer@1.0.0)", "(@scope/peer@2.0.0)"]) {
        expect(parseSnapshotKey(base + suffix)).toBeNull();
      }
    }
  });
});

const VALID_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:
  .:
    dependencies:
      semver:
        specifier: ^7.0.0
        version: 7.7.4
      yaml:
        specifier: 2.8.3
        version: 2.8.3
    devDependencies:
      typescript:
        specifier: 6.0.3
        version: 6.0.3

packages:
  '@xmldom/xmldom@0.9.10':
    resolution: {integrity: sha512-foo}

snapshots:
  '@xmldom/xmldom@0.9.10': {}

  speech-rule-engine@4.1.4:
    dependencies:
      '@xmldom/xmldom': 0.9.10
      commander: 13.1.0
    optionalDependencies:
      optionaldep: 1.2.3

  another-parent@2.0.0:
    dependencies:
      '@xmldom/xmldom': 0.9.10
`;

describe("parseLockfile", () => {
  it("recovers importer paths and every dependency edge despite malformed snapshot data", () => {
    const edges = [
      {
        parent: "parent@1.0.0",
        target: "foo",
        version: "1.0.0",
        optional: false,
      },
      {
        parent: "@scope/parent@2.0.0",
        target: "foo",
        version: "2.0.0",
        optional: true,
      },
      {
        parent: "parent@1.0.0",
        target: "@scope/bar",
        version: "3.0.0",
        optional: true,
      },
      {
        parent: "other@3.0.0",
        target: "@scope/bar",
        version: "4.0.0-rc.1",
        optional: false,
      },
    ];
    for (let mask = 0; mask < 2 ** edges.length; mask++) {
      const selected = edges.filter((_, index) => (mask & (1 << index)) !== 0);
      for (const paths of [[], ["."], ["packages/b", ".", "packages/a"]]) {
        for (const decoration of ["", "(peer@5.0.0)(@scope/peer@6.0.0)"]) {
          const snapshots: Record<
            string,
            Record<string, Record<string, string>>
          > = {};
          for (const edge of selected) {
            const parentKey = edge.parent + decoration;
            snapshots[parentKey] ??= {};
            const snapshot = snapshots[parentKey];
            const field = edge.optional
              ? "optionalDependencies"
              : "dependencies";
            snapshot[field] ??= {};
            snapshot[field][edge.target] = edge.version + decoration;
          }
          const importers = Object.fromEntries(
            paths.map(
              (path, index) =>
                [
                  path,
                  index === 0
                    ? {}
                    : {
                        dependencies: {
                          "importer-only": {
                            specifier: "^1.0.0",
                            version: "1.0.0",
                          },
                        },
                      },
                ] as const,
            ),
          );
          const lf = parseLockfile(
            stringify({
              lockfileVersion: "9.0",
              importers,
              packages: {
                "metadata-only@1.0.0": {
                  resolution: { integrity: "sha512-foo" },
                },
              },
              snapshots: {
                "invalid-snapshot@1.0.0": "not-a-map",
                "invalid-fields@1.0.0": {
                  dependencies: "not-a-map",
                  optionalDependencies: [],
                },
                "invalid-values@1.0.0": {
                  dependencies: { "bad-required": { nested: "object" } },
                  optionalDependencies: { "bad-optional": 42 },
                },
                ...snapshots,
              },
            }),
          );
          expect(lf.version).toBe("9.0");
          expect(lf.importerPaths).toEqual(paths);
          const targets = [...new Set(selected.map((edge) => edge.target))];
          expect([...lf.transitiveParents.keys()].sort()).toEqual(
            targets.sort(),
          );
          for (const target of targets) {
            const expected = selected
              .filter((edge) => edge.target === target)
              .map((edge) => ({
                parentKey: edge.parent + decoration,
                resolvedVersion: edge.version,
              }));
            const actual = lf.transitiveParents.get(target);
            expect(actual).toHaveLength(expected.length);
            expect(actual).toEqual(expect.arrayContaining(expected));
          }
        }
      }
    }
  });

  it("rejects unsupported version values and reports the original string or a missing-version marker", () => {
    const versions = [
      [undefined, null],
      [null, null],
      [9, null],
      [true, null],
      [[], null],
      [{}, null],
      ["6.0", "6.0"],
      ["8.0", "8.0"],
      ["10.0", "10.0"],
      ["9", "9"],
    ] as const;
    for (const [lockfileVersion, found] of versions) {
      const document = { settings: {}, lockfileVersion };
      for (const content of [stringify(document), JSON.stringify(document)]) {
        let thrown: unknown;
        try {
          parseLockfile(content);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(UnsupportedLockfileVersionError);
        if (thrown instanceof UnsupportedLockfileVersionError) {
          expect(thrown.found).toBe(found);
        }
      }
    }
  });

  it("throws MalformedLockfileError on invalid YAML", () => {
    expect(() => parseLockfile(": : :\n  bad:\n indent")).toThrow(
      MalformedLockfileError,
    );
  });

  it("throws MalformedLockfileError when root is not a mapping", () => {
    expect(() => parseLockfile("- a\n- b\n")).toThrow(MalformedLockfileError);
  });

  it("returns empty transitive parents when snapshots are absent", () => {
    const lf = parseLockfile("lockfileVersion: '9.0'\n");
    expect(lf.transitiveParents.size).toBe(0);
    expect(lf.importerPaths).toEqual([]);
  });
});

const ENV_DOCUMENT = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.0.0
        version: 12.0.0

packages:

  pnpm@12.0.0:
    resolution: {integrity: sha512-bar}

snapshots:

  pnpm@12.0.0: {}
`;

describe("extractMainDocument", () => {
  it("recovers the dependency document across env prefixes and line endings", () => {
    const prefixes = [
      "",
      ENV_DOCUMENT,
      `${ENV_DOCUMENT}note: |\n  ---\n  literal marker\n`,
    ];
    for (const comment of ["", "# dependency lockfile\n"]) {
      for (const trailingNewline of ["", "\n"]) {
        const main = comment + VALID_LOCKFILE.trimEnd() + trailingNewline;
        for (const prefix of prefixes) {
          const combined = prefix === "" ? main : `${prefix}---\n${main}`;
          for (const newline of ["\n", "\r\n"]) {
            if (prefix !== "") {
              expect(extractMainDocument(prefix.replace(/\n/g, newline))).toBe(
                "",
              );
            }
            expect(extractMainDocument(combined.replace(/\n/g, newline))).toBe(
              main,
            );
          }
        }
      }
    }
  });
});

describe("parseLockfile with an env lockfile document", () => {
  it("reads the dependency lockfile, not the env document", () => {
    const lf = parseLockfile(`${ENV_DOCUMENT}---\n${VALID_LOCKFILE}`);
    expect(lf.importerPaths).toEqual(["."]);
    expect(lf.transitiveParents.has("pnpm")).toBe(false);
    expect(lf.transitiveParents.has("@xmldom/xmldom")).toBe(true);
  });
});
