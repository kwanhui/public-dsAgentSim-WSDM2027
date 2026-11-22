"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { formatUtc } from "@/lib/admin/format";
import { JOIN_ROUTE_LABELS, type JoinRoute } from "@/lib/cohort/join-route";
import { DeleteConfirm } from "./delete-confirm";

export interface LearnerRow {
  id: string;
  hash: string;
  // What the instructor types to confirm deleting this learner.
  deletePhrase?: string;
  joinedAtIso: string;
  lastActiveAtIso: string | null;
  // Invite link or the public sandbox.
  joinRoute: JoinRoute;
  // Shown in place of the join route, for a seat an author script used
  // ("Scripted reference (author replay)").
  routeLabel?: string;
}

export interface ResumeLinkResult {
  url?: string;
  error?: string;
}

// The pseudonymous learner roster, with a per-learner resume link for anyone
// who lost their session cookie: a fresh invite would create a second
// pseudonymous learner instead of returning them to their own engagement.
export function LearnerList({
  learners,
  createResumeLinkAction,
  canDelete = false,
}: {
  learners: LearnerRow[];
  // Instructor only: a delete action per learner.
  canDelete?: boolean;
  // Absent for the read-only reviewer: a resume link would let the holder act
  // as the learner.
  createResumeLinkAction?: (studentId: string) => Promise<ResumeLinkResult>;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [result, setResult] = useState<ResumeLinkResult | null>(null);
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleteOpenFor, setDeleteOpenFor] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function requestLink(studentId: string) {
    setPendingFor(studentId);
    setOpenFor(studentId);
    setResult(null);
    setCopied(false);
    try {
      if (!createResumeLinkAction) return;
      const res = await createResumeLinkAction(studentId);
      setResult(res);
    } catch {
      setResult({ error: "The resume link could not be generated. Try again." });
    } finally {
      setPendingFor(null);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(true);
    startTransition(() => {
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <ul className="mt-4 max-h-72 space-y-1 overflow-y-auto rounded-md bg-muted/30 p-3 text-xs">
      {learners.map((l) => (
        <li key={l.id} className="border-b border-border/40 py-1.5 last:border-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-mono text-muted-foreground">{l.hash.slice(0, 12)}…</span>
              <span className="shrink-0 text-muted-foreground">{l.routeLabel ?? JOIN_ROUTE_LABELS[l.joinRoute]}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {l.lastActiveAtIso
                  ? `Active ${formatUtc(l.lastActiveAtIso)}`
                  : `Joined ${formatUtc(l.joinedAtIso)}`}
              </span>
              {createResumeLinkAction ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={pendingFor === l.id}
                  onClick={() => void requestLink(l.id)}
                >
                  Resume link
                </Button>
              ) : null}
              {canDelete && l.deletePhrase && deleteOpenFor !== l.id ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteOpenFor(l.id)}>
                  Delete
                </Button>
              ) : null}
            </span>
          </div>
          {canDelete && l.deletePhrase && deleteOpenFor === l.id ? (
            <DeleteConfirm
              kind="learner"
              id={l.id}
              phrase={l.deletePhrase}
              buttonLabel="Delete learner"
              startOpen
              onCancel={() => setDeleteOpenFor(null)}
            />
          ) : null}
          {openFor === l.id && result ? (
            <div className="mt-1.5">
              {result.url ? (
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    readOnly
                    value={result.url}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label="Resume URL"
                  />
                  <Button
                    type="button"
                    variant={copied ? "secondary" : "primary"}
                    size="sm"
                    onClick={() => void copy(result.url as string)}
                  >
                    {copied ? "✓ Copied" : "Copy"}
                  </Button>
                </div>
              ) : (
                <p role="alert" className="text-flag">
                  {result.error}
                </p>
              )}
              {result.url ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Send this to the learner privately. It restores their own session, so
                  their engagement continues where they left off.
                </p>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
