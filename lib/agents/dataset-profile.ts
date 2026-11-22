// Deterministic profile of a released dataset file: the analyst agent's
// stand-in for the "outside analysis" a human learner does in their own
// tools. The agent may only cite numbers that appear here, which keeps its
// artifacts honest: grounded in the actual data, never invented.
//
// One text serves every reader. releaseWorldFact writes the profile into the
// ledger at release, where the personas, the auditor and the rubric judge
// read it, and the analyst agent's prompt carries the same text, so the
// judge can check every figure the agent was given.

import { readReleasedDataset } from "@/lib/agents/data-environment";
import type { Engagement } from "@/lib/engagement/state";
import type { Scenario } from "@/lib/scenarios/types";

export interface ColumnProfile {
  name: string;
  kind: "numeric" | "categorical";
  missing: number;
  // Numeric columns.
  min?: number;
  max?: number;
  mean?: number;
  // Categorical columns: up to three most frequent values.
  topValues?: { value: string; count: number }[];
  // Columns of ISO dates (YYYY-MM-DD): the coverage window. This is what the
  // engagement's in-world clock is derived from (lib/engagement/world-clock).
  dateMin?: string;
  dateMax?: string;
}

export interface DatasetProfile {
  file: string;
  rows: number;
  // Rows identical to an earlier row in every column.
  duplicateRows: number;
  // The record key the file is meant to be unique on, when one is known or
  // can be inferred (see keyColumnsFor), and how often it repeats. A file can
  // have no exact duplicate rows and still repeat its key, which is the
  // churn extract's seeded defect: subscribers who changed plan mid-month
  // appear twice with different plan columns.
  duplicateKey: DuplicateKeyProfile | null;
  columns: ColumnProfile[];
}

export interface DuplicateKeyProfile {
  columns: string[];
  // Distinct key values that occur on more than one row.
  values: number;
  // Rows carrying one of those values (every occurrence, first included).
  rows: number;
}

/**
 * The columns a file's rows are keyed on: the dataset's declared keyColumns
 * when the scenario gives them (and they exist in the header), otherwise the
 * first column named "id" or ending in "_id". Null when neither applies.
 */
export function keyColumnsFor(header: string[], declared?: string[] | null): string[] | null {
  if (declared && declared.length > 0) {
    return declared.every((c) => header.includes(c)) ? declared : null;
  }
  const inferred = header.find((h) => {
    const name = h.trim().toLowerCase();
    return name === "id" || name.endsWith("_id");
  });
  return inferred ? [inferred] : null;
}

// Minimal CSV line parser (quoted fields with commas supported; no embedded
// newlines; matches the committed synthetic datasets).
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function profileCsv(
  file: string,
  csv: string,
  options: { keyColumns?: string[] | null } = {},
): DatasetProfile {
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines.length > 0 ? parseCsvLine(lines[0]) : [];
  const rows = lines.slice(1);

  const keyColumns = keyColumnsFor(header, options.keyColumns);
  let duplicateKey: DuplicateKeyProfile | null = null;
  if (keyColumns) {
    const indexes = keyColumns.map((c) => header.indexOf(c));
    const counts = new Map<string, number>();
    for (const r of rows) {
      const cells = parseCsvLine(r);
      const key = JSON.stringify(indexes.map((i) => (cells[i] ?? "").trim()));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let values = 0;
    let keyRows = 0;
    for (const n of counts.values()) {
      if (n > 1) {
        values++;
        keyRows += n;
      }
    }
    duplicateKey = { columns: keyColumns, values, rows: keyRows };
  }

  const seen = new Set<string>();
  let duplicateRows = 0;
  for (const r of rows) {
    if (seen.has(r)) duplicateRows++;
    else seen.add(r);
  }

  const columns: ColumnProfile[] = header.map((name, col) => {
    let missing = 0;
    const numbers: number[] = [];
    const counts = new Map<string, number>();
    let numericLooking = 0;
    let dateLooking = 0;
    let nonEmpty = 0;
    let dateMin: string | undefined;
    let dateMax: string | undefined;

    for (const r of rows) {
      const cells = parseCsvLine(r);
      const raw = (cells[col] ?? "").trim();
      if (raw === "" || raw.toLowerCase() === "na" || raw.toLowerCase() === "null") {
        missing++;
        continue;
      }
      nonEmpty++;
      const n = Number(raw);
      if (Number.isFinite(n)) {
        numericLooking++;
        numbers.push(n);
      }
      // ISO dates compare correctly as strings, so min/max need no parsing.
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        dateLooking++;
        if (dateMin === undefined || raw < dateMin) dateMin = raw;
        if (dateMax === undefined || raw > dateMax) dateMax = raw;
      }
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }

    const isNumeric = nonEmpty > 0 && numericLooking / nonEmpty > 0.9;
    if (isNumeric) {
      const mean = numbers.length > 0 ? numbers.reduce((s, n) => s + n, 0) / numbers.length : 0;
      return {
        name,
        kind: "numeric" as const,
        missing,
        min: numbers.length > 0 ? Math.min(...numbers) : undefined,
        max: numbers.length > 0 ? Math.max(...numbers) : undefined,
        mean: Math.round(mean * 100) / 100,
      };
    }
    const isDate = nonEmpty > 0 && dateLooking / nonEmpty > 0.9;
    const topValues = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([value, count]) => ({ value, count }));
    return {
      name,
      kind: "categorical" as const,
      missing,
      topValues,
      ...(isDate ? { dateMin, dateMax } : {}),
    };
  });

  return { file, rows: rows.length, duplicateRows, duplicateKey, columns };
}

