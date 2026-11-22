// Usage:
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
//   tsx scripts/replay/cohort.ts create --base-url <url> --name "Showcase: ..." \
//       [--scenario customer-churn] --out <cohort.json>
//   tsx scripts/replay/cohort.ts finalize --base-url <url> --cohort-id <uuid> \
//       --human <engagement-id> --agent <engagement-id> --labels "H1=<id>,A1=<id>,..." \
//       [--scripted "H1,exhibit"] \
//       [--h1-patch <file>:<sha256>] [--scenario customer-churn] --out <final.json>
//
// create: makes the showcase cohort through the admin form and sets its
// config: one scenario, gated at 0.6 with two retries, check-ins, reflections
// and open join off, and visible to the read-only reviewer account.
// finalize: labels the runs (showcase.labels), records the replay patch
// applied to H1 (showcase.h1Patch, file and sha256), pins the compare view's
// default pair and sets reviewer visibility again once the runs exist. If the deployment refuses reviewer
// visibility (for example on a cohort with invited learners), the refusal is
// recorded in --out with reviewerVisible false, and the caller decides what
// to do (scripts/replay/regen.sh sets it in the exported snapshot instead).
import { StepLog, createCohort, flag, patchCohortConfig, showcaseConfig, signInAdmin, writeJson } from "./common";

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const base = flag(argv, "base-url") ?? "";
  const out = flag(argv, "out");
  const scenarioId = flag(argv, "scenario") ?? "customer-churn";
  if (!base || !out || (cmd !== "create" && cmd !== "finalize")) {
    throw new Error("Usage: cohort.ts create|finalize --base-url <url> --out <file> ...");
  }
  const log = new StepLog(`cohort ${cmd}`, flag(argv, "log"));
  const admin = await signInAdmin(base, log);
  try {
    let cohortId: string;
    let comparePair: { human: string; agent: string } | null = null;
    const labels: Record<string, string> = {};
    let h1Patch: { file: string; sha256: string } | null = null;
    const scriptedReplays: string[] = [];
    if (cmd === "create") {
      const name = flag(argv, "name") ?? `Showcase ${new Date().toISOString().slice(0, 10)}`;
      cohortId = await createCohort(admin, name);
      log.line("COHORT ID", cohortId, JSON.stringify(name));
    } else {
      cohortId = flag(argv, "cohort-id") ?? "";
      const human = flag(argv, "human") ?? "";
      const agent = flag(argv, "agent") ?? "";
      if (!cohortId || !human || !agent) throw new Error("finalize needs --cohort-id, --human and --agent");
      comparePair = { human, agent };
      for (const item of (flag(argv, "labels") ?? "").split(",").filter(Boolean)) {
        const [label, id] = item.split("=");
        if (!label || !id) throw new Error(`--labels entry ${item} is not label=engagement-id`);
        labels[id.trim()] = label.trim();
      }
      // The labelled runs these scripts replayed rather than drove live:
      // H1 and the exhibit by default (--scripted "H1,exhibit").
      const scriptedLabels = new Set(
        (flag(argv, "scripted") ?? "H1,exhibit").split(",").map((l) => l.trim()).filter(Boolean),
      );
      for (const [id, label] of Object.entries(labels)) {
        if (scriptedLabels.has(label)) scriptedReplays.push(id);
      }
      const patchArg = flag(argv, "h1-patch");
      if (patchArg) {
        const at = patchArg.lastIndexOf(":");
        const file = patchArg.slice(0, at);
        const sha256 = patchArg.slice(at + 1);
        if (at <= 0 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`--h1-patch ${patchArg} is not <file>:<sha256>`);
        h1Patch = { file, sha256 };
      }
    }

    let res = await patchCohortConfig(admin, cohortId, showcaseConfig({ scenarioId, reviewerVisible: true, comparePair, labels, h1Patch, scriptedReplays }));
    let reviewerVisible = true;
    let refusal: unknown = null;
    if (!res.ok) {
      log.line(`reviewer visibility refused (HTTP ${res.status}):`, JSON.stringify(res.body));
      refusal = res.body;
      reviewerVisible = false;
      res = await patchCohortConfig(admin, cohortId, showcaseConfig({ scenarioId, reviewerVisible: false, comparePair, labels, h1Patch, scriptedReplays }));
      if (!res.ok) throw new Error(`cohort config refused (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }
    log.line("config set:", `gated 0.6/2, scenario ${scenarioId}, reviewerVisible ${reviewerVisible}`, comparePair ? `comparePair ${comparePair.human} vs ${comparePair.agent}` : "", Object.keys(labels).length ? `labels ${JSON.stringify(labels)}` : "", h1Patch ? `h1Patch ${h1Patch.file} ${h1Patch.sha256}` : "");
    writeJson(out, { cohortId, scenarioId, reviewerVisible, comparePair, labels, scriptedReplays, h1Patch, refusal });
  } finally {
    await admin.browser.close().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});
