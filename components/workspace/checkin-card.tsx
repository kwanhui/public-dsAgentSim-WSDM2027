"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { cn } from "@/lib/utils";
import type { BundleStage } from "./types";

// Six-item confidence check-in (1..7 per pipeline stage), collected once at
// engagement start and once at completion, behind a cohort flag that is off
// by default; about 30 seconds of learner time.
export function CheckinCard({
  kind,
  stages,
  goal,
  onDone,
}: {
  kind: "start" | "complete";
  stages: BundleStage[];
  /** Start check-in: unused. Completion check-in: the goal set at the start, echoed back. */
  goal?: string | null;
  onDone: () => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>(
    Object.fromEntries(stages.map((s) => [s.id, 4])),
  );
  const [goalDraft, setGoalDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);

  async function submit() {
    setSaving(true);
    setError(false);
    const res = await fetch("/api/engagement/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, answers, goal: goalDraft.trim() || undefined }),
    });
    if (res.ok || res.status === 409) {
      setSaved(true);
      setSaving(false);
    } else {
      setError(true);
      setSaving(false);
    }
  }

  // One line, not a card restating the answers: they stay readable under
  // the brief, and the learner's task is below.
  if (saved) {
    return (
      <p
        role="status"
        className="mb-6 flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
      >
        <span className="flex-1">
          Check-in saved. Your answers are under the engagement brief.
        </span>
        <Button variant="outline" size="sm" onClick={() => void onDone()}>
          {kind === "complete" ? "Close" : "Continue"}
        </Button>
      </p>
    );
  }

  return (
    <section className="mb-6 rounded-lg border border-primary/40 bg-primary/5 p-5">
      <h2 className="font-medium">
        {kind === "start" ? "Check-in before you start" : "Check-in at completion"}
      </h2>
      <p className="mt-1 text-sm text-foreground/75">
        {kind === "start"
          ? "Rate your confidence in each part of a data-science project, from 1 (not at all) to 7 (very confident). Your instructor sees the answers without your name."
          : "The same six questions as at the start: rate your confidence now, from 1 (not at all) to 7 (very confident)."}
      </p>
      <div className="mt-4 space-y-3">
        {stages.map((s) => (
          <label key={s.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-full sm:w-56">{s.title}</span>
            <span className="text-xs text-foreground">Not at all</span>
            <input
              type="range"
              min={1}
              max={7}
              step={1}
              value={answers[s.id]}
              onChange={(e) => setAnswers((a) => ({ ...a, [s.id]: Number(e.target.value) }))}
              className="max-w-52 flex-1"
              aria-label={`Confidence in ${s.title}, 1 to 7`}
            />
            <span className="text-xs text-foreground">Very confident</span>
            <span className="w-6 text-center font-mono text-xs">{answers[s.id]}</span>
          </label>
        ))}
      </div>
      {kind === "start" ? (
        <label className="mt-4 block text-sm">
          <span className="text-foreground/75">
            Optional: in one line, what do you want to get better at during this engagement?
          </span>
          <input
            type="text"
            value={goalDraft}
            maxLength={500}
            onChange={(e) => setGoalDraft(e.target.value)}
            placeholder="e.g. pinning a vague client down to a measurable objective"
            className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
      ) : goal ? (
        <p className="mt-4 rounded-md bg-background/60 p-3 text-sm text-foreground/75">
          When you started, your goal was: <span className="font-medium text-foreground">{goal.replace(/[.!?\s]+$/, "")}</span>.
          Keep it in mind as you rate yourself now.
        </p>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" size="md" loading={saving} onClick={() => void submit()}>
          Save check-in
        </Button>
        {error ? (
          <span role="alert" className="text-sm text-flag">
            Could not save. Try again.
          </span>
        ) : null}
      </div>
    </section>
  );
}

// The saved check-in, read-only, so the learner can see what they said (and
// what they said the first time round) instead of watching the card vanish.
export function CheckinSummary({
  stages,
  start,
  complete,
  goal,
  className,
}: {
  stages: BundleStage[];
  start: Record<string, number>;
  complete: Record<string, number> | null;
  goal: string | null;
  className?: string;
}) {
  return (
    <Disclosure className={className} title="Your confidence check-in">
      {goal ? (
        <p className="mb-3">
          Your goal for this engagement:{" "}
          <span className="font-medium text-foreground">{goal.replace(/[.!?\s]+$/, "")}</span>.
        </p>
      ) : null}
      <AnswerTable stages={stages} start={start} complete={complete} />
    </Disclosure>
  );
}

function AnswerTable({
  stages,
  start,
  complete,
  className,
}: {
  stages: BundleStage[];
  start: Record<string, number>;
  complete: Record<string, number> | null;
  className?: string;
}) {
  return (
    <ul className={cn("space-y-1 text-sm", className)}>
      {stages.map((s) => (
        <li key={s.id} className="flex items-baseline justify-between gap-3">
          <span>{s.title}</span>
          <span className="shrink-0 font-mono text-xs">
            {start[s.id] ?? "–"}
            {complete ? ` → ${complete[s.id] ?? "–"}` : ""}
            <span className="text-muted-foreground"> / 7</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
