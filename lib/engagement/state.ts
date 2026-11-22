import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  channels,
  checkins,
  cohorts,
  engagements,
  events,
  messages,
  rubricScores,
  submissions,
  worldFacts,
} from "@/lib/db/schema";
import {
  resolveProvenance,
  type FactProvenance,
  type LedgerFact,
} from "@/lib/engagement/provenance";
import { scenarioWorldClockFacts } from "@/lib/engagement/world-clock";
import { loadScenario } from "@/lib/scenarios/load";
import { stageReached, type Scenario, type StageId, STAGE_IDS } from "@/lib/scenarios/types";

export type Engagement = typeof engagements.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type RubricScore = typeof rubricScores.$inferSelect;

// One learner has at most one active engagement per cohort.
export async function getActiveEngagement(studentId: string): Promise<Engagement | null> {
  const [row] = await db
    .select()
    .from(engagements)
    .where(and(eq(engagements.studentId, studentId), eq(engagements.status, "active")))
    .limit(1);
  return row ?? null;
}

// The engagement a learner should see: their active one, falling back to the
// most recently started one (completed engagements stay reviewable).
export async function getCurrentEngagement(studentId: string): Promise<Engagement | null> {
  const active = await getActiveEngagement(studentId);
  if (active) return active;
  const [latest] = await db
    .select()
    .from(engagements)
    .where(eq(engagements.studentId, studentId))
    .orderBy(desc(engagements.createdAt))
    .limit(1);
  return latest ?? null;
}

export async function getEngagement(engagementId: string): Promise<Engagement | null> {
  const [row] = await db.select().from(engagements).where(eq(engagements.id, engagementId)).limit(1);
  return row ?? null;
}

// When the instructor archived the cohort, or null while it is open. An
// archived cohort takes no new engagements (no new LLM cost, no new export
// rows); engagements already under way are not touched.
export async function getCohortArchivedAt(cohortId: string): Promise<Date | null> {
  const [row] = await db
    .select({ archivedAt: cohorts.archivedAt })
    .from(cohorts)
    .where(eq(cohorts.id, cohortId))
    .limit(1);
  return row?.archivedAt ?? null;
}

// Creates the engagement, one channel per persona (channels unlock as stages
// are reached), and seeds the world-fact ledger from the scenario config.
export async function createEngagement(
  cohortId: string,
  studentId: string,
  scenario: Scenario,
): Promise<Engagement> {
  const firstStage: StageId = STAGE_IDS[0];
  const [engagement] = await db
    .insert(engagements)
    .values({ cohortId, studentId, scenarioId: scenario.id, currentStage: firstStage, elicitationTrace: true })
    .returning();

  await db.insert(channels).values(
    scenario.personas.map((p) => ({
      engagementId: engagement.id,
      personaId: p.id,
      unlockedAt: stageReached(firstStage, p.unlockedAtStage) ? new Date() : null,
    })),
  );

  // The scenario's seed facts, plus the in-world clock derived from the
  // dataset's date coverage (lib/engagement/world-clock.ts): without a stated
  // "today", the data owner cannot vouch for her own extract's end date.
  const seedFacts = [...scenario.worldFactsSeed, ...(await scenarioWorldClockFacts(scenario))];
  if (seedFacts.length > 0) {
    await db.insert(worldFacts).values(
      seedFacts.map((fact) => ({
        engagementId: engagement.id,
        fact,
        source: "system",
        provenance: "seed",
        stage: firstStage,
      })),
    );
  }

  await logEvent(engagement.id, cohortId, "engagement_started", { scenarioId: scenario.id });
  return engagement;
}

export async function getChannels(engagementId: string): Promise<Channel[]> {
  return db.select().from(channels).where(eq(channels.engagementId, engagementId)).orderBy(asc(channels.createdAt));
}

export async function getChannel(channelId: string): Promise<Channel | null> {
  const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  return row ?? null;
}

export async function getMessages(channelId: string): Promise<Message[]> {
  return db.select().from(messages).where(eq(messages.channelId, channelId)).orderBy(asc(messages.id));
}

export async function appendMessage(input: {
  channelId: string;
  engagementId: string;
  sender: string;
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}): Promise<Message> {
  const [row] = await db
    .insert(messages)
    .values({ ...input, timestampIso: new Date().toISOString() })
    .returning();
  return row;
}

// Per-channel message tallies for the whole engagement, in one query, so the
// workspace bundle can mark channels the learner has not caught up with.
export async function getChannelMessageCounts(
  engagementId: string,
): Promise<Map<string, { total: number; fromPersona: number }>> {
  const rows = await db
    .select({ channelId: messages.channelId, sender: messages.sender })
    .from(messages)
    .where(eq(messages.engagementId, engagementId));

  const counts = new Map<string, { total: number; fromPersona: number }>();
  for (const row of rows) {
    const entry = counts.get(row.channelId) ?? { total: 0, fromPersona: 0 };
    entry.total += 1;
    if (row.sender !== "learner") entry.fromPersona += 1;
    counts.set(row.channelId, entry);
  }
  return counts;
}

