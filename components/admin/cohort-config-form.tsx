"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CohortConfig } from "@/lib/cohort/defaults";

interface ScenarioOption {
  id: string;
  title: string;
}

export interface EffectiveModels {
  provider: string;
  personaModel: string;
  rubricModel: string;
  // Whether the active provider honours a sampling temperature. When it does
  // not, the temperature field is hidden rather than left as a control that
  // changes nothing.
  acceptsTemperature: boolean;
}

// Numeric inputs keep their raw string here rather than a number. Number("")
// is 0, so committing the parsed value on every keystroke turned a cleared
// field into a silent 0, which for the audit rate switches consistency
// auditing off without saying so.
interface Draft {
  allowed: string[];
  hardGate: boolean;
  minScoreRatio: string;
  maxRetries: string;
  temperature: string;
  checkins: boolean;
  reflections: boolean;
  consistencyAuditRate: string;
  showRubricScores: boolean;
  maxLearnerMessages: string;
  openJoin: boolean;
  maxJoinsPerDay: string;
  sandboxBudget: string;
  sandboxMessages: string;
  reviewerVisible: boolean;
}

type FieldKey =
  | "minScoreRatio"
  | "maxRetries"
  | "temperature"
  | "consistencyAuditRate"
  | "maxLearnerMessages"
  | "maxJoinsPerDay"
  | "sandboxBudget"
  | "sandboxMessages";

function toDraft(config: CohortConfig): Draft {
  return {
    allowed: config.scenarios.allowed,
    hardGate: config.gates.minScoreRatio !== null,
    // Shown as the learner sees them: the pass mark
    // as a percentage, and attempts rather than retries (attempts = retries
    // + 1). Stored as a 0-1 ratio and a retry count.
    minScoreRatio: String(Math.round((config.gates.minScoreRatio ?? 0.6) * 100)),
    maxRetries: String(config.gates.maxRetries + 1),
    temperature: String(config.llm.temperature),
    checkins: config.research.checkins,
    reflections: config.research.reflections,
    consistencyAuditRate: String(config.research.consistencyAuditRate),
    showRubricScores: config.ui.showRubricScores,
    maxLearnerMessages: String(config.limits.maxLearnerMessages),
    openJoin: config.sandbox.openJoin,
    maxJoinsPerDay: String(config.sandbox.maxJoinsPerDay),
    sandboxBudget: config.sandbox.dailyBudgetUsd === null ? "" : String(config.sandbox.dailyBudgetUsd),
    sandboxMessages: String(config.sandbox.maxLearnerMessages),
    reviewerVisible: config.showcase.reviewerVisible,
  };
}

function checkNumber(
  raw: string,
  { min, max, integer }: { min: number; max: number; integer?: boolean },
): string | undefined {
  const range = `Enter a value between ${min} and ${max}`;
  if (raw.trim() === "") return `${range}.`;
  const value = Number(raw);
  if (!Number.isFinite(value)) return `${range}.`;
  if (value < min || value > max) return `${range}.`;
  if (integer && !Number.isInteger(value)) return "Enter a whole number.";
  return undefined;
}

function validate(draft: Draft, acceptsTemperature: boolean): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  if (draft.hardGate) {
    const minScore = checkNumber(draft.minScoreRatio, { min: 0, max: 100 });
    if (minScore) errors.minScoreRatio = minScore;
    const retries = checkNumber(draft.maxRetries, { min: 1, max: 11, integer: true });
    if (retries) errors.maxRetries = retries;
  }
  if (acceptsTemperature) {
    const temperature = checkNumber(draft.temperature, { min: 0, max: 2 });
    if (temperature) errors.temperature = temperature;
  }
  const auditRate = checkNumber(draft.consistencyAuditRate, { min: 0, max: 1 });
  if (auditRate) errors.consistencyAuditRate = auditRate;
  const messages = checkNumber(draft.maxLearnerMessages, { min: 1, max: 5000, integer: true });
  if (messages) errors.maxLearnerMessages = messages;
  if (draft.openJoin) {
    const joins = checkNumber(draft.maxJoinsPerDay, { min: 0, max: 10000, integer: true });
    if (joins) errors.maxJoinsPerDay = joins;
    // Blank switches the sandbox's own limit off.
    if (draft.sandboxBudget.trim() !== "") {
      const budget = checkNumber(draft.sandboxBudget, { min: 0, max: 10000 });
      if (budget) errors.sandboxBudget = budget;
    }
    const sandboxMessages = checkNumber(draft.sandboxMessages, { min: 1, max: 5000, integer: true });
    if (sandboxMessages) errors.sandboxMessages = sandboxMessages;
  }
  return errors;
}

