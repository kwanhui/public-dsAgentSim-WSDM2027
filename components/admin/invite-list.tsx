"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { formatUtc } from "@/lib/admin/format";

interface Invite {
  id: string;
  token: string;
  expiresAt: string; // ISO string; Date is not serializable to client components
}

interface Props {
  cohortId: string;
  cohortSlug: string;
  baseUrl: string;
  invites: Invite[];
}

// What went wrong on revoke, kept per invite so the message sits next to the
// link it is about. "redeemed" is its own case: the learner joined while this
// page was open, which is not a failure the instructor should retry.
type RevokeProblem = "redeemed" | "gone" | "failed";

const REVOKE_MESSAGE: Record<RevokeProblem, string> = {
  redeemed:
    "This invite was redeemed a moment ago. Refresh to see it in the history.",
  gone: "This invite is no longer on this cohort. Refresh to see the current list.",
  failed:
    "The invite could not be revoked. Check your connection and try again.",
};

export function InviteList({ cohortId, cohortSlug, baseUrl, invites }: Props) {
  const router = useRouter();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<{
    id: string;
    kind: RevokeProblem;
  } | null>(null);
  const [, startTransition] = useTransition();
  // Focus management for the inline confirm step: closing it unmounts the
  // button that held focus, which otherwise drops a keyboard user back to
  // <body> and the top of the page. "Keep it" hands focus back to the row's
  // Revoke button; a successful revoke removes the row, so focus lands on
  // the list container instead.
  const revokeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const containerRef = useRef<HTMLDivElement>(null);

  function focusAfterConfirmClosed(inviteId: string) {
    const button = revokeButtonRefs.current.get(inviteId);
    if (button) button.focus();
    else containerRef.current?.focus();
  }

  async function copyToClipboard(url: string, inviteId: string) {
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
    setCopiedId(inviteId);
    window.setTimeout(() => setCopiedId(null), 1500);
  }

  // Confirmation is an inline step rather than window.confirm, and so is the
  // outcome: a browser dialog blocks the page, cannot be styled, and left the
  // instructor with an alert that repeated forever on an invite that had in
  // fact been redeemed.
  async function revoke(inviteId: string) {
    setDeletingId(inviteId);
    setProblem(null);
    try {
      const res = await fetch(
        `/api/admin/cohorts/${cohortId}/invites/${inviteId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const kind: RevokeProblem =
          res.status === 409
            ? "redeemed"
            : res.status === 404
              ? "gone"
              : "failed";
        // Only a transport failure is worth trying again, so the confirm step
        // closes for the other two rather than leaving a button that cannot
        // do anything.
        if (kind !== "failed") {
          setConfirmingId(null);
          focusAfterConfirmClosed(inviteId);
        }
        setProblem({ id: inviteId, kind });
        return;
      }
      setConfirmingId(null);
      // The row is about to disappear with the refresh, so the list container
      // is the surviving focus target.
      containerRef.current?.focus();
      startTransition(() => router.refresh());
    } catch {
      setProblem({ id: inviteId, kind: "failed" });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    // tabIndex={-1} makes the container programmatically focusable so focus
    // has somewhere to land when a revoked row (or the whole list) goes away.
    <div ref={containerRef} tabIndex={-1} className="focus:outline-none">
      {invites.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No active invites.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {invites.map((i) => {
            const url = `${baseUrl}/join/${cohortSlug}?t=${i.token}`;
            const isCopied = copiedId === i.id;
            const isDeleting = deletingId === i.id;
            const isConfirming = confirmingId === i.id;
            const failure = problem?.id === i.id ? problem.kind : null;
            return (
              <li
                key={i.id}
                className="animate-fade-in rounded-md border bg-muted/30 p-2.5"
                // Escape closes this row's confirm step the same way "Keep
                // it" does, handing focus back to the Revoke button. The
                // handler sits on the row, not the confirm box: opening the
                // step leaves focus on the Revoke button, which is outside
                // the box. Disabled while the revoke is in flight, when
                // "Keep it" is disabled too.
                onKeyDown={(e) => {
                  if (e.key === "Escape" && isConfirming && !isDeleting) {
                    e.stopPropagation();
                    setConfirmingId(null);
                    focusAfterConfirmClosed(i.id);
                  }
                }}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label="Invite URL"
                  />
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      type="button"
                      onClick={() => copyToClipboard(url, i.id)}
                      variant={isCopied ? "secondary" : "primary"}
                      size="sm"
                    >
                      {isCopied ? "✓ Copied" : "Copy"}
                    </Button>
                    <Button
                      type="button"
                      ref={(el) => {
                        if (el) revokeButtonRefs.current.set(i.id, el);
                        else revokeButtonRefs.current.delete(i.id);
                      }}
                      onClick={() => {
                        setProblem(null);
                        setConfirmingId(isConfirming ? null : i.id);
                      }}
                      disabled={isDeleting}
                      variant="danger"
                      size="sm"
                      aria-expanded={isConfirming}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>

                {isConfirming ? (
                  <div className="mt-2 rounded-md border border-flag/40 bg-flag/5 p-2.5">
                    <p className="text-xs text-flag">
                      Revoke this invite? Anyone holding the URL will no longer
                      be able to redeem it. Learners who already joined keep
                      their access.
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      <Button
                        type="button"
                        onClick={() => void revoke(i.id)}
                        loading={isDeleting}
                        disabled={isDeleting}
                        variant="danger"
                        size="sm"
                      >
                        Revoke invite
                      </Button>
                      <Button
                        type="button"
                        onClick={() => {
                          setConfirmingId(null);
                          focusAfterConfirmClosed(i.id);
                        }}
                        disabled={isDeleting}
                        variant="outline"
                        size="sm"
                      >
                        Keep it
                      </Button>
                    </div>
                  </div>
                ) : null}

                {failure ? (
                  <div
                    role="alert"
                    className="mt-2 flex flex-wrap items-center gap-2 text-xs text-flag"
                  >
                    <span>{REVOKE_MESSAGE[failure]}</span>
                    {failure === "failed" ? null : (
                      <Button
                        type="button"
                        onClick={() => {
                          setProblem(null);
                          setConfirmingId(null);
                          startTransition(() => router.refresh());
                        }}
                        variant="outline"
                        size="sm"
                      >
                        Refresh
                      </Button>
                    )}
                  </div>
                ) : null}

                <div className="mt-1.5 text-[10px] text-muted-foreground">
                  Expires {formatUtc(i.expiresAt)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
