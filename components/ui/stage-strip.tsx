import { ChartLine, Check, ClipboardCheck, Database, Filter, PackageCheck, Target, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { STAGE_PHASES, type StagePhase } from "@/lib/scenarios/phases";
import type { StageId } from "@/lib/scenarios/types";
import { cn } from "@/lib/utils";

const ICONS: Record<StagePhase["icon"], LucideIcon> = {
  Target,
  Database,
  Filter,
  ChartLine,
  ClipboardCheck,
  PackageCheck,
};

export type StageStatus = "done" | "current" | "later";

const STATUS_WORDS: Record<StageStatus, string> = {
  done: " (delivered)",
  current: " (current stage)",
  later: " (not started)",
};

interface StageStripProps {
  stages: { id: string; title: string }[];
  /** Omit for a plain map of the pipeline (landing page, compare view). */
  status?: (id: string, index: number) => StageStatus;
  /** compact: icons and phase labels, with the stage title in the tooltip and for screen readers. */
  size?: "full" | "compact";
  /** Show each phase's one-line blurb under the title (full size only). */
  blurbs?: boolean;
  /** Extra content under a node, e.g. which runs reached the stage. */
  note?: (id: string) => ReactNode;
  /** Below `sm`, wrap into three columns and two rows instead of scrolling
   * sideways. The connectors are hidden while wrapped, since a row break
   * would cut them. */
  wrap?: boolean;
  className?: string;
}

// The six stages as one horizontal pipeline: a node per stage, joined by a
// line, with the generic phase label above and the stage title below. On a
// narrow screen the strip either wraps into a 3 by 2 grid (wrap) or scrolls
// sideways inside its own box rather than pushing the page wider.
export function StageStrip({ stages, status, size = "full", blurbs = false, note, wrap = false, className }: StageStripProps) {
  const compact = size === "compact";
  const circle = compact ? "h-7 w-7" : "h-9 w-9";
  const icon = compact ? "h-3.5 w-3.5" : "h-4 w-4";
  // The connector runs through the middle of the circles, below the label.
  const lineTop = compact ? "top-[2.125rem]" : "top-[2.375rem]";
  return (
    <div className={cn("max-w-full overflow-x-auto", className)}>
      <ol
        aria-label="Pipeline stages"
        className={cn(
          wrap ? "grid grid-cols-3 gap-y-4 sm:flex sm:items-start" : "flex min-w-max items-start sm:min-w-0",
        )}
      >
        {stages.map((s, i) => {
          const phase = STAGE_PHASES[s.id as StageId] as StagePhase | undefined;
          const Icon = phase ? ICONS[phase.icon] : Target;
          const st = status?.(s.id, i);
          const reached = st === "done" || st === "current";
          return (
            <li
              key={s.id}
              aria-current={st === "current" ? "step" : undefined}
              title={compact ? s.title : undefined}
              className={cn(
                "relative flex flex-1 flex-col items-center px-1 text-center",
                wrap ? "min-w-0" : "",
                compact ? "sm:min-w-[4.25rem]" : "sm:min-w-[6rem]",
                wrap ? "" : compact ? "min-w-[4.25rem]" : "min-w-[6rem]",
              )}
            >
              {i > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute right-1/2 h-0.5 w-full -translate-y-1/2",
                    lineTop,
                    wrap ? "hidden sm:block" : "",
                    // Unreached connectors and borders in a mid grey (about
                    // 3:1 on white), so the rest of the pipeline stays visible.
                    reached ? "bg-primary" : "bg-muted-foreground/70",
                  )}
                />
              ) : null}
              <span
                className={cn(
                  "text-xs font-medium",
                  st === "current" ? "text-foreground" : st === "later" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {phase?.phase ?? s.title}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "relative z-10 mt-1 flex items-center justify-center rounded-full border-2",
                  circle,
                  st === "done"
                    ? "border-primary bg-primary text-primary-foreground"
                    : st === "current"
                      ? "border-primary bg-background text-primary ring-4 ring-primary/20"
                      : st === "later"
                        ? "border-muted-foreground/70 bg-muted text-muted-foreground"
                        : // No status: a primary border at about 3:1 on white.
                          "border-primary/70 bg-background text-primary",
                )}
              >
                {st === "done" ? <Check className={icon} /> : <Icon className={icon} />}
              </span>
              {compact ? (
                <span className="sr-only">{`: ${s.title}`}</span>
              ) : (
                <span
                  className={cn(
                    "mt-1.5 text-xs leading-tight",
                    // With no status (landing page, compare view) the title is
                    // set darker than the muted blurb under it, so the two
                    // lines read as title then blurb.
                    st === "current"
                      ? "font-semibold text-foreground"
                      : st === undefined
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                  )}
                >
                  {s.title}
                </span>
              )}
              {st ? <span className="sr-only">{STATUS_WORDS[st]}</span> : null}
              {blurbs && !compact && phase ? (
                <span className="mt-1.5 max-w-[9rem] text-xs leading-snug text-muted-foreground">
                  {phase.blurb}
                </span>
              ) : null}
              {note ? note(s.id) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// One stage in a table cell: the phase chip with its icon, six dots for the
// position in the pipeline, and the stage title for screen readers and the
// tooltip.
export function StageChip({
  id,
  title,
  index,
  total = 6,
  completed = false,
}: {
  id: string;
  title: string;
  index: number;
  total?: number;
  completed?: boolean;
}) {
  const phase = STAGE_PHASES[id as StageId] as StagePhase | undefined;
  const Icon = phase ? ICONS[phase.icon] : Target;
  return (
    <span className="inline-flex flex-col gap-1" title={title}>
      <span className="inline-flex w-fit items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
        <Icon className="h-3 w-3" aria-hidden="true" />
        <span aria-hidden="true">{phase?.phase ?? title}</span>
        <span className="sr-only">{title}</span>
      </span>
      {index >= 0 ? (
        <span className="flex gap-1" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                completed || i < index ? "bg-primary" : i === index ? "bg-primary/50 ring-1 ring-primary" : "bg-border",
              )}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}
