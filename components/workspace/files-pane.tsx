"use client";

import { Disclosure } from "@/components/ui/disclosure";
import type { BundleFile, BundlePendingFile } from "./types";

// Everything the data owner has handed over: the file itself and the data
// dictionary that came with it, which otherwise only existed as a chat
// message the learner had to scroll back for. Before a release, the pane
// lists the file's column names, marked not yet released, so the learner
// can name the fields they need in a data request.
export function FilesPane({
  files,
  pending = [],
  dataOwnerUnlocked,
  dataOwnerStageTitle,
}: {
  files: BundleFile[];
  pending?: BundlePendingFile[];
  dataOwnerUnlocked: boolean;
  dataOwnerStageTitle: string | null;
}) {
  return (
    <section className="max-w-2xl">
      <h2 className="text-lg font-semibold">Data files</h2>
      {pending.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {pending.map((f) => (
            <li key={f.file} className="rounded-lg border border-dashed p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-medium">{f.file}</span>
                <span className="text-xs text-muted-foreground">Not yet released</span>
              </div>
              {f.description ? <p className="mt-2 text-sm text-muted-foreground">{f.description}</p> : null}
              <p className="mt-3 text-sm">
                Columns in the data dictionary. Name the ones you need, and say what you need them for, when you ask
                the data owner for the extract. The full dictionary comes with the file.
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Columns of ${f.file}`}>
                {f.columns.map((c) => (
                  <li key={c} className="rounded border px-1.5 py-0.5 font-mono text-xs">
                    {c}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length === 0 ? (
        pending.length > 0 ? null : (
        <p className="mt-3 text-sm text-muted-foreground">
          {emptyHint(dataOwnerUnlocked, dataOwnerStageTitle)}
        </p>
        )
      ) : (
        <ul className="mt-4 space-y-3">
          {files.map((f) => (
            <li key={f.file} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-medium">{f.file}</span>
                <a
                  href={`/api/datasets/${encodeURIComponent(f.file)}`}
                  className="text-sm text-primary underline-offset-4 hover:underline"
                  download
                >
                  Download
                </a>
              </div>
              {f.description ? (
                <p className="mt-2 text-sm text-muted-foreground">{f.description}</p>
              ) : null}
              {f.dictionary ? (
                <Disclosure className="mt-3" title="Data dictionary">
                  {/* The dictionary is column-per-line with hanging indents;
                      keep the source line breaks rather than reflowing. */}
                  <pre className="overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-relaxed">
                    {f.dictionary.trim()}
                  </pre>
                </Disclosure>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function emptyHint(dataOwnerUnlocked: boolean, dataOwnerStageTitle: string | null): string {
  if (!dataOwnerUnlocked) {
    return dataOwnerStageTitle
      ? `No files yet. The data owner's channel opens at ${dataOwnerStageTitle}; until then, agree with the client sponsor what you need.`
      : "No files yet. The data owner's channel opens later in the engagement.";
  }
  return "No files yet. Ask the data owner for what you need, and say what you need it for.";
}
