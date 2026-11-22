// The platform line shown under a data-owner reply whose file release the
// platform dropped (release_withheld, lib/agents/release-scope.ts). The
// persona may still have written that it is sending the file; the line says
// that no file was released and why, from the reason the event records.
// Display only: stored messages and events are not changed. Pure.

import { RELEASE_WITHHELD_EVENT } from "@/lib/agents/release-scope";

export interface NoteEvent {
  type: string;
  detailJson: unknown;
}

export interface NoteMessage {
  id: number;
  channelId?: string;
  sender: string;
  content?: string;
}

// The orchestrator's attachment line (lib/agents/orchestrator.ts).
const ATTACHED = /\[Attached: /;

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The platform line for a dropped release, from the event's `missing`
 * list ("column", "purpose"). When another file in the same reply was
 * released, `files` names the ones that were not. */
export function releaseWithheldNote(missing: readonly string[], files: readonly string[] | null = null): string {
  const column = missing.includes("column");
  const purpose = missing.includes("purpose");
  const reason =
    column && purpose
      ? "the request named no column of the data dictionary and stated no purpose"
      : column
        ? "the request named no column of the data dictionary"
        : purpose
          ? "the request stated no purpose"
          : "the request did not state a scope";
  return files && files.length > 0
    ? `Not released: ${files.join(", ")}, because ${reason}.`
    : `No file was released: ${reason}.`;
}

/** Platform lines keyed by the id of the reply they belong under. The reply
 * is the first message after the event's scope message (the learner's
 * message the release answered) that the event's persona sent in the same
 * channel. `messages` may hold one channel or several. */
export function releaseNotesByMessage(
  events: readonly NoteEvent[],
  messages: readonly NoteMessage[],
): Map<number, string> {
  const out = new Map<number, string>();
  const missingByScope = new Map<number, { personaId: string | null; missing: Set<string>; files: Set<string> }>();
  for (const e of events) {
    if (e.type !== RELEASE_WITHHELD_EVENT) continue;
    const d = record(e.detailJson);
    if (typeof d.scopeMessageId !== "number") continue;
    const entry = missingByScope.get(d.scopeMessageId) ?? {
      personaId: typeof d.personaId === "string" ? d.personaId : null,
      missing: new Set<string>(),
      files: new Set<string>(),
    };
    if (typeof d.file === "string") entry.files.add(d.file);
    for (const m of Array.isArray(d.missing) ? d.missing : []) if (typeof m === "string") entry.missing.add(m);
    missingByScope.set(d.scopeMessageId, entry);
  }
  if (missingByScope.size === 0) return out;
  const ordered = [...messages].sort((a, b) => a.id - b.id);
  for (const [scopeId, entry] of missingByScope) {
    const scope = ordered.find((m) => m.id === scopeId);
    if (!scope) continue;
    const reply = ordered.find(
      (m) =>
        m.id > scopeId &&
        m.sender !== "learner" &&
        (entry.personaId === null || m.sender === entry.personaId) &&
        (scope.channelId === undefined || m.channelId === scope.channelId),
    );
    if (!reply) continue;
    const partly = reply.content !== undefined && ATTACHED.test(reply.content);
    out.set(reply.id, releaseWithheldNote([...entry.missing], partly ? [...entry.files] : null));
  }
  return out;
}
