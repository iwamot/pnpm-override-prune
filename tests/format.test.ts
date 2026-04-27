import { describe, expect, it } from "bun:test";
import {
  entryDisplay,
  entryWidth,
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
  it("places top-level overrides first, then pnpm.overrides, then workspace yamls", () => {
    expect(SOURCE_ORDER).toEqual([
      "package.json:overrides",
      "package.json:pnpm.overrides",
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
  it("renders label, padded display, and value", () => {
    const entry: AuditEntry = {
      override: PKG("foo", ">=1.0.0"),
      result: { status: "prune", value: "1.5.0" },
    };
    expect(formatLine(entry, 20)).toBe("[PRUNE] foo >=1.0.0           1.5.0\n");
  });

  it("uses the appropriate label for each status", () => {
    const make = (status: "prune" | "keep" | "skip" | "error"): AuditEntry => ({
      override: PKG("foo", ">=1.0.0"),
      result: { status, value: "x" },
    });
    expect(formatLine(make("prune"), 11)).toContain("[PRUNE]");
    expect(formatLine(make("keep"), 11)).toContain("[KEEP] ");
    expect(formatLine(make("skip"), 11)).toContain("[SKIP] ");
    expect(formatLine(make("error"), 11)).toContain("[ERROR]");
  });
});

describe("formatSummary", () => {
  it("clean (no prunable, not fixed)", () => {
    expect(formatSummary({ prunableCount: 0, fixed: false })).toBe(
      "No prunable entries found.\n",
    );
  });

  it("clean after fix (no prunable, fixed)", () => {
    expect(formatSummary({ prunableCount: 0, fixed: true })).toBe(
      "No prunable entries found.\n",
    );
  });

  it("prunable found, not fixed", () => {
    expect(formatSummary({ prunableCount: 2, fixed: false })).toBe(
      "Run with --fix to prune entries marked [PRUNE].\n",
    );
  });

  it("prunable fixed (singular)", () => {
    expect(formatSummary({ prunableCount: 1, fixed: true })).toBe(
      "Pruned 1 entry.\n",
    );
  });

  it("prunable fixed (plural)", () => {
    expect(formatSummary({ prunableCount: 5, fixed: true })).toBe(
      "Pruned 5 entries.\n",
    );
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
    expect(text).toContain("-V, --version");
    expect(text).toContain("-h, --help");
  });
});
