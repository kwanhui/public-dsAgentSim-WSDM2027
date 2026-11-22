# Architecture

AgenticPracticum is a Next.js (App Router) app with two runtime modes
(learner and instructor) over a shared Postgres database (Vercel Postgres /
Neon), with one instructor → many cohorts → many pseudonymous learners.

```
 instructor ──/admin/login──► Auth.js (Credentials provider, JWT session)
                                    │
                                    ▼
      /admin/cohorts/[id] (invites, engagements) · /analytics · /admin/engagements/[id]
                                    │ owns cohorts (Postgres)
 learner ──invite URL──► /join/[slug] ──cookie──► /workspace
                                    │
                     components/workspace/workspace-client.tsx
                                    │
      ┌─────────────────────────────┼──────────────────────────────┐
      ▼                             ▼                              ▼
 POST /api/chat            POST /api/engagement/submit     GET /api/datasets/[file]
 one persona turn:         one stage-gate pass:            released files only

 Inside POST /api/chat:                Inside /api/engagement/submit:
  1. resolve cohort + engagement        1. store submission ... lib/db (submissions)
     ..... lib/engagement/request.ts    2. rubric judge ....... lib/agents/rubric.ts
  2. load channel history + world          (generateObject, stronger model,
     facts .. lib/engagement/state.ts       judge model + prompt version logged)
  3. build persona prompt               3. gate policy ........ lib/agents/stage-gate.ts
     ..... lib/agents/persona.ts           (cohort minScoreRatio / maxRetries)
  4. one generateObject call            4. advance stage, unlock channels,
     -> { reply, newFacts,                 append world fact, log events
        releaseDatasets }               5. client persona reacts in character
  5. apply releases (data owner only)      in their channel (best-effort)
     ..... lib/agents/data-environment.ts
  6. persist messages + facts + event
```

## The simulation model

An **engagement** is one learner's run through one **scenario**
(`configs/scenarios/*.yaml`, Zod-validated by `lib/scenarios/types.ts`).
A scenario defines:

- **Personas**: one client sponsor, one data owner, one or more end-users.
  Each has a hidden persona card (goals, knowledge, frictions such as scope
  creep) that never reaches the browser (`lib/scenarios/public.ts` strips it).
  Each persona gets its own chat **channel**, unlocked at a configured stage.
- **Six stages**: formulation → data-collection → cleaning → modelling →
  testing → deployment. Each stage has learner guidance and a **gate**: an
  artifact the learner submits (problem statement, data audit, cleaning
  report, model report, validation memo, final report) scored by an
  LLM-judge rubric. For display only, `lib/scenarios/phases.ts` maps each
  stage to a generic CRISP-DM-style phase (Understand, Collect, Prepare,
  Model, Validate, Deliver) with an icon, drawn by `components/ui/stage-strip.tsx`;
  no prompt, stage id or scenario title reads it.
- **Datasets**: seeded synthetic CSVs committed under `datasets/<id>/`
  (regenerated deterministically by `scripts/generate-datasets.ts`). Each
  carries deliberate quality problems that the data-owner persona knows about
  but only reveals under good questioning. Files are downloadable only after
  the data-owner persona decides to release them.

**World-fact ledger.** Personas stay mutually consistent through an
append-only ledger (`world_facts`): scenario seed facts, commitments a
persona makes mid-conversation (extracted in the same structured-output call
as the reply), dataset releases, and stage advances. Every persona prompt
includes the full ledger; channel history is per-channel.

**Learner work happens outside the platform.** Learners analyse the released
CSVs in their own tools (Jupyter, Excel) and bring artifacts back to the
stage gates. The platform simulates the engagement around the analysis, not
the analysis itself.

## Roles

### Instructor
Single fixed admin identity (Auth.js v5 Credentials provider, bcrypt hash in
`ADMIN_PASSWORD_HASH`; sessions are JWT). Creates cohorts, generates one-time
invite URLs, reads engagement transcripts and the world-fact ledger
(`/admin/engagements/[id]`), monitors the stage funnel and rubric criterion
means (`/admin/cohorts/[id]/analytics`), and exports rubric scores or event
logs as CSV for analysis (`/api/admin/cohorts/[id]/export`).

### Learner
Pseudonymous: no email or PII. Joins through a one-time invite token; a
`students` row and cookie session are created, keyed by an HMAC-derived
learner hash (`PSEUDONYM_SALT`). Picks a scenario allowed by the cohort
config, then works the multi-channel workspace.

## Cohort config

`cohorts.configJson` (Zod schema in `lib/cohort/defaults.ts`):

- `scenarios.allowed`: which scenario ids learners may start
- `gates.minScoreRatio` / `gates.maxRetries`: formative (null) or hard gate
- `llm.temperature`: persona sampling (the provider and models are
  deployment settings, not cohort settings)
- `ui.showRubricScores`: whether learners see scores or only the client's
  in-character reaction

## Models

`lib/llm/client.ts` (Vercel AI SDK): personas default to `claude-sonnet-5`,
the rubric judge to `claude-opus-4-8`; both overridable through
`LLM_PERSONA_MODEL` / `LLM_RUBRIC_MODEL`, provider switchable to OpenAI.
Every rubric score row stores the judge model and a `promptVersion` for
traceability in reported results. The current versions, and the text of every
earlier one, are in `lib/agents/prompt-provenance.ts`: at the time of writing
`rubric-v10` (judge), `consistency-v6` (auditor), `persona-v8` (personas) and
`analyst-v3` (analyst agent).

