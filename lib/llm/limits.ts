// Output-token caps for every LLM call, in one place. Each cap has a default
// here and an environment override, so a deployment can tighten or loosen a
// role without a code change. A call that hits its cap is cut off, which for
// a structured call means a parse failure and a retry, so the defaults leave
// room above what each role normally writes.
//
//   LLM_MAX_TOKENS_PERSONA              persona turn (reply plus ledger JSON)
//   LLM_MAX_TOKENS_REACTION             client sponsor's gate reaction
//   LLM_MAX_TOKENS_JUDGE_PER_CRITERION  rubric judge, per rubric criterion
//   LLM_MAX_TOKENS_JUDGE_CAP            rubric judge, upper bound
//   LLM_MAX_TOKENS_AUDITOR              consistency auditor verdict
//   LLM_MAX_TOKENS_ANALYST              analyst-agent step

export const MAX_TOKENS_DEFAULTS = {
  // The prompt asks for 2 to 5 sentences; the cap is a backstop. At 450 a
  // long learner question drew a reply plus ledger JSON that hit the cap and
  // failed schema validation in testing, so the cap is 900.
  persona: 900,
  // The reaction is a structured call (reply plus newFacts JSON) so it needs the JSON overhead on top of a few sentences.
  reaction: 700,
  judgePerCriterion: 250,
  // Room for the assessorDirected report and the JSON around the scores.
  judgeBase: 200,
  judgeCap: 3000,
  auditor: 200,
  // One analyst call either writes a chat message or the complete stage
  // artifact, and the final handover asks for up to 1000 words, so the cap
  // has to fit the artifact. Since analyst-v2 the artifact also carries
  // "Not run:" lines and the step JSON carries stated reasoning, and 2000
  // truncated the handover step in testing, so the cap is 3500.
  analyst: 3500,
} as const;

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function personaMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "LLM_MAX_TOKENS_PERSONA", MAX_TOKENS_DEFAULTS.persona);
}

export function reactionMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "LLM_MAX_TOKENS_REACTION", MAX_TOKENS_DEFAULTS.reaction);
}

/** Sized to the rubric: a base plus a share per criterion, bounded. */
export function judgeMaxTokens(criteria: number, env: NodeJS.ProcessEnv = process.env): number {
  const perCriterion = envInt(env, "LLM_MAX_TOKENS_JUDGE_PER_CRITERION", MAX_TOKENS_DEFAULTS.judgePerCriterion);
  const cap = envInt(env, "LLM_MAX_TOKENS_JUDGE_CAP", MAX_TOKENS_DEFAULTS.judgeCap);
  return Math.min(cap, MAX_TOKENS_DEFAULTS.judgeBase + perCriterion * Math.max(1, criteria));
}

export function auditorMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "LLM_MAX_TOKENS_AUDITOR", MAX_TOKENS_DEFAULTS.auditor);
}

export function analystMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "LLM_MAX_TOKENS_ANALYST", MAX_TOKENS_DEFAULTS.analyst);
}
