// Files the data owner has not released yet, shown in the learner's Data
// files pane from the stage at which they become available, so a learner
// can name the fields they need in a data request. Only the file name, its
// one-line description and the column names are shown: the dictionary's
// column descriptions, which carry the data-quality caveats, travel with the
// file once it is released. Pure.

import type { StageId } from "@/lib/scenarios/types";

export interface PendingFile {
  file: string;
  description: string;
  columns: string[];
}

/** Column names from a data dictionary with one "name: description" entry
 * per column (continuation lines are indented). */
export function dictionaryColumns(dictionary: string): string[] {
  const out: string[] = [];
  for (const line of dictionary.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function pendingFiles(
  datasets: readonly { file: string; description: string; dictionary: string; releasedAtStage: string }[],
  released: readonly string[],
  stageIds: readonly string[],
  currentStage: StageId | string,
  completed: boolean,
): PendingFile[] {
  const at = completed ? stageIds.length : stageIds.indexOf(currentStage);
  return datasets
    .filter((d) => !released.includes(d.file))
    .filter((d) => {
      const from = stageIds.indexOf(d.releasedAtStage);
      return from >= 0 && at >= from;
    })
    .map((d) => ({ file: d.file, description: d.description, columns: dictionaryColumns(d.dictionary) }));
}
