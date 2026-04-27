import { describe, expect, it } from "bun:test";
import { DEFAULT_PACKAGE_JSON_PATH, parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
  it("returns audit with default path when given no args", () => {
    expect(parseArgs([])).toEqual({
      kind: "audit",
      path: DEFAULT_PACKAGE_JSON_PATH,
      fix: false,
    });
  });

  it("recognizes -V as a version request", () => {
    expect(parseArgs(["-V"])).toEqual({ kind: "version" });
  });

  it("recognizes --version as a version request", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("recognizes -h as a help request", () => {
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("recognizes --help as a help request", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("treats version flag as taking precedence over fix and positional", () => {
    expect(parseArgs(["--version", "--fix", "foo"])).toEqual({
      kind: "version",
    });
  });

  it("treats help flag as taking precedence over fix and positional", () => {
    expect(parseArgs(["--help", "foo"])).toEqual({ kind: "help" });
  });

  it("captures --fix as audit with fix=true and default path", () => {
    expect(parseArgs(["--fix"])).toEqual({
      kind: "audit",
      path: DEFAULT_PACKAGE_JSON_PATH,
      fix: true,
    });
  });

  it("captures positional path", () => {
    expect(parseArgs(["path/to/package.json"])).toEqual({
      kind: "audit",
      path: "path/to/package.json",
      fix: false,
    });
  });

  it("captures positional path together with --fix", () => {
    expect(parseArgs(["path/to/package.json", "--fix"])).toEqual({
      kind: "audit",
      path: "path/to/package.json",
      fix: true,
    });
  });

  it("captures --fix before the positional path", () => {
    expect(parseArgs(["--fix", "path/to/package.json"])).toEqual({
      kind: "audit",
      path: "path/to/package.json",
      fix: true,
    });
  });

  it("returns error when given multiple positional arguments", () => {
    const result = parseArgs(["a", "b"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("at most one");
    }
  });

  it("returns error when given an unknown flag", () => {
    const result = parseArgs(["--unknown"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
