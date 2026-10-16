// Generates the committed synthetic datasets under datasets/<scenario-id>/.
// Deterministic given the per-dataset seed: rerunning produces byte-identical
// CSVs, so diffs in git mean the generator changed. Run with:
//   pnpm generate-datasets
//
// The churn extract deliberately ships the warehouse quirks that the
// data-owner persona knows about (see configs/scenarios/customer-churn.yaml):
// duplicate rows for mid-month plan changers, text-typed total_charges with
// blanks for new joiners, ~4% missing usage from the mediation outage, and
// involuntary disconnections labelled churn=1. The scenario now places the
// outage in May (it said March before ccb537a); the rows carry no month
// label, so the generated data is the same under either wording.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// mulberry32: small, seedable PRNG; good enough for synthetic teaching data.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: T[], weights: number[]): T {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

interface ChurnRow {
  subscriber_id: string;
  tenure_months: number;
  contract_type: string;
  months_to_contract_end: number;
  plan_monthly_fee: string;
  total_charges: string; // deliberately text; blank for new joiners
  data_usage_gb: string; // blank where the outage lost records
  voice_minutes: string;
  support_tickets_6m: number;
  network_complaints_6m: number;
  payment_method: string;
  late_payments_12m: number;
  autopay: number;
  churn: number;
}

function generateChurnExtract(seed: number, nSubscribers: number): ChurnRow[] {
  const rng = mulberry32(seed);
  const rows: ChurnRow[] = [];

  for (let i = 0; i < nSubscribers; i++) {
    const subscriberId = `S${(100000 + i).toString(36).toUpperCase().padStart(6, "0")}`;
    const contractType = pick(rng, ["month-to-month", "12-month", "24-month"], [0.42, 0.33, 0.25]);
    const tenure = Math.floor(rng() * rng() * 72); // skewed toward low tenure
    const contractLen = contractType === "12-month" ? 12 : contractType === "24-month" ? 24 : 0;
    const monthsToEnd = contractLen === 0 ? 0 : Math.floor(rng() * contractLen);
    const fee = 20 + Math.round(rng() * 110);
    const usage = Math.round((2 + rng() * 58) * 10) / 10;
    const voice = Math.round(rng() * 600);
    const tickets = Math.floor(rng() * rng() * 7);
    const complaints = Math.min(tickets, Math.floor(rng() * rng() * 4));
    const payment = pick(rng, ["giro", "credit-card", "manual"], [0.35, 0.45, 0.2]);
    const latePayments = payment === "manual" ? Math.floor(rng() * rng() * 8) : Math.floor(rng() * rng() * 3);
    const autopay = payment === "manual" ? 0 : rng() < 0.8 ? 1 : 0;

    // Voluntary churn propensity: contract pressure, complaints, price, low tenure.
    // Intercept tuned so the labelled rate lands near 4-5%: ~2% voluntary
    // (matching the brief's 2.1% monthly churn) plus involuntary pollution.
    let logit = -4.9;
    if (contractType === "month-to-month") logit += 1.1;
    if (contractLen > 0 && monthsToEnd <= 1) logit += 1.4;
    logit += complaints * 0.45;
    logit += (fee - 60) / 90;
    logit += tenure < 6 ? 0.5 : tenure > 36 ? -0.6 : 0;
    logit += autopay ? -0.3 : 0.2;
    const pVoluntary = 1 / (1 + Math.exp(-logit));

    // Involuntary disconnection (non-payment), also labelled churn=1: the
    // label pollution learners should catch.
    const pInvoluntary = Math.min(0.5, latePayments * 0.012);

    const churn = rng() < pVoluntary || rng() < pInvoluntary ? 1 : 0;

    const isNewJoiner = tenure === 0;
    const totalCharges = isNewJoiner ? "" : (fee * tenure * (0.9 + rng() * 0.2)).toFixed(2);
    const outageLostUsage = rng() < 0.04;

    rows.push({
      subscriber_id: subscriberId,
      tenure_months: tenure,
      contract_type: contractType,
      months_to_contract_end: monthsToEnd,
      plan_monthly_fee: fee.toFixed(2),
      total_charges: totalCharges,
      data_usage_gb: outageLostUsage ? "" : usage.toFixed(1),
      voice_minutes: outageLostUsage ? "" : voice.toString(),
      support_tickets_6m: tickets,
      network_complaints_6m: complaints,
      payment_method: payment,
      late_payments_12m: latePayments,
      autopay,
      churn,
    });

    // ~2.5% of subscribers changed plans mid-month: duplicate row with the
    // new fee, same id and label.
    if (rng() < 0.025) {
      rows.push({
        ...rows[rows.length - 1],
        plan_monthly_fee: (fee + (rng() < 0.5 ? -10 : 15)).toFixed(2),
      });
    }
  }
  return rows;
}

