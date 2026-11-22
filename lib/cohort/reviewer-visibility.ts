// When a cohort may be shown to the read-only reviewer account, whose
// password is printed in the paper. Only an exhibit cohort qualifies: one
// with no open join (anonymous visitors) and no invited learner other than
// the labelled showcase runs the authors made themselves. The config route
// refuses the flag otherwise (app/api/admin/cohorts/[id]/route.ts), so one
// wrong tick cannot publish a course cohort's transcripts and scores. Pure.

import type { JoinRoute } from "@/lib/cohort/join-route";

export interface VisibilityLearner {
  joinRoute: JoinRoute;
  /** Ids of this learner's engagements. */
  engagementIds: string[];
}

/** Invited learners who are not labelled showcase runs. A learner counts
 * as a showcase run only when every engagement they have is labelled. */
export function unlabelledInvitedLearners(
  learners: readonly VisibilityLearner[],
  labels: Record<string, string>,
): number {
  return learners.filter(
    (l) =>
      l.joinRoute === "invite" &&
      (l.engagementIds.length === 0 || l.engagementIds.some((id) => !labels[id])),
  ).length;
}

export function reviewerVisibleRefusal(input: {
  reviewerVisible: boolean;
  openJoin: boolean;
  invitedLearners: number;
}): string | null {
  if (!input.reviewerVisible) return null;
  if (input.openJoin) {
    return "The reviewer account cannot see a cohort with open join, because anonymous visitors' work would become readable with the password printed in the paper. Turn off open join, or leave the reviewer setting off.";
  }
  if (input.invitedLearners > 0) {
    return `The reviewer account cannot see a cohort with invited learners (this one has ${input.invitedLearners}), because their transcripts and scores would become readable with the password printed in the paper. Use a separate showcase cohort.`;
  }
  return null;
}
