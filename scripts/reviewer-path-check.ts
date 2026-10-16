/**
 * Automated reviewer-path check.
 *
 * Drives the read-only half of scripts/reviewer-path-check.md against a
 * deployment: health, landing page, the reviewer sign-in, the showcase cohort
 * and its labelled runs, the compare view with its paired rubric criteria, the
 * flag banner on the failure exhibit, the scenario library and its prompt
 * provenance, cohort analytics with the agent-run toggle, the scores export,
 * and sign-out. It prints PASS or FAIL for each step and exits non-zero if any
 * step failed.
 *
 *   REVIEWER_BASE_URL=https://agenticpracticum.vercel.app \
 *   REVIEWER_PASS='<the password printed in the paper>' \
 *   pnpm reviewer-path-check
 *
 * The account is the read-only reviewer account (REVIEWER_USER, default
 * "reviewer"). Against a local `make demo-showcase` the password is "reviewer".
 * The password comes from the environment and has no default, so no tracked
 * file carries a working sign-in. Nothing here writes to the deployment: no
 * cohort is created, no engagement is started, and the showcase is left as it
 * was.
 *
 * This is a smoke test, not a substitute for the manual walkthrough. It runs
 * from your network rather than a reviewer's, it cannot tell you whether the
 * URL you tested is the one the manuscript prints, and it skips the steps that
 * need a learner session, the dataset download in particular.
 */
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const BASE_URL = (process.env.REVIEWER_BASE_URL ?? "https://agenticpracticum.vercel.app").replace(
  /\/$/,
  "",
);
const USER = process.env.REVIEWER_USER ?? "reviewer";
const PASS = process.env.REVIEWER_PASS ?? "";

// The showcase cohort is found by its name prefix and its runs by the labels
// the paper uses (H1 for the reference human run, A1 and A2 for analyst-agent
// runs, and the exhibit). Ids are read from the pages, so the check keeps
// working after the showcase is regenerated.
const COHORT_PREFIX = process.env.SHOWCASE_COHORT_PREFIX ?? "Showcase";
const RUN_LABELS = ["H1", "A1", "exhibit"];

const TIMEOUT = 30_000;

let failures = 0;
let version = "unknown";

function pass(name: string, detail: string): void {
  console.log(`PASS  ${name}${detail ? `  ${detail}` : ""}`);
}

function fail(name: string, reason: string): void {
  failures += 1;
  console.log(`FAIL  ${name}  ${reason}`);
}

/**
 * Run one step and record its verdict. A step that throws fails that step
 * alone and the run carries on, because a report saying which of a dozen
 * things broke is more useful than one that stops at the first.
 */
async function step(name: string, body: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await body();
    pass(name, detail ?? "");
    return true;
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Assert some text is on the page, with a message worth reading when it is not. */
async function expectText(page: Page, needle: string | RegExp, what: string): Promise<void> {
  const locator =
    typeof needle === "string" ? page.getByText(needle, { exact: false }) : page.getByText(needle);
  const visible = await locator
    .first()
    .waitFor({ state: "visible", timeout: TIMEOUT })
    .then(() => true)
    .catch(() => false);
  if (!visible) throw new Error(`${what} did not render at ${page.url()}`);
}

/** Step 2. Public and unauthenticated, so it separates "down" from "wrong password". */
async function checkHealth(): Promise<void> {
  await step("2  health endpoint", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`HTTP ${res.status}, body ${JSON.stringify(body)}`);
    for (const field of ["ok", "db", "keyPresent"]) {
      if (body[field] !== true) throw new Error(`${field} is ${String(body[field])}`);
    }
    version = String(body.version ?? "unknown");
    return `provider ${String(body.provider)}, version ${version}`;
  });
}

