// Verifies that the committed synthetic datasets carry the deliberate
// data-quality quirks the personas know about. If regeneration ever loses a
// quirk, the scenario's pedagogy silently breaks, and these tests make that
// failure visible.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function readCsv(path: string): Promise<Record<string, string>[]> {
  const raw = await readFile(resolve(process.cwd(), path), "utf8");
  const [headerLine, ...lines] = raw.trim().split("\n");
  const header = headerLine.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

describe("customer-churn extract", () => {
  it("carries the seeded quirks and a plausible churn rate", async () => {
    const rows = await readCsv("datasets/customer-churn/churn_extract.csv");

    const ids = rows.map((r) => r.subscriber_id);
    expect(new Set(ids).size).toBeLessThan(ids.length); // mid-month duplicates

    const newJoiners = rows.filter((r) => r.tenure_months === "0");
    expect(newJoiners.length).toBeGreaterThan(0);
    expect(newJoiners.every((r) => r.total_charges === "")).toBe(true);

    const missingUsage = rows.filter((r) => r.data_usage_gb === "").length / rows.length;
    expect(missingUsage).toBeGreaterThan(0.02);
    expect(missingUsage).toBeLessThan(0.07);

    const churnRate = rows.filter((r) => r.churn === "1").length / rows.length;
    expect(churnRate).toBeGreaterThan(0.015);
    expect(churnRate).toBeLessThan(0.08);
  });
});

describe("customer-segmentation extract", () => {
  it("carries staff test accounts, age sentinels, and refund-negative spend", async () => {
    const rows = await readCsv("datasets/customer-segmentation/loyalty_extract.csv");

    expect(rows.some((r) => r.member_id.startsWith("T"))).toBe(true);
    expect(rows.some((r) => r.age === "")).toBe(true);
    expect(rows.some((r) => r.age === "0" || r.age === "999")).toBe(true);
    expect(rows.some((r) => Number(r.monetary_90d) < 0)).toBe(true);

    // Category shares sum to <= 1 (tobacco/lottery exclusion).
    const sums = rows
      .slice(0, 500)
      .map(
        (r) =>
          Number(r.share_fresh) +
          Number(r.share_grocery) +
          Number(r.share_household) +
          Number(r.share_premium),
      );
    expect(Math.max(...sums)).toBeLessThanOrEqual(1.001);
    expect(Math.min(...sums)).toBeGreaterThan(0.85);
  });
});

describe("demand-forecasting extract", () => {
  it("carries closures, the migration double-posting, and the late outlet opening", async () => {
    const rows = await readCsv("datasets/demand-forecasting/daily_sales.csv");

    // CBD outlets have no Sunday rows (closed -> absent dates).
    const k01Sundays = rows.filter(
      (r) => r.outlet_id === "K01" && new Date(r.date + "T00:00:00Z").getUTCDay() === 0,
    );
    expect(k01Sundays).toHaveLength(0);

    // Tampines opened August 2025.
    const k06Dates = rows.filter((r) => r.outlet_id === "K06").map((r) => r.date);
    expect(Math.min(...k06Dates.map((d) => Date.parse(d)))).toBeGreaterThanOrEqual(
      Date.parse("2025-08-01"),
    );

    // Jurong toast during the migration window is roughly doubled versus
    // adjacent weeks.
    const jurongToast = (from: string, to: string) => {
      const w = rows.filter(
        (r) => r.outlet_id === "K05" && r.category === "toast" && r.date >= from && r.date <= to,
      );
      return w.reduce((s, r) => s + Number(r.units_sold), 0) / w.length;
    };
    const migration = jurongToast("2025-03-10", "2025-03-17");
    const before = jurongToast("2025-02-24", "2025-03-09");
    expect(migration).toBeGreaterThan(before * 1.6);

    // K03 renovation window is absent.
    const renovation = rows.filter(
      (r) => r.outlet_id === "K03" && r.date >= "2025-02-03" && r.date <= "2025-02-14",
    );
    expect(renovation).toHaveLength(0);
  });
});
