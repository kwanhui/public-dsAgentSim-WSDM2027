// The landing page's line beside "Try as a learner".

// The seat limit is the one the join route applies to this cohort now (per
// network, per UTC day; the event window's limit while one is in force).
function noInvite(seatsPerAddress: number): string {
  return `No invite needed; up to ${seatsPerAddress} ${seatsPerAddress === 1 ? "seat" : "seats"} per network each day.`;
}

export function sandboxLine(scenarios: string[], seatsPerAddress: number): string {
  const tail = noInvite(seatsPerAddress);
  if (scenarios.length === 1) return `: opens a sandbox seat in one scenario, ${scenarios[0]}. ${tail}`;
  if (scenarios.length > 1) return `: opens a sandbox seat where you choose one of ${scenarios.length} scenarios. ${tail}`;
  return `: opens a sandbox seat. ${tail}`;
}