function writeCsv(path: string, header: string[], rows: Record<string, string | number>[]) {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((h) => csvEscape(String(row[h]))).join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// customer-segmentation: loyalty_extract.csv
// Members are drawn from five latent behavioural archetypes plus noise, so a
// sensible clustering can recover interpretable groups. Seeded quirks match
// the data-owner persona's knowledge: blank/sentinel ages, refund-negative
// spend, staff test accounts, category shares summing to slightly under 1.
// ---------------------------------------------------------------------------

interface LoyaltyRow {
  member_id: string;
  age: string;
  tenure_months: number;
  recency_days: number;
  frequency_90d: number;
  monetary_90d: string;
  basket_avg_sgd: string;
  share_fresh: string;
  share_grocery: string;
  share_household: string;
  share_premium: string;
  online_share: string;
  promo_share: string;
}

function generateLoyaltyExtract(seed: number, nMembers: number): LoyaltyRow[] {
  const rng = mulberry32(seed);
  const rows: LoyaltyRow[] = [];

  // archetype: [age mean, freq mean, basket mean, fresh, grocery, household, premium, online, promo]
  const archetypes: [number, number, number, number, number, number, number, number, number][] = [
    [29, 6, 28, 0.15, 0.45, 0.15, 0.1, 0.55, 0.35], // young online convenience
    [41, 14, 62, 0.4, 0.35, 0.15, 0.05, 0.1, 0.3], // weekly family shoppers, fresh-heavy
    [37, 8, 85, 0.3, 0.25, 0.1, 0.3, 0.25, 0.1], // premium professionals
    [63, 10, 34, 0.3, 0.4, 0.15, 0.02, 0.02, 0.55], // value-driven seniors, promo-heavy
    [45, 2, 40, 0.25, 0.45, 0.2, 0.05, 0.08, 0.25], // lapsing infrequent
  ];
  const weights = [0.22, 0.28, 0.14, 0.2, 0.16];

  for (let i = 0; i < nMembers; i++) {
    const isTest = rng() < 0.004;
    const a = archetypes[pick(rng, [0, 1, 2, 3, 4], weights)];
    const jitter = (m: number, s: number) => Math.max(0, m + (rng() * 2 - 1) * s);

    const trueAge = Math.round(jitter(a[0], 9));
    const ageBlank = rng() < 0.12;
    const ageSentinel = !ageBlank && rng() < 0.02;
    const age = ageBlank ? "" : ageSentinel ? (rng() < 0.5 ? "0" : "999") : String(trueAge);

    const frequency = isTest ? 180 + Math.floor(rng() * 200) : Math.round(jitter(a[1], a[1] * 0.5));
    const basket = jitter(a[2], a[2] * 0.35);
    const refundHeavy = rng() < 0.007;
    const monetary = isTest
      ? frequency * 1.5
      : refundHeavy
        ? -jitter(40, 35)
        : frequency * basket * (0.85 + rng() * 0.3);
    // Archetype 5 is lapsing: recency skews high.
    const recency = a === archetypes[4] ? 120 + Math.floor(rng() * 245) : Math.floor(rng() * rng() * 200);

    // Category shares: archetype proportions + noise, then scaled to sum to
    // 1 minus a small excluded-category share (tobacco/lottery exclusion).
    const rawShares = [a[3], a[4], a[5], a[6]].map((s) => Math.max(0.01, s + (rng() * 2 - 1) * 0.08));
    const excluded = rng() * 0.06;
    const sum = rawShares.reduce((s, v) => s + v, 0);
    const shares = rawShares.map((s) => (s / sum) * (1 - excluded));

    rows.push({
      member_id: (isTest ? "T" : "M") + (200000 + i).toString(36).toUpperCase().padStart(6, "0"),
      age,
      tenure_months: Math.floor(rng() * rng() * 120),
      recency_days: Math.min(365, recency),
      frequency_90d: frequency,
      monetary_90d: monetary.toFixed(2),
      basket_avg_sgd: basket.toFixed(2),
      share_fresh: shares[0].toFixed(3),
      share_grocery: shares[1].toFixed(3),
      share_household: shares[2].toFixed(3),
      share_premium: shares[3].toFixed(3),
      online_share: Math.min(1, Math.max(0, a[7] + (rng() * 2 - 1) * 0.15)).toFixed(3),
      promo_share: Math.min(1, Math.max(0, a[8] + (rng() * 2 - 1) * 0.15)).toFixed(3),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// demand-forecasting: daily_sales.csv
// Six outlets x three categories x ~22 months of daily rows with weekly and
// holiday seasonality. Seeded scars match the data-owner persona: the March
// 2025 POS migration (Jurong double-posting, small category level shift),
// absent rows for closures, unreliable promo_flag before June 2025, the
// Tampines outlet opening in August 2025, and sell-out censoring of units.
// ---------------------------------------------------------------------------

// Singapore public holidays falling inside the extract window.
const SG_PUBLIC_HOLIDAYS = new Set([
  "2024-10-31", "2024-12-25",
  "2025-01-01", "2025-01-29", "2025-01-30", "2025-03-31", "2025-04-18",
  "2025-05-01", "2025-05-12", "2025-06-07", "2025-08-09", "2025-10-20",
  "2025-12-25",
  "2026-01-01", "2026-02-17", "2026-02-18", "2026-03-21", "2026-04-03",
  "2026-05-01", "2026-05-27", "2026-06-01",
]);

interface SalesRow {
  date: string;
  outlet_id: string;
  category: string;
  units_sold: number;
  sales_sgd: string;
  promo_flag: number;
}

function generateDailySales(seed: number): SalesRow[] {
  const rng = mulberry32(seed);
  const rows: SalesRow[] = [];

  const outlets = [
    { id: "K01", kind: "cbd", scale: 1.15, open: "2024-09-01" },
    { id: "K02", kind: "cbd", scale: 0.95, open: "2024-09-01" },
    { id: "K03", kind: "heartland", scale: 1.0, open: "2024-09-01" },
    { id: "K04", kind: "heartland", scale: 1.2, open: "2024-09-01" },
    { id: "K05", kind: "heartland", scale: 1.35, open: "2024-09-01" },
    { id: "K06", kind: "heartland", scale: 0.85, open: "2025-08-01" },
  ] as const;
  const categories = [
    { name: "toast", base: 190, price: 4.8 },
    { name: "drinks", base: 320, price: 2.4 },
    { name: "eggs", base: 150, price: 2.2 },
  ] as const;

  const start = new Date("2024-09-01T00:00:00Z");
  const end = new Date("2026-06-30T00:00:00Z");
  const migrationStart = "2025-03-10";
  const migrationEnd = "2025-03-17";

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay(); // 0 Sunday
    const holiday = SG_PUBLIC_HOLIDAYS.has(date);

    for (const outlet of outlets) {
      if (date < outlet.open) continue;
      // Closures produce absent rows: CBD outlets close Sundays and public
      // holidays; K03 closed for renovation 2025-02-03..2025-02-14.
      if (outlet.kind === "cbd" && (dow === 0 || holiday)) continue;
      if (outlet.id === "K03" && date >= "2025-02-03" && date <= "2025-02-14") continue;

      // Day factor: CBD lives on weekday office crowds; heartland spikes on
      // weekends and holidays.
      const weekend = dow === 0 || dow === 6;
      let dayFactor: number;
      if (outlet.kind === "cbd") {
        dayFactor = dow === 6 ? 0.45 : 1.0 + (dow === 1 || dow === 5 ? 0.05 : 0.12);
      } else {
        dayFactor = weekend ? 1.35 : holiday ? 1.45 : 1.0;
      }

      for (const cat of categories) {
        // Gentle chain-wide growth plus noise.
        const monthsIn = (d.getTime() - start.getTime()) / (30.44 * 24 * 3600 * 1000);
        const trend = 1 + 0.004 * monthsIn;
        // Real promos cluster on Thursdays-Saturdays, ~12% of days.
        const promoActive = rng() < (dow >= 4 && dow <= 6 ? 0.2 : 0.06);
        const promoLift = promoActive ? 1.25 : 1;

        let demand =
          cat.base * outlet.scale * dayFactor * trend * promoLift * (0.85 + rng() * 0.3);

        // Post-migration category level shift from remapped categories.
        if (date >= migrationStart) {
          demand *= cat.name === "toast" ? 1.06 : cat.name === "drinks" ? 0.97 : 1.0;
        }

        // Sell-out censoring: units are capped by production capacity.
        // Jurong (K05) toast is chronically under-produced.
        const capacityFactor = outlet.id === "K05" && cat.name === "toast" ? 1.02 : 1.25;
        const capacity = Math.round(cat.base * outlet.scale * capacityFactor);
        let units = Math.min(Math.round(demand), capacity);

        // Migration cutover double-posting at Jurong.
        if (outlet.id === "K05" && date >= migrationStart && date <= migrationEnd) {
          units *= 2;
        }

        // promo_flag was manually backfilled before June 2025: drop ~40% of
        // true flags and add occasional spurious ones.
        let promoFlag = promoActive ? 1 : 0;
        if (date < "2025-06-01") {
          if (promoFlag === 1 && rng() < 0.4) promoFlag = 0;
          else if (promoFlag === 0 && rng() < 0.03) promoFlag = 1;
        }

        rows.push({
          date,
          outlet_id: outlet.id,
          category: cat.name,
          units_sold: units,
          sales_sgd: (units * cat.price * (0.97 + rng() * 0.06)).toFixed(2),
          promo_flag: promoFlag,
        });
      }
    }
  }
  return rows;
}

function main() {
  const outDir = resolve(process.cwd(), "datasets/customer-churn");
  mkdirSync(outDir, { recursive: true });
  const rows = generateChurnExtract(20260707, 8000);
  writeCsv(resolve(outDir, "churn_extract.csv"), [
    "subscriber_id",
    "tenure_months",
    "contract_type",
    "months_to_contract_end",
    "plan_monthly_fee",
    "total_charges",
    "data_usage_gb",
    "voice_minutes",
    "support_tickets_6m",
    "network_complaints_6m",
    "payment_method",
    "late_payments_12m",
    "autopay",
    "churn",
  ], rows as unknown as Record<string, string | number>[]);
  const churnRate = rows.reduce((s, r) => s + r.churn, 0) / rows.length;
  console.log(`customer-churn: ${rows.length} rows (${(churnRate * 100).toFixed(1)}% churn) -> ${outDir}/churn_extract.csv`);

  const segDir = resolve(process.cwd(), "datasets/customer-segmentation");
  mkdirSync(segDir, { recursive: true });
  const members = generateLoyaltyExtract(20260708, 6000);
  writeCsv(resolve(segDir, "loyalty_extract.csv"), [
    "member_id",
    "age",
    "tenure_months",
    "recency_days",
    "frequency_90d",
    "monetary_90d",
    "basket_avg_sgd",
    "share_fresh",
    "share_grocery",
    "share_household",
    "share_premium",
    "online_share",
    "promo_share",
  ], members as unknown as Record<string, string | number>[]);
  console.log(`customer-segmentation: ${members.length} rows -> ${segDir}/loyalty_extract.csv`);

  const fcDir = resolve(process.cwd(), "datasets/demand-forecasting");
  mkdirSync(fcDir, { recursive: true });
  const sales = generateDailySales(20260709);
  writeCsv(resolve(fcDir, "daily_sales.csv"), [
    "date",
    "outlet_id",
    "category",
    "units_sold",
    "sales_sgd",
    "promo_flag",
  ], sales as unknown as Record<string, string | number>[]);
  console.log(`demand-forecasting: ${sales.length} rows -> ${fcDir}/daily_sales.csv`);
}

main();
