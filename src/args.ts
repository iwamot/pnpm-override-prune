import { parseArgs as nodeParseArgs } from "node:util";

export type ParsedArgs =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "audit"; readonly path: string; readonly fix: boolean }
  | { readonly kind: "error"; readonly message: string };

export const DEFAULT_PACKAGE_JSON_PATH = "./package.json";

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let values: Record<string, unknown>;
  let positionals: readonly string[];
  try {
    const parsed = nodeParseArgs({
      args: [...argv],
      options: {
        version: { type: "boolean", short: "V" },
        help: { type: "boolean", short: "h" },
        fix: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    return {
      kind: "error",
      message: e instanceof Error ? e.message : "argument parse error",
    };
  }
  if (values.version === true) {
    return { kind: "version" };
  }
  if (values.help === true) {
    return { kind: "help" };
  }
  if (positionals.length > 1) {
    return {
      kind: "error",
      message: `expected at most one positional argument, got ${positionals.length}`,
    };
  }
  return {
    kind: "audit",
    path: positionals[0] ?? DEFAULT_PACKAGE_JSON_PATH,
    fix: values.fix === true,
  };
}
