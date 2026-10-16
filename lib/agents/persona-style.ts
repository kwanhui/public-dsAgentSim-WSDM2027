// Post-generation style check for persona replies (persona-v3). Prompt rules
// alone did not hold under persona-v2: transcripts showed praise
// openers, "not just" contrasts, comma splices and the same closing
// instruction in reply after reply. A reply that
// trips one of these patterns is rewritten once with a short corrective
// instruction, and the hit is logged as a persona_style_retry event so the
// hit rate can be read per prompt version. Since rubric-v6 the same check,
// restricted to the patterns that apply to assessor prose (JUDGE_STYLE_IDS),
// also runs on judge rationales (lib/agents/rubric.ts).
//
// Pure and dependency-free apart from the prompt text, so it is unit-tested
// directly.

import { PERSONA_REPLY_MAX_CHARS } from "@/lib/agents/prompt-provenance";

export const PERSONA_STYLE_RETRY_EVENT = "persona_style_retry";

export interface StylePattern {
  id: string;
  // How the problem is named in the corrective instruction.
  label: string;
  test: (reply: string, context?: StyleContext) => boolean;
}

// Openers that grade the consultant or their document before answering.
// Includes "This looks ..."; the tests check openers seen in showcase runs
// ("This is exactly", "This reads", "Fair question", "Good questions",
// "This looks solid").
const VERDICT_OPENER =
  /^\s*(?:good|great|fair|nice|excellent|solid|perfect|spot on|love (?:this|that)|this (?:reads|covers|looks|is (?:exactly|what|the right|a good|solid))|now this|that'?s (?:a )?(?:good|great|fair|the right)|thanks for (?:this|that|the))\b/i;

// Analysis-method words that a stakeholder should not use: a data
// owner advising on clustering, a sponsor quoting precision. "recall" as in
// "as I recall" is ordinary speech and does not count. persona-v7 adds the
// cleaning and evaluation words of method advice ("so dedupe or
// handle that", "treat it as a sensitivity", calibration).
const METHOD_WORDS =
  /\b(?:clustering|centroids?|precision|auc|thresholds?|cross[- ]validat\w*|feature importances?|de-?dup\w*|imput\w*|calibrat\w*|sensitivity (?:analysis|analyses|check|test|range)|treat (?:it|that|this) as a sensitivity)\b|(?<!\b(?:i|you|we|they|to|can'?t|cannot|don'?t|do not|as i)\s)\brecall\b(?!\s+(?:that|what|how|when|whether|if|the (?:meeting|call|conversation)))/i;

// Subordinators after which "..., that's" is a normal complex sentence, not
// a splice ("If the list is long, that's a problem.").
const SUBORDINATE_START =
  /^(?:if|when|whenever|because|although|though|once|as|since|while|unless|after|before|until|where|whether|even if|so that)\b/i;

const SPLICE = /,\s+(?:that'?s|that is|it'?s|it is|this is|i'?m|i am|we'?re|we are|you'?re|they'?re|he'?s|she'?s|there'?s)\b/i;

// ", not a score." / ", not buried," : a negated phrase of up to six words
// closing a clause ("Those are your decisions to make, not mine to bless.",
// "a random sample, not a subset picked in advance"). "whether or not" and
// "if not" have no comma before "not". persona-v7 widens the phrase from two
// words and adds "not X but Y" and "It is not X. It is Y."
const NOT_CONTRAST = /,\s+not\s+(?:[\w'$%-]+\s+){0,5}[\w'$%-]+\s*(?:[.,;!?]|$)/i;
const NOT_BUT = /\bnot\s+(?!sure\b|certain\b)(?:[\w'$%-]+\s+){1,4}but\s+(?!also\b)/i;
const IT_IS_NOT = /\b(?:it|this|that)(?:'s| is| was) not (?:a |an |the |about )?[\w'-]+(?:\s+[\w'-]+){0,3}[.;,]\s*(?:it|this|that)(?:'s| is| was)\b/i;

// "The sample size flag is what I want addressed", "what matters most is":
// the pseudo-cleft framing that made a quarter of the sampled replies sound alike.
const PSEUDO_CLEFT =
  /\b(?:is|are|was) what (?:\w+ ){0,3}?(?:want|wants|need|needs|care|cares|mean|means|matter|matters|count|counts|close|closes|settle|settles|decide|decides)\b|\bmatters most\b|\bwhat matters (?:most|here|to me|to us) is\b/i;

// Stock closers ("before we go further", "before this goes further",
// "before it moves anywhere near handover", "take it upstairs", "closes
// this out", "that's your technical call").
const STOCK_CLOSER =
  /\bbefore (?:we|i|you|this|it|that) (?:go|goes|take (?:this|it|that)|takes (?:this|it|that)|move|moves) (?:any )?(?:further|anywhere near)\b|\bgoes further\b|\byour technical call\b|\bupstairs\b|\bclos(?:e|es|ing) (?:this|it) out\b/i;

// A rationale that says how many problems there are to find ("All four
// data-quality issues are addressed"). rubric-v10 forbids it in the prompt;
// this is the check. Judge rationales only.
const ISSUE_COUNT =
  /\ball (?:\d+|two|three|four|five|six|seven|eight|nine|ten) (?:[a-z-]+ ){0,3}?(?:issues?|problems?|defects?|quirks?|flaws?|risks?|errors?|gaps?)\b/i;

// A question the prompt made end with a full stop ("can you tell me now
// whether that's enough, or do we need Marcus to pull more.").
const QUESTION_START =
  /^(?:(?:can|could|would|will|do|does|did|is|are|should|have|has|shall)\s+(?:you|we|i|it|they|that|this|there|he|she|the|your|our|anyone|someone)\b|(?:how|what|which|who|when|where|why)\s+(?:do|does|did|is|are|was|were|would|will|can|could|should|much|many|long|often|about)\b)/i;

// A hint that there is more to ask ("How Finance defines a successful save
// is worth asking about too.").
const HINT =
  /\bworth (?:asking|raising|checking|a question|looking into)\b|\byou (?:might|may|could|should) (?:also )?(?:want to )?ask (?:me |us |him |her )?about\b|\bask (?:me |us )?about (?:that|it|this) (?:too|as well)\b|\bthere(?:'s| is) more to (?:it|ask|know)\b/i;

// Advice on what to do with the data or the analysis, beyond single method
// words: "so dedupe or handle that before you treat it as one row", "read
// the dictionary carefully before you clean", "show how the save estimate
// moves".
const METHOD_ADVICE =
  /\b(?:so|then|just|you(?:'ll| will)? (?:should|need to|want to|have to)|make sure (?:you|to)|be sure to)\s+(?:dedupe|de-?dup\w*|drop|remove|exclude|impute|filter|clean|coerce|convert|recode|reweight|handle (?:that|those|them|it))\b|\bbefore you (?:clean|model|treat|train|build)\b|\bshow how (?:the|your) [\w ]{1,30}? (?:moves|changes|shifts)\b/i;

// Numbered points mirrored from the consultant's message ("On (1): ...").
const ENUMERATED = /\bon \(?\d\)?\s*[:,]|\(\d\)/i;

// A reply that announces a count before its points ("Two things.", "One
// thing to flag,", "A few points:", "On quirks, one to note:"), persona-v8.
const SIGNPOST =
  /^(?:one|two|three|a few|a couple of|several)\s+(?:more\s+|other\s+|quick\s+)?(?:things?|points?|notes?|flags?|concerns?|questions?|issues?)\b|\b(?:one|two|a few) (?:things? )?to (?:note|flag|mention)\b/i;

// Saying again that a decision is the consultant's.
const REFUSAL =
  /\b(?:yours to (?:make|decide|call)|your (?:call|decision|choice)(?! list| script| volume| cent)|not mine to|not (?:for me|my place|my call) to|up to you|choices? (?:is|are) yours|decisions? (?:is|are) yours|(?:is|are) your (?:\w+ )?(?:call|decisions?|choices?) to make)\b/i;

/** Word sequences of this length shared with an earlier reply count as a
 * repeated phrase. */
export const REPEAT_NGRAM = 5;

function ngrams(text: string, n: number): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9$%']+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** What the style check may compare a reply against: the persona's earlier
 * replies in the same channel, most recent last. */
export interface StyleContext {
  previousReplies?: readonly string[];
}

/** How many of the persona's most recent replies a reply is compared with. */
export const STYLE_CONTEXT_REPLIES = 5;

function sentences(reply: string): string[] {
  return reply
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const STYLE_PATTERNS: readonly StylePattern[] = [
  {
    id: "verdict-opener",
    label: "it opens with praise or a verdict",
    test: (r) => VERDICT_OPENER.test(r),
  },
  { id: "not-just", label: 'it uses "not just"', test: (r) => /\bnot just\b/i.test(r) },
  { id: "not-only", label: 'it uses "not only"', test: (r) => /\bnot only\b/i.test(r) },
  { id: "exactly", label: 'it uses "exactly"', test: (r) => /\bexactly\b/i.test(r) },
  { id: "genuinely", label: 'it uses "genuinely"', test: (r) => /\bgenuine(?:ly)?\b/i.test(r) },
  { id: "em-dash", label: "it uses a dash between clauses", test: (r) => /\u2014|\s\u2013\s|\s--\s/.test(r) },
  { id: "honestly", label: 'it uses "honestly" or "to be honest"', test: (r) => /\bhonestly\b|\bto be honest\b/i.test(r) },
  { id: "worth-flagging", label: 'it uses "worth flagging" or "worth noting"', test: (r) => /\bworth (?:flagging|noting|mentioning|calling out)\b/i.test(r) },
  {
    id: "not-contrast",
    label: 'it sets what it means against what it does not mean (", not X")',
    test: (r) => NOT_CONTRAST.test(r) || NOT_BUT.test(r) || IT_IS_NOT.test(r) || /\brather than being\b/i.test(r),
  },
  {
    id: "pseudo-cleft",
    label: 'it frames what it wants as "X is what I want" or "what matters most"',
    test: (r) => PSEUDO_CLEFT.test(r),
  },
  {
    id: "stock-closer",
    label: 'it uses a stock line such as "before we go further", "upstairs" or "close this out"',
    test: (r) => STOCK_CLOSER.test(r),
  },
  {
    id: "question-full-stop",
    label: "it ends a question with a full stop instead of a question mark",
    test: (r) => sentences(r).some((s) => s.endsWith(".") && QUESTION_START.test(s)),
  },
  {
    id: "hint",
    label: 'it hints that there is more to ask about ("worth asking about")',
    test: (r) => HINT.test(r),
  },
  {
    id: "method-advice",
    label: "it tells the consultant what to do with the data or the analysis",
    test: (r) => METHOD_ADVICE.test(r),
  },
  {
    id: "enumerated",
    label: 'it numbers its points ("On (1):")',
    test: (r) => ENUMERATED.test(r),
  },
  {
    id: "signpost",
    label: 'it announces how many points it has ("Two things.", "One thing to flag")',
    test: (r) => sentences(r).some((s) => SIGNPOST.test(s)),
  },
  {
    id: "repeated-phrase",
    label: "it repeats a phrase from one of your earlier replies",
    test: (r, c) => {
      const mine = ngrams(r, REPEAT_NGRAM);
      if (mine.size === 0) return false;
      return (c?.previousReplies ?? [])
        .slice(-STYLE_CONTEXT_REPLIES)
        .some((prev) => [...ngrams(prev, REPEAT_NGRAM)].some((g) => mine.has(g)));
    },
  },
  {
    id: "repeat-refusal",
    label: "it says again that the decision is the consultant's; say that once, then answer from what you know",
    test: (r, c) => REFUSAL.test(r) && (c?.previousReplies ?? []).slice(-STYLE_CONTEXT_REPLIES).some((p) => REFUSAL.test(p)),
  },
  {
    id: "note-once-closer",
    label: 'it ends with an instruction such as "send me a note once"',
    test: (r) => /\bsend me (?:a|an|the)?\s*(?:short|quick|brief|one-line|one line)?\s*(?:note|line|message|update)\b[^.?!]*\bonce\b/i.test(r),
  },
  { id: "go-ahead", label: 'it tells the consultant "go ahead and"', test: (r) => /\bgo ahead and\b/i.test(r) },
  {
    id: "follow-up-promise",
    label: "it promises to come back later",
    test: (r) =>
      /\b(?:get back to you|come back to you|circle back|follow up with you|i'?ll (?:check|find out|confirm)[^.?!]*\b(?:and|then) (?:let you know|get back|come back))\b/i.test(
        r,
      ),
  },
  {
    id: "comma-splice",
    label: "it joins two sentences with a comma",
    test: (r) => sentences(r).some((s) => !SUBORDINATE_START.test(s) && SPLICE.test(s)),
  },
  {
    id: "method-words",
    label: "it uses analysis-method words (clustering, centroids, precision, recall, AUC, thresholds, cross-validation, feature importance, dedupe, impute, calibration, sensitivity analysis) that a stakeholder would not use",
    test: (r) => METHOD_WORDS.test(r),
  },
  {
    id: "too-long",
    label: "it is longer than about 60 words",
    test: (r) => r.length > PERSONA_REPLY_MAX_CHARS,
  },
  {
    id: "issue-count",
    label: 'it says how many problems there are to find (for example "all four issues")',
    test: (r) => ISSUE_COUNT.test(r),
  },
];

// Patterns that apply to judge rationales only, never to a persona reply.
const JUDGE_ONLY_IDS: readonly string[] = ["issue-count"];

/** Ids of the style patterns a reply trips, in STYLE_PATTERNS order. The
 * context-dependent patterns (repeated-phrase, repeat-refusal) apply only
 * when the persona's earlier replies are passed. */
export function findStyleViolations(reply: string, context?: StyleContext): string[] {
  return STYLE_PATTERNS.filter((p) => !JUDGE_ONLY_IDS.includes(p.id) && p.test(reply, context)).map((p) => p.id);
}

// The patterns that apply to a judge rationale. The chat-only ones (closing
// instructions, promised follow-ups, comma splices, length) do not.
export const JUDGE_STYLE_IDS: readonly string[] = [
  "verdict-opener",
  "not-just",
  "not-only",
  "exactly",
  "genuinely",
  "em-dash",
  "honestly",
  "worth-flagging",
  "not-contrast",
  "issue-count",
];

/** Ids of the judge-applicable style patterns a rationale trips. */
export function findJudgeStyleViolations(rationale: string): string[] {
  return STYLE_PATTERNS.filter((p) => JUDGE_STYLE_IDS.includes(p.id) && p.test(rationale)).map((p) => p.id);
}

/** The labels of the given pattern ids, joined for the corrective prompt. */
export function describeStyleViolations(ids: string[]): string {
  return STYLE_PATTERNS.filter((p) => ids.includes(p.id))
    .map((p) => p.label)
    .join("; ");
}

/**
 * Cuts a reply at the last sentence end within maxChars (or at the last
 * word boundary when no sentence ends in time). Used when the model writes
 * past the reply field's limit, so the turn still validates; the style
 * check then asks for a shorter rewrite.
 */
export function truncateReply(reply: string, maxChars: number = PERSONA_REPLY_MAX_CHARS): string {
  const text = reply.trim();
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const lastEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (lastEnd > maxChars / 3) return head.slice(0, lastEnd + 1);
  const lastSpace = head.lastIndexOf(" ");
  return `${head.slice(0, lastSpace > 0 ? lastSpace : maxChars - 1).replace(/[,;:]$/, "")}.`;
}

// The array fields of the persona's structured output (turn and reaction).
// When a reply runs long, the model can close the object after the reply
// and leave these out; zod then rejects the object, although an empty list
// is the common answer for every one of them.
export const PERSONA_ARRAY_FIELDS = ["newFacts", "revealedWithheld", "raisedFrictions", "releaseDatasets"] as const;

// A field the model returned as a JSON-encoded string ("[\"a\"]") or as a
// single string, read as a list. Anything else is left for zod to reject.
function asList(value: unknown): unknown {
  if (value === undefined || value === null) return [];
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (t === "") return [];
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON: treat it as one item.
    }
  }
  return [t];
}

// A persona's structured output whose reply is itself the whole object as
// JSON text: {"reply": "{\"reply\":\"...\",\"newFacts\":[...]}"}. The
// regenerated showcase of 2026-10-07 delivered three replies of this shape
// to the learner after a style rewrite (messages 30, 46 and 48 of cohort
// showcase-meridian-mobile-churn-1f4wn). Filling in the outer object's
// missing arrays made it validate, so the JSON text went out as the reply
// and its newFacts never reached the ledger. One of the three had been cut
// at the reply limit, mid-JSON.
export const PERSONA_OUTPUT_REPAIR_EVENT = "persona_output_repair";

const NESTED_REPLY_START = /^\s*\{\s*"reply"\s*:\s*"/;

export interface NestedReplyRepair {
  // "nested-json": the reply parsed as an object with a reply key, whose
  // fields were merged in. "truncated-json": the reply began with
  // {"reply":" but did not parse, so the wrapper was stripped and the text up
  // to the first unescaped quote kept.
  kind: "nested-json" | "truncated-json";
  // The array fields the nested object carried items for.
  mergedFields: string[];
  // Length of the reply before and after the unwrap.
  wrappedChars: number;
  replyChars: number;
}

// The reply text of a {"reply":"... prefix that does not parse: the string
// literal up to its first unescaped quote, or to the end when it was cut
// before closing.
function leadingReplyLiteral(text: string): string {
  const start = text.indexOf('"', text.indexOf(":")) + 1;
  let end = start;
  while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
  const raw = text.slice(start, Math.min(end, text.length)).replace(/\\$/, "");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replace(/\\(["\\/])/g, "$1").replace(/\\n/g, "\n");
  }
}

function mergeList(outer: unknown, inner: unknown): unknown[] {
  const a = asList(outer);
  const b = asList(inner);
  const merged = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  return [...new Set(merged)];
}

/**
 * Unwraps a reply that holds the persona's whole structured output as JSON
 * text (see PERSONA_OUTPUT_REPAIR_EVENT). The nested object's reply replaces
 * the outer one and its array fields are merged into the outer ones. A
 * wrapper that was cut before it closed is stripped, and the reply text up to
 * the first unescaped quote is kept. `fields` names the array fields the
 * object may carry: every PERSONA_ARRAY_FIELDS entry before validation, only
 * those already present after it (a reaction has no releaseDatasets). Returns
 * null when the reply is ordinary text. Pure.
 */
export function unwrapNestedReply(
  object: Record<string, unknown>,
  fields: readonly string[] = PERSONA_ARRAY_FIELDS,
): { object: Record<string, unknown>; repair: NestedReplyRepair } | null {
  const wrapped = object.reply;
  if (typeof wrapped !== "string" || !NESTED_REPLY_START.test(wrapped)) return null;
  const out: Record<string, unknown> = { ...object };
  let reply = wrapped;
  let kind: NestedReplyRepair["kind"] = "nested-json";
  const mergedFields = new Set<string>();
  // A reply nested twice is unwrapped twice. The loop stops after three
  // levels so that a pathological output cannot keep it going.
  for (let depth = 0; depth < 3 && NESTED_REPLY_START.test(reply); depth++) {
    let inner: unknown;
    try {
      inner = JSON.parse(reply);
    } catch {
      inner = undefined;
    }
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner) && typeof (inner as { reply?: unknown }).reply === "string") {
      const nested = inner as Record<string, unknown>;
      reply = nested.reply as string;
      for (const field of fields) {
        const items = asList(nested[field]);
        if (!Array.isArray(items) || items.length === 0) continue;
        out[field] = mergeList(out[field], items);
        mergedFields.add(field);
      }
      continue;
    }
    reply = leadingReplyLiteral(reply);
    kind = "truncated-json";
    break;
  }
  out.reply = reply.trim();
  return {
    object: out,
    repair: { kind, mergedFields: [...mergedFields], wrappedChars: wrapped.length, replyChars: (out.reply as string).length },
  };
}

/**
 * A repairText hook for generateObject: when the structured output fails
 * validation because the reply is too long, cut the reply. When it fails
 * because an array field is missing, null or a string, fill in the list
 * (empty when missing). Records whether the reply was cut, so the caller can
 * count the reply as too long and ask for a rewrite.
 *
 * The array repair is the fix for the end user's failed testing turns in the
 * analyst-v2 agent runs: a long reply came back without newFacts and
 * releaseDatasets, the hook cut the reply but left the object invalid, and
 * both attempts failed with AI_NoObjectGeneratedError.
 *
 * Before either repair, a reply that holds the whole object as JSON text is
 * unwrapped (unwrapNestedReply), so that neither the length cut nor the
 * array fill can turn such an object into a valid one with JSON as its reply.
 * The output may also arrive as a JSON string literal holding the object;
 * it is read the same way. Each unwrap is recorded for the
 * persona_output_repair event.
 */
export function replyLengthRepair(maxChars: number = PERSONA_REPLY_MAX_CHARS): {
  repair: (input: { text: string }) => Promise<string | null>;
  wasTruncated: () => boolean;
  repairs: () => NestedReplyRepair[];
} {
  let truncated = false;
  const repairs: NestedReplyRepair[] = [];
  return {
    repair: async ({ text }) => {
      let parsed: Record<string, unknown>;
      let changed = false;
      try {
        let value = JSON.parse(text) as unknown;
        // The whole object returned as one string.
        if (typeof value === "string" && NESTED_REPLY_START.test(value)) {
          value = { reply: value };
          changed = true;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
        parsed = value as Record<string, unknown>;
      } catch {
        // The text itself may be a cut-off object; its reply is all that can
        // be recovered.
        if (!NESTED_REPLY_START.test(text)) return null;
        parsed = { reply: text };
        changed = true;
      }
      if (typeof parsed.reply !== "string") return null;
      const unwrapped = unwrapNestedReply(parsed);
      if (unwrapped) {
        parsed = unwrapped.object;
        repairs.push(unwrapped.repair);
        changed = true;
      }
      if (typeof parsed.reply !== "string") return null;
      const out: Record<string, unknown> = { ...parsed };
      if (parsed.reply.length > maxChars) {
        out.reply = truncateReply(parsed.reply, maxChars);
        truncated = true;
        changed = true;
      }
      for (const field of PERSONA_ARRAY_FIELDS) {
        if (Array.isArray(parsed[field])) continue;
        out[field] = asList(parsed[field]);
        changed = true;
      }
      return changed ? JSON.stringify(out) : null;
    },
    wasTruncated: () => truncated,
    repairs: () => [...repairs],
  };
}
