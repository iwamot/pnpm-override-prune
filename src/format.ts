import type { Override, OverrideSource } from "./manifest.ts";
import type { AuditEntry } from "./pipeline.ts";

export const LABELS = {
  prune: "[PRUNE]",
  keep: "[KEEP] ",
  skip: "[SKIP] ",
  error: "[ERROR]",
} as const;

export const SOURCE_ORDER: readonly OverrideSource[] = [
  "package.json:overrides",
  "package.json:pnpm.overrides",
  "package.json:aube.overrides",
  "package.json:resolutions",
  "pnpm-workspace.yaml",
  "aube-workspace.yaml",
];

export function entryDisplay(override: Override): string {
  return `${override.key} ${override.spec}`;
}

export function entryWidth(overrides: readonly Override[]): number {
  if (overrides.length === 0) {
    return 0;
  }
  return Math.max(...overrides.map((o) => entryDisplay(o).length));
}

export function formatSectionHeader(
  source: OverrideSource,
  count: number,
): string {
  const word = count === 1 ? "entry" : "entries";
  return `=== ${source} (${count} ${word}) ===\n`;
}

export function formatLine(entry: AuditEntry, width: number): string {
  const label = LABELS[entry.result.status];
  const display = entryDisplay(entry.override).padEnd(width);
  return `${label} ${display}  ${entry.result.value}\n`;
}

export interface SummaryOptions {
  readonly prunableCount: number;
  readonly errorCount: number;
  readonly fixed: boolean;
}

function entryWord(count: number): string {
  return count === 1 ? "entry" : "entries";
}

export function formatSummary(opts: SummaryOptions): string {
  const lines: string[] = [];
  if (opts.fixed && opts.prunableCount > 0) {
    lines.push(
      `Pruned ${opts.prunableCount} ${entryWord(opts.prunableCount)}.`,
    );
  } else if (opts.prunableCount > 0) {
    lines.push("Run with --fix to prune entries marked [PRUNE].");
  } else {
    lines.push("No prunable entries found.");
  }
  if (opts.errorCount > 0) {
    lines.push(
      `${opts.errorCount} ${entryWord(opts.errorCount)} could not be evaluated.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// An entry that could not be evaluated means the audit is incomplete, which
// outranks everything else: a clean-looking run that skipped its checks must
// not pass CI.
export function exitCodeFor(opts: SummaryOptions): number {
  if (opts.errorCount > 0) {
    return 2;
  }
  if (opts.prunableCount > 0 && !opts.fixed) {
    return 1;
  }
  return 0;
}

export function formatVersion(version: string): string {
  return `pnpm-override-prune ${version}\n`;
}

export function formatHelp(): string {
  return [
    "Usage: pnpm-override-prune [path] [options]",
    "",
    "Detect prunable pnpm.overrides entries by checking the npm registry",
    "against the local pnpm-lock.yaml / aube-lock.yaml.",
    "",
    "Arguments:",
    "  path           Path to package.json (default: ./package.json)",
    "",
    "Options:",
    "  --fix          Remove prunable entries in place",
    "  -v, --version  Print the version and exit",
    "  -h, --help     Print this help and exit",
    "",
  ].join("\n");
}
