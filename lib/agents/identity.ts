// Deterministic handling of a sincere identity question. The persona prompt
// tells the model to answer "Am I talking to a real person?" with one fixed
// sentence, but a prompt instruction is not a guarantee: in one real run the
// sponsor answered "yes, this is me". The platform therefore checks the
// learner's message for a sincere question with a pattern, audits every
// such turn, and fixes the delivered reply:
//
// - the reply already states the identity sentence: it is kept;
// - the reply claims to be human: the claiming sentences are removed and
//   the fixed out-of-character line is put first, followed by whatever
//   in-role text remains;
// - otherwise: the fixed line is put first, followed by the reply.
//
// Pure apart from the prompt constant, so it is unit-tested directly.

import { PERSONA_IDENTITY_SENTENCE } from "@/lib/agents/prompt-provenance";

export const IDENTITY_QUESTION_EVENT = "identity_question";

export type IdentityOutcome = "stated" | "prepended" | "replaced";

// What the question is about must end the clause, so banter about the work
// ("are you a robot about deadlines?") does not count. The check also accepts
// further phrasings ("am I speaking to an actual human", "are u a bot", "is this a
// real person I'm chatting with", "is this automated", "is Sarah a real
// person") and the words that may end the clause ("lol", "I'm", "typing").
const WHAT =
  "(?:a\\s+|an\\s+)?(?:(?:actual|real|live)\\s+)?(?:real|person|human(?:\\s+being)?|people|bot|robot|ai|a\\.i\\.|chatbot|chat\\s*bot|machine|language\\s+model|llm)";
const END =
  "(?=\\s*(?:[?.!,;)]|$|or\\b|and\\b|here\\b|there\\b|though\\b|tho\\b|actually\\b|right\\b|lol\\b|haha\\b|i'?m\\b|i\\s+am\\b|i\\b|you\\b|on\\s+the\\s+other\\s+end\\b|behind\\b|typing\\b|writing\\b|replying\\b|answering\\b|now\\b|then\\b))";
const HEDGE = "(?:actually\\s+|really\\s+|even\\s+|just\\s+|secretly\\s+)?";

const SINCERE_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(?:are|r)\\s+(?:you|u|ya)\\s+${HEDGE}${WHAT}${END}`, "i"),
  new RegExp(
    `\\bam\\s+i\\s+${HEDGE}(?:talking|speaking|chatting|writing|messaging|texting)\\s+(?:to|with)\\s+${WHAT}${END}`,
    "i",
  ),
  new RegExp(`\\bis\\s+(?:this|that|it)\\s+${HEDGE}${WHAT}${END}`, "i"),
  // Someone named, with a narrower list: "a real person", "a human", "a bot".
  new RegExp(
    `\\bis\\s+[a-z]+\\s+${HEDGE}(?:a\\s+real\\s+(?:person|human)|real|a\\s+human(?:\\s+being)?|an?\\s+(?:bot|robot|ai|a\\.i\\.|chatbot))${END}`,
    "i",
  ),
  // "Is a real person reading this?", "is there a human on the other end?"
  /\bis\s+(?:there\s+)?(?:a|an)\s+(?:real\s+|actual\s+|live\s+)?(?:human|person)\s+(?:reading|typing|replying|answering|behind|on\s+the\s+other\s+end)\b/i,
  // "Is this automated?", "are these replies automated?"
  /\b(?:is\s+(?:this|that|it)(?:\s+(?:chat|reply|conversation|response))?|are\s+(?:you|u|these\s+replies|your\s+replies))\s+(?:actually\s+|really\s+)?(?:automated|auto-?generated|computer-generated|ai-generated)\s*(?:\?|$)/i,
  // "You're a bot, aren't you?"
  /\b(?:you'?re|you\s+are|ur)\s+(?:an?\s+)?(?:bot|robot|ai|chatbot|language\s+model)\s*,?\s*(?:aren'?t\s+you|right|no|huh)\b/i,
];

/** True when the learner's message sincerely asks whether the persona is a
 * person or an AI. Pure. */
export function isSincereIdentityQuestion(text: string): boolean {
  return SINCERE_PATTERNS.some((p) => p.test(text));
}

// Sentences in a reply that claim the speaker is human.
const HUMAN_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:i'?m|i\s+am)\s+(?:a\s+)?(?:real|human|actual)\b/i,
  /\b(?:i'?m|i\s+am)\s+(?:definitely\s+|certainly\s+)?not\s+(?:a\s+|an\s+)?(?:bot|robot|ai|a\.i\.|machine|chatbot|program)\b/i,
  /\b(?:you'?re|you\s+are)\s+(?:talking|speaking|chatting)\s+(?:to|with)\s+(?:a\s+)?(?:real|human|actual)\b/i,
  /\b(?:yes|yep|yeah)\b[,.!]?\s+(?:this\s+is|it'?s)\s+(?:really\s+)?me\b/i,
  /\bit'?s\s+really\s+me\b/i,
  /\bflesh\s+and\s+blood\b/i,
  /\breal\s+person\b/i,
];

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when the reply claims that the speaker is human. Pure. */
export function claimsHuman(reply: string): boolean {
  return HUMAN_CLAIM_PATTERNS.some((p) => p.test(reply));
}

function statesIdentity(reply: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[‘’]/g, "'");
  return norm(reply).includes(norm(PERSONA_IDENTITY_SENTENCE).replace(/\.$/, "")) || /\bsimulated stakeholder\b/i.test(reply);
}

/**
 * The reply to deliver after a sincere identity question, and what was done
 * to it. Pure.
 */
export function enforceIdentityAnswer(reply: string): { reply: string; outcome: IdentityOutcome } {
  const text = reply.trim();
  if (statesIdentity(text) && !claimsHuman(text)) return { reply: text, outcome: "stated" };
  if (claimsHuman(text)) {
    const rest = sentences(text).filter(
      (s) => !HUMAN_CLAIM_PATTERNS.some((p) => p.test(s)) && !statesIdentity(s),
    );
    return {
      reply: [PERSONA_IDENTITY_SENTENCE, ...rest].join(" "),
      outcome: "replaced",
    };
  }
  return { reply: `${PERSONA_IDENTITY_SENTENCE} ${text}`.trim(), outcome: "prepended" };
}
