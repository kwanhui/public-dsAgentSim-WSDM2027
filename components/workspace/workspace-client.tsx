"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StageStrip } from "@/components/ui/stage-strip";
import { SANDBOX_DELETION_DAYS } from "@/app/privacy/provider-line";
import { STAGE_PHASES } from "@/lib/scenarios/phases";
import type { StageId } from "@/lib/scenarios/types";
import { cn, reflowProse } from "@/lib/utils";
import { ChatPane } from "./chat-pane";
import { CheckinCard, CheckinSummary } from "./checkin-card";
import { FilesPane } from "./files-pane";
import { HelpPanel } from "./help-panel";
import { SimulatedNotice } from "./simulated-notice";
import { StagePanel } from "./stage-panel";
import type { WorkspaceBundle } from "./types";
import { engagementTotal, engagementTotalLine } from "./engagement-total";
import { currentRemaining } from "./message-allowance";
import { formatLearnerTime } from "./learner-time";
import { completedScoresLine } from "./learner-copy";

type View = { kind: "channel"; channelId: string } | { kind: "gate" } | { kind: "brief" } | { kind: "files" };

// Per-channel count of persona messages the learner has already looked at,
// kept in the browser so a reload does not re-flag every old reply. Channel
// ids are unique across engagements, so one flat map covers them all.
type SeenCounts = Record<string, number>;

const SEEN_STORAGE_KEY = "agenticpracticum:channel-reads";

function readSeenCounts(): SeenCounts {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(SEEN_STORAGE_KEY) ?? "{}") as SeenCounts;
  } catch {
    return {};
  }
}

