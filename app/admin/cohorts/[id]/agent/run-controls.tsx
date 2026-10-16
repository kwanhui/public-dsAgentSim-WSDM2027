"use client";

import { createContext, useCallback, useContext, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Client-side complement to the server's event-bracket guard on the analyst
// agent page. The server knows a stage is executing from the
// analyst_stage_started/finished bracket, but the page only re-renders when a
// server action completes. For the 1-2 minutes a stage run holds its request
// open, the rendered disable state is frozen at "idle". Worse, the client
// queues server actions dispatched from the same tab behind one another, so a
// click on "Start analyst run" during a stage run executed only after the
// bracket had closed and slipped past the server's re-check. This context
// locks every start/run control at click time, the moment a stage run is
// dispatched from this tab, and unlocks when the action returns; the server
// re-check stays in place for clicks from other tabs.

interface StageRunState {
  // Engagement id of the stage run this tab has in flight, or null.
  pendingRunId: string | null;
  // True when any stage is executing: a run dispatched from this tab, or one
  // the server saw in the event bracket when it rendered the page.
  busy: boolean;
  begin: (runId: string) => void;
  end: () => void;
}

const StageRunContext = createContext<StageRunState>({
  pendingRunId: null,
  busy: false,
  begin: () => {},
  end: () => {},
});

export function StageRunProvider({
  serverBusy,
  children,
}: {
  // Whether the server saw an open stage bracket anywhere in the cohort when
  // it rendered this page. Covers stages driven from other tabs, and carries
  // the bracket's staleness cap so a crashed run cannot wedge the controls.
  serverBusy: boolean;
  children: React.ReactNode;
}) {
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const begin = useCallback((runId: string) => setPendingRunId(runId), []);
  const end = useCallback(() => setPendingRunId(null), []);
  return (
    <StageRunContext.Provider
      value={{ pendingRunId, busy: pendingRunId !== null || serverBusy, begin, end }}
    >
      {children}
    </StageRunContext.Provider>
  );
}

// Rendered inside the explanatory paragraph under the page header, so the
// disabled controls always come with the reason next to them.
export function StageRunNote() {
  const { busy } = useContext(StageRunContext);
  if (!busy) return null;
  return <> A stage is running right now, so starting another run is held back until it finishes.</>;
}

// "Run current stage" for one agent run. Dispatching locks the whole page's
// run controls through the context above; the server action re-checks the
// event bracket itself, so a dispatch from a stale tab still cannot race an
// executing stage.
export function RunStageButton({
  runId,
  action,
  progressLabel,
  children,
}: {
  runId: string;
  action: () => Promise<void>;
  // What the button says while the stage runs, e.g. "Running stage 2 of 6".
  progressLabel: string;
  children: React.ReactNode;
}) {
  const { pendingRunId, busy, begin, end } = useContext(StageRunContext);
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [lost, setLost] = useState(false);
  const pending = pendingRunId === runId;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        loading={pending}
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setLost(false);
          begin(runId);
          startTransition(async () => {
            try {
              await action();
            } catch {
              // The stage run logs its own failures server-side; landing here
              // means the response never arrived (connection dropped, tab lost
              // the request), and the run may still be executing.
              setLost(true);
            } finally {
              end();
              // The action revalidates the page on the server, but this tab's
              // run card kept the previous stage and status until a manual
              // reload; refetching here re-renders the card and buttons with
              // the post-stage server data as soon as the action resolves.
              router.refresh();
            }
          });
        }}
      >
        {pending ? `${progressLabel}…` : children}
      </Button>
      {lost ? (
        <p role="status" className="w-full text-xs text-flag">
          The stage request lost its connection, and the run may still be executing. Reload the
          page to see where it stands.
        </p>
      ) : null}
    </>
  );
}

// Scenario picker plus "Start analyst run". Disabled, with the note above,
// while any stage is in flight; when the server rejects a start anyway (a
// stage was running in another tab), it says so instead of doing nothing.
export function StartRunForm({
  action,
  options,
  defaultScenarioId,
}: {
  action: (scenarioId: string) => Promise<{ started: boolean; message?: string }>;
  options: { id: string; title: string }[];
  defaultScenarioId: string;
}) {
  const { busy } = useContext(StageRunContext);
  const router = useRouter();
  const [isStarting, startTransition] = useTransition();
  // Explains a rejected or failed start; the next submit clears it.
  const [notice, setNotice] = useState<"held" | "failed" | null>(null);
  // A refusal the server explained (the daily usage limit).
  const [refusal, setRefusal] = useState<string | null>(null);
  const disabled = busy || isStarting;

  return (
    <div>
      <form
        className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled) return;
          const scenarioId = String(new FormData(e.currentTarget).get("scenarioId") ?? "");
          setNotice(null);
          setRefusal(null);
          startTransition(async () => {
            try {
              const result = await action(scenarioId);
              if (!result.started) {
                if (result.message) setRefusal(result.message);
                else setNotice("held");
              }
              // Same staleness as the stage button: without a refetch the new
              // run's card (or the stage that blocked the start) only shows
              // up after a manual reload.
              router.refresh();
            } catch {
              setNotice("failed");
            }
          });
        }}
      >
        <label className="block min-w-0 text-xs">
          <span className="mb-1 block font-medium uppercase tracking-wider text-muted-foreground">
            Scenario
          </span>
          <select
            name="scenarioId"
            defaultValue={defaultScenarioId}
            disabled={disabled}
            className="h-9 w-full max-w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50 sm:w-auto"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" loading={isStarting} disabled={disabled}>
          Start analyst run
        </Button>
      </form>
      {refusal ? (
        <p role="status" className="mt-1.5 max-w-xs text-xs text-flag">
          {refusal}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-1.5 max-w-xs text-xs text-flag">
          {notice === "held"
            ? "Not started: a stage is running on another run in this cohort. Wait for it to finish, then start again."
            : "The run could not be started. Check your connection and try again."}
        </p>
      ) : null}
    </div>
  );
}

// Live activity line while this tab has a stage run in flight: polls the
// run's event log and shows the latest analyst step, so a 1-2 minute stage
// run is not dead air on stage.
const ACTIVITY_POLL_MS = 5000;

export function StageActivity({ runId, cohortId }: { runId: string; cohortId: string }) {
  const { pendingRunId } = useContext(StageRunContext);
  const active = pendingRunId === runId;
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/admin/cohorts/${cohortId}/agent/activity?run=${encodeURIComponent(runId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { line?: unknown };
        if (!stopped && typeof data.line === "string" && data.line.length > 0) {
          setLine(data.line);
        }
      } catch {
        // Polling is a convenience; a failed poll keeps the last line up.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), ACTIVITY_POLL_MS);
    return () => {
      // The stage finished (or the run changed): stop polling and drop the
      // line so a later stage run starts from a clean slate.
      stopped = true;
      window.clearInterval(timer);
      setLine(null);
    };
  }, [active, cohortId, runId]);

  if (!active) return null;
  return (
    <p role="status" className="mt-3 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary align-middle"
      />
      {line ?? "Stage running. Waiting for the first analyst step…"}
    </p>
  );
}
