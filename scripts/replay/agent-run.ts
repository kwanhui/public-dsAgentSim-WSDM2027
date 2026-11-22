// Drives one analyst-agent run through all six stages on a live instance,
// using only the runner's own controls (Start analyst run, then "Run current
// stage" once per stage). With `analystModel` the run is started through
// POST /api/admin/cohorts/<id>/agent-runs instead, which runs this one run's
// analyst on that model (instructor only); the stages are driven the same way. It never clicks again while a stage is in flight,
// and stops the moment the run leaves "active": repeat clicks on a finished
// engagement open empty analyst_stage_started/finished brackets.
//
// Used by scripts/replay/agent-runs.ts (N runs in one cohort) and by
// scripts/paper-metrics/drive-run.ts (one run).
import type { Page } from "@playwright/test";

import type { StepLog } from "./common";

/** Longest wait for one stage, in seconds (env STAGE_TIMEOUT_S). */
const STAGE_TIMEOUT_S = Number(process.env.STAGE_TIMEOUT_S ?? 600);
/** Poll interval while a stage runs, in seconds (env STAGE_POLL_S). */
const STAGE_POLL_S = Number(process.env.STAGE_POLL_S ?? 5);
const MAX_STAGES = 8;

export interface AgentRunResult {
  label: string;
  engagementId: string;
  /** The analyst model requested for this run (null: the deployment's). */
  requestedAnalystModel: string | null;
  /** The analyst model the run records, as the start route reported it. */
  analystModel: string | null;
  status: string;
  stagesDriven: number;
  failureBanner: boolean;
  ok: boolean;
  error?: string;
}

