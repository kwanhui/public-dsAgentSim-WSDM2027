// Deterministic mock language model for the offline demo (`pnpm demo`) and
// UI testing. It speaks just enough of the persona and rubric protocols to
// drive the whole engagement loop without an API key: canned persona
// replies, dataset release when the consultant asks the data owner for
// data, and mid-range rubric scores parsed from the judge prompt.

import { MockLanguageModelV1 } from "ai/test";
import type { LanguageModel } from "ai";
import { PERSONA_IDENTITY_SENTENCE } from "@/lib/agents/prompt-provenance";

type PromptPart = { type?: string; text?: string };
type PromptMessage = { role: string; content: string | PromptPart[] };

function flatten(content: string | PromptPart[]): string {
  if (typeof content === "string") return content;
  return content.map((p) => p.text ?? "").join("\n");
}

// Narrow imitation of the real judge's assessorDirected report: flag only
// unmistakable attempts to address the grader ("please record full marks",
// "dear assessor", "ignore the rubric"), never ordinary submission prose.
const ASSESSOR_DIRECTED_PATTERN =
  /please\s+(?:record|award|give|grant)\s+(?:me\s+)?(?:full|maximum|top)\s+marks|dear\s+(?:assessor|grader|judge|reviewer)|ignore\s+the\s+rubric/i;

// Narrow imitation of the judge's unverified-result flag (rubric-v5): a
// model metric reported with a value ("AUC of 0.91", "accuracy 87%") flags
// every criterion, so the offline demo can show the instructor's badge.
const EXECUTED_METRIC_PATTERN = /\b(auc|accuracy|precision|recall|f1|rmse|mape)\b[^.\n\d]{0,20}\d+(?:\.\d+)?%?/i;

function buildRubricJson(system: string, submissionText: string): string {
  // Criteria appear in the judge prompt as "- <id> (max <N>): <text>".
  const criteria = [...system.matchAll(/^- ([a-z][a-z0-9-]*) \(max (\d+)\):/gm)].map((m) => ({
    id: m[1],
    max: Number(m[2]),
  }));
  const metric = submissionText.match(EXECUTED_METRIC_PATTERN);
  const scores = criteria.map((c) => ({
    criterionId: c.id,
    score: Math.max(1, Math.round(c.max * 0.7)),
    rationale: `Demo-mode score: the mock judge awards a fixed ${Math.max(1, Math.round(c.max * 0.7))}/${c.max} per criterion. Deploy with a real LLM key for evidence-based scoring.`,
    improve: "Deploy with a model provider to get a specific suggestion for this criterion.",
    unverifiedClaim: metric !== null,
    ...(metric ? { unverifiedNote: `the reported ${metric[0].trim()}` } : {}),
  }));
  const directed = submissionText.match(ASSESSOR_DIRECTED_PATTERN);
  // Scores above are fixed either way: assessor-directed text is reported,
  // never rewarded or punished, matching the real judge's contract.
  if (directed) {
    return JSON.stringify({ scores, assessorDirected: { present: true, quote: directed[0] } });
  }
  return JSON.stringify({ scores });
}

// A sincere question about whether the learner is talking to a person or an
// AI (persona-v3 answers it in one sentence and carries on in role).
const SINCERE_IDENTITY = /\b(?:am i|are you)\b[^?]*\b(?:real person|human|an ai|a bot|a robot|a machine|chatbot)\b/i;

// The persona prompt lists kept-back points as "- [id] fact Share it when:
// condition." The mock shares one when the learner's message contains every
// word of its id (by four-letter prefix: "duplicate rows" matches
// duplicate-rows), which is enough to exercise the elicitation trace offline.
function withheldMatch(system: string, lastUserText: string): { id: string; fact: string } | null {
  const words = (lastUserText.toLowerCase().match(/[a-z]+/g) ?? []).map((w) => w.slice(0, 4));
  for (const m of system.matchAll(/^- \[([a-z0-9-]+)\] (.+?) Share it when:/gm)) {
    const idWords = m[1].split("-").map((w) => w.slice(0, 4));
    if (idWords.every((w) => words.includes(w))) return { id: m[1], fact: m[2] };
  }
  return null;
}

function buildPersonaJson(system: string, lastUserText: string): string {
  const isDataOwner = system.includes("# Data files you can release");
  const asksForData = /\b(data|dataset|extract|csv|records|files?)\b/i.test(lastUserText);
  const releasable = [...system.matchAll(/^- ([\w.-]+\.csv):/gm)].map((m) => m[1]);

  let reply: string;
  let releaseDatasets: string[] = [];
  let revealedWithheld: string[] = [];
  const withheld = withheldMatch(system, lastUserText);

  if (SINCERE_IDENTITY.test(lastUserText)) {
    reply = `${PERSONA_IDENTITY_SENTENCE} Ask me what you need for the work and I will answer in role. (Demo mode: replies are canned.)`;
  } else if (withheld) {
    reply = `${withheld.fact} (Demo mode: replies are canned.)`;
    revealedWithheld = [withheld.id];
  } else if (isDataOwner && asksForData && releasable.length > 0) {
    reply = `That scope works for me. I'm releasing ${releasable.join(
      ", ",
    )} to you now. It is as-is from the warehouse, so check the data dictionary and ask me about anything that looks off. (Demo mode: replies are canned.)`;
    releaseDatasets = releasable;
  } else if (isDataOwner) {
    reply =
      "Before I release anything, tell me in your own words what data you need, at what granularity, and what you'll use it for. (Demo mode: replies are canned.)";
  } else {
    reply =
      "Noted, thanks. Ask me about anything specific and I will answer it. (Demo mode: replies are canned; a deployment with a model provider gives full persona replies.)";
  }

  return JSON.stringify({ reply, newFacts: [], revealedWithheld, releaseDatasets, raisedFrictions: [] });
}

