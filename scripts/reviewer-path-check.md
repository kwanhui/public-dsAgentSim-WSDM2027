# Reviewer path check

The live URL can work on the author's machine and fail everywhere else, so run
this checklist by hand before every submission and again the week the reviews
open. It confirms that the path a reviewer takes works, rather than assuming it.

Do it in a **fresh incognito window**, on a **normal connection with no VPN or
proxy**, and use **only what the manuscript prints**: the URL and the reviewer
sign-in exactly as they appear in the paper. Any step that needs knowledge not
in the manuscript is a failure of the path, not of the reviewer. Do not paste
the password into this file when you record a run.

The reviewer account is read-only, so the showcase cohort should be unchanged
after a run. Keep a snapshot to put it back with, taken once against
production and committed:

```bash
pnpm showcase:export  --cohort showcase-meridian-mobile-churn-esagd \
                      --out demo/showcase-snapshot.json
```

Restore with `pnpm showcase:restore --in demo/showcase-snapshot.json`, after a
`--dry-run` pass.

## Checklist

| # | Step | Expected | Pass |
| --- | --- | --- | --- |
| 1 | Open a new incognito/private window; confirm no VPN or corporate proxy is active | n/a | ☐ |
| 2 | Fetch `https://agenticpracticum.vercel.app/api/health` | HTTP 200 and JSON with `"ok": true`, `"db": true`, `"keyPresent": true`, `"provider": "anthropic"`, `"budgetSet": true`; note the `version` | ☐ |
| 3 | Open the URL exactly as printed in the manuscript | Landing page renders: the three stakeholder roles (client sponsor, data owner, end user) and the six stage gates | ☐ |
| 4 | Click **Instructor or reviewer sign-in** | Redirect to `/admin/login` | ☐ |
| 5 | Sign in with the reviewer credentials exactly as printed in the manuscript | Redirect to `/admin`; the cohort list renders and the header reads "Signed in as reviewer (read-only)" with **Sign out** | ☐ |
| 6 | Open the cohort **Showcase: Meridian Mobile churn** | The engagement table lists the runs by label: H1 (scripted reference), A1 and A2 (analyst agent) and exhibit | ☐ |
| 7 | Click **Compare engagements** on that cohort | "Compare engagements" renders two columns headed **Analyst agent** and **Scripted reference (author replay)**, over a delta strip: rubric score, messages sent, stages reached, wall clock (active time for the agent, replay time for the reference), each restricted to shared stages | ☐ |
| 8 | In the compare view's **Modelling** row, expand the gate attempt | Both columns show the gate's criteria side by side with the judge's per-criterion score and rationale, and a line under each column reads "judged by <model> · prompt <version>" | ☐ |
| 9 | Open the run labelled `exhibit` from the cohort page | Engagement monitor renders: channels with full transcripts, world-fact ledger, submissions with rubric scores | ☐ |
| 10 | Read the data-audit submission on that monitor | A banner above it reads "This submission contained text addressed to the assessor", quotes the offending line, and states the judge scored the work on its merits; a later revised submission clears the gate | ☐ |
| 11 | Read the world-fact ledger on the run labelled H1 | The ledger records the release of `churn_extract.csv` together with its row count and column list, and the personas' commitments are traceable to the channel they were made in | ☐ |
| 12 | Open **Scenarios** in the header | Three scenarios (churn, segmentation, demand forecasting), each with its personas, six stage gates, and the rubric criteria the judge scores at each gate | ☐ |
| 13 | Scroll to **Prompt provenance** on the same page and expand both entries | The literal rubric-judge prompt and persona-consistency-audit prompt render, each stamped with its version string; placeholders appear in guillemets | ☐ |
| 14 | Open the showcase cohort's **Analytics** tab | Stage funnel, rubric criterion means and consistency-audit rate render for all runs, since the cohort is open to the reviewer ("Counting N engagements: author replays, agent runs") | ☐ |
| 15 | Click **Leave out agent runs** | Counts and the scope label change to "author replays"; the export buttons switch to the same scope | ☐ |
| 16 | Click **Export scores CSV** | A CSV downloads with one row per criterion per scored submission, carrying the judge model and prompt version | ☐ |
| 17 | Download a released dataset file (see the note below) | `churn_extract.csv` downloads from **Data files** in the learner workspace | ☐ |
| 18 | Click **Sign out**, then open `/admin` again | Back at `/admin/login`; `/admin` redirects rather than rendering | ☐ |

