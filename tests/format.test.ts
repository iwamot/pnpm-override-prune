import { describe, expect, it } from "bun:test";
import {
  entryDisplay,
  entryWidth,
  exitCodeFor,
  formatLine,
  formatSectionHeader,
  formatSummary,
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

describe("entry display and width", () => {
  it("preserves each display and selects the widest entry independently of order and repetition", () => {
    // Explicit widths are ordered independently of the display implementation.
    const entries = [
      [PKG("a", ">=1.0.0"), "a >=1.0.0", 9],
      [PKG("b", ">=100.200.300"), "b >=100.200.300", 15],
      [PKG("longer-name", ">=1.0.0"), "longer-name >=1.0.0", 19],
      [PKG("@xmldom/xmldom", ">=0.9.10"), "@xmldom/xmldom >=0.9.10", 23],
    ] as const;
    for (const [entry, display] of entries) {
      expect(entryDisplay(entry)).toBe(display);
    }
    for (let mask = 0; mask < 2 ** entries.length; mask++) {
      const selected = entries.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const expected = selected.at(-1)?.[2] ?? 0;
      const overrides = selected.map(([entry]) => entry);
      for (const ordered of [overrides, overrides.toReversed()]) {
        expect(entryWidth(ordered)).toBe(expected);
        expect(entryWidth([...ordered, ...ordered])).toBe(expected);
      }
    }
  });
});

describe("formatSectionHeader", () => {
  it("preserves every source and uses the count's singular or plural wording", () => {
    const counts = [
      [0, "entries"],
      [1, "entry"],
      [2, "entries"],
      [3, "entries"],
    ] as const;
    for (const source of SOURCE_ORDER) {
      for (const [count, word] of counts) {
        expect(formatSectionHeader(source, count)).toBe(
          `=== ${source} (${count} ${word}) ===\n`,
        );
      }
    }
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
