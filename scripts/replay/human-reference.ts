// Usage:
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
//   tsx scripts/replay/human-reference.ts --base-url <url> --cohort-id <uuid> \
//       [--fixture scripts/replay/fixtures/human-reference.json] \
//       [--patch scripts/replay/patches/h1-current-scenario.json | --no-patch] [--apply <sets>] \
//       [--label H1] [--log <file>] [--out <result.json>] [--delay-ms 0] [--timeout-ms 600000] [--lenient-gates]
//
// Plays the reference human run (H1 of the showcase cohort: 19 learner
// messages and six gate artifacts) as a scripted learner on a fresh invite in
// the given cohort. See replay.ts for how it follows the transcript when the
// persona replies differ from the recording. Exits non-zero when it stops.
//
// By default the artifacts are patched with
// scripts/replay/patches/h1-current-scenario.json (the current scenario's
// facts and one arithmetic fix; every replacement is logged and the file's
// sha256 goes into --out). --no-patch replays the recording verbatim.
// --apply adds named substitution sets from the fixture; none is applied by
// default.
import { StepLog, flag } from "./common";
import { DEFAULT_H1_PATCH, loadFixture, loadPatch } from "./fixture";
import { runReplay } from "./replay";

async function main() {
  const argv = process.argv.slice(2);
  const base = flag(argv, "base-url") ?? "";
  const cohortId = flag(argv, "cohort-id") ?? "";
  if (!base || !cohortId) throw new Error("Usage: human-reference.ts --base-url <url> --cohort-id <uuid> [--fixture f] [--apply sets] [--label H1] [--log f] [--out f]");
  const fixture = loadFixture(flag(argv, "fixture") ?? "scripts/replay/fixtures/human-reference.json");
  const applyArg = flag(argv, "apply");
  const label = flag(argv, "label") ?? "H1";
  const noPatch = argv.includes("--no-patch");
  if (noPatch && flag(argv, "patch")) throw new Error("--patch and --no-patch are exclusive");
  const patch = noPatch ? undefined : loadPatch(flag(argv, "patch") ?? DEFAULT_H1_PATCH);
  const result = await runReplay({
    base,
    cohortId,
    fixture,
    apply: applyArg !== undefined ? applyArg.split(",").filter(Boolean) : (fixture.defaultApply ?? []),
    patch,
    label,
    log: new StepLog(label, flag(argv, "log")),
    out: flag(argv, "out"),
    delayMs: Number(flag(argv, "delay-ms") ?? 0),
    timeoutMs: Number(flag(argv, "timeout-ms") ?? 600_000),
    lenientGates: argv.includes("--lenient-gates"),
  });
  if (!result.ok) process.exit(1);
  if (result.finalStatus !== "completed") {
    console.error(`${label}: the replay ran every step but the engagement is ${result.finalStatus} at ${result.finalStage}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});
