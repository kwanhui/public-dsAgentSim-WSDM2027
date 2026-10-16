// CSV serialisation for the instructor exports.
//
// Quoting handles separators and embedded quotes. The leading-quote guard
// handles the other half: Excel, Numbers and Sheets treat a cell that starts
// with = + - @ (or a tab / carriage return before one) as a formula, so a
// learner artifact or an override note beginning with "=" would execute on
// open. Prefixing with an apostrophe makes the cell text; the apostrophe is
// not shown by the spreadsheet. Plain numbers, including negative scores and
// the ISO timestamps that start with a digit, are left alone.

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-\d+(\.\d+)?([eE][+-]?\d+)?$/;

export function csvEscape(v: string): string {
  const guarded = FORMULA_LEAD.test(v) && !PLAIN_NUMBER.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  const lines = [header.join(",")];
  for (const row of rows) lines.push(row.map((v) => csvEscape(String(v))).join(","));
  return lines.join("\n") + "\n";
}
