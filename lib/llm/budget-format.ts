// USD display and the budget refusal wording, apart from lib/llm/budget.ts
// so client and pure modules can use them without the database client.

/** "USD 0.45": rounded to cents. A figure above zero that rounds to nothing
 * reads "under USD 0.01" rather than a misleading zero. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "USD 0.00";
  if (usd < 0.005) return "under USD 0.01";
  return `USD ${usd.toFixed(2)}`;
}

/** The next 00:00 UTC after `now`, when the daily budget resets. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export type BudgetRefusalKind = "chat" | "submit" | "agent";

/** Who the refusal is for: a course learner, whose instructor can act on a
 * pause that keeps happening, or a demo sandbox visitor, who has none. */
export type BudgetAudience = "course" | "sandbox";

/**
 * The learner-facing refusal. `localTime` is the reset in the learner's own
 * time ("08:00"); without it the server's UTC wording is used. It says why
 * (a budget shared by everyone, not a limit on this learner), when replies
 * resume, and whom to tell:
 *   chat: "The course's daily model budget is used up for everyone; this is
 *          not a limit on your account. Replies resume at 08:00 your time.
 *          Tell your instructor if this keeps happening."
 */
export function budgetRefusalMessage(
  kind: BudgetRefusalKind,
  localTime: string | null,
  audience: BudgetAudience = "course",
): string {
  const at = localTime ? `${localTime} your time` : "00:00 UTC";
  if (kind === "agent") return `Model calls are paused until ${at}, when the daily budget resets.`;
  const why =
    audience === "sandbox"
      ? "The demo's daily model budget is used up for everyone; this is not a limit on your seat."
      : "The course's daily model budget is used up for everyone; this is not a limit on your account.";
  const resume =
    kind === "submit" ? `Scoring resumes at ${at}, and your draft is kept.` : `Replies resume at ${at}.`;
  const who = audience === "sandbox" ? "" : " Tell your instructor if this keeps happening.";
  return `${why} ${resume}${who}`;
}

/** "08:00" for a reset instant, in the given (or the browser's) time zone. */
export function localResetTime(resetsAtIso: string, timeZone?: string): string | null {
  const d = new Date(resetsAtIso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(d);
}

/** The refusal in the learner's local time when the response carries the
 * reset instant, otherwise the server's own message. */
export function localBudgetRefusal(
  kind: BudgetRefusalKind,
  body: { error?: string; message?: string; resetsAtIso?: string } | null,
  timeZone?: string,
  audience: BudgetAudience = "course",
): string | null {
  if (!body) return null;
  if (body.error === "daily-budget-exhausted") {
    const local = body.resetsAtIso ? localResetTime(body.resetsAtIso, timeZone) : null;
    return budgetRefusalMessage(kind, local, audience);
  }
  return body.message ?? null;
}