**Note on step 17.** Dataset downloads are deliberately learner-scoped:
`/api/datasets/<file>` needs a learner session and refuses a file the data owner
has not released to that engagement, so the instructor views have no download
link and neither does the engagement monitor. Reaching the file therefore means
walking the learner path: open the "Try as a learner" link on the landing page
in a second incognito window, start a churn engagement, and ask Marcus Wong in
the data channel for postpaid attributes, usage, billing, and churn labels. He
releases the extract, it appears under **Data files**, and the link downloads
it. This is the one step that spends live model calls, so it takes a few
minutes; steps 9 and 11 already show that a release happened on the curated
runs.

## Record the run

Fill this in and commit it with the submission record:

```
Date checked      : YYYY-MM-DD
Checked by        :
Browser / OS      :
Network           : (home broadband / campus / mobile; no VPN)
URL as printed    :
Credentials printed in the manuscript: (yes/no; do not copy them here)
/api/health       : (paste the JSON)
Deployment version: (the "version" field from /api/health)
Steps failed      : (none, or the numbers above)
Showcase restored : (yes/no, and the snapshot file used)
Notes             :
```

## If a step fails

- **Health returns 503.** Read which field is false. `db: false` means the app
  cannot reach Neon: check `POSTGRES_URL` on the Vercel project and whether the
  database has been suspended. `keyPresent: false` means `ANTHROPIC_API_KEY` is
  missing from the production environment. Both are environment problems, not
  code problems, so a redeploy of the same commit fixes nothing until the
  variable is set. `budgetSet: false` means `LLM_DAILY_BUDGET_USD` is empty.
- **Health does not respond at all.** The deployment is down or the domain has
  moved. Check `vercel ls` for the newest production deployment; remember that
  `vercel redeploy <url>` rebuilds *that* deployment's commit, so after an
  environment change redeploy the newest one.
- **Sign-in rejected.** The printed password no longer matches
  `REVIEWER_PASSWORD_HASH`. Rotate deliberately with
  `pnpm change-admin-password --reviewer` and update the manuscript in the same
  commit, so the two never drift apart.
- **Showcase cohort missing or short of engagements.** Someone cleaned the
  database or a reviewer deleted a run. Restore with
  `pnpm showcase:restore --in demo/showcase-snapshot.json` (use `--dry-run`
  first to see what it would replace).
- **Compare view shows only one column.** The pinned pair no longer names two
  engagements in the cohort, or the cohort was archived. Open the compare view
  from the cohort page and choose the two runs there.
- **The flag banner is absent on the failure exhibit.** The submission was
  re-scored under a prompt version that does not report assessor-directed text,
  or the exhibit was overwritten. Check for a `submission_flagged` event in the
  events CSV, and restore the snapshot if there is none.
- **Analytics reads zero everywhere.** The scope toggle is on human runs and the
  cohort holds only agent runs, or the wrong cohort is open. Try **Include agent
  runs** before assuming the data is gone (the showcase cohort includes them by
  default).
- **A dataset download returns 403.** That is the correct answer when the file
  has not been released to that engagement. A 401 instead means the learner
  cookie was dropped, usually because the invite was opened in the same window
  as the instructor session.

## Automated version

`pnpm reviewer-path-check` drives the read-only steps (2, 3, 4, 5, 6, 7, 8, 10,
12, 13, 14, 15, 16, 18) with Playwright and prints PASS or FAIL per step:

```bash
REVIEWER_BASE_URL=https://agenticpracticum.vercel.app \
REVIEWER_PASS='<the reviewer password printed in the paper and the README>' \
pnpm reviewer-path-check
```

The account is `reviewer` unless `REVIEWER_USER` says otherwise. Against a local
`make demo-showcase`, use `REVIEWER_BASE_URL=http://localhost:3000` and
`REVIEWER_PASS=reviewer`. The check finds the cohort, the runs and the compare
pair by their names and labels, so it keeps working after the showcase is
regenerated.

It writes nothing to the deployment, so it never disturbs the showcase. It is a
smoke test rather than a replacement for the manual run: it cannot tell you
whether the URL in the manuscript is the one you tested, it runs from your
network rather than a reviewer's, and it skips the steps that need a learner
session.
