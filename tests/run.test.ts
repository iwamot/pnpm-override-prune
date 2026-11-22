import { describe, expect, it } from "bun:test";
import { decideRun } from "../src/run.ts";

describe("decideRun", () => {
  it("renders the supplied version identically for both version options", () => {
    for (const version of ["1.2.3", "9.0.0-rc.1", "0.0.0+build.7"]) {
      for (const flag of ["-v", "--version"]) {
        expect(decideRun([flag], version)).toEqual({
          kind: "sync",
          exitCode: 0,
          stdout: `pnpm-override-prune ${version}\n`,
          stderr: "",
        });
      }
    }
  });

  it("renders complete help identically for both help options independently of the version", () => {
    const reference = decideRun(["-h"], "1.2.3");
    for (const version of ["1.2.3", "9.0.0-rc.1"]) {
      for (const flag of ["-h", "--help"]) {
        const result = decideRun([flag], version);
        expect(result).toEqual(reference);
        expect(result).toEqual({
          kind: "sync",
          exitCode: 0,
          stdout: expect.stringContaining("Usage: pnpm-override-prune"),
          stderr: "",
        });
        if (result.kind === "sync") {
          for (const option of ["--fix", "-v, --version", "-h, --help"]) {
            expect(result.stdout).toContain(option);
          }
        }
      }
    }
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

  it("preserves audit options independently of argument order and display version", () => {
    for (const path of [
      null,
      "custom/package.json",
      "プロジェクト/package.json",
      "",
    ]) {
      for (const fix of [false, true]) {
        const args = [
          ...(path === null ? [] : [path]),
          ...(fix ? ["--fix"] : []),
        ];
        for (const ordered of [args, args.toReversed()]) {
          for (const version of ["1.2.3", "9.0.0-rc.1"]) {
            expect(decideRun(ordered, version)).toEqual({
              kind: "audit",
              path: path ?? "./package.json",
              fix,
            });
          }
        }
      }
    }
  });
});
