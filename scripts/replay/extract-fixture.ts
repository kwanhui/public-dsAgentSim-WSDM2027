// Usage:
//   tsx scripts/replay/extract-fixture.ts --in demo/showcase-snapshot.json \
//       --engagement <id> --out scripts/replay/fixtures/<name>.json
//
// Writes the learner side of one recorded engagement as a replay fixture:
// every learner chat message and every gate submission, merged in the order
// they happened. Reflection text is never copied. When --out already exists,
// its hand-written keys (dataRequest, expect, substitutions, defaultApply,
// notes) are kept and only `source` and `timeline` are replaced, so the
// fixture can be re-extracted from a new snapshot without losing them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { flag } from "../paper-metrics/source";
import type { ReplayFixture, TimelineStep } from "./fixture";

type Row = Record<string, unknown>;

function main() {
  const argv = process.argv.slice(2);
  const input = flag(argv, "in");
  const engagementId = flag(argv, "engagement");
  const out = flag(argv, "out");
  if (!input || !engagementId || !out) {
    throw new Error("Usage: extract-fixture.ts --in <snapshot.json> --engagement <id> --out <fixture.json>");
  }
  const snap = JSON.parse(readFileSync(input, "utf8")) as {
    exportedAt: string;
    cohort: { slug: string };
    tables: Record<string, Row[]>;
  };
  const eng = snap.tables.engagements.find((e) => String(e.id).startsWith(engagementId));
  if (!eng) throw new Error(`No engagement ${engagementId} in ${input}`);
  const eid = String(eng.id);

  const persona = new Map(snap.tables.channels.filter((c) => c.engagementId === eid).map((c) => [c.id, String(c.personaId)]));
  const submissions = snap.tables.submissions
    .filter((s) => s.engagementId === eid)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  // The stage a message was sent in is the stage of the first submission made
  // after it (the learner cannot leave a stage without submitting).
  const stageAt = (iso: string): string => {
    const next = submissions.find((s) => String(s.createdAt) > iso);
    return next ? String(next.stage) : String(eng.currentStage);
  };

  // index is set once the steps are in recorded order.
  const steps: TimelineStep[] = [];
  for (const m of snap.tables.messages) {
    if (m.engagementId !== eid || m.sender !== "learner") continue;
    const iso = String(m.timestampIso);
    steps.push({ kind: "message", index: 0, recordedAt: iso, stage: stageAt(iso), personaId: persona.get(m.channelId) ?? "?", text: String(m.content) });
  }
  const attempts = new Map<string, number>();
  for (const s of submissions) {
    const stage = String(s.stage);
    const attempt = (attempts.get(stage) ?? 0) + 1;
    attempts.set(stage, attempt);
    steps.push({ kind: "submit", index: 0, recordedAt: String(s.createdAt), stage, artifactKind: String(s.kind), attempt, text: String(s.contentText) });
  }
  steps.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const timeline = steps.map((s, index) => ({ ...s, index }));

  const previous: Partial<ReplayFixture> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  const fixture: ReplayFixture = {
    ...previous,
    format: "agenticpracticum-replay-fixture",
    formatVersion: 1,
    source: {
      snapshot: input,
      snapshotExportedAt: snap.exportedAt,
      cohortSlug: snap.cohort.slug,
      engagementId: eid,
      scenarioId: String(eng.scenarioId),
      learnerMessages: timeline.filter((s) => s.kind === "message").length,
      submissions: timeline.filter((s) => s.kind === "submit").length,
    },
    timeline,
  };
  writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(
    `Wrote ${out}: ${fixture.source.learnerMessages} learner messages, ${fixture.source.submissions} submissions from ${eid}`,
  );
}

main();
