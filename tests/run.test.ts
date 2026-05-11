import { describe, expect, it } from "bun:test";
import { decideRun } from "../src/run.ts";

describe("decideRun", () => {
  it("returns sync version output for -v", () => {
    const result = decideRun(["-v"], "1.2.3");
    expect(result).toEqual({
      kind: "sync",
      exitCode: 0,
      stdout: "pnpm-override-prune 1.2.3\n",
      stderr: "",
    });
  });

  it("returns sync version output for --version", () => {
    const result = decideRun(["--version"], "1.2.3");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.stdout).toBe("pnpm-override-prune 1.2.3\n");
    }
  });

  it("returns sync help output for -h", () => {
    const result = decideRun(["-h"], "1.2.3");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: pnpm-override-prune");
    }
  });

  it("returns sync help output for --help", () => {
    const result = decideRun(["--help"], "1.2.3");
    expect(result.kind).toBe("sync");
  });

  it("returns sync error output with exit code 2 on bad args", () => {
    const result = decideRun(["a", "b"], "1.2.3");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/^error: /);
      expect(result.stdout).toBe("");
    }
  });

  it("returns audit request with default path when given no args", () => {
    expect(decideRun([], "1.2.3")).toEqual({
      kind: "audit",
      path: "./package.json",
      fix: false,
    });
  });

  it("returns audit request with path and fix when both are given", () => {
    expect(decideRun(["custom/package.json", "--fix"], "1.2.3")).toEqual({
      kind: "audit",
      path: "custom/package.json",
      fix: true,
    });
  });
});
