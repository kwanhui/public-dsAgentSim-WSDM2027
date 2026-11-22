// The scripted-learner replay behind human-reference.ts and
// fail-then-revise.ts. It plays a fixture's timeline against a live instance:
// each recorded learner message goes to its persona's channel in the recorded
// order, and each recorded artifact is submitted at its gate. Persona replies
// under the current prompts differ from the recording, so the replay follows
// the transcript's intent rather than its exact turns:
//
//   - A message to a channel that is still locked stops the replay (the
//     recorded order no longer matches the stage the engagement is in).
//   - When the recorded data request has not released the extract, the data
//     owner is taken to be asking for purpose, fields and granularity, and
//     the fixture's dataRequest is sent (up to its maxAttempts); the replay
//     stops if the extract is still unreleased before the next step that
//     needs it.
//   - Each submission must do what the fixture expects (advance, or be held
//     at the gate); anything else stops the replay.
//
// Every step is logged, and a JSON summary is written with --out.
import {
  ReplayStop,
  excerpt,
  newLearner,
  signInAdmin,
  sleep,
  writeJson,
  type LearnerSession,
  type StepLog,
} from "./common";
import {
  applyPatch,
  applySubstitutions,
  expectationFor,
  type LoadedPatch,
  type ReplayFixture,
  type TimelineStep,
} from "./fixture";

export interface ReplayOptions {
  base: string;
  cohortId: string;
  fixture: ReplayFixture;
  apply: string[];
  /** A replay patch (scripts/replay/patches/), applied after any
   * substitution sets; its sha256 goes into the result. */
  patch?: LoadedPatch;
  label: string;
  log: StepLog;
  out?: string;
  delayMs: number;
  timeoutMs: number;
  /** Log, rather than stop on, a submission whose gate outcome differs from
   * the fixture's expectation. For the mock provider only: its judge scores
   * every artifact the same, so no gate ever holds a submission there. */
  lenientGates?: boolean;
}

export interface ReplayResult {
  label: string;
  engagementId: string;
  cohortId: string;
  source: ReplayFixture["source"];
  applied: { set: string; find: string; count: number }[];
  /** The patch applied to the timeline, or null when the replay is verbatim. */
  patch: { file: string; sha256: string; entries: { index: number; stage: string; old: string; new: string }[] } | null;
  steps: {
    index: number;
    kind: string;
    stage: string;
    target: string;
    status: number;
    outcome: string;
  }[];
  dataRequestsSent: number;
  /** Submissions whose gate outcome differed from the fixture (lenientGates only). */
  gateMismatches: number;
  finalStage: string;
  finalStatus: string;
  ok: boolean;
  error?: string;
}

async function channelFor(learner: LearnerSession, personaId: string) {
  const st = await learner.state();
  return { st, channel: st.channels.find((c) => c.personaId === personaId) };
}

