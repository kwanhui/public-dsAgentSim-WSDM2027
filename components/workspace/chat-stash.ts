// The server writes the learner's question to the transcript only together
// with the persona's reply (lib/agents/orchestrator.ts), so a tab closed
// while a turn is in flight would otherwise lose the question entirely. The
// chat pane stashes the in-flight message here at send time and clears it
// once the reply confirms persistence; a stash still present on mount is a
// stranded message that belongs back in the box. Channel ids are unique
// across engagements, so one key per channel covers them all.
//
// Every localStorage access is wrapped: some contexts (private windows,
// browsers blocking site data) throw on the accessor itself, and a browser
// refusing storage should only cost the recovery, not the send.

const STASH_KEY_PREFIX = "agenticpracticum:chat-in-flight:";

export function stashKey(channelId: string): string {
  return `${STASH_KEY_PREFIX}${channelId}`;
}

/** Records the message about to be sent, so it survives a reload or tab
 * close while the turn is in flight. */
export function stashInFlightMessage(channelId: string, text: string): void {
  try {
    window.localStorage.setItem(stashKey(channelId), text);
  } catch {
    // Without storage the message survives only in memory, as before.
  }
}

/** Drops the stash once the server has confirmed both sides of the exchange
 * are in the transcript. */
export function clearStashedMessage(channelId: string): void {
  try {
    window.localStorage.removeItem(stashKey(channelId));
  } catch {
    // At worst a stale stash is restored once on the next mount.
  }
}

/** Returns the stranded message for this channel without clearing it, or
 * null when there is nothing to restore. Reading and clearing are separate
 * so the pane can read during state initialisation (safely repeatable) and
 * clear in an effect: once the message is back in the box the stash's job is
 * done, and one the learner then deletes must not resurface on every visit. */
export function peekStashedMessage(channelId: string): string | null {
  try {
    const text = window.localStorage.getItem(stashKey(channelId));
    return text !== null && text.trim() !== "" ? text : null;
  } catch {
    return null;
  }
}
