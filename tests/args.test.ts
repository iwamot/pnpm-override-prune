import { describe, expect, it } from "bun:test";
import { DEFAULT_PACKAGE_JSON_PATH, parseArgs } from "../src/args.ts";

function* permutations(args: readonly string[]): Generator<string[]> {
  if (args.length === 0) {
    yield [];
    return;
  }
  for (const [index, arg] of args.entries()) {
    const others = args.filter((_, other) => other !== index);
    for (const rest of permutations(others)) {
      yield [arg, ...rest];
    }
  }
}

describe("parseArgs", () => {
  it("preserves command intent across flag aliases, order, and repetition", () => {
    const versions = [
      { flag: null, request: null },
      { flag: "-v", request: { kind: "version" } },
      { flag: "--version", request: { kind: "version" } },
    ] as const;
    const helpRequests = [
      { flag: null, request: null },
      { flag: "-h", request: { kind: "help" } },
      { flag: "--help", request: { kind: "help" } },
    ] as const;
    for (const version of versions) {
      for (const help of helpRequests) {
        for (const fix of [false, true]) {
          for (const path of [
            null,
            "path/to/package.json",
            "日本語 workspace/package.json",
            "",
          ]) {
            // Command priority is version, help, then audit; audit preserves the path verbatim.
            const expected = version.request ??
              help.request ?? {
                kind: "audit" as const,
                path: path ?? DEFAULT_PACKAGE_JSON_PATH,
                fix,
              };
            const flags = [
              version.flag,
              help.flag,
              fix ? "--fix" : null,
            ].filter((flag) => flag !== null);
            const args = path === null ? flags : [...flags, path];
            for (const ordered of permutations(args)) {
              expect(parseArgs(ordered)).toEqual(expected);
              const repeated = ordered.flatMap((arg) =>
                flags.includes(arg) ? [arg, arg] : [arg],
              );
              expect(parseArgs(repeated)).toEqual(expected);
            }
          }
        }
      }
    }
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
