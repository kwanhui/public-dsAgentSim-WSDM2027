// Small server-rendered charts for the instructor analytics page. Plain
// HTML/SVG, no chart library: bars are divs, dumbbells are one SVG row each.
// Series colors come from --chart-main / --chart-alt (validated for CVD and
// contrast in both themes); all text stays in text tokens. The data tables
// remain on the page as the accessible table view of the same numbers.

const TRACK = "bg-muted";

export function HBarList({
  items,
  max,
  formatValue,
}: {
  items: { label: string; value: number; detail?: string }[];
  /** Scale maximum; defaults to the largest value. */
  max?: number;
  formatValue?: (v: number) => string;
}) {
  const scale = Math.max(max ?? 0, ...items.map((i) => i.value), 1);
  const fmt = formatValue ?? ((v: number) => String(v));
  return (
    <ul className="max-w-xl space-y-2">
      {items.map((it) => (
        <li key={it.label} className="grid grid-cols-[10rem_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground" title={it.detail ?? it.label}>
            {it.label}
          </span>
          <span className={`h-3.5 w-full overflow-hidden rounded ${TRACK}`} aria-hidden="true">
            <span
              className="block h-full rounded-r"
              style={{
                width: `${(it.value / scale) * 100}%`,
                backgroundColor: "var(--chart-main)",
              }}
            />
          </span>
          <span className="font-mono text-xs tabular-nums">{fmt(it.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export function DumbbellList({
  items,
  min,
  max,
  startLabel,
  endLabel,
}: {
  items: { label: string; start: number | null; end: number | null }[];
  min: number;
  max: number;
  startLabel: string;
  endLabel: string;
}) {
  const pos = (v: number) => ((v - min) / (max - min)) * 100;
  return (
    <div className="max-w-xl">
      <p className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: "var(--chart-alt)" }}
            aria-hidden="true"
          />
          {startLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: "var(--chart-main)" }}
            aria-hidden="true"
          />
          {endLabel}
        </span>
        <span className="ml-auto font-mono">
          {min}–{max}
        </span>
      </p>
      <ul className="mt-2 space-y-2">
        {items.map((it) => (
          <li key={it.label} className="grid grid-cols-[10rem_1fr] items-center gap-3 text-sm">
            <span className="truncate text-muted-foreground">{it.label}</span>
            <svg
              viewBox="0 0 100 12"
              preserveAspectRatio="none"
              className="h-4 w-full"
              role="img"
              aria-label={`${it.label}: ${startLabel} ${it.start ?? "none"}, ${endLabel} ${it.end ?? "none"}`}
            >
              <line x1="0" y1="6" x2="100" y2="6" className="stroke-border" strokeWidth="1" />
              {it.start !== null && it.end !== null ? (
                <line
                  x1={pos(it.start)}
                  y1="6"
                  x2={pos(it.end)}
                  y2="6"
                  stroke="var(--chart-main)"
                  strokeOpacity="0.45"
                  strokeWidth="2.5"
                />
              ) : null}
              {it.start !== null ? (
                <circle cx={pos(it.start)} cy="6" r="4" fill="var(--chart-alt)">
                  <title>{`${startLabel}: ${it.start}`}</title>
                </circle>
              ) : null}
              {it.end !== null ? (
                <circle cx={pos(it.end)} cy="6" r="4" fill="var(--chart-main)">
                  <title>{`${endLabel}: ${it.end}`}</title>
                </circle>
              ) : null}
            </svg>
          </li>
        ))}
      </ul>
    </div>
  );
}
