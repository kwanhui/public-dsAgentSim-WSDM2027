// Usage:
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
//   tsx scripts/replay/probes.ts --base-url <url> --out <dir> \
//       [--cohort-id <uuid> | --cohort-name "Leak probes"] [--seeds 1] [--only p01-...,p06-...] \
//       [--timeout-ms 600000] [--log <file>] [--list]
//
// Runs the scripted learner probes (scripts/replay/probes/round5.ts)
// against the server at --base-url, each as a fresh learner in a "Leak
// probes" cohort (created unless --cohort-id names one): gated at 0.6 with
// two retries like the showcase, every persona reply audited
// (consistencyAuditRate 1) so each reply gets an early-disclosure verdict,
// check-ins, reflections and open join off, not reviewer-visible.
//
// Each probe first reaches its start stage with competent prerequisite work
// (a prerequisite artifact held at its gate is resubmitted unchanged until
// the gate opens after its retries), then sends its own steps. The runner
// records every reply, release, submission outcome, learner-facing score,
// rationale and improve line, and the full transcripts. After the last probe
// it pulls the cohort's events, scores and engagements exports as the
// instructor, and files each probe's events under the step whose window they
// fall in: releases and withheld releases, elicitation rows (fact_elicited
// with verified, detection, matchedKey), audits (persona_consistency) and
// early-disclosure verdicts, frictions, style retries and reaction-leak
// filters. It writes one JSON per probe run, summary.json and summary.md to
// --out, with the raw CSVs. --seeds repeats every probe (three seeds are recommended).
//
// The runner does not judge the probes; it computes a few mechanical signals
// per probe (named in each probe's `check`). Exits non-zero only when a probe
// could not be run.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadScenario } from "@/lib/scenarios/load";

import {
  ReplayStop,
  StepLog,
  createCohort,
  excerpt,
  flag,
  newLearner,
  patchCohortConfig,
  signInAdmin,
  writeJson,
  type AdminSession,
  type LearnerSession,
} from "./common";
import { DEFAULT_COHORT_CONFIG, type CohortConfig } from "../../lib/cohort/defaults";
import { ROUND5_PROBES, prelude, type ProbeStep } from "./probes/round5";
import { parseCsv } from "./csv";
import { probeSignals, type ProbeRun, type StepRecord } from "./probes/signals";

type Json = Record<string, unknown>;

function probesCohortConfig(): CohortConfig {
  const base = structuredClone(DEFAULT_COHORT_CONFIG);
  return {
    ...base,
    scenarios: { allowed: ["customer-churn", "customer-segmentation", "demand-forecasting"] },
    gates: { minScoreRatio: 0.6, maxRetries: 2 },
    ui: { showRubricScores: true },
    research: { ...base.research, checkins: false, reflections: false, consistencyAuditRate: 1 },
    sandbox: { ...base.sandbox, openJoin: false },
    showcase: { ...base.showcase, reviewerVisible: false, labels: {}, comparePair: null },
  };
}

async function channelMessages(learner: LearnerSession, channelId: string) {
  const res = await learner.request.get(`/api/chat?channelId=${encodeURIComponent(channelId)}`);
  if (!res.ok()) return [];
  const body = (await res.json()) as { messages: { sender: string; content: string; timestampIso: string }[] };
  return body.messages.map((m) => ({ sender: m.sender, content: m.content, at: m.timestampIso }));
}

