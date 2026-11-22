import { subDays } from "date-fns";

export interface Window {
  label: string;
  current: { sinceIso: string };
  prior: { sinceIso: string; untilIso: string };
}

export function rollingWindow(days: number): Window {
  const now = new Date();
  const currentSince = subDays(now, days);
  const priorSince = subDays(now, days * 2);
  return {
    label: `last ${days}d`,
    current: { sinceIso: currentSince.toISOString() },
    prior: { sinceIso: priorSince.toISOString(), untilIso: currentSince.toISOString() },
  };
}
