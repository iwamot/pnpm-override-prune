import { describe, expect, it } from "bun:test";
import {
  computeNaturalResolution,
  pickVersion,
  type VersionPool,
} from "../src/resolve.ts";

function pool(
  versions: readonly string[],
  extra: { latest?: string; deprecated?: readonly string[] } = {},
): VersionPool {
  return {
    versions,
    latest: extra.latest ?? null,
    deprecated: new Set(extra.deprecated ?? []),
  };
}

describe("computeNaturalResolution", () => {
  it("returns the lowest of per-spec max-satisfying versions", () => {
    expect(
      computeNaturalResolution(
        [">=1.0.0", "<3.0.0"],
        pool(["0.5.0", "1.5.0", "2.0.0", "3.5.0"]),
      ),
    ).toBe("2.0.0");
  });

  it("returns the lowest when caret and tilde ranges disagree", () => {
    expect(
      computeNaturalResolution(
        ["^1.2.3", "~1.5.0"],
        pool(["1.4.0", "1.5.5", "1.5.9", "1.6.0", "2.0.0"]),
      ),
    ).toBe("1.5.9");
  });

  it("returns the lowest version when exact pins disagree", () => {
    // Specs '1.19.0' and '1.19.11' can't be hoisted to a single version.
    // pnpm would install both; the worst case for any consumer is 1.19.0.
    expect(
      computeNaturalResolution(
        ["1.19.0", "1.19.11"],
        pool(["1.19.0", "1.19.11", "1.19.13"]),
      ),
    ).toBe("1.19.0");
  });

  it("returns null when no parent specs are given", () => {
    expect(computeNaturalResolution([], pool(["1.0.0", "2.0.0"]))).toBeNull();
  });

  it("returns null when no candidate versions are given", () => {
    expect(computeNaturalResolution([">=1.0.0"], pool([]))).toBeNull();
  });

  it("returns null when no candidate satisfies any spec", () => {
    expect(
      computeNaturalResolution([">=10.0.0"], pool(["1.0.0", "2.0.0"])),
    ).toBeNull();
  });

  it("skips specs that have no satisfying candidate but uses the rest", () => {
    expect(
      computeNaturalResolution(
        [">=10.0.0", "^1.0.0"],
        pool(["1.0.0", "1.5.0", "2.0.0"]),
      ),
    ).toBe("1.5.0");
  });

  it("handles a single spec correctly", () => {
    expect(
      computeNaturalResolution([">=1.0.0"], pool(["0.5.0", "1.0.0", "1.5.0"])),
    ).toBe("1.5.0");
  });

  it("ignores pre-release versions when ranges are stable", () => {
    expect(
      computeNaturalResolution(
        [">=1.0.0"],
        pool(["1.0.0", "1.1.0-beta.1", "1.0.5"]),
      ),
    ).toBe("1.0.5");
  });

  it("handles invalid candidate versions by filtering them out", () => {
    // satisfies() returns false on invalid versions instead of throwing.
    expect(
      computeNaturalResolution(
        [">=1.0.0"],
        pool(["not-a-version", "1.5.0", "2.0.0"]),
      ),
    ).toBe("2.0.0");
  });

  it("handles invalid parent specs by filtering all candidates out", () => {
    // satisfies() returns false on invalid specs, so nothing matches.
    expect(
      computeNaturalResolution(["not-a-spec"], pool(["1.0.0", "2.0.0"])),
    ).toBeNull();
  });

  it("falls back to all versions for a spec no candidate satisfies", () => {
    const candidates = ["1.0.0", "1.1.0"];
    const all = ["1.0.0", "1.1.0", "1.2.0", "2.0.0"];
    expect(
      computeNaturalResolution(["^1.0.0"], pool(candidates), pool(all)),
    ).toBe("1.1.0");
    expect(
      computeNaturalResolution(["^2.0.0"], pool(candidates), pool(all)),
    ).toBe("2.0.0");
    expect(
      computeNaturalResolution(
        ["^1.0.0", "^2.0.0"],
        pool(candidates),
        pool(all),
      ),
    ).toBe("1.1.0");
  });

  it("returns null with no versions at all", () => {
    expect(computeNaturalResolution(["^1.0.0"], pool([]), pool([]))).toBeNull();
  });
});

describe("pickVersion", () => {
  it("prefers the latest tag when it satisfies the range", () => {
    const p = pool(["1.0.0", "1.1.0", "1.2.0"], { latest: "1.1.0" });
    expect(pickVersion("^1.0.0", p)).toBe("1.1.0");
    expect(pickVersion("*", p)).toBe("1.1.0");
  });

  it("takes the highest satisfying version when latest is outside the range", () => {
    const p = pool(["1.0.0", "1.1.0", "2.0.0"], { latest: "2.0.0" });
    expect(pickVersion("^1.0.0", p)).toBe("1.1.0");
  });

  it("picks a prerelease latest for a bare star, as pnpm does", () => {
    const p = pool(["1.0.0", "2.0.0-beta.1"], { latest: "2.0.0-beta.1" });
    expect(pickVersion("*", p)).toBe("2.0.0-beta.1");
    expect(pickVersion("^1.0.0", p)).toBe("1.0.0");
  });

  it("avoids a deprecated highest version when another satisfies", () => {
    const p = pool(["1.0.0", "1.1.0", "1.2.0"], { deprecated: ["1.2.0"] });
    expect(pickVersion("^1.0.0", p)).toBe("1.1.0");
  });

  it("takes the deprecated version when nothing else satisfies", () => {
    const p = pool(["1.0.0", "1.2.0"], { deprecated: ["1.2.0"] });
    expect(pickVersion("~1.2.0", p)).toBe("1.2.0");
    expect(
      pickVersion("^1.0.0", pool(["1.2.0"], { deprecated: ["1.2.0"] })),
    ).toBe("1.2.0");
  });

  it("still returns a deprecated latest, as pnpm does", () => {
    const p = pool(["1.0.0", "1.1.0"], {
      latest: "1.1.0",
      deprecated: ["1.1.0"],
    });
    expect(pickVersion("^1.0.0", p)).toBe("1.1.0");
  });

  it("returns null when nothing satisfies", () => {
    expect(
      pickVersion("^3.0.0", pool(["1.0.0"], { latest: "1.0.0" })),
    ).toBeNull();
  });
});