async function runStep(
  learner: LearnerSession,
  step: ProbeStep,
  phase: "prelude" | "probe",
  opts: { timeoutMs: number; maxAttempts: number; log: StepLog },
): Promise<StepRecord[]> {
  const out: StepRecord[] = [];
  if (step.kind === "message") {
    const st = await learner.state();
    const ch = st.channels.find((c) => c.personaId === step.personaId);
    if (!ch) throw new ReplayStop(`no channel for ${step.personaId}`);
    if (!ch.unlocked) throw new ReplayStop(`${step.personaId} channel is locked at ${st.engagement.currentStage}`);
    const startedAt = new Date().toISOString();
    opts.log.line(`${phase} -> ${step.personaId}:`, excerpt(step.text));
    const res = await learner.send(ch.id, step.text, opts.timeoutMs);
    const reply = res.body.message?.content ?? "";
    opts.log.line(`  ${step.personaId} [${res.status}]:`, excerpt(reply), (res.body.releasedFiles ?? []).length ? `[released ${res.body.releasedFiles!.join(",")}]` : "");
    out.push({
      phase,
      kind: "message",
      target: step.personaId,
      note: step.note,
      sent: step.text,
      startedAt,
      endedAt: new Date().toISOString(),
      status: res.status,
      reply,
      releasedFiles: res.body.releasedFiles ?? [],
    });
    if (res.status !== 200) throw new ReplayStop(`chat failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    return out;
  }

  // A submission. In a prelude it must advance: a held prerequisite is
  // resubmitted unchanged until the gate opens after its retries.
  for (let attempt = 1; attempt <= (phase === "prelude" ? opts.maxAttempts : 1); attempt++) {
    const before = await learner.state();
    const client = before.channels.find((c) => c.personaId === "client");
    const clientBefore = client ? (await channelMessages(learner, client.id)).length : 0;
    const startedAt = new Date().toISOString();
    opts.log.line(`${phase} submit at ${before.engagement.currentStage} (${step.text.length} chars), attempt ${attempt}`);
    const res = await learner.submit(step.text, opts.timeoutMs);
    const b = res.body;
    const clientAfter = client ? await channelMessages(learner, client.id) : [];
    const reaction = clientAfter.slice(clientBefore).filter((m) => m.sender !== "learner").map((m) => m.content).join("\n\n");
    opts.log.line(`  gate [${res.status}]: passed=${b.passed} advanced=${b.advanced} score=${b.scoreRatio ?? "hidden"}`, reaction ? `reaction: ${excerpt(reaction)}` : "");
    out.push({
      phase,
      kind: "submit",
      target: before.engagement.currentStage,
      note: step.note,
      sent: step.text,
      startedAt,
      endedAt: new Date().toISOString(),
      status: res.status,
      submit: {
        attempt: b.attempt ?? attempt,
        passed: b.passed,
        advanced: b.advanced,
        completed: b.engagementCompleted,
        scoreRatio: b.scoreRatio ?? null,
        reason: b.reason,
        stage: before.engagement.currentStage,
      },
      reaction,
    });
    if (res.status !== 200) throw new ReplayStop(`submission failed: HTTP ${res.status} ${JSON.stringify(b)}`);
    if (phase === "probe" || b.advanced || b.engagementCompleted) return out;
    opts.log.line("  prerequisite held at the gate; resubmitting it unchanged");
  }
  throw new ReplayStop(`the prerequisite artifact did not advance after ${opts.maxAttempts} attempts`);
}

async function pullExports(admin: AdminSession, cohortId: string, out: string) {
  const got: Record<string, Record<string, string>[]> = {};
  for (const what of ["events", "scores", "engagements"]) {
    const res = await admin.context.request.get(`/api/admin/cohorts/${cohortId}/export?what=${what}`);
    const text = res.ok() ? await res.text() : "";
    writeFileSync(join(out, `probes-${what}.csv`), text);
    got[what] = parseCsv(text);
  }
  return got;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    for (const p of ROUND5_PROBES) console.log(`${p.id}\t#${p.number}\t${p.scenario}\t${p.start}\t${p.title}`);
    return;
  }
  const base = flag(argv, "base-url") ?? "";
  const out = flag(argv, "out") ?? "";
  if (!base || !out) throw new Error("Usage: probes.ts --base-url <url> --out <dir> [--cohort-id id] [--seeds N] [--only ids]");
  mkdirSync(out, { recursive: true });
  const seeds = Number(flag(argv, "seeds") ?? 1);
  const only = (flag(argv, "only") ?? "").split(",").filter(Boolean);
  const timeoutMs = Number(flag(argv, "timeout-ms") ?? 600_000);
  const log = new StepLog("probes", flag(argv, "log") ?? join(out, "probes.log"));
  const probes = ROUND5_PROBES.filter((p) => only.length === 0 || only.includes(p.id));
  if (probes.length === 0) throw new Error(`--only matched no probe; see --list`);

  const admin = await signInAdmin(base, log);
  const runs: ProbeRun[] = [];
  let cohortId = flag(argv, "cohort-id") ?? "";
  try {
    const config = probesCohortConfig();
    if (!cohortId) {
      cohortId = await createCohort(admin, flag(argv, "cohort-name") ?? "Leak probes");
      log.line("COHORT ID", cohortId);
    }
    const patched = await patchCohortConfig(admin, cohortId, config);
    if (!patched.ok) throw new Error(`probe cohort config refused: HTTP ${patched.status} ${JSON.stringify(patched.body)}`);
    const maxAttempts = config.gates.maxRetries + 1;
    const health = (await (await admin.context.request.get("/api/health")).json().catch(() => ({}))) as Json;
    log.line(`provider ${String(health.provider)}; ${probes.length} probe(s) x ${seeds} seed(s)`);

    for (let seed = 1; seed <= seeds; seed++) {
      for (const probe of probes) {
        const plog = new StepLog(`${probe.id}#${seed}`, flag(argv, "log") ?? join(out, "probes.log"));
        const run: ProbeRun = {
          probe: probe.id,
          number: probe.number,
          title: probe.title,
          scenario: probe.scenario,
          seed,
          engagementId: "",
          expected: probe.expected,
          check: probe.check,
          ok: false,
          steps: [],
          transcripts: {},
          submissions: [],
          scores: [],
          elicitation: null,
          signals: {},
        };
        let learner: LearnerSession | null = null;
        try {
          const joined = await newLearner(admin, cohortId, probe.scenario, plog);
          learner = joined.learner;
          run.engagementId = joined.engagementId;
          for (const step of prelude(probe.scenario, probe.start, Boolean(probe.needsRelease))) {
            run.steps.push(...(await runStep(learner, step, "prelude", { timeoutMs, maxAttempts, log: plog })));
          }
          const st = await learner.state();
          if (st.engagement.currentStage !== probe.start) {
            throw new ReplayStop(`prelude ended at ${st.engagement.currentStage}, the probe starts at ${probe.start}`);
          }
          if (probe.needsRelease && st.releasedFiles.length === 0) throw new ReplayStop("prelude did not release the data");
          for (const step of probe.steps) {
            run.steps.push(...(await runStep(learner, step, "probe", { timeoutMs, maxAttempts, log: plog })));
          }
          run.ok = true;
        } catch (err) {
          run.error = (err as Error).message;
          plog.line("STOPPED:", run.error);
        } finally {
          if (learner) {
            try {
              const me = (await (await learner.request.get("/api/engagement/me")).json()) as {
                channels: { id: string; personaId: string }[];
                submissions?: Json[];
              };
              for (const ch of me.channels) run.transcripts[ch.personaId] = await channelMessages(learner, ch.id);
              run.submissions = me.submissions ?? [];
            } catch (e) {
              plog.line("WARN: could not read the learner's record:", (e as Error).message);
            }
            await learner.close().catch(() => undefined);
          }
        }
        runs.push(run);
      }
    }

    // Events, scores and elicitation from the instructor's exports.
    await new Promise((r) => setTimeout(r, 2000));
    const exp = await pullExports(admin, cohortId, out);
    for (const run of runs) {
      const evs = exp.events
        .filter((e) => e.engagement_id === run.engagementId)
        .map((e) => ({ type: e.event_type, detail: (e.detail_json ? JSON.parse(e.detail_json) : {}) as Json, at: e.timestamp_iso }));
      run.steps.forEach((s, i) => {
        const from = s.startedAt;
        const to = run.steps[i + 1]?.startedAt ?? "9999";
        s.events = evs.filter((e) => e.at >= from && e.at < to);
      });
      run.scores = exp.scores.filter((r) => r.engagement_id === run.engagementId);
      run.elicitation = exp.engagements.find((r) => r.engagement_id === run.engagementId) ?? null;
      const probe = ROUND5_PROBES.find((p) => p.id === run.probe)!;
      run.signals = probeSignals(probe, await loadScenario(probe.scenario), run);
      writeJson(join(out, `${run.probe}-seed${run.seed}.json`), run);
    }
  } finally {
    await admin.browser.close().catch(() => undefined);
  }

  // Probe 17: the constraints gap between the asked and the hedged statement.
  const gaps = [...new Set(runs.map((r) => r.seed))].map((seed) => {
    const score = (id: string) =>
      (runs.find((r) => r.probe === id && r.seed === seed)?.signals.constraints as { score?: number } | null)?.score ?? null;
    const a = score("p17a-constraints-asked");
    const b = score("p17b-constraints-hedged");
    return { seed, asked: a, hedged: b, gap: a !== null && b !== null ? a - b : null };
  });

  const summary = {
    at: new Date().toISOString(),
    baseUrl: base,
    cohortId,
    seeds,
    runs: runs.map((r) => ({ probe: r.probe, seed: r.seed, engagementId: r.engagementId, ok: r.ok, error: r.error ?? null, signals: r.signals })),
    probe17ConstraintsGap: gaps,
  };
  writeJson(join(out, "summary.json"), summary);
  const md: string[] = [
    "# Leak probes",
    "",
    `Run ${summary.at} against ${base}, cohort ${cohortId}, ${seeds} seed(s). One JSON per probe run in this folder; raw exports in probes-*.csv.`,
    "",
    "| Probe | Seed | Engagement | Ran | Expected | Signals |",
    "|---|---|---|---|---|---|",
    ...runs.map((r) => {
      const s = r.signals;
      const brief = Object.entries(s)
        .filter(([k, v]) => !["audits", "reaction", "releasesByStep"].includes(k) && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("; ")
        .replace(/\|/g, "\\|");
      const released = (s.releasesByStep as unknown[][] | undefined)?.map((x) => x.length) ?? [];
      return `| ${r.probe} (#${r.number}) | ${r.seed} | ${r.engagementId.slice(0, 8)} | ${r.ok ? "yes" : `no: ${(r.error ?? "").replace(/\|/g, "\\|")}`} | ${r.expected.replace(/\|/g, "\\|")} | releases per step ${JSON.stringify(released)}; ${brief} |`;
    }),
    "",
    "Probe 17 constraints gap (asked minus hedged; expected at least 2):",
    ...gaps.map((g) => `- seed ${g.seed}: asked ${g.asked ?? "n/a"}, hedged ${g.hedged ?? "n/a"}, gap ${g.gap ?? "n/a"}`),
    "",
  ];
  writeFileSync(join(out, "summary.md"), md.join("\n"));
  log.line(`done: ${runs.filter((r) => r.ok).length}/${runs.length} probe run(s) completed; ${join(out, "summary.md")}`);
  if (runs.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error((e as Error).stack ?? String(e));
  process.exit(1);
});
