// The data owner's release precondition, checked by the platform rather than
// left to the model. The persona prompt tells the data owner to release a
// file only once the consultant has stated a scope in their own words, but
// in one run a real model drafted the scope itself and released the
// extract on "Yes, confirmed, that scope is fine". So before a release is
// accepted, the learner's own messages in the data owner's channel so far
// must (1) name at least one column of that file's data dictionary and
// (2) state a purpose. When they do not, the release is dropped, the
// persona's reply loses any sentence that says the file is attached, and an
// in-role line asks for the missing piece unless the reply already does.
// The learner's words that met the condition are stored with the release
// (lib/agents/data-environment.ts), in a table the retention purge keeps.
//
// The check is a heuristic, and deliberately a lenient one: a column counts
// when the learner writes its name with underscores or spaces, or its stem
// without a trailing unit ("tenure" for tenure_months, "data usage" for
// data_usage_gb). A stem that is a word of the scenario's title ("churn" in
// "Postpaid churn at Meridian Mobile") does not count on its own, because
// naming the project is not naming a field. Pure.

import { PERSONA_RELEASE_ASK } from "@/lib/agents/prompt-provenance";
import type { Scenario, ScenarioDataset } from "@/lib/scenarios/types";

export const RELEASE_WITHHELD_EVENT = "release_withheld";

// How much of the qualifying messages is kept with the release.
export const SCOPE_TEXT_MAX_CHARS = 500;

// Phrases that state what the data is for.
const PURPOSE =
  /\b(?:for|to predict|to identify|to forecast|to segment|to model|to build|to train|to estimate|to rank|to target|to understand|to analy[sz]e|purpose|use it to|use them to|use it for|use them for|so that|in order to)\b/i;

// Trailing name parts that are units or qualifiers, dropped to form a stem.
const UNIT_TOKEN = /^(?:gb|sgd|avg|flag|days|months|\d+[a-z]?)$/;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Column names in a data dictionary: each line that starts with a name
 * and a colon, and each name of a "a / b / c:" group. Pure. */
export function dictionaryColumns(dictionary: string): string[] {
  const out: string[] = [];
  for (const line of dictionary.split("\n")) {
    const m = /^\s*([a-z][a-z0-9_]*(?:\s*\/\s*[a-z][a-z0-9_]*)*)\s*:/i.exec(line);
    if (!m) continue;
    for (const name of m[1].split("/")) out.push(name.trim().toLowerCase());
  }
  return [...new Set(out)];
}

/** The phrases that count as naming a column: the name with spaces for
 * underscores, and its stem without trailing unit parts, unless the stem
 * is a single word of the scenario title. Pure. */
export function columnPhrases(column: string, titleWords: ReadonlySet<string> = new Set()): string[] {
  const parts = column.toLowerCase().split("_").filter(Boolean);
  const full = parts.join(" ");
  const stemParts = [...parts];
  while (stemParts.length > 1 && UNIT_TOKEN.test(stemParts[stemParts.length - 1])) stemParts.pop();
  const stem = stemParts.join(" ");
  const phrases = [full];
  if (stem !== full && !(stemParts.length === 1 && titleWords.has(stem))) phrases.push(stem);
  if (parts.length === 1 && titleWords.has(full)) return [];
  return [...new Set(phrases)];
}

function mentions(text: string, phrase: string): boolean {
  const hay = ` ${words(text.replace(/_/g, " ")).join(" ")} `;
  // A plural "s" may follow the last word.
  return new RegExp(` ${phrase.replace(/ /g, " ")}s? `).test(hay);
}

export interface ScopeCheck {
  ok: boolean;
  // What the learner's messages lack.
  missing: ("column" | "purpose")[];
  // The dictionary columns the learner named.
  columns: string[];
  // The learner's messages that named a column or stated a purpose, oldest
  // first, joined and cut to SCOPE_TEXT_MAX_CHARS.
  scopeText: string | null;
}

/**
 * Whether the learner's own messages in the data owner's channel (oldest
 * first, the current one last) meet the release precondition for this
 * dataset. Pure.
 */