## Research instrumentation


- **Role-consistency audit** (`lib/agents/consistency.ts`): a configurable
  fraction of persona turns (`research.consistencyAuditRate`) is checked
  against the world-fact ledger by a second, separate structured-output
  model call (no sampling temperature is sent);
  verdicts land as `persona_consistency` events and surface as a
  consistency rate on the cohort analytics page.
- **Instructor score moderation**: per-criterion overrides with notes sit
  beside (never replace) judge scores on `rubric_scores`; the scores export
  carries both.
- **Check-ins and reflections** (`research.checkins`,
  `research.reflections`): a confidence check-in at engagement start and
  completion, and a short reflection with each gate submission. Both sit
  behind cohort flags that are off by default; with a flag off the
  learner is not asked for either.

## Privacy & retention

Learner ids are HMAC-hashed; transcripts are stored raw (instructors need
them for formative feedback; learners are pseudonymous). The daily
`/api/cron/cleanup` job, authenticated by `CRON_SECRET`
(`lib/logging/retention.ts`), first copies the grade record onto the
submission and score rows, then:

- deletes chat messages and events older than `RETENTION_DAYS` (default 180);
- blanks the learner's own words on data releases of the same age
  (`data_releases.scope_text`), keeping the row with the text's length and
  sha256;
- deletes sandbox seats older than 30 days with every row under them, and
  records each deletion in `deletion_log`;
- removes the IP address hash from sandbox seats older than 30 days.

Submissions with their scores and grade record, the world-fact ledger,
`fact_elicitations` and the release records without their text are kept
until an instructor deletes the learner, the engagement or the cohort.
Cohorts with `showcase.reviewerVisible` on are exempt from the purge: they
hold the curated showcase runs, restored with their original timestamps.

## Testing

- `pnpm test` runs the vitest unit tests: scenario config invariants, stage
  pipeline logic, persona prompt containment (no dictionary/card leaks),
  rubric judge post-processing (clamping, skipped criteria, duplicates),
  and dataset-quirk regression checks on the committed CSVs.
- `pnpm e2e tests/e2e/smoke.spec.ts`: no-database smoke: public pages,
  auth redirect, join error.
- `E2E_ADMIN_PASSWORD=... pnpm e2e tests/e2e/engagement-walkthrough.spec.ts`
 covers the walkthrough path: cohort → invite → join → chat with the client →
  stage-gate submission → rubric → dataset release and download →
  instructor monitor. Runs offline against `pnpm demo`
  (`E2E_ADMIN_PASSWORD=demo`) or against a real deployment through
  `PLAYWRIGHT_BASE_URL`.

## Local demo mode

`pnpm demo` (or `make demo`) runs the whole system with zero external
dependencies: `DB_DRIVER=pglite` swaps the Vercel Postgres driver for an
embedded PGlite database under `.pglite/` (migrated on start by
`scripts/migrate-local.ts`), `LLM_PROVIDER=mock` swaps both models for a
deterministic mock (`lib/llm/mock.ts`) that speaks the persona and rubric
protocols, and `DEMO_MODE=1` enables fixed instructor credentials
(admin/demo) when no `ADMIN_PASSWORD_HASH` is set. None of these switches
may be set on a real deployment.

## Analyst-agent demo mode (AgenticPracticum demo capability)

An **analyst agent** can play the learner side of an
engagement (`engagements.mode = "agent"`; human engagements are untouched).
`lib/agents/analyst.ts` builds a strictly learner-visible view (brief, stage
guidance, gate instructions, channel transcripts, and deterministic profiles
of released dataset files (`lib/agents/dataset-profile.ts`) standing in for
the human's outside analysis) and one `generateObject` call per step decides
a single action: message an unlocked stakeholder channel, or submit the
stage-gate artifact. Actions execute through the identical pipeline as a
human (`handleLearnerMessage`, `handleGateSubmission`), so rubric scoring,
world facts, and events accrue the same way. Containment is structural: the
prompt builder (`buildAnalystSystemPrompt`) is pure and never receives
persona cards, the world-fact ledger, or data dictionaries (unit-tested).
Grounding rule: the agent may only cite numbers present in the dataset
profiles or the transcripts, and since `analyst-v3` it may not say in a
message or an artifact that work was done, a sample sent or a decision agreed
unless an artifact or a transcript shows it. A retry after a failed gate sees
the agent's own previous artifact for the stage and the feedback a learner
sees (score, rationales, improve lines). Invalid actions (locked channel, message after
the per-stage turn cap `ANALYST_MAX_MESSAGES_PER_STAGE`) are logged as
`analyst_step_rejected` and retried, never silently corrected. Every step
logs model, prompt version (`analyst-v3` at the time of writing), token
usage, and the agent's stated reasoning.

Instructor surfaces: `/admin/cohorts/[id]/agent` starts runs and drives them
one stage at a time; `/admin/compare?a=&b=` renders two engagements side by
side (stage progress, gate submissions with rubric totals, channel
transcripts) with mode badges, so a reviewer can watch a human learner and
the analyst agent work the same scenario. The mock LLM implements a
deterministic analyst policy, so the whole mode works offline in `pnpm demo`.
