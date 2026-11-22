// Per-engagement cap on learner messages (cohort config
// limits.maxLearnerMessages). Pure, so the rule is testable apart from the
// route that enforces it.

export function messageCapMessage(cap: number): string {
  return `This engagement has reached its limit of ${cap} messages. You can still submit the stage artifact.`;
}

/** The refusal text when sending one more message would exceed the cap, or
 * null when the message may go through. */
export function messageCapRefusal(sentSoFar: number, cap: number): string | null {
  return sentSoFar >= cap ? messageCapMessage(cap) : null;
}

/** Messages the learner may still send; never below zero. */
export function messagesRemaining(sentSoFar: number, cap: number): number {
  return Math.max(0, cap - sentSoFar);
}

// Logged when the cap refuses a learner message.
export const MESSAGE_CAP_EVENT = "message_cap_reached";