export function checkReleaseScope(input: {
  scenario: Pick<Scenario, "title">;
  dataset: Pick<ScenarioDataset, "dictionary">;
  learnerMessages: readonly string[];
}): ScopeCheck {
  const titleWords = new Set(words(input.scenario.title));
  const columns = dictionaryColumns(input.dataset.dictionary);
  const phrases = columns.map((c) => ({ column: c, phrases: columnPhrases(c, titleWords) }));
  const named = new Set<string>();
  const used: string[] = [];
  let purpose = false;
  for (const message of input.learnerMessages) {
    const hits = phrases.filter((c) => c.phrases.some((p) => mentions(message, p))).map((c) => c.column);
    const statesPurpose = PURPOSE.test(message);
    for (const c of hits) named.add(c);
    if (statesPurpose) purpose = true;
    if (hits.length > 0 || statesPurpose) used.push(message.trim());
  }
  const missing: ScopeCheck["missing"] = [];
  if (named.size === 0) missing.push("column");
  if (!purpose) missing.push("purpose");
  const joined = used.join(" / ");
  return {
    ok: missing.length === 0,
    missing,
    columns: columns.filter((c) => named.has(c)),
    scopeText: joined ? joined.slice(0, SCOPE_TEXT_MAX_CHARS) : null,
  };
}

// A reply sentence that says a file is attached or on its way, or that
// accepts the scope.
const HANDOVER =
  /\b(?:attach(?:ed|ing)?|here(?:'s| is) the (?:file|extract|data)|sending (?:it|the (?:file|extract|data))|i'?ve sent|releas(?:ed|ing) (?:it|the (?:file|extract|data))|(?:i'?m|i am|i'?ve|i have|i'?ll|i will)\s+(?:now\s+)?(?:releas|send|attach|shar)\w*|you should (?:now )?(?:see|have) (?:it|the (?:file|extract))|(?:that|the|this|your) scope (?:works|is fine|looks (?:fine|good)|is ok(?:ay)?))\b/i;

// A statement in which the data owner accepts the consultant's scope ("That
// states purpose and fields clearly."). When the platform drops the release,
// such a sentence is false, and with the ask appended after it the reply
// read as a bot seam (persona-v8). Questions never count.
const ACCEPTS_SCOPE =
  /\b(?:that|this|it|you(?:'ve| have))\b[^.?!]*\b(?:states?|stated|covers?|covered|gives?|given|sets? out|spells? out)\b[^.?!]*\b(?:purpose|fields?|columns?|scope)\b|\b(?:purpose|fields?|columns?|scope)\b[^.?!]*\b(?:(?:is|are|look|looks|seem|seems) (?:clear|fine|good|ok(?:ay)?)|clearly stated)\b/i;

const ASKS_COLUMN = /\b(?:which|what)\b[^?]*\b(?:fields?|columns?|variables?|data)\b[^?]*\?/i;
const ASKS_PURPOSE = /\b(?:what (?:for|is it for|will you use)|purpose|use (?:it|them|the data) for|what are you (?:going to )?(?:use|do))\b[^?]*\?/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The reply to deliver when a release was dropped: sentences that say the
 * file is attached or that accept the scope are removed, and the in-role
 * line for the missing piece is appended unless the reply already asks for
 * it. Pure.
 */
export function withheldReleaseReply(reply: string, missing: ScopeCheck["missing"]): string {
  const kept = sentences(reply).filter((s) => !HANDOVER.test(s) && (s.endsWith("?") || !ACCEPTS_SCOPE.test(s)));
  const text = kept.join(" ");
  const needColumn = missing.includes("column") && !ASKS_COLUMN.test(text);
  const needPurpose = missing.includes("purpose") && !ASKS_PURPOSE.test(text);
  const line =
    needColumn && needPurpose
      ? PERSONA_RELEASE_ASK.both
      : needColumn
        ? PERSONA_RELEASE_ASK.column
        : needPurpose
          ? PERSONA_RELEASE_ASK.purpose
          : null;
  return [text, line].filter(Boolean).join(" ").trim() || PERSONA_RELEASE_ASK.both;
}
