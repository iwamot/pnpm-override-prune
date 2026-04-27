import { describe, expect, it } from "bun:test";
import { computeNaturalResolution } from "../src/resolve.ts";

describe("computeNaturalResolution", () => {
  it("returns the max version satisfying all parent specs", () => {
    expect(
      computeNaturalResolution(
        [">=1.0.0", "<3.0.0"],
        ["0.5.0", "1.5.0", "2.0.0", "3.5.0"],
      ),
    ).toBe("2.0.0");
  });

  it("intersects caret and tilde ranges correctly", () => {
    expect(
      computeNaturalResolution(
        ["^1.2.3", "~1.5.0"],
        ["1.4.0", "1.5.5", "1.5.9", "1.6.0", "2.0.0"],
      ),
    ).toBe("1.5.9");
  });

  it("returns null when no parent specs are given", () => {
    expect(computeNaturalResolution([], ["1.0.0", "2.0.0"])).toBeNull();
  });

  it("returns null when no candidate versions are given", () => {
    expect(computeNaturalResolution([">=1.0.0"], [])).toBeNull();
  });

  it("returns null when no candidate satisfies the intersection", () => {
    expect(
      computeNaturalResolution([">=10.0.0"], ["1.0.0", "2.0.0"]),
    ).toBeNull();
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
