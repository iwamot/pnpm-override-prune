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

  it("rejects keys without an @ separator", () => {
    expect(parseSnapshotKey("foo")).toBeNull();
  });

  it("rejects keys whose only @ is a leading scope marker", () => {
    expect(parseSnapshotKey("@scope")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseSnapshotKey("")).toBeNull();
  });

  it("rejects keys with empty version", () => {
    expect(parseSnapshotKey("foo@")).toBeNull();
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
  it("recovers importer paths and every incoming dependency edge", () => {
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
              snapshots,
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

  it("throws UnsupportedLockfileVersionError on missing version", () => {
    const lockfile = "settings: {}\n";
    let thrown: unknown;
    try {
      parseLockfile(lockfile);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnsupportedLockfileVersionError);
    if (thrown instanceof UnsupportedLockfileVersionError) {
      expect(thrown.found).toBeNull();
    }
  });

  it("throws UnsupportedLockfileVersionError on legacy version", () => {
    const lockfile = "lockfileVersion: '6.0'\n";
    let thrown: unknown;
    try {
      parseLockfile(lockfile);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnsupportedLockfileVersionError);
    if (thrown instanceof UnsupportedLockfileVersionError) {
      expect(thrown.found).toBe("6.0");
    }
  });

  it("throws UnsupportedLockfileVersionError when version is not a string", () => {
    const lockfile = "lockfileVersion: 9.0\n";
    let thrown: unknown;
    try {
      parseLockfile(lockfile);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnsupportedLockfileVersionError);
    if (thrown instanceof UnsupportedLockfileVersionError) {
      expect(thrown.found).toBeNull();
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

  it("ignores snapshot entries that are not mappings", () => {
    const lockfile = `lockfileVersion: '9.0'
snapshots:
  foo@1.0.0: invalid-string
`;
    const lf = parseLockfile(lockfile);
    expect(lf.transitiveParents.size).toBe(0);
  });

  it("ignores snapshot dep maps that are not mappings", () => {
    const lockfile = `lockfileVersion: '9.0'
snapshots:
  foo@1.0.0:
    dependencies: not-a-map
`;
    const lf = parseLockfile(lockfile);
    expect(lf.transitiveParents.size).toBe(0);
  });

  it("ignores snapshot dep values that are not strings", () => {
    const lockfile = `lockfileVersion: '9.0'
snapshots:
  foo@1.0.0:
    dependencies:
      bar: {nested: object}
`;
    const lf = parseLockfile(lockfile);
    expect(lf.transitiveParents.size).toBe(0);
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
  it("returns a single-document lockfile unchanged", () => {
    expect(extractMainDocument(VALID_LOCKFILE)).toBe(VALID_LOCKFILE);
  });

  it("returns the document after the env lockfile", () => {
    const combined = `${ENV_DOCUMENT}---\n${VALID_LOCKFILE}`;
    expect(extractMainDocument(combined)).toBe(VALID_LOCKFILE);
  });

  it("handles CRLF line endings", () => {
    const combined = `${ENV_DOCUMENT}---\n${VALID_LOCKFILE}`.replace(
      /\n/g,
      "\r\n",
    );
    expect(extractMainDocument(combined)).toBe(VALID_LOCKFILE);
  });

  it("returns an empty string for an env-only lockfile", () => {
    expect(extractMainDocument(ENV_DOCUMENT)).toBe("");
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
