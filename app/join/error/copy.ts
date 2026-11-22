export interface JoinErrorCopy {
  title: string;
  description: string;
  /** Optional second line, with a link to the read-only showcase. */
  showcaseHint?: boolean;
}

/**
 * Copy for every way a join or resume link can fail. Anything unrecognised
 * (a truncated URL, a hand-edited `reason`, no reason at all) falls back to
 * the generic bad-link message, never to "already used": telling a learner
 * their invite is spent when the link was merely mangled sends them to ask
 * for a replacement they do not need.
 */
const COPY: Record<string, JoinErrorCopy> = {
  missing: {
    title: "This invite link is incomplete",
    description:
      "The link has no invite token in it. Check it copied fully from your email, or ask your instructor for a fresh invite URL.",
  },
  invalid: {
    title: "This invite link is not valid",
    description:
      "This link looks incomplete. Check that it copied fully from your email; if the full link still fails, ask your instructor for a new one.",
  },
  used: {
    title: "This invite has already been used",
    description:
      "Each invite works once. Already joined on another device? Ask your instructor for a resume link, which returns you to the engagement you started.",
  },
  expired: {
    title: "This invite has expired",
    description:
      "Invites expire 30 days after they are issued, and an instructor can revoke one sooner. Ask your instructor for a fresh one.",
  },
  "cohort-closed": {
    title: "This cohort has been closed",
    description:
      "This cohort has been closed by the instructor, so its invite links no longer let anyone join. Learners who joined before it closed keep their access. Ask your instructor which class to join instead.",
  },
  "reviewer-visible": {
    title: "This invite link cannot be used",
    description:
      "The cohort it belongs to is a public showcase, so it takes no learners. Ask your instructor for an invite to your class cohort.",
  },
  "sandbox-closed": {
    title: "Learner sandbox is not open",
    description:
      "No cohort on this deployment is open for trying the learner side without an invite. Ask the instructor for an invite link.",
  },
  "sandbox-no-budget": {
    title: "Learner sandbox is not available",
    description:
      "This deployment has no daily spending limit set, so it does not take sandbox visitors. The operator can set LLM_DAILY_BUDGET_USD to open it.",
  },
  "sandbox-ip-limit": {
    title: "Sandbox seat limit reached",
    description:
      "This network has taken the most sandbox seats allowed in one day. It opens again at 00:00 UTC. If you already have a seat, return to it from the same browser.",
    showcaseHint: true,
  },
  "sandbox-full": {
    title: "Learner sandbox is full for today",
    description:
      "The sandbox takes a fixed number of new learners per day. It opens again at 00:00 UTC.",
    showcaseHint: true,
  },
  "usage-limit": {
    title: "Daily usage limit reached",
    description: "The demo has reached today's usage limit. It resets at 00:00 UTC.",
    showcaseHint: true,
  },
  "resume-expired": {
    title: "This resume link has expired",
    description:
      "Resume links are valid for 14 days. Your engagement is still there: ask your instructor for a new resume link.",
  },
  "resume-invalid": {
    title: "This resume link is not valid",
    description:
      "Check the link copied fully, or ask your instructor for a new resume link.",
  },
};

// The hint's middle words are the link to the reviewer sign-in, so the page
// renders before + link + after with only the link text underlined.
export const SHOWCASE_HINT = {
  before: "You can still view the showcase cohort with the ",
  linkText: "read-only reviewer sign-in",
  href: "/admin/login",
  after: ", which needs no seat.",
} as const;

export function joinErrorCopy(reason?: string | null): JoinErrorCopy {
  if (reason && Object.prototype.hasOwnProperty.call(COPY, reason)) return COPY[reason];
  return COPY.invalid;
}