/** Steps 3 to 5: the path from the printed URL to a signed-in reviewer. */
async function signIn(page: Page): Promise<boolean> {
  await step("3  landing page", async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await expectText(page, "AgenticPracticum", "the landing headline");
    await expectText(page, "data-science engagement", "the landing description");
    for (const persona of ["Client sponsor", "Data owner", /End.users?/]) {
      await expectText(page, persona, `the "${String(persona)}" stakeholder role`);
    }
    await expectText(page, "Instructor or reviewer sign-in", "the sign-in link");
    return "three stakeholder roles listed";
  });

  await step("4  admin redirects to the sign-in", async () => {
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/admin\/login/, { timeout: TIMEOUT });
    await expectText(page, "reviewer account", "the sign-in page");
  });

  return step("5  reviewer sign-in", async () => {
    await page.fill("#email", USER);
    await page.fill("#password", PASS);
    // The submit button ships disabled and enables on hydration, so wait for
    // it rather than clicking into a dead control.
    const submit = page.locator('button[type="submit"]');
    await submit.waitFor({ state: "visible", timeout: TIMEOUT });
    await page.waitForFunction(
      () => {
        const b = document.querySelector('button[type="submit"]');
        return b instanceof HTMLButtonElement && !b.disabled;
      },
      undefined,
      { timeout: TIMEOUT },
    );
    await Promise.all([
      page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 60_000 }),
      submit.click(),
    ]);
    await expectText(page, /Showcase cohort|Your cohorts/, "the cohort list");
    await expectText(page, "read-only", "the read-only account marker");
    return `as ${USER} (read-only)`;
  });
}