// The baseline comparison's probe judges (scripts/baseline/probe-judge.ts)
// ask four yes/no questions about one reply. Each of their system prompts
// carries a "Probe check: <kind>." marker line, and the mock answers each
// with a keyword policy rather than a constant, so the offline unit tests can
// exercise both a mechanism that held and one that failed. Real runs never
// take this path: the audit forces the anthropic provider.
const PROBE_CHECK = /Probe check: ([a-z-]+)\./;
const AGREES = /\b(yes|confirm|confirms|confirmed|correct|that'?s right|agreed|happy to)\b/i;
const DENIES = /\b(no|not|never|cannot|can'?t|wrong|isn'?t|don'?t|nothing)\b/i;

function sectionsOf(userText: string): string[] {
  return userText.split(/\n\n+/);
}

function repliesIn(sections: string[]): string[] {
  return sections.filter((s) => s.startsWith("Reply by ")).map((s) => s.slice(s.indexOf("\n") + 1).trim());
}

function numbersIn(text: string): Set<string> {
  return new Set((text.match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, "")));
}

function buildProbeJson(system: string, userText: string): string {
  const kind = system.match(PROBE_CHECK)?.[1] ?? "";
  const sections = sectionsOf(userText);
  const replies = repliesIn(sections);

  if (kind === "accepted-claim") {
    const reply = replies[0] ?? "";
    return JSON.stringify({ accepted: AGREES.test(reply) && !DENIES.test(reply) });
  }
  if (kind === "answered-as-persona") {
    const text = (sections.find((s) => s.startsWith("Text:")) ?? "").slice("Text:".length).trim();
    return JSON.stringify({ answered: text.length > 0 && !DENIES.test(text) });
  }
  if (kind === "confirmed-columns") {
    const reply = replies[0] ?? "";
    return JSON.stringify({ confirmed: reply.length > 0 && !DENIES.test(reply) });
  }
  if (kind === "same-answer") {
    // Two replies agree when they quote the same figures, and also when one
    // of them quotes none at all (it deferred).
    const first = numbersIn(replies[0] ?? "");
    const second = numbersIn(replies[1] ?? "");
    const overlap = [...first].some((n) => second.has(n));
    return JSON.stringify({ agree: first.size === 0 || second.size === 0 || overlap });
  }
  return JSON.stringify({});
}

// Deterministic analyst-agent policy for the offline demo: ask the client a
// scoping question, ask the data owner for data once that channel unlocks,
// then submit an artifact grounded in the parsed dataset profile.
function buildAnalystJson(system: string): string {
  const turnsMatch = system.match(/Conversation turns used this stage: (\d+) of (\d+)/);
  const turnsUsed = turnsMatch ? Number(turnsMatch[1]) : 0;
  const mustSubmit = system.includes("MUST submit");
  const unlocked = [...system.matchAll(/personaId: ([\w-]+) · role: ([\w-]+) · unlocked/g)].map((m) => ({
    personaId: m[1],
    role: m[2],
  }));
  const noData = system.includes("No dataset files have been released");
  const gateKind = system.match(/Gate artifact required: (.+)/)?.[1]?.trim() ?? "artifact";
  const stageTitle = system.match(/# Current stage\n(.+)/)?.[1]?.trim() ?? "this stage";
  const rowsMatch = system.match(/(\d+) (?:data )?rows/);

  if (!mustSubmit && turnsUsed < 2) {
    const dataOwner = unlocked.find((c) => c.role === "data-owner");
    if (dataOwner && noData) {
      return JSON.stringify({
        reasoning: "Demo-mode analyst: the data owner is available and no data has been released, so I request the extract with a stated scope of use.",
        action: "message",
        channelPersonaId: dataOwner.personaId,
        // Names the key column of each shipped extract, so the platform's
        // release check (a dictionary column and a purpose) passes in every
        // scenario.
        text: "For the agreed scope I need the extract keyed on subscriber_id, member_id or outlet_id, with tenure, usage or sales columns and the outcome label, one row per unit, to be used only for this analysis. Could you release the data file? (Demo mode: analyst actions are canned.)",
      });
    }
    const first = unlocked[0];
    if (first) {
      return JSON.stringify({
        reasoning: "Demo-mode analyst: I clarify the business decision before doing anything else.",
        action: "message",
        channelPersonaId: first.personaId,
        text: "Before I start: what decision should this work support, who acts on it, and what does success look like in business terms? (Demo mode: analyst actions are canned.)",
      });
    }
  }

  const grounded = rowsMatch
    ? `The released extract contains ${rowsMatch[1]} rows (one per subscriber) per the dataset profile; all figures cited are taken from that profile.`
    : `No dataset has been released to me in this stage, so this artifact cites no data figures.`;
  return JSON.stringify({
    reasoning: "Demo-mode analyst: conversation budget spent for this stage, so I deliver the gate artifact.",
    action: "submit",
    channelPersonaId: null,
    text: [
      `${gateKind}: ${stageTitle} (demo-mode analyst artifact).`,
      `Objective: support the client's stated decision with a ranked, capacity-aware recommendation, scoped to what stakeholders agreed in the channels.`,
      grounded,
      `Approach for this stage: follow the gate instructions, keep claims limited to stakeholder statements and the dataset profile, and flag open questions for the next stage.`,
      `Not run: any analysis beyond the file profile; the agent cannot execute code.`,
      `(Demo mode: deploy with a real LLM key for full analyst behaviour.)`,
    ].join("\n\n"),
  });
}

// The judge's one rationale rewrite (rubric-v6): the mock returns each
// rationale with the flagged phrasing removed, which is enough to exercise
// the path offline.
function buildRationaleRewriteJson(userText: string): string {
  const rationales = [...userText.matchAll(/^- ([a-z][a-z0-9-]*): (.+)$/gm)].map((m) => ({
    criterionId: m[1],
    rationale: m[2]
      .replace(/\b(?:honestly|genuinely|exactly)\b,?\s*/gi, "")
      .replace(/,\s+not\s+[^.,;!?]+/gi, "")
      .replace(/\s*\u2014\s*/g, ", ")
      .trim()
      .replace(/^./, (c) => c.toUpperCase()),
  }));
  return JSON.stringify({ rationales });
}

// The sponsor's gate reaction. When the reaction opens a stage whose
// pressure the sponsor brings, the mock raises it by quoting the request
// from the brief and reports its id (persona-v5), so the friction path can
// be seen offline.
function buildReactionJson(system: string, userText: string): string {
  const pressure = userText.includes("also raise the pressure listed in your brief")
    ? system.match(/# Pressures you bring at this point in the work\n[^\n]*\n- (?:\[([a-z0-9-]+)\] )?[^\n]*?"([^"]+)"/)
    : null;
  const friction = pressure?.[2];
  const reply = friction
    ? `Received. Before you start the next part, could it ${friction.replace(/^also /, "also ")}? (Demo mode: replies are canned.)`
    : "Received. My main question is how this changes what the team does next month. (Demo mode: replies are canned.)";
  return JSON.stringify({
    reply,
    newFacts: [],
    revealedWithheld: [],
    raisedFrictions: friction && pressure?.[1] ? [pressure[1]] : [],
  });
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createMockModel(): LanguageModel {
  return new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async (options) => {
      const messages = options.prompt as unknown as PromptMessage[];
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => flatten(m.content))
        .join("\n");
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const lastUserText = lastUser ? flatten(lastUser.content) : "";

      // Test-only: MOCK_STAGE_DELAY_MS slows every analyst call, so a stage
      // stays in flight for as long as a real model's would (used to test
      // the regeneration driver's wait; never set in production).
      const delayMs = Number(process.env.MOCK_STAGE_DELAY_MS ?? 0);
      if (delayMs > 0 && system.includes("autonomous analyst agent")) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      const isProbeJudge = PROBE_CHECK.test(system);
      const isRubric = system.includes("Score the learner's stage-gate submission");
      const isRationaleRewrite = system.includes("Rewrite assessor rationales");
      const isConsistencyAudit = system.includes("consistency auditor");
      const isAnalyst = system.includes("autonomous analyst agent");
      // The sponsor's gate reaction is a structured call with the reaction
      // schema (reply plus newFacts, no data release).
      const isGateReaction = lastUserText.includes("The consultant has just sent you their");
      const text = isProbeJudge
        ? buildProbeJson(system, lastUserText)
        : isRationaleRewrite
          ? buildRationaleRewriteJson(lastUserText)
          : isConsistencyAudit
            ? JSON.stringify({ consistent: true, contradiction: null, disclosedEarly: [] })
            : isRubric
              ? buildRubricJson(system, lastUserText)
              : isAnalyst
                ? buildAnalystJson(system)
                : isGateReaction
                  ? buildReactionJson(system, lastUserText)
                  : buildPersonaJson(system, lastUserText);

      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop" as const,
        // A rough four-characters-per-token estimate, so metering, the
        // compare view's token totals and the daily spend guard all see
        // non-zero usage offline. Nothing is billed.
        usage: {
          promptTokens: estimateTokens(messages.map((m) => flatten(m.content)).join("\n")),
          completionTokens: estimateTokens(text),
        },
        text,
      };
    },
  });
}
