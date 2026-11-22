// The per-engagement message cap that applies to a learner. A seat that
// joined through the public sandbox gets the lower of the cohort's
// limits.maxLearnerMessages and sandbox.maxLearnerMessages (default 40), so
// an anonymous visitor cannot run an engagement to the course cap of 200.
// Pure.

import type { CohortConfig } from "@/lib/cohort/defaults";
import type { JoinRoute } from "@/lib/cohort/join-route";

export function learnerMessageCap(
  config: Pick<CohortConfig, "limits" | "sandbox">,
  joinRoute: JoinRoute,
): number {
  const cap = config.limits.maxLearnerMessages;
  if (joinRoute !== "sandbox") return cap;
  return Math.min(cap, config.sandbox.maxLearnerMessages);
}