export function WorkspaceClient({ engagementId }: { engagementId?: string } = {}) {
  const router = useRouter();
  // With an engagement id the workspace shows that earlier engagement,
  // read-only; without one, the learner's current engagement.
  const bundleUrl = engagementId
    ? `/api/engagement/me?engagement=${encodeURIComponent(engagementId)}`
    : "/api/engagement/me";
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(null);
  const [view, setView] = useState<View>({ kind: "brief" });
  const [loadError, setLoadError] = useState(false);
  const [seen, setSeen] = useState<SeenCounts>(readSeenCounts);
  const [filesHighlighted, setFilesHighlighted] = useState(false);
  const [signOutArmed, setSignOutArmed] = useState(false);
  // The latest remaining-message count a chat response reported; the bundle
  // only refreshes on some turns, so the chat pane reports each send here.
  const [remainingFromChat, setRemainingFromChat] = useState<number | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(bundleUrl, { cache: "no-store" });
    if (!res.ok) {
      setLoadError(true);
      return;
    }
    setBundle((await res.json()) as WorkspaceBundle);
  }, [bundleUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(bundleUrl, { cache: "no-store" }).catch(() => null);
      if (cancelled) return;
      if (!res?.ok) {
        setLoadError(true);
        return;
      }
      setBundle((await res.json()) as WorkspaceBundle);
    })();
    return () => {
      cancelled = true;
    };
  }, [bundleUrl]);

  // Reading a channel means having it open: mark it caught up when it opens
  // and again when the learner leaves it, so replies that arrived while they
  // were reading do not come back as unread. Counts only ever move forward:
  // the bundle can lag behind a reply the open channel has already shown.
  const markRead = useCallback((channelIds: string[], counts: Map<string, number>) => {
    setSeen((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const id of channelIds) {
        const count = counts.get(id) ?? 0;
        if (count > (next[id] ?? 0)) {
          next[id] = count;
          changed = true;
        }
      }
      if (!changed) return prev;
      try {
        window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // A browser refusing storage only costs the unread marks.
      }
      return next;
    });
  }, []);

  // A reply that lands while its channel is on screen has been read by the
  // time it renders. The open pane reports what it is showing, so the reply
  // does not resurface as unread the next time the learner passes by.
  const markChannelCaughtUp = useCallback(
    (channelId: string, personaMessages: number) => {
      markRead([channelId], new Map([[channelId, personaMessages]]));
    },
    [markRead],
  );

  const openView = useCallback(
    (next: View) => {
      const counts = new Map((bundle?.channels ?? []).map((c) => [c.id, c.messagesFromPersona]));
      const touched = [
        ...(view.kind === "channel" ? [view.channelId] : []),
        ...(next.kind === "channel" ? [next.channelId] : []),
      ];
      if (touched.length > 0) markRead(touched, counts);
      setView(next);
    },
    [bundle, markRead, view],
  );

  // The release happens in a chat message, somewhere else on the screen, so
  // flag the Data files section briefly when one lands.
  const flagNewFile = useCallback(() => {
    setFilesHighlighted(true);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setFilesHighlighted(false), 6000);
  }, []);

  async function signOut() {
    await fetch("/api/engagement/signout", { method: "POST" }).catch(() => null);
    router.push("/");
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-center text-sm text-muted-foreground">
        Could not load your workspace. Refresh the page; if it persists, contact your instructor.
      </main>
    );
  }
  if (!bundle) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-center text-sm text-muted-foreground">
        Loading your engagement…
      </main>
    );
  }

  const { scenario, engagement, channels, learner } = bundle;
  const stageIdx = scenario.stages.findIndex((s) => s.id === engagement.currentStage);
  const past = engagement.past === true;
  // An earlier engagement opened from the list reads like a completed one.
  const completed = engagement.status === "completed" || past;
  const otherEngagements = (bundle.engagements ?? []).filter((e) => e.id !== engagement.id);
  const stageTitle = (id: string) => scenario.stages.find((s) => s.id === id)?.title ?? id;
  const sandbox = learner.joinRoute === "sandbox";
  const cohortLabel = sandbox ? "Demo" : learner.cohortName;
  const totalLine = completed
    ? engagementTotalLine(engagementTotal(bundle.submissions, bundle.ui.showRubricScores))
    : null;
  const messagesRemaining = currentRemaining(bundle.limits.messagesRemaining, remainingFromChat);

  const dataOwner = scenario.personas.find((p) => p.role === "data-owner");
  const dataOwnerChannel = channels.find((c) => c.personaId === dataOwner?.id);
  const clientChannel = channels.find(
    (c) => c.personaId === scenario.personas.find((p) => p.role === "client-sponsor")?.id,
  );

  const mobilePhase = STAGE_PHASES[scenario.stages[stageIdx]?.id as StageId]?.phase;

  const unreadFor = (channelId: string, fromPersona: number) =>
    Math.max(0, fromPersona - (seen[channelId] ?? 0));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
              AgenticPracticum
            </Link>
            <div className="h-5 w-px bg-border" aria-hidden="true" />
            <h1 className="text-sm font-semibold">{scenario.title}</h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {signOutArmed ? (
              <>
                <span className="max-w-56 text-right">
                  {sandbox
                    ? `Signing out ends this demo seat; to have it erased before the ${SANDBOX_DELETION_DAYS}-day purge, note your learner id first: ${learner.pseudonym}.`
                    : "Signing out means you will need a resume link from your instructor to return."}
                </span>
                <Button size="sm" variant="danger" onClick={() => void signOut()}>
                  Sign out
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSignOutArmed(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <span title={`${cohortLabel} · your learner id`}>
                  Signed in as {learner.pseudonym}
                </span>
                {/* Always reachable, so a learner can find how to have their
                    data deleted without signing out. */}
                <Link href="/privacy" className="text-primary underline-offset-4 hover:underline">
                  Privacy
                </Link>
                <Button size="sm" variant="ghost" onClick={() => setSignOutArmed(true)}>
                  Sign out
                </Button>
              </>
            )}
          </div>
          <div className="w-full sm:hidden" aria-label="Pipeline progress">
            <p className="text-xs text-muted-foreground">
              {completed
                ? "All 6 stages complete"
                : `${mobilePhase ? `${mobilePhase} · ` : ""}Stage ${stageIdx + 1} of ${scenario.stages.length}: ${scenario.stages[stageIdx]?.title}`}
            </p>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{
                  // The current stage counts as filled, so stage 1 shows one
                  // sixth rather than an empty bar.
                  width: `${(Math.min(completed ? scenario.stages.length : stageIdx + 1, scenario.stages.length) / scenario.stages.length) * 100}%`,
                }}
              />
            </div>
          </div>
          {/* The pipeline as a stepper: done stages carry a check, the
              current one a ring. Narrow screens keep the bar above. */}
          <StageStrip
            className="hidden w-full border-t pt-3 sm:block"
            stages={scenario.stages}
            status={(_, i) => (completed || i < stageIdx ? "done" : i === stageIdx ? "current" : "later")}
          />
        </div>
      </header>

      {past ? (
        <div className="border-b bg-muted/40 px-6 py-2 text-center text-sm">
          You are reading an earlier engagement. It is read-only.{" "}
          <Link href="/workspace" className="font-medium text-primary underline underline-offset-4">
            Back to your current engagement
          </Link>
        </div>
      ) : completed ? (
        <div className="border-b bg-primary/10 px-6 py-2 text-center text-sm text-foreground">
          Engagement complete.{totalLine ? ` ${totalLine}` : ""}{" "}
          {totalLine ? completedScoresLine(sandbox ? "sandbox" : "invite") : null}Your
          channels and scores stay readable here, or you can{" "}
          <Link href="/workspace?new=1" className="font-medium underline underline-offset-4">
            start a new engagement
          </Link>
          .
        </div>
      ) : null}

      {/* Above both columns, so it is the first thing a learner sees at any
          width, including on a phone where the sidebar stacks on top. */}
      <SimulatedNotice
        pseudonym={learner.pseudonym}
        personas={scenario.personas}
        joinRoute={learner.joinRoute}
        provider={learner.provider}
        demoContact={learner.demoContact}
      />
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row">
        <aside className="w-full shrink-0 md:w-56">
          <nav className="space-y-1" aria-label="Workspace">
            <SidebarButton active={view.kind === "brief"} onClick={() => openView({ kind: "brief" })}>
              Engagement brief
            </SidebarButton>
            <SidebarButton active={view.kind === "gate"} onClick={() => openView({ kind: "gate" })}>
              Stage gate
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {completed ? "Done" : scenario.stages[stageIdx]?.title}
              </span>
            </SidebarButton>
          </nav>

          <h2 className="mt-6 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Channels
          </h2>
          <nav className="mt-2 space-y-1" aria-label="Stakeholder channels">
            {channels.map((c) => {
              const persona = scenario.personas.find((p) => p.id === c.personaId);
              if (!persona) return null;
              // A closed engagement has nothing left to catch up on.
              const unread = c.unlocked && !completed ? unreadFor(c.id, c.messagesFromPersona) : 0;
              return (
                <SidebarButton
                  key={c.id}
                  disabled={!c.unlocked}
                  active={view.kind === "channel" && view.channelId === c.id}
                  title={`${persona.channelName}, ${persona.title}`}
                  onClick={() => openView({ kind: "channel", channelId: c.id })}
                >
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 leading-snug">
                      {!c.unlocked ? (
                        <>
                          <Lock aria-hidden="true" className="mr-1 inline h-3 w-3 align-[-1px]" />
                          <span className="sr-only">Locked: </span>
                        </>
                      ) : null}
                      {persona.channelName}
                    </span>
                    {!c.unlocked ? (
                      <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                        Opens at {stageTitle(persona.unlockedAtStage)}
                      </span>
                    ) : null}
                  </span>
                  {unread > 0 && !(view.kind === "channel" && view.channelId === c.id) ? (
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                      {unread}
                      <span className="sr-only">{unread === 1 ? " unread message" : " unread messages"}</span>
                    </span>
                  ) : null}
                </SidebarButton>
              );
            })}
          </nav>

          <h2
            className={cn(
              "mt-6 rounded px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors",
              filesHighlighted && "bg-primary/15 text-primary",
            )}
          >
            Data files
            {filesHighlighted ? <span className="sr-only">: a new file was just released</span> : null}
          </h2>
          {bundle.releasedFiles.length === 0 ? (
            <p className="mt-2 px-2 text-xs leading-snug text-muted-foreground">
              {dataOwnerChannel?.unlocked
                ? "Nothing released yet. Ask the data owner, and say what you need it for."
                : dataOwner
                  ? `Nothing released yet. The data owner joins at ${stageTitle(dataOwner.unlockedAtStage)}.`
                  : "Nothing released yet."}
            </p>
          ) : (
            <nav className="mt-2 space-y-1" aria-label="Released data files">
              {bundle.releasedFiles.map((f) => (
                <SidebarButton
                  key={f.file}
                  active={view.kind === "files"}
                  title={f.description}
                  onClick={() => openView({ kind: "files" })}
                >
                  <span className="min-w-0 flex-1 font-mono text-xs leading-snug">{f.file}</span>
                </SidebarButton>
              ))}
            </nav>
          )}

          {otherEngagements.length > 0 ? (
            <>
              <h2 className="mt-6 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Your engagements
              </h2>
              <ul className="mt-2 space-y-1 px-2 text-sm" aria-label="Your other engagements">
                {otherEngagements.map((e) => (
                  <li key={e.id}>
                    <Link
                      href={e.current ? "/workspace" : `/workspace?engagement=${encodeURIComponent(e.id)}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {e.scenarioTitle}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {e.current ? "current" : e.status === "completed" ? "completed" : e.status},{" "}
                      started {formatLearnerTime(e.createdAt, { withDate: true })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>

        <main className="min-w-0 flex-1">
          {bundle.checkins.enabled && !bundle.checkins.start && !completed ? (
            <CheckinCard kind="start" stages={scenario.stages} onDone={refresh} />
          ) : null}
          {bundle.checkins.enabled && completed && !past && !bundle.checkins.complete ? (
            <CheckinCard kind="complete" stages={scenario.stages} goal={bundle.checkins.goal} onDone={refresh} />
          ) : null}
          {view.kind === "brief" ? (
            <article className="max-w-2xl">
              <h2 className="text-lg font-semibold">Engagement brief</h2>
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {reflowProse(scenario.brief)}
              </p>
              {!completed ? <HelpPanel pseudonym={learner.pseudonym} joinRoute={learner.joinRoute} /> : null}
              {bundle.checkins.start ? (
                <CheckinSummary
                  className="mt-6"
                  stages={scenario.stages}
                  start={bundle.checkins.start.answers}
                  complete={bundle.checkins.complete?.answers ?? null}
                  goal={bundle.checkins.goal}
                />
              ) : null}
            </article>
          ) : view.kind === "gate" ? (
            <StagePanel
              bundle={bundle}
              onStateChange={refresh}
              onOpenClientChannel={
                clientChannel ? () => openView({ kind: "channel", channelId: clientChannel.id }) : undefined
              }
            />
          ) : view.kind === "files" ? (
            <FilesPane
              files={bundle.releasedFiles}
              pending={bundle.pendingFiles ?? []}
              dataOwnerUnlocked={dataOwnerChannel?.unlocked ?? false}
              dataOwnerStageTitle={dataOwner ? stageTitle(dataOwner.unlockedAtStage) : null}
            />
          ) : (
            <ChatPane
              key={view.channelId}
              channelId={view.channelId}
              persona={scenario.personas.find(
                (p) => p.id === channels.find((c) => c.id === view.channelId)?.personaId,
              )}
              readOnly={completed}
              messagesRemaining={messagesRemaining}
              maxMessages={bundle.limits.maxLearnerMessages}
              onMessagesRemaining={setRemainingFromChat}
              onStateChange={refresh}
              onRead={markChannelCaughtUp}
              onOpenFiles={() => openView({ kind: "files" })}
              onFilesReleased={flagNewFile}
              sandbox={sandbox}
              mock={learner.provider === "mock"}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function SidebarButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        // Muted 12px text on the active row's bg-muted measured 4.29:1; the
        // row lifts it to foreground/70 (above 4.5:1 in both themes).
        active ? "bg-muted font-medium [&_.text-muted-foreground]:text-foreground/70" : "hover:bg-muted/60",
        // A locked row is not dimmed with opacity, which took its "Unlocks
        // at" line to about 2:1. The name is muted (4.7:1) and the unlock
        // line foreground/70, both above 4.5:1, with a lock glyph.
        disabled && "cursor-not-allowed text-muted-foreground hover:bg-transparent [&_.text-muted-foreground]:text-foreground/70",
      )}
    >
      {children}
    </button>
  );
}
