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
  it("accepts >=", () => {
    expect(isPureLowerBound(">=1.0.0")).toBe(true);
  });

  it("accepts >", () => {
    expect(isPureLowerBound(">1.0.0")).toBe(true);
  });

  it("accepts OR of pure lower bounds", () => {
    expect(isPureLowerBound(">=1.0.0 || >=2.0.0")).toBe(true);
  });

  it("rejects exact version", () => {
    expect(isPureLowerBound("1.0.0")).toBe(false);
  });

  it("rejects caret range", () => {
    expect(isPureLowerBound("^1.0.0")).toBe(false);
  });

  it("rejects tilde range", () => {
    expect(isPureLowerBound("~1.0.0")).toBe(false);
  });

  it("rejects bounded range", () => {
    expect(isPureLowerBound(">=1.0.0 <2.0.0")).toBe(false);
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
  it("detects catalog:", () => {
    expect(hasProtocolPrefix("catalog:default")).toBe(true);
  });

  it("detects workspace:", () => {
    expect(hasProtocolPrefix("workspace:*")).toBe(true);
  });

  it("detects file:", () => {
    expect(hasProtocolPrefix("file:./local")).toBe(true);
  });

  it("detects link:", () => {
    expect(hasProtocolPrefix("link:./local")).toBe(true);
  });

  it("detects portal:", () => {
    expect(hasProtocolPrefix("portal:./local")).toBe(true);
  });

  it("detects npm:", () => {
    expect(hasProtocolPrefix("npm:foo@1.0.0")).toBe(true);
  });

  it("detects github:", () => {
    expect(hasProtocolPrefix("github:user/repo")).toBe(true);
  });

  it("detects git:", () => {
    expect(hasProtocolPrefix("git:foo")).toBe(true);
  });

  it("detects git+", () => {
    expect(hasProtocolPrefix("git+https://example.com/repo.git")).toBe(true);
  });

  it("detects http:", () => {
    expect(hasProtocolPrefix("http://example.com/foo.tgz")).toBe(true);
  });

  it("detects https:", () => {
    expect(hasProtocolPrefix("https://example.com/foo.tgz")).toBe(true);
  });

  it("ignores plain semver", () => {
    expect(hasProtocolPrefix("1.0.0")).toBe(false);
    expect(hasProtocolPrefix(">=1.0.0")).toBe(false);
    expect(hasProtocolPrefix("^1.0.0")).toBe(false);
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

  it("prunes when resolved version satisfies the lower bound", () => {
    expect(classify(">=1.0.0", "2.0.0")).toEqual({
      status: "prune",
      value: "2.0.0",
    });
  });

  it("prunes at exact lower bound", () => {
    expect(classify(">=2.0.0", "2.0.0")).toEqual({
      status: "prune",
      value: "2.0.0",
    });
  });

  it("keeps when resolved version is below the bound", () => {
    expect(classify(">=2.0.0", "1.0.0")).toEqual({
      status: "keep",
      value: "1.0.0",
    });
  });

  it("keeps when resolved equals the strict-greater bound", () => {
    expect(classify(">2.0.0", "2.0.0")).toEqual({
      status: "keep",
      value: "2.0.0",
    });
  });
});
