// Shared by the showcase regeneration drivers (scripts/replay/*): argument
// parsing, a step log, the instructor session (Playwright, since cohort
// creation, invites and agent runs are server actions behind the admin UI),
// and a learner session that talks to the learner API directly.
//
// Nothing here knows a URL, cohort or credential; every driver takes
// --base-url, and the instructor sign-in comes from E2E_ADMIN_EMAIL and
// E2E_ADMIN_PASSWORD, as for scripts/paper-metrics/drive-run.ts.
import { chromium, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_COHORT_CONFIG, type CohortConfig } from "../../lib/cohort/defaults";

export { flag } from "../paper-metrics/source";

// ---------------------------------------------------------------- logging

export class StepLog {
  constructor(
    private readonly label: string,
    private readonly file?: string,
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  line(...parts: unknown[]): void {
    const text = `[${new Date().toISOString()}] ${this.label} ${parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ")}`;
    console.log(text);
    if (this.file) appendFileSync(this.file, text + "\n");
  }
}

/** Stops the driver: logs the reason and throws, so main() exits non-zero. */
export class ReplayStop extends Error {}

export function excerpt(text: string, n = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- instructor

export interface AdminSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  base: string;
}

export function adminCredentials(): { email: string; password: string } {
  const email = process.env.E2E_ADMIN_EMAIL ?? "admin";
  const password = process.env.E2E_ADMIN_PASSWORD ?? "";
  if (!password) throw new Error("Set E2E_ADMIN_PASSWORD (and E2E_ADMIN_EMAIL if it is not 'admin') to the instructor sign-in for --base-url.");
  return { email, password };
}

export async function signInAdmin(base: string, log: StepLog): Promise<AdminSession> {
  const { email, password } = adminCredentials();
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  await page.goto("/admin/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(?!\/login)/, { timeout: 60_000 });
  log.line("instructor signed in at", base);
  return { browser, context, page, base };
}

/** Creates a cohort through the admin form and returns its id. */
export async function createCohort(admin: AdminSession, name: string): Promise<string> {
  const { page } = admin;
  await page.goto("/admin/cohorts");
  await page.getByLabel("Cohort name").fill(name);
  await page.getByRole("button", { name: "Create cohort" }).click();
  await page.waitForURL(/\/admin\/cohorts\/[^/]+$/);
  const id = page.url().match(/\/admin\/cohorts\/([^/?#]+)$/)?.[1];
  if (!id) throw new ReplayStop(`cohort creation did not land on a cohort page (${page.url()})`);
  return id;
}

/**
 * Replaces the cohort's config through PATCH /api/admin/cohorts/<id>. The
 * route validates the full config, so the caller passes a complete one.
 */
export async function patchCohortConfig(
  admin: AdminSession,
  cohortId: string,
  config: CohortConfig,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await admin.context.request.patch(`/api/admin/cohorts/${cohortId}`, {
    data: { config },
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok(), status: res.status(), body };
}

/** The showcase config: gated at the default pass mark, one scenario. */
export function showcaseConfig(opts: {
  scenarioId: string;
  reviewerVisible: boolean;
  comparePair?: { human: string; agent: string } | null;
  /** Showcase run labels by engagement id (H1, A1, A2, exhibit). */
  labels?: Record<string, string>;
  /** The replay patch applied to H1 (file and sha256). */
  h1Patch?: { file: string; sha256: string } | null;
  /** Engagement ids of the runs these scripts replayed (H1, the exhibit). */
  scriptedReplays?: string[];
}): CohortConfig {
  const base = structuredClone(DEFAULT_COHORT_CONFIG);
  return {
    ...base,
    scenarios: { allowed: [opts.scenarioId] },
    // Gated explicitly, whatever the deployment's default for new cohorts:
    // the exhibit depends on a gate that holds a failing memo.
    gates: { minScoreRatio: 0.6, maxRetries: 2 },
    research: { ...base.research, checkins: false, reflections: false },
    sandbox: { ...base.sandbox, openJoin: false },
    // The labels name the runs in the cohort table and compare pickers, and
    // the config route accepts reviewer visibility only when every invited
    // learner's engagement carries one.
    showcase: {
      ...base.showcase,
      reviewerVisible: opts.reviewerVisible,
      comparePair: opts.comparePair ?? null,
      labels: opts.labels ?? {},
      scriptedReplays: opts.scriptedReplays ?? [],
      h1Patch: opts.h1Patch ?? null,
    } as CohortConfig["showcase"],
  };
}

/** Mints one invite on the cohort page and returns its URL on --base-url. */
export async function mintInvite(admin: AdminSession, cohortId: string): Promise<string> {
  const { page } = admin;
  await page.goto(`/admin/cohorts/${cohortId}`);
  const inputs = page.getByLabel("Invite URL");
  const before = new Set(await inputs.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)));
  await page.getByRole("button", { name: "Generate invite link" }).click();
  let url = "";
  for (let i = 0; i < 30 && !url; i++) {
    await page.waitForTimeout(500);
    const now = await inputs.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    url = now.find((v) => v && !before.has(v)) ?? "";
  }
  if (!url) throw new ReplayStop("no new invite URL appeared after 'Generate invite link'");
  // The link carries the origin the app believes it has; rewrite it to the
  // origin this driver was pointed at.
  const u = new URL(url);
  return new URL(u.pathname + u.search, admin.base).toString();
}

// ---------------------------------------------------------------- learner

export interface ChannelState {
  id: string;
  personaId: string;
  unlocked: boolean;
}

export interface LearnerState {
  engagement: { id: string; currentStage: string; status: string };
  channels: ChannelState[];
  releasedFiles: { file: string }[];
}

export class LearnerSession {
  private constructor(
    private readonly context: BrowserContext,
    readonly request: APIRequestContext,
  ) {}

  /** Redeems an invite link in a fresh browser context (its own cookie jar). */
  static async join(browser: Browser, base: string, inviteUrl: string): Promise<LearnerSession> {
    const context = await browser.newContext({ baseURL: base });
    const res = await context.request.get(inviteUrl, { maxRedirects: 0 });
    const location = res.headers()["location"] ?? "";
    if (res.status() < 300 || res.status() >= 400 || !/\/workspace/.test(location)) {
      throw new ReplayStop(`invite redemption failed: HTTP ${res.status()} -> ${location || "(no redirect)"}`);
    }
    return new LearnerSession(context, context.request);
  }

  async startEngagement(scenarioId: string): Promise<string> {
    const res = await this.request.post("/api/engagement", { data: { scenarioId } });
    const body = (await res.json().catch(() => ({}))) as { engagementId?: string; error?: string };
    if (res.status() !== 201 || !body.engagementId) {
      throw new ReplayStop(`starting the engagement failed: HTTP ${res.status()} ${JSON.stringify(body)}`);
    }
    return body.engagementId;
  }

  async state(): Promise<LearnerState> {
    const res = await this.request.get("/api/engagement/me");
    if (!res.ok()) throw new ReplayStop(`GET /api/engagement/me failed: HTTP ${res.status()}`);
    return (await res.json()) as LearnerState;
  }

  async send(channelId: string, message: string, timeoutMs: number) {
    const res = await this.request.post("/api/chat", { data: { channelId, message }, timeout: timeoutMs });
    const body = (await res.json().catch(() => ({}))) as {
      message?: { content: string };
      releasedFiles?: string[];
      error?: string;
      messagesRemaining?: number;
    };
    return { status: res.status(), body };
  }

  async submit(text: string, timeoutMs: number) {
    const res = await this.request.post("/api/engagement/submit", { data: { text }, timeout: timeoutMs });
    const body = (await res.json().catch(() => ({}))) as {
      passed?: boolean;
      advanced?: boolean;
      engagementCompleted?: boolean;
      newStage?: string;
      attempt?: number;
      scoreRatio?: number | null;
      reason?: string;
      error?: string;
    };
    return { status: res.status(), body };
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** Joins the cohort as a new learner and starts the scenario. */
export async function newLearner(
  admin: AdminSession,
  cohortId: string,
  scenarioId: string,
  log: StepLog,
): Promise<{ learner: LearnerSession; engagementId: string }> {
  const invite = await mintInvite(admin, cohortId);
  log.line("invite minted");
  const learner = await LearnerSession.join(admin.browser, admin.base, invite);
  const engagementId = await learner.startEngagement(scenarioId);
  log.line("engagement started", engagementId);
  return { learner, engagementId };
}
