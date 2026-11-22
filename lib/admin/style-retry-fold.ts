// The event log folds each persona_style_retry event into the reply it
// rewrote, so a reply that tripped the style check reads as one row with a
// short note ("style rewrite: 2 rules, fixed") and the rules behind a
// toggle. The style event is logged just before the reply's own event
// (persona_turn for a chat reply, client_reaction for a gate reaction) of
// the same persona; a style event with no such reply after it keeps its own
// row. Only the display changes: the stored events are untouched. Pure.

import { stylePatternsLine } from "@/lib/admin/style-labels";

export interface FoldableEvent {
  id: number;
  type: string;
  detailJson: unknown;
}

export interface StyleNote {
  // "style rewrite: 2 rules, fixed"
  line: string;
  // The rules, in words, for the expanded view.
  detail: string;
  resolved: boolean;
}

export interface FoldedRow<E extends FoldableEvent> {
  event: E;
  style: StyleNote | null;
  // The persona_style_retry folded into this reply's row, for the stored
  // JSON view.
  folded: E | null;
}

const STYLE_RETRY = "persona_style_retry";

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strings(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

/** The one-line note and the expanded detail for a persona_style_retry.
 * "still present" counts only the flagged rules that the rewrite kept; a
 * rule that first appears in the rewrite is counted as new. */
export function styleNote(detailJson: unknown): StyleNote {
  const d = record(detailJson);
  const patterns = strings(d.patterns) ?? [];
  const after = strings(d.patternsAfterRetry);
  const rules = `${patterns.length} ${patterns.length === 1 ? "rule" : "rules"}`;
  const kept = after ? after.filter((id) => patterns.includes(id)) : [];
  const added = after ? after.filter((id) => !patterns.includes(id)) : [];
  const outcome =
    after === null
      ? "rewrite failed, first draft kept"
      : after.length === 0
        ? "fixed"
        : [
            kept.length > 0 ? `${kept.length} still present` : `${patterns.length - kept.length} fixed`,
            added.length > 0 ? `${added.length} new` : null,
          ]
            .filter(Boolean)
            .join(", ");
  const capital = (t: string) => (t.length > 0 ? t[0].toUpperCase() + t.slice(1) : t);
  const detail = [
    patterns.length > 0 ? `Flagged: ${stylePatternsLine(patterns)}` : null,
    kept.length > 0 ? `Still present after the rewrite: ${stylePatternsLine(kept)}` : null,
    added.length > 0 ? `New after the rewrite: ${stylePatternsLine(added)}` : null,
    after === null ? "The rewrite call failed, so the first draft was sent" : null,
  ]
    .filter((x): x is string => Boolean(x))
    .map((x) => `${capital(x)}.`)
    .join(" ");
  return { line: `style rewrite: ${rules}, ${outcome}`, detail, resolved: after !== null && after.length === 0 };
}

function replyTypeFor(detailJson: unknown): string {
  return record(detailJson).kind === "reaction" ? "client_reaction" : "persona_turn";
}

function personaOf(detailJson: unknown): string | null {
  const p = record(detailJson).personaId;
  return typeof p === "string" ? p : null;
}

/** Rows for the event log, oldest first, with each style retry folded into
 * the reply it belongs to. */
export function foldStyleRetries<E extends FoldableEvent>(events: readonly E[]): FoldedRow<E>[] {
  const noteFor = new Map<number, E>();
  const folded = new Set<number>();
  for (const [i, e] of events.entries()) {
    if (e.type !== STYLE_RETRY) continue;
    const persona = personaOf(e.detailJson);
    const replyType = replyTypeFor(e.detailJson);
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (personaOf(next.detailJson) !== persona) continue;
      // Another rewrite of the same persona first: this one's reply is missing.
      if (next.type === STYLE_RETRY) break;
      if (next.type === replyType && !noteFor.has(next.id)) {
        noteFor.set(next.id, e);
        folded.add(e.id);
        break;
      }
    }
  }
  return events
    .filter((e) => !folded.has(e.id))
    .map((e) => {
      const source = e.type === STYLE_RETRY ? e : (noteFor.get(e.id) ?? null);
      return {
        event: e,
        style: source ? styleNote(source.detailJson) : null,
        folded: e.type === STYLE_RETRY ? null : source,
      };
    });
}
