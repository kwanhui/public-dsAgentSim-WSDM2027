// How a learner seat was created, read from students.profileJson.kind.
// "invite": redeemed an instructor's invite link (no profile kind).
// "sandbox": created by the public /try route (lib/cohort/sandbox.ts).
// "agent": the analyst agent's seat (lib/agents/analyst.ts).
// Pure, so the learner list, the exports, analytics and the learner notice
// all label a seat the same way.

export type JoinRoute = "invite" | "sandbox" | "agent";

export function joinRouteOf(profileJson: unknown): JoinRoute {
  const kind =
    profileJson && typeof profileJson === "object" ? (profileJson as { kind?: unknown }).kind : undefined;
  if (kind === "sandbox") return "sandbox";
  if (kind === "analyst-agent") return "agent";
  return "invite";
}

export const JOIN_ROUTE_LABELS: Record<JoinRoute, string> = {
  invite: "Invite",
  sandbox: "Sandbox",
  agent: "Analyst agent",
};
