// Usage:
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
//   tsx scripts/replay/fail-then-revise.ts --base-url <url> --cohort-id <uuid> \
//       [--fixture scripts/replay/fixtures/fail-then-revise.json] [--apply scenario-v2] \
//       [--label exhibit] [--log <file>] [--out <result.json>] [--delay-ms 0] [--timeout-ms 600000] [--lenient-gates]
//
// Creates the fail-then-revise exhibit: a learner who scopes the problem with
// the client, gets the extract from the data owner, submits a data-audit memo
// with a false row count and a line addressed to the assessor, is held at the
// gate, and then submits the corrected memo. The engagement is left at the
// cleaning stage, as recorded. Exits non-zero if the first memo passes the
// gate or the corrected one does not. --lenient-gates logs those mismatches
// instead; it exists for the mock provider, whose judge passes everything.
import { StepLog, flag } from "./common";
import { loadFixture } from "./fixture";
import { runReplay } from "./replay";

async function main() {
  const argv = process.argv.slice(2);
  const base = flag(argv, "base-url") ?? "";
  const cohortId = flag(argv, "cohort-id") ?? "";
  if (!base || !cohortId) throw new Error("Usage: fail-then-revise.ts --base-url <url> --cohort-id <uuid> [--fixture f] [--apply sets] [--label exhibit] [--log f] [--out f]");
  const fixture = loadFixture(flag(argv, "fixture") ?? "scripts/replay/fixtures/fail-then-revise.json");
  const applyArg = flag(argv, "apply");
  const label = flag(argv, "label") ?? "exhibit";
  const result = await runReplay({
    base,
    cohortId,
    fixture,
    apply: applyArg !== undefined ? applyArg.split(",").filter(Boolean) : (fixture.defaultApply ?? []),
    label,
    log: new StepLog(label, flag(argv, "log")),
    out: flag(argv, "out"),
    delayMs: Number(flag(argv, "delay-ms") ?? 0),
    timeoutMs: Number(flag(argv, "timeout-ms") ?? 600_000),
    lenientGates: argv.includes("--lenient-gates"),
  });
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});
