// Analyst-agent demo walkthrough: the instructor starts an agent-mode
// engagement, drives it through the formulation stage, and opens the compare
// view. Runs offline against `pnpm demo` (mock LLM makes the agent's actions
// deterministic) or against a real deployment via PLAYWRIGHT_BASE_URL.

import { expect, test } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.skip(!ADMIN_PASSWORD, "E2E_ADMIN_PASSWORD not set; walkthrough needs a provisioned environment");

// A full stage is several LLM calls (analyst turns, persona replies, rubric).
test.setTimeout(600_000);

test("instructor runs the analyst agent through a stage and compares runs", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(?!\/login)/);

  await page.goto("/admin/cohorts");
  const cohortName = `e2e-agent-${Date.now()}`;
  await page.getByLabel("Cohort name").fill(cohortName);
  await page.getByRole("button", { name: "Create cohort" }).click();
  await page.waitForURL(/\/admin\/cohorts\/[^/]+$/);
  const cohortId = page.url().match(/\/admin\/cohorts\/([^/]+)$/)?.[1];

  await page.getByRole("link", { name: "Analyst agent runs" }).click();
  await page.waitForURL(/\/admin\/cohorts\/[^/]+\/agent$/);

  // The scenario picker opens on the cohort's first allowed scenario, since a
  // fresh cohort has no learner engagement to follow.
  await expect(page.getByLabel("Scenario")).toHaveValue("customer-churn");
  await page.getByRole("button", { name: "Start analyst run" }).click();
  await expect(page.getByText(/Postpaid churn at Meridian Mobile ·/).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Problem formulation").first()).toBeVisible();

  // Drive the agent through the formulation stage: it messages the client,
  // then submits the gate artifact; the stage pointer moves on.
  await page.getByRole("button", { name: "Run current stage" }).click();
  await expect(page.getByText("Data collection").first()).toBeVisible({ timeout: 300_000 });

  // The agent run is inspectable in the standard engagement monitor.
  const compareHref = await page.locator('a[href*="/admin/compare?a="]').first().getAttribute("href");
  expect(compareHref).toBeTruthy();
  const runId = new URL(compareHref!, "http://x").searchParams.get("a");
  expect(runId).toBeTruthy();

  // Compare view renders both columns (agent run on both sides is enough to
  // exercise the two-column layout; the demo pairs it with a human run).
  await page.goto(`/admin/compare?a=${runId}&b=${runId}`);
  await expect(page.getByText("Compare engagements")).toBeVisible();
  const badges = page.getByText("Analyst agent", { exact: true });
  await expect(badges).toHaveCount(2);
  // The delta strip reports the stages both runs scored, and the stage rows
  // hold the two runs side by side.
  await expect(page.getByText("Rubric score, shared stages")).toBeVisible();
  await expect(page.getByRole("region", { name: "Problem formulation" })).toBeVisible();

  // The gate attempt is paired across the two columns, one row per attempt.
  await expect(page.getByText(/Left · .*attempt 1/).first()).toBeVisible();

  // Best-effort teardown: archive the e2e-agent-* cohort this spec created,
  // so repeated runs against a real deployment do not pile test cohorts into
  // the admin list. A teardown failure never fails the walkthrough itself.
  try {
    if (cohortId) {
      await page.goto(`/admin/cohorts/${cohortId}/config`);
      await page.getByRole("button", { name: "Archive cohort" }).click();
      await page.getByRole("button", { name: "Unarchive cohort" }).waitFor({ timeout: 15_000 });
    }
  } catch {
    // The cohort stays in the list; archive it by hand from its config page.
  }
});
