import { describe, expect, it } from "bun:test";
import { Range } from "semver";
import {
  categorize,
  classify,
  hasProtocolPrefix,
  isNestedKey,
  isPureLowerBound,
  parseKey,
} from "../src/analyze.ts";

describe("isPureLowerBound", () => {
  it("accepts conjunctions and alternatives made entirely from lower bounds", () => {
    const bounds = ["1.2.3", "2.0.0-rc.1", "10.0.0"].flatMap((version) =>
      [">", ">="].map((operator) => operator + version),
    );
    for (const first of bounds) {
      expect(isPureLowerBound(first)).toBe(true);
      for (const second of bounds) {
        for (const join of [" ", " || "]) {
          expect(isPureLowerBound(first + join + second)).toBe(true);
        }
      }
    }
  });

  it("rejects restrictions other than lower bounds anywhere in a compound range", () => {
    for (const version of ["1.2.3", "2.0.0-rc.1", "10.0.0"]) {
      for (const operator of ["", "^", "~", "<", "<="]) {
        const restriction = operator + version;
        expect(isPureLowerBound(restriction)).toBe(false);
        for (const lower of [">=1.2.3", ">2.0.0-rc.1"]) {
          for (const join of [" ", " || "]) {
            expect(isPureLowerBound(lower + join + restriction)).toBe(false);
            expect(isPureLowerBound(restriction + join + lower)).toBe(false);
          }
        }
      }
    }
  });

  it("rejects empty string", () => {
    expect(isPureLowerBound("")).toBe(false);
  });

  it("rejects malformed spec", () => {
    expect(isPureLowerBound("not-a-version")).toBe(false);
  });

  it("rejects bare wildcard", () => {
    // "*" expands to >=0.0.0 with operator "" — we still want it filtered
    // because it carries no meaningful lower bound.
    expect(isPureLowerBound("*")).toBe(false);
  });
});

describe("override key structure", () => {
  it("round-trips flat keys and distinguishes nested keys from range comparators", () => {
    const names = ["foo", "with-dash", "@scope/pkg"];
    const selectors = [
      null,
      "^1.0.0",
      ">=4.0.0 <=4.17.22",
      "> 4.0.0",
      "1.0.0",
      ">=1.0.0 || > 2.0.0",
      ...Array.from({ length: 10 }, (_, major) => `>${major}.0.0`),
    ];
    for (const name of names) {
      for (const selectorRaw of selectors) {
        const key = selectorRaw === null ? name : `${name}@${selectorRaw}`;
        expect(parseKey(key)).toEqual({ name, selectorRaw });
        expect(isNestedKey(key)).toBe(false);
        for (const child of names) {
          expect(isNestedKey(`${key}>${child}`)).toBe(true);
        }
      }
    }
  });

  it("treats an empty key as flat with no selector", () => {
    expect(parseKey("")).toEqual({ name: "", selectorRaw: null });
    expect(isNestedKey("")).toBe(false);
  });

  it("treats trailing '>' as nested (malformed)", () => {
    expect(isNestedKey("foo>")).toBe(true);
  });
});

describe("hasProtocolPrefix", () => {
  it("recognizes complete protocol prefixes independently of payload and rejects misplaced or incomplete prefixes", () => {
    const protocols = [
      "catalog:",
      "workspace:",
      "file:",
      "link:",
      "portal:",
      "npm:",
      "github:",
      "git:",
      "git+",
      "http:",
      "https:",
    ];
    for (const prefix of protocols) {
      for (const payload of [
        "",
        "*",
        "default",
        "./local",
        "@scope/pkg@^1.0.0",
        "https://example.com/pkg.tgz",
      ]) {
        expect(hasProtocolPrefix(prefix + payload)).toBe(true);
        expect(hasProtocolPrefix("x-" + prefix + payload)).toBe(false);
        expect(hasProtocolPrefix(prefix.slice(0, -1) + payload)).toBe(false);
      }
    }
    for (const spec of ["", "1.0.0", ">=1.0.0", "^1.0.0"]) {
      expect(hasProtocolPrefix(spec)).toBe(false);
    }
  });
});

