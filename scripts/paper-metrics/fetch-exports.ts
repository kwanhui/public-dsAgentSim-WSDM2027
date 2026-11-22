// Read-only: signs in as instructor and downloads the cohort CSV exports
// (scores and events) from a hosted instance. Check-ins are not fetched: they
// sit behind a flag that is off by default and the paper metrics do not
// use them.
//
//   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
//   tsx scripts/paper-metrics/fetch-exports.ts --base-url <url> --cohort-id <uuid>[,<uuid>...] --out <dir>
//
// Credentials come from the environment and have no defaults. The instructor
// password is a real credential on a live deployment, so it does not belong in
// a tracked file; set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (they live in the
// gitignored .env.local). The exports lack per-message token counts, so follow
// this with pull-db.ts --source postgres, into the same --out directory.
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { flag } from "./source";

const USAGE = `Usage: tsx scripts/paper-metrics/fetch-exports.ts --base-url <url> --cohort-id <uuid>[,<uuid>...] --out <dir>`;

async function main(argv: string[]): Promise<void> {
  const base = flag(argv, "base-url");
  const cohortIds = flag(argv, "cohort-id")?.split(",").filter(Boolean);
  const out = flag(argv, "out");
  if (!base || !cohortIds?.length || !out) {
    console.error(USAGE);
    process.exit(1);
  }
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD before running this script. " +
        "They are the instructor sign-in for the deployment named by --base-url, and " +
        "they are deliberately not stored in the repo.",
    );
  }
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: base });
  const page = await ctx.newPage();

  await page.goto("/admin/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(?!\/login)/, { timeout: 60_000 });
  console.log("signed in, at", page.url());

  for (const id of cohortIds) {
    for (const what of ["scores", "events"]) {
      const res = await ctx.request.get(`/api/admin/cohorts/${id}/export?what=${what}`);
      const text = await res.text();
      const disp = res.headers()["content-disposition"] ?? "";
      const fname = disp.match(/filename="([^"]+)"/)?.[1] ?? `${id}-${what}.csv`;
      console.log(`${id} ${what}: ${res.status()} ${fname} ${text.length} bytes`);
      if (res.status() === 200) writeFileSync(`${out}/${fname}`, text);
      else console.log("  body:", text.slice(0, 300));
    }
  }
  await browser.close();
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