/** Messages the learner (or the analyst agent) has sent in this engagement,
 * across all channels. The per-engagement message cap counts these. */
export async function countLearnerMessages(engagementId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(messages)
    .where(and(eq(messages.engagementId, engagementId), eq(messages.sender, "learner")));
  return Number(row?.n ?? 0);
}

export async function getWorldFacts(engagementId: string): Promise<string[]> {
  const rows = await db
    .select({ fact: worldFacts.fact })
    .from(worldFacts)
    .where(eq(worldFacts.engagementId, engagementId))
    .orderBy(asc(worldFacts.id));
  return rows.map((r) => r.fact);
}

export interface LedgerRow extends LedgerFact {
  source: string;
  stage: string;
}

/** The ledger with each fact's provenance, oldest first. Rows without a
 * stored tag get the inferred one (lib/engagement/provenance.ts). */
export async function getLedger(engagementId: string): Promise<LedgerRow[]> {
  const rows = await db
    .select({
      fact: worldFacts.fact,
      source: worldFacts.source,
      stage: worldFacts.stage,
      provenance: worldFacts.provenance,
    })
    .from(worldFacts)
    .where(eq(worldFacts.engagementId, engagementId))
    .orderBy(asc(worldFacts.id));
  return rows.map((r) => ({
    fact: r.fact,
    source: r.source,
    stage: r.stage,
    provenance: resolveProvenance(r),
  }));
}

// Provenance defaults from the source: a persona id means the stakeholder
// model wrote the fact; "system" means a platform event. Release profiles
// and seeds pass their tag explicitly.
export async function appendWorldFacts(
  engagementId: string,
  stage: StageId,
  source: string,
  facts: string[],
  provenance?: FactProvenance,
): Promise<void> {
  if (facts.length === 0) return;
  const tag: FactProvenance = provenance ?? (source === "system" ? "system" : "persona");
  await db
    .insert(worldFacts)
    .values(facts.map((fact) => ({ engagementId, fact, source, stage, provenance: tag })));
}

export async function getSubmissions(engagementId: string): Promise<Submission[]> {
  return db.select().from(submissions).where(eq(submissions.engagementId, engagementId)).orderBy(asc(submissions.createdAt));
}

export async function getRubricScores(engagementId: string): Promise<RubricScore[]> {
  return db.select().from(rubricScores).where(eq(rubricScores.engagementId, engagementId)).orderBy(asc(rubricScores.id));
}

export async function advanceStage(engagementId: string, to: StageId, scenario: Scenario): Promise<void> {
  await db.update(engagements).set({ currentStage: to }).where(eq(engagements.id, engagementId));
  // Unlock channels whose persona becomes available at (or before) the new stage.
  const chans = await getChannels(engagementId);
  const now = new Date();
  for (const c of chans) {
    if (c.unlockedAt) continue;
    const persona = scenario.personas.find((p) => p.id === c.personaId);
    if (persona && stageReached(to, persona.unlockedAtStage)) {
      await db.update(channels).set({ unlockedAt: now }).where(eq(channels.id, c.id));
    }
  }
}

export async function completeEngagement(engagementId: string): Promise<void> {
  await db
    .update(engagements)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(engagements.id, engagementId));
}

export type Checkin = typeof checkins.$inferSelect;

export async function getCheckins(engagementId: string): Promise<Checkin[]> {
  return db.select().from(checkins).where(eq(checkins.engagementId, engagementId)).orderBy(asc(checkins.id));
}

export async function addCheckin(
  engagementId: string,
  kind: "start" | "complete",
  answers: Record<string, number>,
  goal?: string,
): Promise<void> {
  await db.insert(checkins).values({ engagementId, kind, answersJson: answers, goal: goal ?? null });
}

// Errors are swallowed: an event-log failure must never break the learner flow.
export async function logEvent(
  engagementId: string,
  cohortId: string | null,
  type: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(events).values({
      engagementId,
      cohortId,
      type,
      detailJson: detail ?? null,
      timestampIso: new Date().toISOString(),
    });
  } catch {
    // intentionally swallowed
  }
}

export async function getEvents(engagementId: string) {
  return db.select().from(events).where(eq(events.engagementId, engagementId)).orderBy(asc(events.id));
}

export async function loadScenarioFor(engagement: Engagement): Promise<Scenario> {
  return loadScenario(engagement.scenarioId);
}
