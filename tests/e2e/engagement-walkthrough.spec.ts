// Full engagement walkthrough: instructor creates a cohort and invite, a
// learner joins, starts the churn scenario, talks to the client, passes the
// formulation gate, then requests and downloads data from the data owner.
//
// Runs against any provisioned environment, including the offline demo:
//   pnpm demo                     (in one terminal: PGlite + mock LLM)
//   E2E_ADMIN_PASSWORD=demo pnpm e2e tests/e2e/engagement-walkthrough.spec.ts
// or against a real deployment with PLAYWRIGHT_BASE_URL and the real
// admin password (LLM turns then take considerably longer).

import { expect, test } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.skip(!ADMIN_PASSWORD, "E2E_ADMIN_PASSWORD not set; walkthrough needs a provisioned environment");

// LLM turns and rubric scoring can be slow on real models.
test.setTimeout(600_000);

test("instructor sets up a cohort; learner works formulation and gets data", async ({ browser }) => {
  const instructor = await browser.newContext();
  const admin = await instructor.newPage();

  await admin.goto("/admin/login");
  await admin.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await admin.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
  await admin.getByRole("button", { name: /sign in/i }).click();
  await admin.waitForURL(/\/admin(?!\/login)/);

  await admin.goto("/admin/cohorts");
  const cohortName = `e2e-${Date.now()}`;
  await admin.getByLabel("Cohort name").fill(cohortName);
  await admin.getByRole("button", { name: "Create cohort" }).click();
  await admin.waitForURL(/\/admin\/cohorts\/[^/]+$/);
  const cohortId = admin.url().match(/\/admin\/cohorts\/([^/]+)$/)?.[1];

  await admin.getByRole("button", { name: "Generate invite link" }).click();
  const inviteUrl = await admin.getByLabel("Invite URL").first().inputValue();
  expect(inviteUrl).toContain("/join/");

  const learnerCtx = await browser.newContext();
  const learner = await learnerCtx.newPage();
  await learner.goto(inviteUrl);
  await learner.waitForURL(/\/workspace/);

  await learner.getByRole("heading", { name: "Choose your engagement" }).waitFor();
  const churnCard = learner.locator("div.rounded-lg", { hasText: "Postpaid churn at Meridian Mobile" });
  await churnCard.getByRole("button", { name: "Start this engagement" }).first().click();
  // Starting asks for confirmation, since the choice cannot be undone.
  await churnCard.getByRole("button", { name: "Yes, start this engagement" }).first().click();

  // The confidence check-in is off by default (research.checkins). When a
  // cohort has it on, the card appears before the workspace; save the
  // default answers and move on.
  const checkin = learner.getByRole("button", { name: "Save check-in" });
  const sponsorChannel = learner.getByRole("button", { name: /Sarah Tan/ });
  await checkin.or(sponsorChannel).first().waitFor({ timeout: 60_000 });
  if (await checkin.count()) {
    await checkin.click();
    await checkin.waitFor({ state: "detached" });
  }

  // Workspace loads; client channel is open, data owner is locked.
  await sponsorChannel.click();
  await learner
    .getByPlaceholder(/Message Sarah Tan/)
    .fill("Hi Sarah. Before we talk models, what decision should this work support, and who acts on it?");
  await learner.getByRole("button", { name: "Send" }).click();
  await expect(learner.getByTestId("persona-message").first()).toBeVisible({ timeout: 120_000 });

  // Submit a formulation artifact at the stage gate.
  await learner.getByRole("button", { name: /Stage gate/ }).click();
  await learner.getByPlaceholder(/Paste or write your artifact/).fill(
    [
      "Problem statement: Meridian Mobile's retention team must decide which postpaid subscribers",
      "receive one of ~6,000 monthly retention offers (S$30 each) from a S$540,000 quarterly budget.",
      "We will rank active postpaid subscribers by probability of churning in the next month,",
      "defined as porting out or cancelling, so the campaign team can target the top of the",
      "ranking up to capacity. A save counts when a contacted subscriber stays six more months.",
      "Success is saves per campaign dollar against the untargeted baseline. Prepaid,",
      "acquisition, and upsell are out of scope.",
    ].join(" "),
  );
  // The reflection field shows only when the cohort collects reflections
  // (research.reflections, off by default).
  const reflection = learner.getByLabel(/Reflection \(optional/);
  if (await reflection.count()) {
    await reflection.fill(
      "Hardest part was pinning Sarah down on what a save is worth; next time I would ask about offer economics first.",
    );
  }
  await learner.getByRole("button", { name: "Submit for review" }).click();
  // The memo is under the stage's word target, so the workspace asks for a
  // confirmation that names the attempt it will use.
  await expect(learner.getByText(/Submit anyway\?/)).toBeVisible();
  await learner.getByRole("button", { name: "Submit anyway" }).click();
  // New cohorts start with formative gates, so the stage moves on after
  // scoring; a hard gate would say passed or below the pass mark.
  await expect(learner.locator("text=/Gate passed|Below the pass mark|Submitted. Moving on/").first()).toBeVisible({
    timeout: 300_000,
  });

  // Data-collection stage: the data owner unlocks; ask for the extract.
  await learner.getByRole("button", { name: /Marcus Wong/ }).click();
  await learner
    .getByPlaceholder(/Message Marcus Wong/)
    .fill(
      "Hi Marcus. For the agreed retention-targeting scope I need subscriber_id, tenure, contract type, data usage, billing and the churn label for postpaid subscribers, one row per subscriber. Can you release the extract?",
    );
  await learner.getByRole("button", { name: "Send" }).click();
  const releasedChip = learner.getByRole("button", { name: /churn_extract\.csv/ }).first();
  await expect(releasedChip).toBeVisible({
    timeout: 120_000,
  });

  // The chip opens the Data files pane; the released file downloads from there.
  await releasedChip.click();
  const downloadPromise = learner.waitForEvent("download");
  await learner.getByRole("link", { name: "Download" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("churn_extract.csv");

  // Instructor sees the engagement, transcripts, and scores.
  await admin.reload();
  // A one-scenario cohort names the scenario once above the table, and each
  // row opens its monitor from the learner cell.
  await expect(admin.getByText("Scenario: Postpaid churn at Meridian Mobile.")).toBeVisible();
  await admin.locator('table a[href^="/admin/engagements/"]').first().click();
  await admin.waitForURL(/\/admin\/engagements\//);
  await expect(admin.getByText("World-fact ledger")).toBeVisible();
  await expect(admin.getByText(/Problem formulation · Problem statement/).first()).toBeVisible();

  // Best-effort teardown: archive the e2e-* cohort this spec created, so
  // repeated runs against a real deployment do not pile test cohorts into the
  // admin list. A teardown failure never fails the walkthrough itself.
  try {
    if (cohortId) {
      await admin.goto(`/admin/cohorts/${cohortId}/config`);
      await admin.getByRole("button", { name: "Archive cohort" }).click();
      await admin.getByRole("button", { name: "Unarchive cohort" }).waitFor({ timeout: 15_000 });
    }
  } catch {
    // The cohort stays in the list; archive it by hand from its config page.
  }

  await learnerCtx.close();
  await instructor.close();
});
