import { describe, expect, it } from "bun:test";
import {
  MalformedLockfileError,
  parseLockfile,
  parseResolvedVersion,
  parseSnapshotKey,
  UnsupportedLockfileVersionError,
} from "../src/lockfile.ts";

describe("parseSnapshotKey", () => {
  it("parses unscoped name@version", () => {
    expect(parseSnapshotKey("speech-rule-engine@4.1.4")).toEqual({
      name: "speech-rule-engine",
      version: "4.1.4",
    });
  });

  it("parses scoped name@version", () => {
    expect(parseSnapshotKey("@xmldom/xmldom@0.9.10")).toEqual({
      name: "@xmldom/xmldom",
      version: "0.9.10",
    });
  });

  it("strips peer dependency decorations", () => {
    expect(parseSnapshotKey("foo@1.0.0(bar@2.0.0)")).toEqual({
      name: "foo",
      version: "1.0.0",
    });
  });

  it("strips peer decorations on scoped names", () => {
    expect(parseSnapshotKey("@a/b@1.0.0(c@2.0.0)(d@3.0.0)")).toEqual({
      name: "@a/b",
      version: "1.0.0",
    });
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

describe("parseResolvedVersion", () => {
  it("returns plain version unchanged", () => {
    expect(parseResolvedVersion("1.0.0")).toBe("1.0.0");
  });

  it("strips single peer decoration", () => {
    expect(parseResolvedVersion("1.0.0(peer@2.0.0)")).toBe("1.0.0");
  });

  it("strips multiple peer decorations", () => {
    expect(parseResolvedVersion("1.0.0(peer@2.0.0)(other@3.0.0)")).toBe(
      "1.0.0",
    );
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
  it("parses a valid v9.0 lockfile", () => {
    const lf = parseLockfile(VALID_LOCKFILE);
    expect(lf.version).toBe("9.0");
  });

  it("collects direct requirements with specifier and resolved version", () => {
    const lf = parseLockfile(VALID_LOCKFILE);
    const semver = lf.directRequirements.get("semver");
    expect(semver).toEqual([
      {
        importerKey: ".",
        depType: "dependencies",
        specifier: "^7.0.0",
        resolvedVersion: "7.7.4",
      },
    ]);
    const ts = lf.directRequirements.get("typescript");
    expect(ts).toEqual([
      {
        importerKey: ".",
        depType: "devDependencies",
        specifier: "6.0.3",
        resolvedVersion: "6.0.3",
      },
    ]);
  });

  it("collects transitive parents from snapshots dependencies", () => {
    const lf = parseLockfile(VALID_LOCKFILE);
    const parents = lf.transitiveParents.get("@xmldom/xmldom");
    expect(parents).toEqual([
      { parentKey: "speech-rule-engine@4.1.4", resolvedVersion: "0.9.10" },
      { parentKey: "another-parent@2.0.0", resolvedVersion: "0.9.10" },
    ]);
  });

  it("collects optional dependencies as transitive parents too", () => {
    const lf = parseLockfile(VALID_LOCKFILE);
    const parents = lf.transitiveParents.get("optionaldep");
    expect(parents).toEqual([
      { parentKey: "speech-rule-engine@4.1.4", resolvedVersion: "1.2.3" },
    ]);
  });

  it("strips peer decorations from importer resolved version", () => {
    const lockfile = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      foo:
        specifier: 1.0.0
        version: 1.0.0(peer@2.0.0)

snapshots: {}
`;
    const lf = parseLockfile(lockfile);
    expect(lf.directRequirements.get("foo")).toEqual([
      {
        importerKey: ".",
        depType: "dependencies",
        specifier: "1.0.0",
        resolvedVersion: "1.0.0",
      },
    ]);
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

  it("returns empty maps when importers and snapshots are absent", () => {
    const lf = parseLockfile("lockfileVersion: '9.0'\n");
    expect(lf.directRequirements.size).toBe(0);
    expect(lf.transitiveParents.size).toBe(0);
  });

  it("ignores importers entries that are not mappings", () => {
    const lockfile = `lockfileVersion: '9.0'
importers:
  .: invalid-string-instead-of-map
`;
    const lf = parseLockfile(lockfile);
    expect(lf.directRequirements.size).toBe(0);
  });

  it("ignores dep-type fields whose value is not a mapping", () => {
    const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    dependencies: not-a-map
`;
    const lf = parseLockfile(lockfile);
    expect(lf.directRequirements.size).toBe(0);
  });

  it("ignores dep entries that are not mappings", () => {
    const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo: just-a-string
`;
    const lf = parseLockfile(lockfile);
    expect(lf.directRequirements.size).toBe(0);
  });

  it("ignores dep entries with non-string specifier or version", () => {
    const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo:
        specifier: 1.0.0
        version: 1
      bar:
        specifier: 2
        version: 2.0.0
`;
    const lf = parseLockfile(lockfile);
    expect(lf.directRequirements.size).toBe(0);
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
