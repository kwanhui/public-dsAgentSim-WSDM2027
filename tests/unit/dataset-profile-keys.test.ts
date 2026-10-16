// Duplicate-key counting in the release profile. The
// churn extract has no exact duplicate rows but repeats 170 subscriber_id
// values, the seeded mid-month plan-change defect. The profile used to count
// only exact duplicates, so the ledger never mentioned the defect and the
// consistency auditor flagged the data owner's truthful disclosure of it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  duplicateKeyClause,
  keyColumnsFor,
  profileCsv,
  releaseWorldFact,
  renderProfile,
} from "@/lib/agents/dataset-profile";
import { loadScenario } from "@/lib/scenarios/load";

const churnCsv = readFileSync("datasets/customer-churn/churn_extract.csv", "utf8");

describe("keyColumnsFor", () => {
  it("prefers the scenario's declared key", () => {
    expect(keyColumnsFor(["date", "outlet_id", "category"], ["date", "outlet_id", "category"])).toEqual([
      "date",
      "outlet_id",
      "category",
    ]);
  });

  it("falls back to the first id column", () => {
    expect(keyColumnsFor(["subscriber_id", "plan_id"])).toEqual(["subscriber_id"]);
    expect(keyColumnsFor(["id", "name"])).toEqual(["id"]);
  });

  it("finds none in a file without one, or when a declared key is not in the header", () => {
    expect(keyColumnsFor(["a", "b"])).toBeNull();
    expect(keyColumnsFor(["a", "b"], ["missing"])).toBeNull();
  });
});

describe("the committed churn extract", () => {
  const profile = profileCsv("churn_extract.csv", churnCsv);

  it("repeats 170 subscriber ids over 340 rows with no exact duplicate row", () => {
    expect(profile.rows).toBe(8170);
    expect(profile.duplicateRows).toBe(0);
    expect(profile.duplicateKey).toEqual({ columns: ["subscriber_id"], values: 170, rows: 340 });
  });

  it("puts both counts into the release fact that goes into the ledger", () => {
    const fact = releaseWorldFact(profile);
    expect(fact).toContain(
      "170 subscriber_id values appear more than once (340 rows); 0 exact duplicate rows",
    );
  });

  it("shows the same counts in the analyst's view of the file", () => {
    expect(renderProfile(profile)).toContain(
      "8170 rows (170 subscriber_id values appear more than once (340 rows); 0 exact duplicate rows)",
    );
  });
});

describe("the other shipped datasets", () => {
  it("state a unique key rather than inventing duplicates", async () => {
    const seg = profileCsv(
      "loyalty_extract.csv",
      readFileSync("datasets/customer-segmentation/loyalty_extract.csv", "utf8"),
    );
    expect(releaseWorldFact(seg)).toContain("every member_id value is unique; 0 exact duplicate rows");

    // daily_sales.csv is keyed on (date, outlet_id, category), declared in
    // the scenario. Inferring outlet_id alone would call every row a duplicate.
    const scenario = await loadScenario("demand-forecasting");
    const dataset = scenario.datasets.find((d) => d.file === "daily_sales.csv");
    const sales = profileCsv(
      "daily_sales.csv",
      readFileSync("datasets/demand-forecasting/daily_sales.csv", "utf8"),
      { keyColumns: dataset?.keyColumns },
    );
    expect(sales.duplicateKey).toEqual({ columns: ["date", "outlet_id", "category"], values: 0, rows: 0 });
    expect(releaseWorldFact(sales)).toContain("every (date, outlet_id, category) combination is unique");
  });
});

describe("duplicateKeyClause", () => {
  it("uses the singular for one repeated value", () => {
    expect(duplicateKeyClause({ columns: ["id"], values: 1, rows: 2 })).toBe(
      "1 id value appears more than once (2 rows)",
    );
  });
});
