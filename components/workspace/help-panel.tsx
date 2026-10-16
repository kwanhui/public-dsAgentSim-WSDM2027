"use client";

import { FileSpreadsheet, MessagesSquare, Send } from "lucide-react";
import { useState } from "react";
import { readLocalFlag, writeLocalFlag } from "./local-flag";
import { helpStorageLine, type LearnerJoinRoute } from "./learner-copy";

// Three steps, each at most twelve words.
const STEPS = [
  { Icon: MessagesSquare, text: "Ask the stakeholders in Channels, starting with the client sponsor." },
  { Icon: FileSpreadsheet, text: "Analyse the released Data files in your own tools." },
  { Icon: Send, text: "Submit at the Stage gate; a judge scores it against the rubric." },
];

// "How this works", as a collapsible panel under the brief. It starts open
// on a learner's first visit and collapsed on every visit after that; the
// learner can open or close it at any time.
export function HelpPanel({ pseudonym, joinRoute = "invite" }: { pseudonym: string; joinRoute?: LearnerJoinRoute }) {
  const key = `agenticpracticum:help-seen:${pseudonym}`;
  // Rendered only after the workspace bundle has loaded in the browser, so
  // storage can be read in the initial state.
  const [firstVisit] = useState(() => {
    if (typeof window === "undefined") return false;
    const seen = readLocalFlag(key);
    if (!seen) writeLocalFlag(key, true);
    return !seen;
  });
  return (
    <details open={firstVisit} className="mt-6 rounded-lg border p-4 text-sm">
      <summary className="cursor-pointer font-medium">How this works</summary>
      <ol className="mt-3 space-y-2 text-muted-foreground">
        {STEPS.map(({ Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span>{text}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-muted-foreground">{helpStorageLine(joinRoute)}</p>
    </details>
  );
}
