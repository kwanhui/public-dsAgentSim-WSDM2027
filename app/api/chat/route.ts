import { NextResponse } from "next/server";
import { z } from "zod";
import { handleLearnerMessage } from "@/lib/agents/orchestrator";
import { resolveLearnerContext } from "@/lib/engagement/request";
import { countLearnerMessages, getChannel, getEngagement, getEvents, getMessages, logEvent } from "@/lib/engagement/state";
import { releaseNotesByMessage } from "@/lib/engagement/release-notes";
import { MESSAGE_CAP_EVENT, messageCapRefusal, messagesRemaining } from "@/lib/engagement/message-cap";
import {
  BUDGET_REFUSED_EVENT,
  budgetExceededResponse,
  budgetRefusedDetail,
  checkCohortBudget,
} from "@/lib/llm/budget";
import { learnerMessageCap } from "@/lib/cohort/limits";

export const runtime = "nodejs";

// GET /api/chat?channelId=... -> transcript of one channel.
export async function GET(req: Request) {
  const res = await resolveLearnerContext();
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 401 });

  const channelId = new URL(req.url).searchParams.get("channelId");
  if (!channelId) return NextResponse.json({ error: "bad-request" }, { status: 400 });

  const channel = await getChannel(channelId);
  // Any of the learner's own engagements, so an earlier engagement opened
  // from the workspace list stays readable; never another learner's.
  const owner =
    channel && channel.engagementId !== res.ctx.engagement.id ? await getEngagement(channel.engagementId) : null;
  if (!channel || (channel.engagementId !== res.ctx.engagement.id && owner?.studentId !== res.ctx.cohort.studentId)) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  const msgs = await getMessages(channelId);
  // A platform line under a reply whose file release was dropped; display
  // only (lib/engagement/release-notes.ts).
  const notes = releaseNotesByMessage(await getEvents(channel.engagementId), msgs);
  return NextResponse.json({
    messages: msgs.map((m) => ({
      id: m.id,
      sender: m.sender,
      content: m.content,
      timestampIso: m.timestampIso,
      platformNote: notes.get(m.id) ?? null,
    })),
  });
}

const PostSchema = z.object({
  channelId: z.string(),
  message: z.string().min(1).max(4000),
});

// POST -> one synchronous persona turn.
export async function POST(req: Request) {
  const res = await resolveLearnerContext();
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 401 });
  const { engagement, scenario, cohort } = res.ctx;

  if (engagement.status !== "active") {
    return NextResponse.json({ error: "engagement-closed" }, { status: 409 });
  }

  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-request" }, { status: 400 });

  const channel = await getChannel(parsed.data.channelId);
  if (!channel || channel.engagementId !== engagement.id) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  if (!channel.unlockedAt) {
    return NextResponse.json({ error: "channel-locked" }, { status: 403 });
  }

  // Spend controls, checked before any model call: the sandbox cohort's own
  // daily limit and the deployment's daily budget, then this engagement's
  // message cap. A refusal is logged on the engagement so the instructor
  // can see who was turned away.
  const budget = await checkCohortBudget({ id: cohort.cohortId, config: cohort.config });
  if (!budget.ok) {
    await logEvent(engagement.id, engagement.cohortId, BUDGET_REFUSED_EVENT, budgetRefusedDetail(budget, "chat", engagement.currentStage));
    return budgetExceededResponse("chat", new Date(), cohort.joinRoute === "sandbox" ? "sandbox" : "course");
  }
  const cap = learnerMessageCap(cohort.config, cohort.joinRoute);
  const sent = await countLearnerMessages(engagement.id);
  const capRefusal = messageCapRefusal(sent, cap);
  if (capRefusal) {
    // Logged so the instructor can see who ran out of messages; one event
    // per refused message.
    await logEvent(engagement.id, engagement.cohortId, MESSAGE_CAP_EVENT, {
      channelId: channel.id,
      personaId: channel.personaId,
      stage: engagement.currentStage,
      cap,
      sent,
    });
    return NextResponse.json(
      { error: "message-limit", message: capRefusal, messagesRemaining: 0 },
      { status: 429 },
    );
  }

  try {
    const reply = await handleLearnerMessage({
      engagement,
      channel,
      scenario,
      config: cohort.config,
      text: parsed.data.message,
    });
    // The turn is stored, so this learner message counts toward the cap.
    return NextResponse.json({ ...reply, messagesRemaining: messagesRemaining(sent + 1, cap) });
  } catch (err) {
    // The failure and the tokens it cost are logged as persona_failed by the
    // orchestrator; a failed turn does not count toward the cap.
    console.error("chat turn failed", err);
    return NextResponse.json(
      { error: "persona-unavailable", messagesRemaining: messagesRemaining(sent, cap) },
      { status: 502 },
    );
  }
}
