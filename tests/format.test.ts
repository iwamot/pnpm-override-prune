import { describe, expect, it } from "bun:test";
import {
  entryDisplay,
  entryWidth,
  exitCodeFor,
  formatHelp,
  formatLine,
  formatSectionHeader,
  formatSummary,
  formatVersion,
  LABELS,
  SOURCE_ORDER,
} from "../src/format.ts";
import type { Override } from "../src/manifest.ts";
import type { AuditEntry } from "../src/pipeline.ts";

const PKG: (key: string, spec: string) => Override = (key, spec) => ({
  key,
  spec,
  source: "package.json:pnpm.overrides",
});

describe("LABELS", () => {
  it("covers all statuses with uniform-width labels", () => {
    expect(Object.keys(LABELS).sort()).toEqual([
      "error",
      "keep",
      "prune",
      "skip",
    ]);
    const widths = new Set(Object.values(LABELS).map((l) => l.length));
    expect(widths.size).toBe(1);
  });
});

describe("SOURCE_ORDER", () => {
  it("places package.json containers first, then workspace yamls", () => {
    expect(SOURCE_ORDER).toEqual([
      "package.json:overrides",
      "package.json:pnpm.overrides",
      "package.json:aube.overrides",
      "package.json:resolutions",
      "pnpm-workspace.yaml",
      "aube-workspace.yaml",
    ]);
  });
});

describe("entryDisplay", () => {
  it("joins key and spec with a space", () => {
    expect(entryDisplay(PKG("@xmldom/xmldom", ">=0.9.10"))).toBe(
      "@xmldom/xmldom >=0.9.10",
    );
  });
});

describe("entryWidth", () => {
  it("returns 0 for empty list", () => {
    expect(entryWidth([])).toBe(0);
  });

  it("returns the max display length", () => {
    expect(
      entryWidth([
        PKG("a", ">=1.0.0"),
        PKG("longer-name", ">=1.0.0"),
        PKG("b", ">=1.0.0"),
      ]),
    ).toBe("longer-name >=1.0.0".length);
  });
});

describe("formatSectionHeader", () => {
  it("uses 'entry' for count of 1", () => {
    expect(formatSectionHeader("package.json:pnpm.overrides", 1)).toBe(
      "=== package.json:pnpm.overrides (1 entry) ===\n",
    );
  });

  it("uses 'entries' for plural counts", () => {
    expect(formatSectionHeader("pnpm-workspace.yaml", 3)).toBe(
      "=== pnpm-workspace.yaml (3 entries) ===\n",
    );
  });
});

describe("formatLine", () => {
  it("preserves result text and aligns every status at each display width", () => {
    const labels = [
      ["prune", "[PRUNE]"],
      ["keep", "[KEEP] "],
      ["skip", "[SKIP] "],
      ["error", "[ERROR]"],
    ] as const;
    const columns = [
      [11, ""],
      [20, "         "],
    ] as const;
    for (const [status, label] of labels) {
      for (const [width, padding] of columns) {
        for (const value of ["1.5.0", "(unused)", "registry: 日本語"]) {
          const entry: AuditEntry = {
            override: PKG("foo", ">=1.0.0"),
            result: { status, value },
          };
          expect(formatLine(entry, width)).toBe(
            `${label} foo >=1.0.0${padding}  ${value}\n`,
          );
        }
      }
    }
  });
});

describe("audit outcome", () => {
  it("combines pruning and failure notices while giving errors exit-code priority", () => {
    const pruning = [
      [0, false, "No prunable entries found.\n", 0],
      [0, true, "No prunable entries found.\n", 0],
      [2, false, "Run with --fix to prune entries marked [PRUNE].\n", 1],
      [1, true, "Pruned 1 entry.\n", 0],
      [2, true, "Pruned 2 entries.\n", 0],
      [5, true, "Pruned 5 entries.\n", 0],
    ] as const;
    const failures = [
      [0, "", null],
      [1, "1 entry could not be evaluated.\n", 2],
      [2, "2 entries could not be evaluated.\n", 2],
      [3, "3 entries could not be evaluated.\n", 2],
    ] as const;
    for (const [prunableCount, fixed, notice, pruningExit] of pruning) {
      for (const [errorCount, failureNotice, errorExit] of failures) {
        const options = { prunableCount, fixed, errorCount };
        expect(formatSummary(options)).toBe(notice + failureNotice);
        expect(exitCodeFor(options)).toBe(errorExit ?? pruningExit);
      }
    }
  });
});

describe("formatVersion", () => {
  it("prints program name and version with trailing newline", () => {
    expect(formatVersion("1.2.3")).toBe("pnpm-override-prune 1.2.3\n");
  });
});

describe("formatHelp", () => {
  it("includes usage line and key flags", () => {
    const text = formatHelp();
    expect(text).toContain("Usage: pnpm-override-prune");
    expect(text).toContain("--fix");
    expect(text).toContain("-v, --version");
    expect(text).toContain("-h, --help");
  });
});