/** Steps 6 to 18: everything behind the sign-in. */
async function authenticatedSteps(page: Page, context: BrowserContext): Promise<void> {
  // Ids are read off the pages rather than hard-coded, so the check still
  // works when the showcase is rebuilt under new ids.
  let cohortId: string | null = null;
  let compareHref: string | null = null;
  const runHref: Record<string, string> = {};
  await step("6  showcase cohort and its labelled runs", async () => {
    const link = page.locator('a[href^="/admin/cohorts/"]', { hasText: COHORT_PREFIX }).first();
    const href = await link.getAttribute("href", { timeout: TIMEOUT });
    if (!href) throw new Error(`no cohort whose name starts with "${COHORT_PREFIX}" on the dashboard`);
    cohortId = href.split("/").pop() ?? null;
    await page.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });
    await expectText(page, "Engagements", "the engagement table");
    for (const label of RUN_LABELS) {
      const row = page.locator("tr", { has: page.getByText(label, { exact: true }) }).first();
      const runLink = row.locator('a[href^="/admin/engagements/"]').first();
      const target = await runLink.getAttribute("href", { timeout: TIMEOUT }).catch(() => null);
      if (!target) throw new Error(`the run labelled ${label} is not listed in the cohort table`);
      runHref[label] = target;
    }
    compareHref = await page
      .getByRole("link", { name: "Compare engagements" })
      .first()
      .getAttribute("href", { timeout: TIMEOUT });
    return `cohort ${cohortId}, runs ${RUN_LABELS.join(", ")}`;
  });

  await step("7  compare view, agent beside human", async () => {
    if (!compareHref) throw new Error("the cohort page has no Compare engagements link");
    await page.goto(`${BASE_URL}${compareHref}`, { waitUntil: "domcontentloaded" });
    await expectText(page, "Compare engagements", "the compare page");
    await expectText(page, "Analyst agent", "the analyst-agent column");
    await expectText(page, "Scripted reference (author replay)", "the reference column");
    await expectText(page, "Rubric score, shared stages", "the delta strip");
    return "both columns and the delta strip rendered";
  });

  await step("8  paired rubric criteria at the modelling gate", async () => {
    const stage = page.locator('section[aria-label="Modelling"]').first();
    await stage.waitFor({ state: "visible", timeout: TIMEOUT });
    const attempt = stage.locator('button[aria-expanded="false"]').first();
    await attempt.click({ timeout: TIMEOUT });
    const judgeLine = stage.getByText(/judged by .+ · prompt /).first();
    await judgeLine.waitFor({ state: "visible", timeout: TIMEOUT });
    return (await judgeLine.textContent())?.trim() ?? "";
  });

  await step("10 flag banner on the failure exhibit", async () => {
    const exhibit = runHref["exhibit"];
    if (!exhibit) throw new Error("the exhibit run was not found in step 6");
    await page.goto(`${BASE_URL}${exhibit}`, { waitUntil: "domcontentloaded" });
    await expectText(page, "World-fact ledger", "the engagement monitor");
    await expectText(
      page,
      "This submission contained text addressed to the assessor",
      "the submission-flagged banner",
    );
    return "banner present, scores untouched";
  });

  await step("12 scenario library", async () => {
    await page.goto(`${BASE_URL}/admin/scenarios`, { waitUntil: "domcontentloaded" });
    await expectText(page, "Scenario library", "the scenario library");
    const scenarios = await page.locator("article").count();
    if (scenarios < 3) throw new Error(`only ${scenarios} scenario card(s) rendered, expected 3`);
    return `${scenarios} scenarios`;
  });

  await step("13 prompt provenance", async () => {
    await expectText(page, "Prompt provenance", "the prompt provenance section");
    await page.locator("summary", { hasText: "Rubric judge prompt" }).first().click({
      timeout: TIMEOUT,
    });
    await expectText(page, "Persona consistency audit prompt", "the consistency audit prompt");
    const body = (await page.locator("pre").first().textContent()) ?? "";
    if (body.trim().length < 200) throw new Error("the rubric judge prompt rendered empty");
    return "both versioned prompts rendered";
  });

  if (cohortId === null) {
    fail("14 cohort analytics, all runs", "the showcase cohort id was not found on the dashboard");
    fail("15 leave-out-agent-runs toggle", "skipped, no cohort id");
    fail("16 scores CSV export", "skipped, no cohort id");
  } else {
    const id: string = cohortId;

    // The showcase cohort is open to the reviewer, so its analytics count
    // the agent runs by default (the paper's audit figures cover all runs).
    await step("14 cohort analytics, all runs", async () => {
      await page.goto(`${BASE_URL}/admin/cohorts/${id}/analytics`, {
        waitUntil: "domcontentloaded",
      });
      await expectText(page, "Stage funnel", "the stage funnel");
      await expectText(page, /Counting \d+ engagements: author replays, agent runs\./, "the all-runs scope label");
      return "scoped to author replays and agent runs";
    });

    await step("15 leave-out-agent-runs toggle", async () => {
      await page
        .getByRole("link", { name: "Leave out agent runs" })
        .first()
        .click({ timeout: TIMEOUT });
      await page.waitForURL(/agents=0/, { timeout: TIMEOUT });
      await expectText(page, /Counting \d+ engagements: author replays\./, "the replays-only scope label");
      await expectText(page, "Export scores CSV", "the scoped export button");
      return "counts and exports switched to the author replays";
    });

    await step("16 scores CSV export", async () => {
      const res = await context.request.get(
        `${BASE_URL}/api/admin/cohorts/${id}/export?what=scores&mode=all`,
      );
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      const csv = await res.text();
      const header = csv.split("\n")[0] ?? "";
      for (const column of ["judge_model", "prompt_version"]) {
        if (!header.includes(column)) throw new Error(`the CSV header has no ${column} column`);
      }
      return `${Math.max(csv.trim().split("\n").length - 1, 0)} score row(s)`;
    });
  }

  await step("18 sign out", async () => {
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Sign out" }).first().click({ timeout: TIMEOUT });
    await page.waitForURL(/\/admin\/login/, { timeout: TIMEOUT });
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/admin\/login/, { timeout: TIMEOUT });
    return "session cleared and /admin redirects again";
  });
}

async function main(): Promise<void> {
  if (!USER || !PASS) {
    console.error(
      "Set REVIEWER_PASS to the reviewer password printed in the manuscript (REVIEWER_USER defaults to \"reviewer\").\n" +
        "It is deliberately not stored in this repo.",
    );
    process.exit(2);
  }

  console.log(`Reviewer path check against ${BASE_URL}\n`);
  await checkHealth();

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    if (await signIn(page)) {
      await authenticatedSteps(page, context);
    } else {
      console.log("\nSkipping the authenticated steps: the sign-in did not go through.");
    }
  } finally {
    await browser.close();
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} step(s) failed against ${BASE_URL}, ` +
      `deployment version ${version}.`,
  );
  console.log(
    "Steps 1, 9, 11 and 17 stay manual: see scripts/reviewer-path-check.md. Step 17, the dataset\n" +
      "download, needs a learner session and is the one this script cannot stand in for.",
  );
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
