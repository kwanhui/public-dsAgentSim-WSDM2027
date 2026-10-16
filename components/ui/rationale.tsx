import { splitFirstSentence } from "@/lib/text/first-sentence";
import { cn } from "@/lib/utils";

// A judge rationale collapsed to its first sentence, with the rest behind a
// native disclosure, and the judge's one-line "To improve" under it when
// there is one (rubric-v3). Server-renderable (no client state), so the
// learner result card, the monitor and the compare view can all use it.
export function Rationale({
  text,
  improve,
  className,
}: {
  text: string;
  improve?: string | null;
  className?: string;
}) {
  const { first, rest } = splitFirstSentence(text);
  return (
    <div className={cn("mt-1 text-muted-foreground", className)}>
      <p>{first}</p>
      {rest ? (
        // A named group: the monitor's own sections are open <details
        // class="group"> too, and an unnamed group-open would match them, so a
        // collapsed rationale would read "Hide full rationale".
        <details className="group/rationale mt-1">
          <summary className="cursor-pointer text-xs text-primary">
            <span className="group-open/rationale:hidden">Show full rationale</span>
            <span className="hidden group-open/rationale:inline">Hide full rationale</span>
          </summary>
          <p className="mt-1 whitespace-pre-line">{rest}</p>
        </details>
      ) : null}
      {improve ? (
        <p className="mt-1 text-foreground">
          <span className="font-medium">To improve:</span> {improve}
        </p>
      ) : null}
    </div>
  );
}
