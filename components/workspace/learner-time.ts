// Timestamps the learner sees (chat messages, past submissions), with the
// short time zone name so a learner and an instructor in different zones
// read the same moment the same way. Pure: the locale, zone and "now" can be
// passed in, which is how the tests pin the output.

export interface LearnerTimeOptions {
  now?: Date;
  locale?: string | string[];
  timeZone?: string;
  /** Always include the date, even for a timestamp from today. */
  withDate?: boolean;
}

function dayKey(d: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** "01:37 SGT" for today, "30 Sep, 01:37 SGT" otherwise. The zone name is
 * whatever Intl reports as short, which for some zones is an offset such as
 * "GMT+8". */
export function formatLearnerTime(iso: string, opts: LearnerTimeOptions = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const { now = new Date(), locale = [], timeZone, withDate = false } = opts;
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${part("hour")}:${part("minute")} ${part("timeZoneName")}`.trim();
  if (!withDate && dayKey(d, timeZone) === dayKey(now, timeZone)) return time;
  return `${part("day")} ${part("month")}, ${time}`;
}
