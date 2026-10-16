"use client";

import { useState } from "react";
import { describeEvent } from "@/lib/admin/event-labels";
import { formatUtc } from "@/lib/admin/format";
import { foldStyleRetries } from "@/lib/admin/style-retry-fold";

export interface EventLogRow {
  id: number;
  type: string;
  timestampIso: string;
  detailJson: unknown;
}

// The engagement's event log as a table, newest last, with the stored JSON
// behind one toggle for the whole table. A reply's style rewrite is shown on
// the reply's own row, collapsed to a count, with the rules on expand.
export function EventLog({
  events,
  personaNames,
}: {
  events: EventLogRow[];
  personaNames: Record<string, string>;
}) {
  const [raw, setRaw] = useState(false);
  if (events.length === 0) return <p className="mt-3 text-sm text-muted-foreground">No events yet.</p>;
  return (
    <div className="mt-3">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} className="h-3.5 w-3.5" />
        Show stored JSON
      </label>
      <div className="mt-2 max-h-96 overflow-auto rounded-lg border">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-background text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="px-2 py-1.5 font-medium">Time (UTC)</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Event</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Stage</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Persona</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">Tokens</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {foldStyleRetries(events).map(({ event: e, style, folded }) => {
              const standalone = e.type === "persona_style_retry";
              const v = describeEvent(e.type, e.detailJson, (id) => personaNames[id] ?? id, {
                omitStyleFlag: style !== null,
              });
              const summary = standalone ? "" : v.summary;
              return (
                <tr key={e.id} className="border-b align-top last:border-0">
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">
                    {formatUtc(e.timestampIso, { seconds: true }).replace(" UTC", "")}
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1.5 ${v.problem ? "text-flag" : ""}`}>{v.label}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{v.stage ?? ""}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{v.persona ?? ""}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                    {v.tokens !== null ? v.tokens.toLocaleString("en-US") : ""}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground [overflow-wrap:anywhere]">
                    {summary}
                    {style ? (
                      <details className="inline [&[open]]:block">
                        <summary className="inline cursor-pointer list-none underline decoration-dotted underline-offset-2 [&::-webkit-details-marker]:hidden">
                          {summary ? " · " : ""}
                          {style.line}
                        </summary>
                        <span className="block">{style.detail}</span>
                      </details>
                    ) : null}
                    {raw && e.detailJson ? (
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{JSON.stringify(e.detailJson, null, 1)}</pre>
                    ) : null}
                    {raw && folded?.detailJson ? (
                      <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">
                        {`${folded.type}\n${JSON.stringify(folded.detailJson, null, 1)}`}
                      </pre>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
