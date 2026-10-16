// Smoke checks that need no database or LLM key: public pages render and
// gated areas redirect. The full engagement walkthrough lives in
// engagement-walkthrough.spec.ts and needs a provisioned environment.

import { expect, test } from "@playwright/test";

test("landing page presents the three personas and six stages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("AgenticPracticum");
  await expect(page.getByText("practising a data-science engagement from scoping to handover")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Client sponsor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Data owner" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "End user" })).toBeVisible();
  await expect(page.getByText("Deployment & handover")).toBeVisible();
});

test("admin area redirects to the instructor login", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
  await expect(page.getByRole("heading", { name: "Instructor and reviewer sign-in", exact: true })).toBeVisible();
});

test("workspace without an invite explains how to join", async ({ page }) => {
  await page.goto("/workspace");
  await expect(page.getByText("invite link from your instructor")).toBeVisible();
});

test("invite link without a token lands on the join error page", async ({ page }) => {
  await page.goto("/join/some-cohort");
  await expect(page.getByText("invite link is incomplete")).toBeVisible();
});