describe("categorize", () => {
  it("targets a pure lower bound on a flat key with no selector", () => {
    expect(categorize("foo", ">=1.0.0")).toEqual({
      kind: "target",
      name: "foo",
      selector: null,
      spec: ">=1.0.0",
    });
  });

  it("targets a versioned key with parseable selector", () => {
    const result = categorize("lodash@<4.17.21", ">=4.17.21");
    expect(result.kind).toBe("target");
    if (result.kind === "target") {
      expect(result.name).toBe("lodash");
      expect(result.spec).toBe(">=4.17.21");
      expect(result.selector?.range).toBe(new Range("<4.17.21").range);
    }
  });

  it("targets a scoped versioned key", () => {
    const result = categorize("@azure/core-rest-pipeline@^1.0.0", ">=1.14.0");
    expect(result.kind).toBe("target");
    if (result.kind === "target") {
      expect(result.name).toBe("@azure/core-rest-pipeline");
      expect(result.selector?.range).toBe(new Range("^1.0.0").range);
    }
  });

  it("targets a versioned key with compound selector", () => {
    const result = categorize("lodash@>=4.0.0 <=4.17.22", ">=4.17.23");
    expect(result.kind).toBe("target");
    if (result.kind === "target") {
      expect(result.name).toBe("lodash");
      expect(result.selector?.range).toBe(new Range(">=4.0.0 <=4.17.22").range);
    }
  });

  it("skips nested keys", () => {
    expect(categorize("foo>bar", ">=1.0.0")).toEqual({
      kind: "skip",
      reason: "nested-key",
    });
  });

  it("skips when selector is a dist-tag", () => {
    expect(categorize("foo@latest", ">=1.0.0")).toEqual({
      kind: "skip",
      reason: "unsupported-selector",
    });
  });

  it("skips when selector is non-semver garbage", () => {
    expect(categorize("foo@my-fork", ">=1.0.0")).toEqual({
      kind: "skip",
      reason: "unsupported-selector",
    });
  });

  it("skips protocol specs", () => {
    expect(categorize("foo", "catalog:default")).toEqual({
      kind: "skip",
      reason: "protocol-spec",
    });
  });

  it("skips exact pins", () => {
    expect(categorize("foo", "1.0.0")).toEqual({
      kind: "skip",
      reason: "non-lower-bound",
    });
  });

  it("skips caret ranges", () => {
    expect(categorize("foo", "^1.0.0")).toEqual({
      kind: "skip",
      reason: "non-lower-bound",
    });
  });

  it("skips versioned key with non-lower-bound spec", () => {
    expect(categorize("lodash@<4.17.21", "^4.17.21")).toEqual({
      kind: "skip",
      reason: "non-lower-bound",
    });
  });

  it("nested-key takes precedence over protocol", () => {
    expect(categorize("foo>bar", "workspace:*")).toEqual({
      kind: "skip",
      reason: "nested-key",
    });
  });

  it("nested-key takes precedence over selector parse", () => {
    // 'foo>bar@1.0.0' has '>' so it's nested first.
    expect(categorize("foo>bar@1.0.0", ">=1.0.0")).toEqual({
      kind: "skip",
      reason: "nested-key",
    });
  });

  it("unsupported-selector takes precedence over protocol-spec", () => {
    expect(categorize("foo@latest", "catalog:default")).toEqual({
      kind: "skip",
      reason: "unsupported-selector",
    });
  });

  it("protocol takes precedence over non-lower-bound check", () => {
    expect(categorize("foo", "catalog:default")).toEqual({
      kind: "skip",
      reason: "protocol-spec",
    });
  });
});

describe("classify", () => {
  it("prunes when nothing depends on the package (resolved is null)", () => {
    expect(classify(">=1.0.0", null)).toEqual({
      status: "prune",
      value: "(unused)",
    });
  });

  it("prunes exactly the versions above the floor, including equality for >=", () => {
    const orderedVersions = [
      "0.0.0",
      "1.0.0-alpha.2",
      "1.0.0-alpha.10",
      "1.0.0-beta.1",
      "1.0.0",
      "1.0.2",
      "1.0.10",
      "1.2.0",
      "1.10.0",
      "2.0.0",
      "10.0.0",
    ];
    for (const [floorIndex, floor] of orderedVersions.entries()) {
      for (const [resolvedIndex, resolved] of orderedVersions.entries()) {
        for (const inclusive of [false, true]) {
          const spec = `${inclusive ? ">=" : ">"}${floor}`;
          const prunable = inclusive
            ? resolvedIndex >= floorIndex
            : resolvedIndex > floorIndex;
          expect(classify(spec, resolved)).toEqual({
            status: prunable ? "prune" : "keep",
            value: resolved,
          });
        }
      }
    }
  });
});