async function cardState(page: Page, runId: string) {
  return page.evaluate((rid) => {
    const a = document.querySelector(`a[href='/admin/engagements/${rid}']`);
    const li = a?.closest("li");
    if (!li) return null;
    const text = (li.textContent ?? "").replace(/\s+/g, " ").trim();
    const buttons = [...li.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    return { text, buttons, running: buttons.some((b) => /Stage running/i.test(b)) };
  }, runId);
}

interface RunState {
  status: string;
  stage: string;
  inFlight: boolean;
  failed: boolean;
}

/** The run's state from the agent page's activity route (null if unreadable). */
async function runState(page: Page, cohortId: string, runId: string): Promise<RunState | null> {
  try {
    const res = await page.request.get(`/admin/cohorts/${cohortId}/agent/activity?run=${runId}`);
    if (!res.ok()) return null;
    const b = (await res.json()) as Partial<RunState>;
    if (typeof b.inFlight !== "boolean") return null;
    return { status: b.status ?? "", stage: b.stage ?? "", inFlight: b.inFlight, failed: Boolean(b.failed) };
  } catch {
    return null;
  }
}

/**
 * Waits until no stage is in flight on the run, polling every STAGE_POLL_S
 * seconds for up to STAGE_TIMEOUT_S. After a click (`justClicked`), first
 * allows 15 s for the start event to appear, since a stage that finishes
 * inside a poll never shows as in flight.
 */
async function waitForStageIdle(
  page: Page,
  cohortId: string,
  runId: string,
  log: StepLog,
  justClicked: boolean,
): Promise<"idle" | "timeout"> {
  const t0 = Date.now();
  let seenInFlight = !justClicked;
  let lastNote = 0;
  for (;;) {
    const s = await runState(page, cohortId, runId);
    const waited = (Date.now() - t0) / 1000;
    if (s?.inFlight) seenInFlight = true;
    else if (seenInFlight || waited >= 15) return "idle";
    if (waited >= STAGE_TIMEOUT_S) return "timeout";
    if (waited - lastNote >= 30) {
      lastNote = waited;
      log.line(`stage in flight, ${Math.round(waited)} s so far (timeout ${STAGE_TIMEOUT_S} s)`);
    }
    await page.waitForTimeout(seenInFlight ? STAGE_POLL_S * 1000 : 500);
  }
}

async function runIds(page: Page): Promise<string[]> {
  return page.locator("a[href^='/admin/engagements/']").evaluateAll((els) =>
    els.map((e) => (e as HTMLAnchorElement).getAttribute("href")!.split("/").pop()!),
  );
}

export async function driveAgentRun(
  page: Page,
  opts: { cohortId: string; scenarioId: string; label: string; log: StepLog; analystModel?: string | null;
    /** Continue this existing active run instead of starting a new one. */
    resumeRunId?: string;
  },
): Promise<AgentRunResult> {
  const { log } = opts;
  const result: AgentRunResult = {
    label: opts.label,
    engagementId: "",
    requestedAnalystModel: opts.analystModel ?? null,
    analystModel: null,
    status: "",
    stagesDriven: 0,
    failureBanner: false,
    ok: false,
  };
  try {
    const agentUrl = `/admin/cohorts/${opts.cohortId}/agent`;
    await page.goto(agentUrl);
    const before = new Set(await runIds(page));
    log.line("existing runs:", [...before].join(",") || "(none)");

    let runId = opts.resumeRunId ?? "";
    if (runId) {
      result.analystModel = opts.analystModel ?? null;
      log.line("RESUMING existing run", runId, "(continuing it in place, not restarting)");
    } else if (opts.analystModel) {
      const res = await page.request.post(`/api/admin/cohorts/${opts.cohortId}/agent-runs`, {
        data: { scenarioId: opts.scenarioId, analystModel: opts.analystModel },
      });
      const body = (await res.json().catch(() => ({}))) as { engagementId?: string; analystModel?: string; message?: string };
      if (res.status() !== 201 || !body.engagementId) {
        throw new Error(`start with analyst model ${opts.analystModel} refused: HTTP ${res.status()} ${JSON.stringify(body)}`);
      }
      runId = body.engagementId;
      result.analystModel = body.analystModel ?? null;
      log.line(`started through the agent-run route, analyst model ${opts.analystModel} (records ${result.analystModel})`);
      await page.goto(agentUrl);
    } else {
      await page.locator("select[name='scenarioId']").selectOption(opts.scenarioId);
      await page.getByRole("button", { name: /^Start analyst run$/ }).click();
    }
    // The start action revalidates and the client refetches; give the new card time.
    for (let i = 0; i < 30 && !runId; i++) {
      await page.waitForTimeout(2000);
      const fresh = (await runIds(page)).filter((id) => !before.has(id));
      if (fresh.length === 1) runId = fresh[0];
      else if (fresh.length > 1) throw new Error(`more than one new run appeared: ${fresh.join(",")}`);
      else if (i % 5 === 4) await page.reload();
    }
    if (!runId) throw new Error("no new run appeared after Start analyst run");
    result.engagementId = runId;
    log.line("NEW RUN ID", runId);

    const notice = await page.locator("p[role='status']").allTextContents();
    if (notice.some((t) => /Not started/i.test(t))) throw new Error("start was refused: " + notice.join(" | "));

    // One click per stage. A real model takes 30 to 180 s per stage, so the
    // wait for a stage polls the run's state (the agent page's activity
    // route) every STAGE_POLL_S seconds for up to STAGE_TIMEOUT_S, instead of
    // reading the card once. A failed attempt is retried once through the
    // page's own "Retry current stage" control.
    const retried = new Set<string>();
    for (let clicks = 0; clicks < MAX_STAGES + 6; ) {
      await page.reload();
      await page.waitForLoadState("networkidle");
      const st = await cardState(page, runId);
      if (!st) throw new Error("run card not found");
      log.line(`stage ${clicks + 1} pre:`, JSON.stringify(st.text.slice(0, 140)));
      if (!/ · completed|· active/.test(st.text)) log.line("WARN: unrecognised status text");
      if (!/· active/.test(st.text)) {
        log.line("run is no longer active, stopping");
        break;
      }
      let state = await runState(page, opts.cohortId, runId);
      if (state?.inFlight || st.running) {
        log.line("a stage is already in flight, waiting");
        const w = await waitForStageIdle(page, opts.cohortId, runId, log, false);
        if (w === "timeout") throw new Error(`stage still in flight after ${STAGE_TIMEOUT_S} s`);
        continue; // re-read the card and state
      }

      const btn = page.locator(`li:has(a[href='/admin/engagements/${runId}']) button`).filter({
        hasText: /Run current stage|Retry current stage/,
      });
      if ((await btn.count()) === 0) {
        log.line("no run-stage button on the card, stopping");
        break;
      }
      const stageId = state?.stage ?? `#${clicks}`;
      if (state?.failed) {
        if (retried.has(stageId)) {
          result.failureBanner = true;
          log.line(`STAGE FAILURE BANNER PRESENT: stage ${stageId} failed again after one retry, stopping`);
          break;
        }
        retried.add(stageId);
        log.line(`stage ${stageId} failed; retrying once through "Retry current stage"`);
      }

      const t0 = Date.now();
      await btn.first().click();
      clicks++;
      result.stagesDriven++;
      const w = await waitForStageIdle(page, opts.cohortId, runId, log, true);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (w === "timeout") throw new Error(`stage ${stageId} still in flight after ${STAGE_TIMEOUT_S} s`);
      await page.waitForTimeout(1000);
      await page.reload();
      await page.waitForLoadState("networkidle");
      const done = await cardState(page, runId);
      state = await runState(page, opts.cohortId, runId);
      log.line(`stage ${stageId} done in ${secs}s ->`, JSON.stringify(done?.text.slice(0, 200)));
      if (state?.failed) {
        result.failureBanner = true;
        log.line("STAGE FAILURE BANNER PRESENT");
      }
      if (done && !/· active/.test(done.text)) {
        log.line("run finished");
        break;
      }
    }

    const final = await cardState(page, runId);
    result.status = /· completed/.test(final?.text ?? "") ? "completed" : /· active/.test(final?.text ?? "") ? "active" : "unknown";
    result.ok = result.status === "completed";
    log.line("FINAL", runId, result.status, JSON.stringify(final?.text.slice(0, 220)));
  } catch (err) {
    result.error = (err as Error).message;
    log.line("ERROR", result.error);
  }
  return result;
}
