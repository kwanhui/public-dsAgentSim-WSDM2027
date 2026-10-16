// Invites and resume links on a cohort the reviewer account can read. The
// reviewer password is printed in the paper, so a real learner invited into
// such a cohort by mistake would have their transcripts and scores readable
// by anyone holding the paper. The config route already refuses reviewer
// access for a cohort with invited learners (reviewer-visibility.ts); this
// closes the other order: once reviewer access is on, no invite can be
// minted or redeemed and no resume link can be issued.
//
// The one exception is the showcase regeneration (scripts/replay/regen.sh),
// which creates the cohort reviewer-visible and then invites its own
// scripted learners (the H1 reference run and the exhibit), labelled as
// showcase runs afterwards. It runs with SHOWCASE_REGEN=1 in the server's
// environment (`make showcase-regen` and `pnpm showcase:regen` set it for
// the local server they start). A deployment should never keep it set.

export const SHOWCASE_REGEN_ENV = "SHOWCASE_REGEN";

export const REVIEWER_VISIBLE_INVITE_REFUSAL =
  "This cohort is visible to the read-only reviewer account, so it takes no invites or resume links. Turn off reviewer access under Configuration first, or invite learners into a course cohort.";

/** True while the showcase regeneration script drives this server. */
export function showcaseRegenAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SHOWCASE_REGEN_ENV] === "1";
}

/** Why an invite or resume link may not be issued on this cohort, or null. */
export function reviewerVisibleInviteRefusal(
  config: { showcase: { reviewerVisible: boolean } },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!config.showcase.reviewerVisible) return null;
  if (showcaseRegenAllowed(env)) return null;
  return REVIEWER_VISIBLE_INVITE_REFUSAL;
}
