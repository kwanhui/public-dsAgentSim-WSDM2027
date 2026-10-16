// Usage:
//   tsx scripts/replay/run-map.ts --dir <regen output dir> --snapshot <exported snapshot.json> \
//       --out <paper-runs.env> [--installed-snapshot demo/showcase-snapshot.json] [--commit <sha>]
//
// Writes the pinned run map behind section 5 (paper-runs.env) from the
// results the regeneration drivers left in --dir (cohort.json,
// cohort-final.json, human-reference.json, agent-runs.json,
// fail-then-revise.json), after checking that every run is in the exported
// snapshot. It rewrites the snapshot in place: learner session rows are
// dropped and invite tokens redacted, and when the deployment refused reviewer
// visibility at finalize, the cohort config is set here instead
// (reviewerVisible, the compare pair and the run labels), and the env file
// says so.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { flag } from "./common";

type Json = Record<string, unknown>;
const read = (p: string): Json => JSON.parse(readFileSync(p, "utf8")) as Json;

function main() {
  const argv = process.argv.slice(2);
  const dir = flag(argv, "dir");
  const snapshotPath = flag(argv, "snapshot");
  const out = flag(argv, "out");
  if (!dir || !snapshotPath || !out) throw new Error("Usage: run-map.ts --dir <dir> --snapshot <file> --out <paper-runs.env>");
  const installed = flag(argv, "installed-snapshot") ?? "demo/showcase-snapshot.json";
  const commit = flag(argv, "commit") ?? "unknown";

  const human = read(join(dir, "human-reference.json"));
  const agents = read(join(dir, "agent-runs.json")) as {
    runs: { label: string; engagementId: string; ok: boolean; requestedAnalystModel?: string | null; analystModel?: string | null }[];
  };
  const exhibit = read(join(dir, "fail-then-revise.json"));
  const final = read(join(dir, "cohort-final.json"));

  const runs: { label: string; id: string; group: string }[] = [
    { label: String(human.label), id: String(human.engagementId), group: "exemplar" },
    ...agents.runs.map((r) => ({ label: r.label, id: r.engagementId, group: "paper" })),
    { label: String(exhibit.label), id: String(exhibit.engagementId), group: "context" },
  ];

  const snap = read(snapshotPath) as {
    cohort: { id: string; slug: string };
    tables: { cohorts: Json[]; engagements: Json[] };
  };
  const inSnapshot = new Set(snap.tables.engagements.map((e) => String(e.id)));
  const missing = runs.filter((r) => !inSnapshot.has(r.id));
  if (missing.length) throw new Error(`runs missing from ${snapshotPath}: ${missing.map((r) => `${r.label}=${r.id}`).join(", ")}`);

  // A published snapshot carries no way into the live instance: learner
  // sessions (cookie tokens) are dropped and invite tokens are redacted, as in
  // the committed snapshot.
  const tables = snap.tables as unknown as Record<string, Json[]> & { cohortInvites?: Json[]; studentSessions?: Json[] };
  const counts = (snap as unknown as { counts: Record<string, number> }).counts;
  const sessions = tables.studentSessions?.length ?? 0;
  tables.studentSessions = [];
  counts.studentSessions = 0;
  for (const inv of tables.cohortInvites ?? []) inv.token = `redacted-${String(inv.id).slice(0, 8)}`;
  console.log(`snapshot: dropped ${sessions} learner session row(s), redacted ${tables.cohortInvites?.length ?? 0} invite token(s)`);

  let visibilityNote = "set on the deployment";
  if (!final.reviewerVisible) {
    const cohort = snap.tables.cohorts[0] as { configJson: { showcase?: Json } };
    cohort.configJson.showcase = {
      ...(cohort.configJson.showcase ?? {}),
      reviewerVisible: true,
      comparePair: final.comparePair ?? null,
      labels: final.labels ?? {},
      h1Patch: final.h1Patch ?? null,
    };
    visibilityNote = "refused by the deployment, set in the exported snapshot";
    console.log(`reviewerVisible ${visibilityNote}`);
  }

  writeFileSync(snapshotPath, JSON.stringify(snap, null, 2) + "\n");

  const spec = runs.map((r) => `${r.label}=${r.id}:${r.group}`).join(",");
  const lines = [
    "# Pinned run map behind the paper's section 5. Sourced by",
    "# scripts/paper-metrics/section5.sh (make section5), which restores",
    "# SECTION5_SNAPSHOT into a fresh PGlite directory and runs make paper-metrics",
    "# with these runs. Written by scripts/replay/run-map.ts; do not edit by hand.",
    `# Written ${new Date().toISOString()} at tool commit ${commit}.`,
    `# Reviewer visibility: ${visibilityNote}.`,
    `# H1 replay patch: ${human.patch ? `${(human.patch as Json).file} sha256 ${(human.patch as Json).sha256}` : "none (verbatim replay)"}.`,
    `# Analyst models: ${agents.runs.map((r) => `${r.label}=${r.analystModel ?? "deployment default"}${r.requestedAnalystModel && r.requestedAnalystModel !== r.analystModel ? ` (requested ${r.requestedAnalystModel})` : ""}`).join(", ")}.`,
    `SECTION5_SNAPSHOT=${installed}`,
    `SECTION5_COHORT=${snap.cohort.slug}`,
    `SECTION5_RUNS="${spec}"`,
    // Every run in a regenerated cohort is fully metered and under the audit
    // floor, so no historical cutoff is passed.
    `SECTION5_ARGS=""`,
    "",
  ];
  writeFileSync(out, lines.join("\n"));
  console.log(`Wrote ${out}: ${spec}`);
}

main();
