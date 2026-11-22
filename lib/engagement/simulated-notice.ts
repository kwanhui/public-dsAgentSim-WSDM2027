// The notice a learner sees on first entry to the workspace: who the
// stakeholders are (simulated by a language model) and where their messages
// go. Pure, so the workspace and its tests read the same text.

export interface NoticePersona {
  name: string;
  role: string;
}

// Client sponsor first, then data owner, then end user, the order the
// engagement introduces them in; any other role follows in scenario order.
const ROLE_ORDER = ["client-sponsor", "data-owner", "end-user"];

export function stakeholderNames(personas: NoticePersona[]): string[] {
  const rank = (role: string) => {
    const i = ROLE_ORDER.indexOf(role);
    return i === -1 ? ROLE_ORDER.length : i;
  };
  return [...personas]
    .map((p, i) => ({ p, i }))
    .sort((x, y) => rank(x.p.role) - rank(y.p.role) || x.i - y.i)
    .map(({ p }) => p.name);
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** How the learner joined (lib/cohort/join-route.ts). A sandbox visitor has
 * no instructor, so their notice says where the messages are kept instead. */
export type NoticeJoinRoute = "invite" | "sandbox" | "agent";

export function storageNoticeLine(joinRoute: NoticeJoinRoute = "invite"): string {
  return joinRoute === "sandbox"
    ? "Your messages are sent to the model provider and stored on this demo server."
    : "Your messages are sent to the model provider and stored for your instructor.";
}

export function simulatedNoticeLines(
  personas: NoticePersona[],
  joinRoute: NoticeJoinRoute = "invite",
): string[] {
  const names = stakeholderNames(personas);
  const who = names.length > 0 ? joinNames(names) : "The stakeholders";
  return [
    `${who} ${names.length === 1 ? "is" : "are"} simulated by a language model.`,
    storageNoticeLine(joinRoute),
  ];
}

/** Browser storage key for the dismissal, one per learner. */
export function simulatedNoticeKey(pseudonym: string): string {
  return `agenticpracticum:simulated-notice-dismissed:${pseudonym}`;
}