function toConfig(draft: Draft, stored: CohortConfig): CohortConfig {
  // The retry count is only on screen while the hard gate is on, so a value
  // left unparseable behind a switched-off gate falls back to what is already
  // stored rather than to Number(""), which is 0.
  const retries = Number(draft.maxRetries) - 1;
  const temperature = Number(draft.temperature);
  const joins = Number(draft.maxJoinsPerDay);
  return {
    scenarios: { allowed: draft.allowed },
    gates: {
      minScoreRatio: draft.hardGate ? Math.round(Number(draft.minScoreRatio) * 10) / 1000 : null,
      maxRetries: Number.isFinite(retries) ? retries : stored.gates.maxRetries,
    },
    // A hidden temperature field (provider ignores it) keeps what is stored.
    llm: {
      temperature:
        draft.temperature.trim() !== "" && Number.isFinite(temperature)
          ? temperature
          : stored.llm.temperature,
    },
    ui: { showRubricScores: draft.showRubricScores },
    research: {
      checkins: draft.checkins,
      reflections: draft.reflections,
      consistencyAuditRate: Number(draft.consistencyAuditRate),
    },
    limits: { maxLearnerMessages: Number(draft.maxLearnerMessages) },
    sandbox: {
      openJoin: draft.openJoin,
      maxJoinsPerDay:
        draft.maxJoinsPerDay.trim() !== "" && Number.isFinite(joins)
          ? joins
          : stored.sandbox.maxJoinsPerDay,
      dailyBudgetUsd:
        draft.sandboxBudget.trim() === ""
          ? null
          : Number.isFinite(Number(draft.sandboxBudget))
            ? Number(draft.sandboxBudget)
            : stored.sandbox.dailyBudgetUsd,
      maxLearnerMessages: Number.isFinite(Number(draft.sandboxMessages)) && draft.sandboxMessages.trim() !== ""
        ? Number(draft.sandboxMessages)
        : stored.sandbox.maxLearnerMessages,
    },
    // The pinned compare pair is not on the form: it is set with the
    // showcase restore, and a save keeps whatever is stored.
    showcase: { ...stored.showcase, reviewerVisible: draft.reviewerVisible },
  };
}

const FIELD_LABELS: Record<FieldKey, string> = {
  minScoreRatio: "Pass mark",
  maxRetries: "Attempts before the gate opens anyway",
  temperature: "Reply temperature",
  consistencyAuditRate: "Persona consistency audit rate",
  maxLearnerMessages: "Learner messages per engagement",
  maxJoinsPerDay: "Sandbox joins per day",
  sandboxBudget: "Sandbox daily budget",
  sandboxMessages: "Messages per sandbox engagement",
};

