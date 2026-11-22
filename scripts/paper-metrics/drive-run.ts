// Usage:
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
//   tsx scripts/paper-metrics/drive-run.ts --base-url <url> --cohort-id <uuid> --label A5 \
//       [--scenario customer-churn] [--log <file>]
//
// Operator tool: drives ONE new analyst-agent run through all six stages on
// the instance at --base-url. On a deployment with a paid provider this makes
// paid model calls. The driving logic lives in scripts/replay/agent-run.ts;
// scripts/replay/agent-runs.ts runs several in a row.
import { StepLog, flag, signInAdmin } from "../replay/common";
import { driveAgentRun } from "../replay/agent-run";

async function main() {
  const argv = process.argv.slice(2);
  const base = flag(argv, "base-url") ?? "";
  const cohortId = flag(argv, "cohort-id") ?? "";
  const label = flag(argv, "label") ?? "A?";
  if (!base || !cohortId) {
    throw new Error("Usage: drive-run.ts --base-url <url> --cohort-id <uuid> --label <label> [--scenario <id>] [--log <file>]");
  }
  const log = new StepLog(label, flag(argv, "log"));
  const admin = await signInAdmin(base, log);
  try {
    const r = await driveAgentRun(admin.page, {
      cohortId,
      scenarioId: flag(argv, "scenario") ?? "customer-churn",
      label,
      log,
    });
    if (!r.ok) process.exitCode = 1;
  } finally {
    await admin.browser.close();
  }
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});
