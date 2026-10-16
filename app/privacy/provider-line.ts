// Who processes learner messages, named from the deployment's configured
// provider (lib/llm/model-names.ts activeProvider). The privacy page and the
// workspace notice both read this one check, so they cannot disagree about
// where messages go. Pure.

// The sandbox retention period, as lib/logging/retention.ts applies it
// (SANDBOX_RETENTION_DAYS). Repeated here because this module is pure and is
// bundled into the learner workspace; a unit test keeps the two equal.
export const SANDBOX_DELETION_DAYS = 30;

/** Where a sandbox seat lives: the seat is a session cookie in this
 * browser, with no invite and no resume link behind it. The workspace
 * notice, the help panel and the stage panel use the same sentence. */
export const SANDBOX_SEAT_LINE =
  "Your demo seat lives in this browser only: signing out or clearing this site's data ends it, and it cannot be opened on another device.";

export function providerName(provider: string): string {
  return provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : provider;
}

/** The privacy page's "Model provider" entry. */
export function providerLine(provider: string): string {
  if (provider === "mock") {
    return "This deployment runs an offline test model; nothing leaves this server.";
  }
  const name = providerName(provider);
  return `Your chat messages and stage submissions are sent to ${name}, whose language model plays the stakeholders and scores the submissions. ${name} processes them on its own servers, which may be outside Singapore, and ${name}'s terms on how long it keeps them apply.`;
}

/** The second sentence of the workspace notice: where messages go and who
 * keeps them. A sandbox seat has no instructor: its work is kept on the demo
 * server, where the demo authors can read it, and the contact line (from
 * DEMO_CONTACT) says how to reach them when the deployment sets one. */
export function noticeStorageLine(
  provider: string | undefined,
  joinRoute: "invite" | "sandbox" | "agent" = "invite",
  demoContact?: string | null,
): string {
  if (joinRoute === "sandbox") {
    const where =
      provider === "mock"
        ? "An offline test model answers, so your messages stay on this demo server, where the demo authors can read them."
        : `Your messages are sent to ${provider ? providerName(provider) : "the model provider"} and stored on this demo server, where the demo authors can read them.`;
    const contact = demoContactLine(demoContact);
    const kept = `${SANDBOX_SEAT_LINE} This demo engagement is deleted automatically ${SANDBOX_DELETION_DAYS} days after you joined.`;
    return contact ? `${where} ${kept} ${contact}` : `${where} ${kept}`;
  }
  if (provider === "mock") return "Your messages stay on this server (an offline test model answers) and are stored for your instructor.";
  const to = provider ? providerName(provider) : "the model provider";
  return `Your messages are sent to ${to} and stored for your instructor.`;
}

/** The deployment's contact for demo visitors, from DEMO_CONTACT. */
export function demoContact(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.DEMO_CONTACT?.trim();
  return value ? value : null;
}

/** "Contact the demo authors: <contact>.", or null when none is set. */
export function demoContactLine(contact: string | null | undefined): string | null {
  const c = contact?.trim();
  if (!c) return null;
  return `Contact the demo authors: ${c.replace(/[.\s]+$/, "")}.`;
}
