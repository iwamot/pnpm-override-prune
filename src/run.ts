import { parseArgs } from "./args.ts";
import { formatHelp, formatVersion } from "./format.ts";

export interface SyncOutcome {
  readonly kind: "sync";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AuditRequest {
  readonly kind: "audit";
  readonly path: string;
  readonly fix: boolean;
}

export type RunDecision = SyncOutcome | AuditRequest;

export function decideRun(
  argv: readonly string[],
  version: string,
): RunDecision {
  const parsed = parseArgs(argv);
  switch (parsed.kind) {
    case "version":
      return {
        kind: "sync",
        exitCode: 0,
        stdout: formatVersion(version),
        stderr: "",
      };
    case "help":
      return {
        kind: "sync",
        exitCode: 0,
        stdout: formatHelp(),
        stderr: "",
      };
    case "error":
      return {
        kind: "sync",
        exitCode: 2,
        stdout: "",
        stderr: `error: ${parsed.message}\n`,
      };
    case "audit":
      return {
        kind: "audit",
        path: parsed.path,
        fix: parsed.fix,
      };
  }
}
