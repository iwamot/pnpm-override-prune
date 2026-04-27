import { describe, expect, it } from "bun:test";
import {
  categorize,
  classify,
  hasProtocolPrefix,
  isNestedKey,
  isPureLowerBound,
  isVersionedKey,
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

describe("isNestedKey", () => {
  it("recognizes parent>child syntax", () => {
    expect(isNestedKey("foo>bar")).toBe(true);
  });

  it("treats flat name as not nested", () => {
    expect(isNestedKey("foo")).toBe(false);
  });

  it("treats scoped flat name as not nested", () => {
    expect(isNestedKey("@scope/foo")).toBe(false);
  });
});

describe("isVersionedKey", () => {
  it("treats plain name as not versioned", () => {
    expect(isVersionedKey("foo")).toBe(false);
  });

  it("treats scoped name as not versioned", () => {
    expect(isVersionedKey("@scope/foo")).toBe(false);
  });

  it("recognizes name with caret range", () => {
    expect(isVersionedKey("ajv@^8.0.0")).toBe(true);
  });

  it("recognizes scoped name with caret range", () => {
    expect(isVersionedKey("@azure/core-rest-pipeline@^1.0.0")).toBe(true);
  });

  it("recognizes name with exact pin", () => {
    expect(isVersionedKey("foo@1.0.0")).toBe(true);
  });

  it("treats empty string as not versioned", () => {
    expect(isVersionedKey("")).toBe(false);
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
  it("targets a pure lower bound on a flat key", () => {
    expect(categorize("foo", ">=1.0.0")).toEqual({
      kind: "target",
      spec: ">=1.0.0",
    });
  });

  it("skips nested keys", () => {
    expect(categorize("foo>bar", ">=1.0.0")).toEqual({
      kind: "skip",
      reason: "nested-key",
    });
  });

  it("skips versioned keys", () => {
    expect(categorize("ajv@^8.0.0", ">=8.18.0")).toEqual({
      kind: "skip",
      reason: "versioned-key",
    });
  });

  it("skips scoped versioned keys", () => {
    expect(categorize("@azure/core-rest-pipeline@^1.0.0", ">=1.14.0")).toEqual({
      kind: "skip",
      reason: "versioned-key",
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

  it("nested-key takes precedence over protocol", () => {
    expect(categorize("foo>bar", "workspace:*")).toEqual({
      kind: "skip",
      reason: "nested-key",
    });
  });

  it("nested-key takes precedence over versioned-key", () => {
    // 'foo>bar@1.0.0' has '>' so it's nested first.
    expect(categorize("foo>bar@1.0.0", ">=1.0.0")).toEqual({
      kind: "skip",
      reason: "nested-key",
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
