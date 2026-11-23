// The sandbox limits that apply at a given moment. A cohort's sandbox
// settings hold the ordinary per-address seat limit and daily budget, and
// may hold one dated event window (for a live demonstration at a venue,
// where every visitor shares the venue's network) whose own per-address
// limit and daily budget replace the ordinary ones from its start to its
// end. Outside the window, or with no window, the ordinary limits apply,
// so the limits fall back on their own when the event is over.
//
// The window's times are ISO 8601 with an offset (the venue's local time,
// for example 2027-02-15T00:00:00+08:00); the start is inclusive and the
// end exclusive. A window whose end is not after its start never applies.
// The seat counts and the budget are still counted per UTC day.
//
// Pure, with no database import, so the Configuration form and the landing
// page can use it as well as the join route and the budget guard.

export const DEFAULT_JOINS_PER_ADDRESS_PER_DAY = 5;

export interface SandboxEventWindow {
  startsAt: string;
  endsAt: string;
  maxJoinsPerAddressPerDay: number;
  dailyBudgetUsd: number;
}

export interface SandboxLimitSettings {
  maxJoinsPerAddressPerDay?: number;
  dailyBudgetUsd?: number | null;
  eventWindow?: SandboxEventWindow | null;
}

export interface EffectiveSandboxLimits {
  maxJoinsPerAddressPerDay: number;
  dailyBudgetUsd: number | null;
  // True while the event window's limits are the ones in force.
  eventActive: boolean;
}

/** Whether the window is well formed (both times parse, end after start). */
export function eventWindowValid(window: SandboxEventWindow | null | undefined): window is SandboxEventWindow {
  if (!window) return false;
  const start = Date.parse(window.startsAt);
  const end = Date.parse(window.endsAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

/** Whether `now` falls inside the window (start inclusive, end exclusive). */
export function eventWindowActive(window: SandboxEventWindow | null | undefined, now: Date = new Date()): boolean {
  if (!eventWindowValid(window)) return false;
  const t = now.getTime();
  return t >= Date.parse(window.startsAt) && t < Date.parse(window.endsAt);
}

/** The per-address seat limit and the daily budget in force at `now`. */
export function effectiveSandboxLimits(
  sandbox: SandboxLimitSettings,
  now: Date = new Date(),
): EffectiveSandboxLimits {
  const window = sandbox.eventWindow;
  if (eventWindowActive(window, now)) {
    return {
      maxJoinsPerAddressPerDay: window!.maxJoinsPerAddressPerDay,
      dailyBudgetUsd: window!.dailyBudgetUsd,
      eventActive: true,
    };
  }
  return {
    maxJoinsPerAddressPerDay: sandbox.maxJoinsPerAddressPerDay ?? DEFAULT_JOINS_PER_ADDRESS_PER_DAY,
    dailyBudgetUsd: sandbox.dailyBudgetUsd === undefined ? null : sandbox.dailyBudgetUsd,
    eventActive: false,
  };
}
