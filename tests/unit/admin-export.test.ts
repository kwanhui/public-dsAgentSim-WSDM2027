import { describe, expect, it } from "vitest";
import { csvEscape, toCsv } from "@/lib/admin/csv";

describe("csvEscape", () => {
  it("leaves ordinary cells alone", () => {
    expect(csvEscape("clarity_of_scope")).toBe("clarity_of_scope");
    expect(csvEscape("2026-08-25T11:24:03.000Z")).toBe("2026-08-25T11:24:03.000Z");
    expect(csvEscape("")).toBe("");
  });

  it("quotes separators, quotes and newlines", () => {
    expect(csvEscape("scope, then data")).toBe('"scope, then data"');
    expect(csvEscape('he said "no"')).toBe('"he said ""no"""');
    expect(csvEscape("line one\nline two")).toBe('"line one\nline two"');
  });

  it("defuses a cell a spreadsheet would run as a formula", () => {
    expect(csvEscape("=1+1")).toBe("'=1+1");
    expect(csvEscape("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvEscape("@import")).toBe("'@import");
    expect(csvEscape("-2+3+cmd|' /c calc'!A0")).toBe("'-2+3+cmd|' /c calc'!A0");
    expect(csvEscape("\tHYPERLINK")).toBe("'\tHYPERLINK");
    expect(csvEscape("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("keeps negative numbers as numbers", () => {
    expect(csvEscape("-1")).toBe("-1");
    expect(csvEscape("-0.75")).toBe("-0.75");
    expect(csvEscape("-1.5e3")).toBe("-1.5e3");
  });

  it("guards before quoting, so a formula holding a comma stays one cell", () => {
    expect(csvEscape('=HYPERLINK("http://x","click")')).toBe(
      `"'=HYPERLINK(""http://x"",""click"")"`,
    );
  });
});

describe("toCsv", () => {
  it("writes the header and one line per row, ending with a newline", () => {
    const csv = toCsv(
      ["criterion_id", "score", "override_note"],
      [
        ["clarity", 3, "=cmd"],
        ["fit", -1, ""],
      ],
    );
    expect(csv).toBe("criterion_id,score,override_note\nclarity,3,'=cmd\nfit,-1,\n");
  });
});