export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const { fixture, log } = opts;
  const substituted = applySubstitutions(fixture, opts.apply);
  const { applied } = substituted;
  for (const a of applied) {
    log.line(`substitution [${a.set}] x${a.count}:`, JSON.stringify(a.find), "->", JSON.stringify(a.replace));
    if (a.count === 0) log.line("WARN: substitution matched nothing; the fixture may have drifted");
  }
  let timeline = substituted.timeline;
  let patchSummary: ReplayResult["patch"] = null;
  if (opts.patch) {
    const patched = applyPatch(fixture, timeline, opts.patch.patch);
    timeline = patched.timeline;
    log.line(`patch ${opts.patch.file} sha256 ${opts.patch.sha256}: ${patched.applied.length} replacement(s)`);
    for (const e of patched.applied) {
      log.line(`  patch step ${e.index} [${e.stage}${e.artifact ? ` ${e.artifact}` : ""}]:`, JSON.stringify(e.old), "->", JSON.stringify(e.new), `(${e.reason})`);
    }
    patchSummary = {
      file: opts.patch.file,
      sha256: opts.patch.sha256,
      entries: patched.applied.map((e) => ({ index: e.index, stage: e.stage, old: e.old, new: e.new })),
    };
  } else {
    log.line("no patch: the recorded artifacts are replayed verbatim");
  }

  const result: ReplayResult = {
    label: opts.label,
    engagementId: "",
    cohortId: opts.cohortId,
    source: fixture.source,
    applied: applied.map((a) => ({ set: a.set, find: a.find, count: a.count })),
    patch: patchSummary,
    steps: [],
    dataRequestsSent: 0,
    gateMismatches: 0,
    finalStage: "",
    finalStatus: "",
    ok: false,
  };

  const admin = await signInAdmin(opts.base, log);
  let learner: LearnerSession | null = null;
  try {
    const joined = await newLearner(admin, opts.cohortId, fixture.source.scenarioId, log);
    learner = joined.learner;
    result.engagementId = joined.engagementId;
    log.line("ENGAGEMENT ID", joined.engagementId);

    const needsData = (step: TimelineStep) => step.kind === "submit" && step.stage === "data-collection";
    let dataOwnerAsked = false;
    // Stages whose remaining recorded attempts are skipped because, under
    // lenientGates, an attempt expected to be held advanced instead.
    const skipStages = new Set<string>();

    const ensureData = async (before: TimelineStep) => {
      const st = await learner!.state();
      if (st.releasedFiles.length > 0) return;
      const req = fixture.dataRequest;
      if (!req) throw new ReplayStop(`no data released before step ${before.index} and the fixture has no dataRequest`);
      const ch = st.channels.find((c) => c.personaId === req.personaId);
      if (!ch?.unlocked) throw new ReplayStop(`data owner channel is locked before step ${before.index}`);
      for (let attempt = 1; attempt <= req.maxAttempts; attempt++) {
        log.line(`data not released; sending the stated data request (${attempt}/${req.maxAttempts})`);
        const res = await learner!.send(ch.id, req.text, opts.timeoutMs);
        result.dataRequestsSent++;
        if (res.status !== 200) throw new ReplayStop(`data request failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        log.line("  data owner:", excerpt(res.body.message?.content ?? ""));
        if ((res.body.releasedFiles ?? []).length > 0) {
          log.line("  released:", (res.body.releasedFiles ?? []).join(", "));
          return;
        }
        await sleep(opts.delayMs);
      }
      throw new ReplayStop(`the data owner did not release the extract after ${req.maxAttempts} stated requests`);
    };

    for (const step of timeline) {
      await sleep(opts.delayMs);
      // The data request is judged once the recorded data-owner turns that
      // precede the next non-data-owner step have been sent.
      const leavingDataOwner = dataOwnerAsked && !(step.kind === "message" && step.personaId === "data-owner");
      if (needsData(step) || leavingDataOwner) {
        await ensureData(step);
        dataOwnerAsked = false;
      }

      if (step.kind === "message") {
        const { st, channel } = await channelFor(learner, step.personaId);
        if (!channel) throw new ReplayStop(`step ${step.index}: no channel for persona ${step.personaId}`);
        if (!channel.unlocked) {
          throw new ReplayStop(
            `step ${step.index}: ${step.personaId} channel is locked at stage ${st.engagement.currentStage} (recorded at ${step.stage})`,
          );
        }
        log.line(`step ${step.index} [${step.stage}] learner -> ${step.personaId}:`, excerpt(step.text));
        const res = await learner.send(channel.id, step.text, opts.timeoutMs);
        if (res.status !== 200) {
          throw new ReplayStop(`step ${step.index}: chat failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        }
        const released = res.body.releasedFiles ?? [];
        log.line(`  ${step.personaId}:`, excerpt(res.body.message?.content ?? ""), released.length ? `[released ${released.join(", ")}]` : "");
        result.steps.push({
          index: step.index,
          kind: "message",
          stage: st.engagement.currentStage,
          target: step.personaId,
          status: res.status,
          outcome: released.length ? `released ${released.join(",")}` : "reply",
        });
        if (step.personaId === "data-owner" && step.stage === "data-collection") dataOwnerAsked = true;
        continue;
      }

      // Gate submission.
      if (skipStages.has(step.stage)) {
        log.line(`step ${step.index} [${step.stage}] skipped: an earlier attempt at this stage already advanced (lenient gates)`);
        result.steps.push({ index: step.index, kind: "submit", stage: step.stage, target: step.artifactKind, status: 0, outcome: "skipped" });
        continue;
      }
      const st = await learner.state();
      if (st.engagement.currentStage !== step.stage) {
        throw new ReplayStop(`step ${step.index}: engagement is at ${st.engagement.currentStage}, the recorded ${step.artifactKind} belongs to ${step.stage}`);
      }
      const expected = expectationFor(fixture, step);
      log.line(`step ${step.index} [${step.stage}] submit ${step.artifactKind} attempt ${step.attempt} (${step.text.length} chars), expect ${expected}`);
      const res = await learner.submit(step.text, opts.timeoutMs);
      if (res.status !== 200) {
        throw new ReplayStop(`step ${step.index}: submission failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
      const b = res.body;
      const outcome = `passed=${b.passed} advanced=${b.advanced} attempt=${b.attempt} score=${b.scoreRatio ?? "hidden"}${b.engagementCompleted ? " completed" : ""}`;
      log.line("  gate:", outcome, b.reason ? `(${excerpt(b.reason, 100)})` : "");
      result.steps.push({ index: step.index, kind: "submit", stage: step.stage, target: step.artifactKind, status: res.status, outcome });
      const advanced = Boolean(b.advanced || b.engagementCompleted);
      if (expected === "advance" && !advanced) {
        const msg = `step ${step.index}: the ${step.artifactKind} was held at the gate, the fixture expects it to advance`;
        if (!opts.lenientGates) throw new ReplayStop(msg);
        log.line(`WARN: ${msg} (lenient gates: continuing)`);
        result.gateMismatches++;
      }
      if (expected === "not-advance" && advanced) {
        const msg = `step ${step.index}: the ${step.artifactKind} advanced, the fixture expects the gate to hold it`;
        if (!opts.lenientGates) throw new ReplayStop(msg);
        log.line(`WARN: ${msg} (lenient gates: continuing, later attempts at ${step.stage} are skipped)`);
        result.gateMismatches++;
        skipStages.add(step.stage);
      }
    }

    const final = await learner.state();
    result.finalStage = final.engagement.currentStage;
    result.finalStatus = final.engagement.status;
    result.ok = true;
    log.line("DONE", result.engagementId, `stage=${result.finalStage} status=${result.finalStatus}`);
  } catch (err) {
    result.error = (err as Error).message;
    log.line("STOPPED:", result.error);
  } finally {
    if (learner) await learner.close().catch(() => undefined);
    await admin.browser.close().catch(() => undefined);
    if (opts.out) writeJson(opts.out, result);
  }
  return result;
}