function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  error,
}: {
  id: FieldKey;
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  step: number;
  error?: string;
}) {
  return (
    <div className="max-w-sm text-sm">
      <label htmlFor={id} className="block">
        {label}
      </label>
      <Input
        id={id}
        // Validation lives in the form, so the browser's own bubble (which
        // disappears on the next keystroke and only ever flags the first bad
        // field) does not stand in for it.
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={error ? "mt-1.5 w-32 border-flag" : "mt-1.5 w-32"}
      />
      {error ? (
        <span id={`${id}-error`} role="alert" className="mt-1 block text-xs text-flag">
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={`${id}-hint`} className="mt-1 block text-xs text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function CohortConfigForm({
  cohortId,
  initialConfig,
  initialVersion,
  availableScenarios,
  models,
  readOnly = false,
  openJoinWarning = null,
}: {
  cohortId: string;
  initialConfig: CohortConfig;
  // Fingerprint of the stored config this form was loaded from. It rides along
  // with the save so a second tab's changes are not silently replaced.
  initialVersion: string;
  availableScenarios: ScenarioOption[];
  models: EffectiveModels;
  // Reviewer sessions see the settings but cannot change them.
  readOnly?: boolean;
  // Shown under the sandbox setting when more than one cohort has open join.
  openJoinWarning?: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initialConfig));
  const [baseVersion, setBaseVersion] = useState(initialVersion);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);

  const errors = useMemo(
    () => validate(draft, models.acceptsTemperature),
    [draft, models.acceptsTemperature],
  );
  const noScenarios = draft.allowed.length === 0;
  const problems = [
    ...(noScenarios ? ["Enable at least one scenario."] : []),
    ...(Object.keys(errors) as FieldKey[]).map((k) => `${FIELD_LABELS[k]}: ${errors[k]}`),
  ];
  const blocked = problems.length > 0;

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
  }

  function toggleScenario(id: string) {
    setDraft((d) => ({
      ...d,
      allowed: d.allowed.includes(id)
        ? d.allowed.filter((s) => s !== id)
        : [...d.allowed, id],
    }));
    setSaved(false);
  }

  async function save() {
    if (blocked || stale || readOnly) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/admin/cohorts/${cohortId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: toConfig(draft, initialConfig), baseVersion }),
      });
      const body = (await res.json().catch(() => null)) as
        | { message?: string; version?: string; warning?: string | null }
        | null;
      if (res.ok) {
        setSaveWarning(body?.warning ?? null);
        // Take the fingerprint of what was just stored, so a second save from
        // this same tab is not mistaken for another tab's write.
        if (body?.version) setBaseVersion(body.version);
        setSaved(true);
        router.refresh();
      } else if (res.status === 409) {
        // Someone saved this cohort's settings from another tab or window
        // after this page loaded. Overwriting would drop their change without
        // either of them seeing it, so this save is refused too.
        setStale(true);
        setError(
          "This cohort's settings were changed elsewhere since this page loaded. Reload to see the current values.",
        );
      } else {
        setError(
          body?.message
            ? `Save rejected: ${body.message}`
            : `Save failed (HTTP ${res.status}). The stored configuration is unchanged.`,
        );
      }
    } catch {
      setError("Save failed because the server could not be reached. Nothing was changed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="max-w-2xl space-y-8"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={readOnly} className="min-w-0 space-y-8">
      <fieldset>
        <legend className="text-base font-medium">Scenarios</legend>
        <p className="mt-1 text-sm text-muted-foreground">
          Which engagements learners in this cohort can start. At least one must stay enabled.
        </p>
        <div className="mt-3 space-y-2">
          {availableScenarios.map((s) => (
            <label key={s.id} className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={draft.allowed.includes(s.id)}
                onChange={() => toggleScenario(s.id)}
                className="h-4 w-4 rounded border"
              />
              <span>{s.title}</span>
              <code className="text-xs text-muted-foreground">{s.id}</code>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-base font-medium">Stage gates</legend>
        <p className="mt-1 text-sm text-muted-foreground">
          Formative gates always advance after scoring. A hard gate requires a pass mark, with a
          set number of attempts before it opens anyway.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          New cohorts start formative, because the judge&apos;s agreement with instructors has not
          been measured yet; turn on a hard gate only if you will review the scores.
        </p>
        <label className="mt-3 flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.hardGate}
            onChange={(e) => update({ hardGate: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          Hard gate (require a minimum score to advance)
        </label>
        {draft.hardGate ? (
          <div className="mt-3 flex flex-wrap gap-4">
            <NumberField
              id="minScoreRatio"
              label="Pass mark (% of the rubric)"
              value={draft.minScoreRatio}
              onChange={(v) => update({ minScoreRatio: v })}
              min={0}
              max={100}
              step={5}
              error={errors.minScoreRatio}
            />
            <NumberField
              id="maxRetries"
              label="Attempts before the gate opens anyway"
              value={draft.maxRetries}
              onChange={(v) => update({ maxRetries: v })}
              min={1}
              max={11}
              step={1}
              error={errors.maxRetries}
            />
          </div>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className="text-base font-medium">Models</legend>
        {models.acceptsTemperature ? (
          <div className="mt-3">
            <NumberField
              id="temperature"
              label="Persona reply temperature (0–2)"
              value={draft.temperature}
              onChange={(v) => update({ temperature: v })}
              min={0}
              max={2}
              step={0.1}
              error={errors.temperature}
            />
          </div>
        ) : null}
        <div className="mt-3 rounded-md border bg-muted/30 p-3 text-xs">
          <p className="font-medium text-foreground">Models this deployment is running</p>
          <dl className="mt-2 space-y-1 text-muted-foreground">
            <div className="flex justify-between gap-4">
              <dt>Provider</dt>
              <dd className="font-mono">{models.provider}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Personas and analyst agent</dt>
              <dd className="font-mono">{models.personaModel}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Rubric judge and consistency auditor</dt>
              <dd className="font-mono">{models.rubricModel}</dd>
            </div>
          </dl>
          <p className="mt-2 text-muted-foreground">
            The deployment sets the provider and models for every cohort, so they are shown
            here rather than edited.
            {models.acceptsTemperature
              ? ""
              : " This provider does not take a sampling temperature, so there is no temperature setting."}{" "}
            Each rubric score is stored with the judge model that produced it.
          </p>
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-base font-medium">Research instrumentation</legend>
        <label className="mt-3 flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.checkins}
            onChange={(e) => update({ checkins: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          Collect the six-item confidence check-in at engagement start and completion
        </label>
        <label className="mt-3 flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.reflections}
            onChange={(e) => update({ reflections: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          Ask for an optional, unscored reflection with each gate submission
        </label>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Both are research instruments and are off by default. Turning one off hides data
          already collected; it does not delete it.
        </p>
        <div className="mt-3">
          <NumberField
            id="consistencyAuditRate"
            label="Persona consistency audit rate (0 to 1)"
            value={draft.consistencyAuditRate}
            onChange={(v) => update({ consistencyAuditRate: v })}
            min={0}
            max={1}
            step={0.05}
            error={errors.consistencyAuditRate}
            hint="Share of persona replies that a second model call checks against the shared engagement record. The first two replies from each persona are always checked; this rate applies after that. A higher rate gives more checks and costs more."
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-base font-medium">Learner experience</legend>
        <label className="mt-3 flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.showRubricScores}
            onChange={(e) => update({ showRubricScores: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          Show rubric scores and rationales to learners after each submission
        </label>
        <p className="mt-1.5 text-xs text-muted-foreground">
          When off, learners see only the client sponsor&apos;s reply; scores stay
          instructor-only.
        </p>
        <div className="mt-3">
          <NumberField
            id="maxLearnerMessages"
            label="Learner messages per engagement"
            value={draft.maxLearnerMessages}
            onChange={(v) => update({ maxLearnerMessages: v })}
            min={1}
            max={5000}
            step={1}
            error={errors.maxLearnerMessages}
            hint="Counted across all channels. When a learner reaches it, the chat stops accepting messages; gate submissions still work."
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-base font-medium">Sandbox</legend>
        <label className="mt-3 flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.openJoin}
            onChange={(e) => update({ openJoin: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          Open join: anyone with the public link gets a fresh learner seat in this cohort
        </label>
        <p className="mt-1.5 text-xs text-muted-foreground">
          For demonstration cohorts only. Visitors join through /try/{"<slug>"}; the landing page
          links here only when this is the one open cohort or SANDBOX_COHORT_SLUG names it.
        </p>
        {(saveWarning ?? openJoinWarning) && draft.openJoin ? (
          <p role="status" className="mt-2 rounded-md border border-flag/40 bg-flag/5 p-2 text-xs text-flag">
            {saveWarning ?? openJoinWarning}
          </p>
        ) : null}
        {draft.openJoin ? (
          <div className="mt-3 flex flex-wrap gap-4">
            <NumberField
              id="maxJoinsPerDay"
              label="Sandbox joins per day (UTC)"
              value={draft.maxJoinsPerDay}
              onChange={(v) => update({ maxJoinsPerDay: v })}
              min={0}
              max={10000}
              step={1}
              error={errors.maxJoinsPerDay}
            />
            <NumberField
              id="sandboxBudget"
              label="Sandbox daily budget (USD)"
              value={draft.sandboxBudget}
              onChange={(v) => update({ sandboxBudget: v })}
              min={0}
              max={10000}
              step={0.5}
              error={errors.sandboxBudget}
              hint="Spend in this cohort per UTC day before its model calls pause. Counted apart from the deployment's budget, so visitors cannot use up what the course cohorts share. Leave blank for no separate limit."
            />
            <NumberField
              id="sandboxMessages"
              label="Messages per sandbox engagement"
              value={draft.sandboxMessages}
              onChange={(v) => update({ sandboxMessages: v })}
              min={1}
              max={5000}
              step={1}
              error={errors.sandboxMessages}
              hint="Applies to seats that joined through the public link; the lower of this and the cohort's message limit is used."
            />
          </div>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className="text-base font-medium">Reviewer access</legend>
        <label className="mt-3 flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={draft.reviewerVisible}
            onChange={(e) => update({ reviewerVisible: e.target.checked })}
            disabled={readOnly}
            className="h-4 w-4 rounded border"
          />
          Visible to the read-only reviewer account
        </label>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Turn this on only for a showcase cohort. The reviewer sees no other cohort. It is refused
          for a cohort with open join or with invited learners other than labelled showcase runs.
        </p>
      </fieldset>
      </fieldset>

      {readOnly ? null : (
      <div className="space-y-3">
        {blocked ? (
          <div
            role="alert"
            className="rounded-md border border-flag/40 bg-flag/5 p-3 text-sm text-flag"
          >
            <p className="font-medium">
              {problems.length === 1
                ? "One setting needs fixing before this can be saved:"
                : `${problems.length} settings need fixing before this can be saved:`}
            </p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-flag/40 bg-flag/5 p-3 text-sm text-flag"
          >
            <p>{error}</p>
            {stale ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => window.location.reload()}
              >
                Reload this page
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={saving} disabled={blocked || stale}>
            Save configuration
          </Button>
          {saved ? <span className="text-sm text-primary">Saved.</span> : null}
        </div>
      </div>
      )}
    </form>
  );
}
