import { describe, expect, it } from "vitest";
import { failedAttemptSpans, failuresIn, overlapMs } from "@/lib/admin/wall-clock";

// Two failed analyst attempts at stage 6 used to count as eleven minutes of
// agent time on the compare view.
const ev = (type: string, iso: string) => ({ type, timestampIso: iso });

describe("failed analyst attempts", () => {
  const events = [
    ev("analyst_stage_started", "2026-09-29T17:19:30Z"),
    ev("analyst_step_failed", "2026-09-29T17:19:55Z"),
    ev("analyst_stage_started", "2026-09-29T17:22:00Z"),
    ev("analyst_stage_failed", "2026-09-29T17:22:25Z"),
    ev("analyst_stage_started", "2026-09-29T17:28:00Z"),
    ev("analyst_step", "2026-09-29T17:28:30Z"),
    ev("analyst_stage_finished", "2026-09-29T17:29:00Z"),
  ];
  const t = (iso: string) => new Date(iso).getTime();

  it("spans each failed run from its start to the next run's start", () => {
    expect(failedAttemptSpans(events)).toEqual([
      { start: t("2026-09-29T17:19:30Z"), end: t("2026-09-29T17:22:00Z") },
      { start: t("2026-09-29T17:22:00Z"), end: t("2026-09-29T17:28:00Z") },
    ]);
  });

  it("cuts the spans out of a stage window and counts the failures in it", () => {
    const start = t("2026-09-29T17:18:00Z");
    const end = t("2026-09-29T17:29:00Z");
    const spans = failedAttemptSpans(events);
    expect(end - start - overlapMs(spans, start, end)).toBe(t("2026-09-29T17:29:00Z") - t("2026-09-29T17:28:00Z") + (t("2026-09-29T17:19:30Z") - start));
    expect(failuresIn(events, start, end)).toBe(2);
    expect(failuresIn(events, end, null)).toBe(0);
  });

  it("uses the failure time when no start or restart was logged", () => {
    const only = [ev("analyst_step_failed", "2026-09-29T10:00:00Z")];
    expect(failedAttemptSpans(only)).toEqual([{ start: t("2026-09-29T10:00:00Z"), end: t("2026-09-29T10:00:00Z") }]);
  });

  it("is empty for a human run", () => {
    expect(failedAttemptSpans([ev("persona_turn", "2026-09-29T10:00:00Z")])).toEqual([]);
  });
});

describe("analyst brackets and active time", () => {
  const e = (type: string, iso: string, stage?: string) => ({
    type,
    timestampIso: iso,
    detailJson: stage ? { stage } : {},
  });
  // A1 in the committed showcase: formulation started, the driver stopped the
  // server about 9 s in, and the stage was resumed 30 minutes later; testing
  // failed once and was retried.
  const a1 = [
    e("analyst_stage_started", "2026-09-29T22:43:58.977Z", "formulation"),
    e("analyst_stage_started", "2026-09-29T23:13:43.036Z", "formulation"),
    e("analyst_stage_finished", "2026-09-29T23:14:25.228Z", "formulation"),
    e("analyst_stage_started", "2026-09-29T23:14:31.073Z", "data-collection"),
    e("analyst_stage_finished", "2026-09-29T23:15:32.131Z", "data-collection"),
    e("analyst_stage_started", "2026-09-29T23:15:39.140Z", "cleaning"),
    e("analyst_stage_finished", "2026-09-29T23:16:13.699Z", "cleaning"),
    e("analyst_stage_started", "2026-09-29T23:16:17.090Z", "modelling"),
    e("analyst_stage_finished", "2026-09-29T23:16:51.365Z", "modelling"),
    e("analyst_stage_started", "2026-09-29T23:16:55.995Z", "testing"),
    e("analyst_step_failed", "2026-09-29T23:17:11.178Z", "testing"),
    e("analyst_stage_finished", "2026-09-29T23:17:11.180Z", "testing"),
    e("analyst_stage_started", "2026-09-29T23:17:18.916Z", "testing"),
    e("analyst_stage_finished", "2026-09-29T23:18:18.893Z", "testing"),
    e("analyst_stage_started", "2026-09-29T23:18:21.926Z", "deployment"),
    e("analyst_stage_finished", "2026-09-29T23:19:06.465Z", "deployment"),
  ];

  it("sums successful attempts only: A1 is 276.6 s, about 4.6 minutes", async () => {
    const { analystBrackets, activeTimeMs, interruptedCount, failedCount } = await import("@/lib/admin/wall-clock");
    const b = analystBrackets(a1);
    expect(b).toHaveLength(8);
    expect(activeTimeMs(b)).toBe(276_600);
    expect(interruptedCount(b)).toBe(1);
    expect(interruptedCount(b, "formulation")).toBe(1);
    expect(failedCount(b, "testing")).toBe(1);
    expect(activeTimeMs(b, "formulation")).toBe(42_192);
    expect(activeTimeMs(b, "testing")).toBe(59_977);
  });

  it("treats an open last bracket as running, not interrupted, while the run is live", async () => {
    const { analystBrackets, activeTimeMs } = await import("@/lib/admin/wall-clock");
    const live = [...a1.slice(0, 3), e("analyst_stage_started", "2026-09-29T23:14:31.073Z", "data-collection")];
    const b = analystBrackets(live, { running: true });
    expect(b.at(-1)).toMatchObject({ interrupted: false, end: null });
    expect(activeTimeMs(b)).toBe(42_192);
  });

  it("is empty for a run that never logged a finish", async () => {
    const { analystBrackets } = await import("@/lib/admin/wall-clock");
    expect(analystBrackets([e("analyst_stage_started", "2026-09-29T10:00:00Z", "formulation")])).toEqual([]);
  });
});
