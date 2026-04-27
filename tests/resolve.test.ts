import { describe, expect, it } from "bun:test";
import { computeNaturalResolution } from "../src/resolve.ts";

describe("computeNaturalResolution", () => {
  it("returns the lowest of per-spec max-satisfying versions", () => {
    expect(
      computeNaturalResolution(
        [">=1.0.0", "<3.0.0"],
        ["0.5.0", "1.5.0", "2.0.0", "3.5.0"],
      ),
    ).toBe("2.0.0");
  });

  it("returns the lowest when caret and tilde ranges disagree", () => {
    expect(
      computeNaturalResolution(
        ["^1.2.3", "~1.5.0"],
        ["1.4.0", "1.5.5", "1.5.9", "1.6.0", "2.0.0"],
      ),
    ).toBe("1.5.9");
  });

  it("returns the lowest version when exact pins disagree", () => {
    // Specs '1.19.0' and '1.19.11' can't be hoisted to a single version.
    // pnpm would install both; the worst case for any consumer is 1.19.0.
    expect(
      computeNaturalResolution(
        ["1.19.0", "1.19.11"],
        ["1.19.0", "1.19.11", "1.19.13"],
      ),
    ).toBe("1.19.0");
  });

  it("returns null when no parent specs are given", () => {
    expect(computeNaturalResolution([], ["1.0.0", "2.0.0"])).toBeNull();
  });

  it("returns null when no candidate versions are given", () => {
    expect(computeNaturalResolution([">=1.0.0"], [])).toBeNull();
  });

  it("returns null when no candidate satisfies any spec", () => {
    expect(
      computeNaturalResolution([">=10.0.0"], ["1.0.0", "2.0.0"]),
    ).toBeNull();
  });

  it("skips specs that have no satisfying candidate but uses the rest", () => {
    expect(
      computeNaturalResolution(
        [">=10.0.0", "^1.0.0"],
        ["1.0.0", "1.5.0", "2.0.0"],
      ),
    ).toBe("1.5.0");
  });

  it("handles a single spec correctly", () => {
    expect(
      computeNaturalResolution([">=1.0.0"], ["0.5.0", "1.0.0", "1.5.0"]),
    ).toBe("1.5.0");
  });

  it("ignores pre-release versions when ranges are stable", () => {
    expect(
      computeNaturalResolution([">=1.0.0"], ["1.0.0", "1.1.0-beta.1", "1.0.5"]),
    ).toBe("1.0.5");
  });

  it("handles invalid candidate versions by filtering them out", () => {
    // satisfies() returns false on invalid versions instead of throwing.
    expect(
      computeNaturalResolution(
        [">=1.0.0"],
        ["not-a-version", "1.5.0", "2.0.0"],
      ),
    ).toBe("2.0.0");
  });

  it("handles invalid parent specs by filtering all candidates out", () => {
    // satisfies() returns false on invalid specs, so nothing matches.
    expect(
      computeNaturalResolution(["not-a-spec"], ["1.0.0", "2.0.0"]),
    ).toBeNull();
  });
});
