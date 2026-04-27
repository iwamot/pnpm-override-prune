import { describe, expect, it } from "bun:test";
import {
  MalformedRegistryResponseError,
  parsePackageMetadata,
} from "../src/registry.ts";

describe("parsePackageMetadata", () => {
  it("collects dependencies for each published version", () => {
    const raw = {
      name: "speech-rule-engine",
      versions: {
        "4.1.3": {
          version: "4.1.3",
          dependencies: {
            "@xmldom/xmldom": "0.9.9",
            commander: "11.1.0",
          },
        },
        "4.1.4": {
          version: "4.1.4",
          dependencies: {
            "@xmldom/xmldom": "0.9.10",
            commander: "13.1.0",
          },
        },
      },
    };
    const meta = parsePackageMetadata(raw, "speech-rule-engine");
    expect(meta.name).toBe("speech-rule-engine");
    expect(meta.versions.size).toBe(2);
    const v413 = meta.versions.get("4.1.3");
    expect(v413?.version).toBe("4.1.3");
    expect(v413?.dependencies.get("@xmldom/xmldom")).toBe("0.9.9");
    expect(meta.versions.get("4.1.4")?.dependencies.get("commander")).toBe(
      "13.1.0",
    );
  });

  it("merges peerDependencies and optionalDependencies into dependencies", () => {
    const raw = {
      versions: {
        "1.0.0": {
          dependencies: { a: ">=1.0.0" },
          peerDependencies: { b: ">=2.0.0" },
          optionalDependencies: { c: ">=3.0.0" },
        },
      },
    };
    const meta = parsePackageMetadata(raw, "x");
    const v = meta.versions.get("1.0.0");
    expect(v?.dependencies.get("a")).toBe(">=1.0.0");
    expect(v?.dependencies.get("b")).toBe(">=2.0.0");
    expect(v?.dependencies.get("c")).toBe(">=3.0.0");
  });

  it("dependencies takes precedence over peerDependencies on overlap", () => {
    const raw = {
      versions: {
        "1.0.0": {
          dependencies: { a: "^1.0.0" },
          peerDependencies: { a: "^2.0.0" },
        },
      },
    };
    const meta = parsePackageMetadata(raw, "x");
    expect(meta.versions.get("1.0.0")?.dependencies.get("a")).toBe("^1.0.0");
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

  it("creates an empty dep map when no dep fields are present", () => {
    const raw = {
      versions: {
        "1.0.0": {},
      },
    };
    const meta = parsePackageMetadata(raw, "x");
    expect(meta.versions.get("1.0.0")?.dependencies.size).toBe(0);
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
