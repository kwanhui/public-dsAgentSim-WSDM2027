"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  simulatedNoticeKey,
  simulatedNoticeLines,
  type NoticeJoinRoute,
  type NoticePersona,
} from "@/lib/engagement/simulated-notice";
import { noticeStorageLine } from "@/app/privacy/provider-line";
import { readLocalFlag, writeLocalFlag } from "./local-flag";

// Shown on a learner's first entry to the workspace until they dismiss it.
// The dismissal is remembered per learner in this browser; after that the
// "simulated" label in each chat header carries the statement.
export function SimulatedNotice({
  pseudonym,
  personas,
  joinRoute,
  provider,
  demoContact,
}: {
  pseudonym: string;
  personas: NoticePersona[];
  joinRoute: NoticeJoinRoute;
  provider?: string;
  /** DEMO_CONTACT, for a sandbox seat; the line is left out when unset. */
  demoContact?: string | null;
}) {
  const key = simulatedNoticeKey(pseudonym);
  // The workspace renders this only after its bundle has loaded in the
  // browser, so storage can be read in the initial state without a server
  // render to mismatch.
  const [dismissed, setDismissed] = useState(() =>
    typeof window === "undefined" ? true : readLocalFlag(key),
  );

  if (dismissed) return null;
  // The second sentence comes from the same provider check as /privacy.
  const [who] = simulatedNoticeLines(personas, joinRoute);
  const where = noticeStorageLine(provider, joinRoute, demoContact);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6">
      <section
        role="note"
        aria-label="About the stakeholders"
        className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted/40 p-4 text-sm"
      >
        <p className="min-w-0 flex-1">
          {who} {where}{" "}
          <Link href="/privacy" className="text-primary underline underline-offset-4">
            Privacy
          </Link>
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            writeLocalFlag(key, true);
            setDismissed(true);
          }}
        >
          Dismiss
        </Button>
      </section>
    </div>
  );
}

// Beside every channel name: the stakeholders are simulated, and the label
// says so wherever a learner picks one.
export function SimulatedLabel() {
  return (
    <span className="whitespace-nowrap rounded border px-1 py-px align-middle text-[11px] font-normal text-muted-foreground">
      simulated
    </span>
  );
}
