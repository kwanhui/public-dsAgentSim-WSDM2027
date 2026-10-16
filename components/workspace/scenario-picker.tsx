"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn, reflowProse } from "@/lib/utils";

interface ScenarioSummary {
  id: string;
  title: string;
  sector: string;
  task: string;
  estimatedEffort?: string;
  brief: string;
}

export function ScenarioPicker({
  scenarios,
  showEffort = true,
}: {
  scenarios: ScenarioSummary[];
  showEffort?: boolean;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  // The confirm prompt replaces the button at the foot of a card, which on a
  // three-across grid can open below the fold. Bring it into view so the
  // learner does not have to hunt for the buttons they just asked for.
  useEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [confirming]);

  async function start(scenarioId: string) {
    setStarting(scenarioId);
    setError(null);
    const res = await fetch("/api/engagement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId }),
    });
    if (res.ok || res.status === 409) {
      router.refresh();
      return;
    }
    // The cohort can be archived between page load and the click; say what
    // happened rather than suggesting a retry that would fail the same way.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setError(
      body?.error === "cohort-archived"
        ? "This cohort has been closed by the instructor; you can no longer start a new engagement. Existing engagements stay accessible."
        : "Could not start the engagement. Try again or contact your instructor.",
    );
    setStarting(null);
  }

  if (scenarios.length === 0) {
    return (
      <p className="mt-8 text-sm text-muted-foreground">
        No scenarios are enabled for your cohort yet. Check back once your
        instructor has configured one.
      </p>
    );
  }

  return (
    <div className="mt-8">
      {error ? (
        <p role="alert" className="mb-4 rounded-md border border-flag/40 bg-flag/5 px-3 py-2 text-sm text-flag">
          {error}
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {scenarios.map((s, i) => {
          const brief = reflowProse(s.brief);
          const isOpen = expanded === s.id;
          const isConfirming = confirming === s.id;
          // With an odd card left over, the last one spans the two-column
          // layout rather than leaving a hole beside it.
          const spansRow = scenarios.length % 2 === 1 && i === scenarios.length - 1;
          return (
            <div
              key={s.id}
              className={cn(
                "flex flex-col rounded-lg border p-5",
                spansRow && "md:col-span-2 lg:col-span-1",
              )}
            >
              {/* Plain muted text: pills are kept for status. */}
              <p className="text-xs text-muted-foreground">
                {[s.sector, s.task, showEffort && s.estimatedEffort ? `~${s.estimatedEffort}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <h2 className="mt-3 font-medium">{s.title}</h2>
              <p
                className={cn(
                  "mt-2 whitespace-pre-line text-sm text-muted-foreground",
                  !isOpen && "line-clamp-5",
                )}
              >
                {isOpen ? brief : brief.split("\n\n")[0]}
              </p>
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : s.id)}
                aria-expanded={isOpen}
                className="mt-2 self-start text-sm text-primary underline-offset-4 hover:underline"
              >
                {isOpen ? "Show less" : "Read full brief"}
              </button>
              <div className="mt-4 flex-1" />
              {isConfirming ? (
                <div ref={confirmRef} className="rounded-md border bg-muted/40 p-3">
                  <p className="text-sm">
                    Start <span className="font-medium">{s.title}</span>? This choice is final:
                    you stay with this client until handover, and you cannot switch to another
                    brief afterwards.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="md"
                      loading={starting === s.id}
                      disabled={starting !== null}
                      onClick={() => start(s.id)}
                    >
                      Yes, start this engagement
                    </Button>
                    <Button
                      size="md"
                      disabled={starting !== null}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="primary"
                  size="md"
                  disabled={starting !== null}
                  onClick={() => setConfirming(s.id)}
                >
                  Start this engagement
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