export async function profileReleasedDatasets(
  engagement: Engagement,
  scenario: Scenario,
  releasedFiles: string[],
): Promise<DatasetProfile[]> {
  const profiles: DatasetProfile[] = [];
  for (const file of releasedFiles) {
    const buf = await readReleasedDataset(engagement, scenario, file);
    const keyColumns = scenario.datasets.find((d) => d.file === file)?.keyColumns;
    if (buf) profiles.push(profileCsv(file, buf.toString("utf8"), { keyColumns }));
  }
  return profiles;
}

// Short ledger entry recording a released file's actual shape. The
// world-fact ledger reaches every persona (shared engagement record) and the
// stage-gate judge (engagement record), so the data owner cannot dispute her
// own extract's row count and a judge cannot dock a claim the learner read
// straight off the file. The dataset's dictionary notes ride along for the
// same reason: once the dictionary says the "drinks" category covers coffee,
// a judge must not penalise the learner for saying drinks.
export function releaseWorldFact(
  p: DatasetProfile,
  dataset?: { description?: string; notes?: string },
): string {
  const notable: string[] = [];
  // With a key column, both duplicate counts are stated even when zero: a
  // file with no exact duplicate rows can still repeat its key, and a reader
  // of the ledger (a persona, the judge, the auditor) must not take "no
  // duplicates" from the absence of a clause.
  if (p.duplicateKey) {
    notable.push(duplicateKeyClause(p.duplicateKey));
    notable.push(exactDuplicateClause(p.duplicateRows));
  } else if (p.duplicateRows > 0) {
    notable.push(exactDuplicateClause(p.duplicateRows));
  }
  const withMissing = p.columns.filter((c) => c.missing > 0);
  if (withMissing.length > 0) {
    notable.push(
      `missing values in ${withMissing.map((c) => `${c.name} (${c.missing})`).join(", ")}`,
    );
  }
  const what = dataset?.description ? `${p.file} (${dataset.description})` : p.file;
  const cols = p.columns.map((c) => c.name).join(", ");
  const shape = `The released file ${what} has ${p.rows} data rows with columns: ${cols}${
    notable.length > 0 ? `; ${notable.join("; ")}` : ""
  }.`;
  const summaries = p.columns.map(columnSummary).filter((c): c is string => c !== null);
  const profile = summaries.length > 0 ? `${shape} Column profile: ${summaries.join("; ")}.` : shape;
  const notes = dataset?.notes?.trim();
  return notes ? `${profile} Per the data dictionary: ${notes}` : profile;
}

// One column's summary for the shared profile: range and mean of a number,
// the span of a date column, or the most frequent values of a text column.
// A text column whose top values each occur once (an id) gets no summary.
function columnSummary(c: ColumnProfile): string | null {
  if (c.kind === "numeric") return `${c.name} numeric, min ${c.min}, max ${c.max}, mean ${c.mean}`;
  if (c.dateMin && c.dateMax) return `${c.name} dates from ${c.dateMin} to ${c.dateMax}`;
  const tops = c.topValues ?? [];
  if (tops.length === 0 || tops.every((t) => t.count === 1)) return null;
  return `${c.name} most frequent ${tops.map((t) => `${t.value} (${t.count})`).join(", ")}`;
}

/** The profiles of the released files as the analyst agent reads them: the
 * same text the ledger holds for the judge and the personas. */
export function renderReleasedProfiles(
  profiles: DatasetProfile[],
  datasets: readonly { file: string; description?: string; notes?: string }[],
): string {
  return profiles.map((p) => `- ${releaseWorldFact(p, datasets.find((d) => d.file === p.file))}`).join("\n");
}

function exactDuplicateClause(n: number): string {
  return `${n} exact duplicate row${n === 1 ? "" : "s"}`;
}

export function duplicateKeyClause(k: DuplicateKeyProfile): string {
  const single = k.columns.length === 1;
  const label = single ? k.columns[0] : `(${k.columns.join(", ")})`;
  if (k.values === 0) {
    return single ? `every ${label} value is unique` : `every ${label} combination is unique`;
  }
  const noun = single ? (k.values === 1 ? "value" : "values") : k.values === 1 ? "combination" : "combinations";
  const verb = k.values === 1 ? "appears" : "appear";
  return `${k.values} ${label} ${noun} ${verb} more than once (${k.rows} rows)`;
}

/** A compact per-column listing of one profile. Kept for tools that list a
 * file's columns; the prompts use releaseWorldFact. */
export function renderProfile(p: DatasetProfile): string {
  const cols = p.columns
    .map((c) => {
      const missingNote = c.missing > 0 ? `, ${c.missing} missing` : "";
      if (c.kind === "numeric") {
        return `  - ${c.name}: numeric (min ${c.min}, max ${c.max}, mean ${c.mean}${missingNote})`;
      }
      const tops = (c.topValues ?? []).map((t) => `${t.value}×${t.count}`).join(", ");
      return `  - ${c.name}: categorical (top: ${tops}${missingNote})`;
    })
    .join("\n");
  const dupParts = [
    ...(p.duplicateKey ? [duplicateKeyClause(p.duplicateKey)] : []),
    ...(p.duplicateRows > 0 || p.duplicateKey ? [exactDuplicateClause(p.duplicateRows)] : []),
  ];
  const dupNote = dupParts.length > 0 ? ` (${dupParts.join("; ")})` : "";
  return `- ${p.file}: ${p.rows} rows${dupNote}\n${cols}`;
}
