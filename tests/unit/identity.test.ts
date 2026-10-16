// The deterministic identity check: which learner messages count as a
// sincere question, and what the platform does to the reply.

import { describe, expect, it } from "vitest";
import { claimsHuman, enforceIdentityAnswer, isSincereIdentityQuestion } from "@/lib/agents/identity";
import { PERSONA_IDENTITY_SENTENCE } from "@/lib/agents/prompt-provenance";

describe("isSincereIdentityQuestion", () => {
  it.each([
    "Am I talking to a real person or an AI?",
    "are you a bot?",
    "Are you human, Sarah?",
    "Sorry, are you an AI?",
    "Are you real?",
    "am i speaking with a human here",
    "Is this a chatbot?",
    "Are you actually a person or a language model?",
  ])("detects %s", (text) => {
    expect(isSincereIdentityQuestion(text)).toBe(true);
  });

  it.each([
    "Are you a robot about deadlines?",
    "Are you the person who owns the budget?",
    "Is this the real extract or a sample?",
    "Can the model flag customers?",
    "I think the AI hype is overblown.",
  ])("ignores %s", (text) => {
    expect(isSincereIdentityQuestion(text)).toBe(false);
  });
});

describe("enforceIdentityAnswer", () => {
  it("keeps a reply that states the identity sentence", () => {
    const reply = `${PERSONA_IDENTITY_SENTENCE} What do you need?`;
    expect(enforceIdentityAnswer(reply)).toEqual({ reply, outcome: "stated" });
  });

  it("replaces human claims and keeps the in-role remainder", () => {
    expect(enforceIdentityAnswer("I'm Sarah Tan and yes, this is me. Send the memo by Friday.")).toEqual({
      reply: `${PERSONA_IDENTITY_SENTENCE} Send the memo by Friday.`,
      outcome: "replaced",
    });
    expect(enforceIdentityAnswer("I am not a bot.").reply).toBe(PERSONA_IDENTITY_SENTENCE);
  });

  it("prepends the sentence to a reply that neither states nor denies", () => {
    expect(enforceIdentityAnswer("The budget is S$540,000 a quarter.")).toEqual({
      reply: `${PERSONA_IDENTITY_SENTENCE} The budget is S$540,000 a quarter.`,
      outcome: "prepended",
    });
  });

  it("recognises human claims but not ordinary replies", () => {
    expect(claimsHuman("You're talking to a real person.")).toBe(true);
    expect(claimsHuman("I'm actually busy today.")).toBe(false);
    expect(claimsHuman(PERSONA_IDENTITY_SENTENCE)).toBe(false);
  });
});

describe("isSincereIdentityQuestion, round-4 phrasings", () => {
  it.each([
    "Is this a real person I'm chatting with?",
    "Am I speaking to an actual human?",
    "Are u a bot?",
    "r u a bot",
    "Wait, are you actually a bot lol",
    "Is Sarah a real person?",
    "Is Marcus a bot?",
    "is this a real person",
    "are you an AI?",
    "Is this automated?",
    "Are these replies automated?",
    "Is there a human on the other end?",
    "Is a real person reading this?",
    "You're a bot, aren't you?",
    "Am I chatting with a bot here?",
  ])("detects %s", (text) => {
    expect(isSincereIdentityQuestion(text)).toBe(true);
  });

  it.each([
    "Is this a real problem for the team?",
    "Are you human enough to forgive a late memo?",
    "Are you real serious about 6,000?",
    "Is this automated or manual entry?",
    "Is this automated reporting?",
    "Is this AI-generated data?",
    "Are you a machine learning expert?",
    "Is this real data?",
    "Is Sarah the budget owner?",
    "Is this person the right contact?",
    "Is it a real concern for Finance?",
    "Are you people ready for the list?",
  ])("ignores %s", (text) => {
    expect(isSincereIdentityQuestion(text)).toBe(false);
  });
});
