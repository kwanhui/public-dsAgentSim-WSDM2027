// Usage:
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
//   tsx scripts/replay/agent-runs.ts --base-url <url> --cohort-id <uuid> \
//       [--count 2] [--labels A1,A2] [--analyst-models claude-sonnet-5,claude-haiku-4-5] \
//       [--scenario customer-churn] [--log <file>] [--out <result.json>] [--resume]
//
// Runs N analyst-agent runs in the cohort, one after another, each driven
// through all six stages and waited on until it completes (agent-run.ts).
// The runs are sequential on purpose: two runs in flight at once would share
// the deployment's rate limits and make their latencies incomparable.
// Stops at the first run that does not complete, and exits non-zero.
//
// --resume reads the earlier --out file: a run recorded as completed is
// skipped (logged), and a run recorded as active is continued in place from
// its current stage rather than restarted, so no stage is paid for twice.
//
// --analyst-models gives each run its own analyst model, in label order (an
// empty entry keeps the deployment's analyst model for that run); each such
// run is started through the instructor-only agent-run route.
import { existsSync, readFileSync } from "node:fs";
import { StepLog, flag, signInAdmin, writeJson } from "./common";
import { driveAgentRun, type AgentRunResult } from "./agent-run";

async function main() {
  const argv = process.argv.slice(2);
  const base = flag(argv, "base-url") ?? "";
  const cohortId = flag(argv, "cohort-id") ?? "";
  if (!base || !cohortId) throw new Error("Usage: agent-runs.ts --base-url <url> --cohort-id <uuid> [--count N] [--labels A1,A2] [--scenario id] [--log f] [--out f]");
  const count = Number(flag(argv, "count") ?? 2);
  const labels = (flag(argv, "labels") ?? "").split(",").filter(Boolean);
  while (labels.length < count) labels.push(`A${labels.length + 1}`);
  const scenarioId = flag(argv, "scenario") ?? "customer-churn";
  const analystModels = (flag(argv, "analyst-models") ?? "").split(",").map((m) => m.trim());
  const logFile = flag(argv, "log");
  const out = flag(argv, "out");

  const log = new StepLog("agent-runs", logFile);
  const admin = await signInAdmin(base, log);
  const results: AgentRunResult[] = [];
  const prior: AgentRunResult[] =
    argv.includes("--resume") && out && existsSync(out)
      ? ((JSON.parse(readFileSync(out, "utf8")) as { runs?: AgentRunResult[] }).runs ?? [])
      : [];
  try {
    for (let i = 0; i < count; i++) {
      const label = labels[i];
      const analystModel = analystModels[i] || null;
      const earlier = prior.find((p) => p.label === label && p.engagementId);
      if (earlier?.ok && earlier.status === "completed") {
        log.line(`RESUME: skipping ${label}, already completed (${earlier.engagementId})`);
        results.push(earlier);
        continue;
      }
      const r = await driveAgentRun(admin.page, {
        cohortId,
        scenarioId,
        label,
        analystModel,
        resumeRunId: earlier?.engagementId || undefined,
        log: new StepLog(label, logFile),
      });
      if (earlier) r.stagesDriven += earlier.stagesDriven;
      results.push(r);
      if (!r.ok) {
        log.line(`STOPPED: run ${label} (${r.engagementId || "not started"}) ended ${r.status || "without a status"}${r.error ? `: ${r.error}` : ""}`);
        break;
      }
    }
  } finally {
    await admin.browser.close().catch(() => undefined);
    if (out) writeJson(out, { cohortId, scenarioId, runs: results });
  }
  if (results.length < count || results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});
