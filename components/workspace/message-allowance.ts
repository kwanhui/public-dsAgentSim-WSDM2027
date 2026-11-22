// The learner's message allowance for the engagement (cohort config
// limits.maxLearnerMessages), shown as one muted line under the composer.
// Pure, so the wording is testable apart from the chat pane.

import { messageCapMessage } from "@/lib/engagement/message-cap";

/** "184 of 200 messages left", or the cap message once none are left. */
export function messagesLeftLine(remaining: number, max: number): string {
  const left = Math.max(0, Math.floor(remaining));
  if (left === 0) return messageCapMessage(max);
  return `${left} of ${max} ${max === 1 ? "message" : "messages"} left`;
}

/** The remaining count a chat response reports, or null when it carries
 * none (a response from before the field existed, or an unrelated error). */
export function remainingFromResponse(body: unknown): number | null {
  const n =
    body && typeof body === "object" ? (body as { messagesRemaining?: unknown }).messagesRemaining : undefined;
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : null;
}

/** Remaining messages as the workspace knows them: the lower of the bundle's
 * count and the latest chat response, since the count only goes down and
 * either one can be the more recent. */
export function currentRemaining(fromBundle: number, fromChat: number | null): number {
  return Math.max(0, fromChat === null ? fromBundle : Math.min(fromBundle, fromChat));
}
