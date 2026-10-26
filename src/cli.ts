import { runAudit } from "./core.ts";
import { decideRun } from "./run.ts";
import { VERSION } from "./version.ts";

const decision = decideRun(process.argv.slice(2), VERSION);

if (decision.kind === "sync") {
  if (decision.stdout) {
    process.stdout.write(decision.stdout);
  }
  if (decision.stderr) {
    process.stderr.write(decision.stderr);
  }
  process.exitCode = decision.exitCode;
} else {
  process.exitCode = await runAudit(decision.path, decision.fix);
}
