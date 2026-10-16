import { listScenarios, loadScenario } from "@/lib/scenarios/load";
import { PROMPT_HISTORY, type PromptVersionRecord } from "@/lib/agents/prompt-provenance";
import { PageHeader } from "@/components/ui/page-header";
import { humanizeId, reflowProse } from "@/lib/utils";

const PROMPT_ROLE_LABELS: Record<PromptVersionRecord["role"], string> = {
  "rubric-judge": "Rubric judge prompt",
  "consistency-auditor": "Persona consistency audit prompt",
  persona: "Stakeholder persona prompt",
  "analyst-agent": "Analyst agent prompt",
};

export default async function ScenarioLibraryPage() {
  const summaries = await listScenarios();
  const scenarios = await Promise.all(summaries.map((s) => loadScenario(s.id)));

  return (
    <section>
      <PageHeader
        title="Scenario library"
        description="The scenarios installed on this deployment, read-only. Enable them for a cohort under its Configuration tab."
      />
      <div className="mt-6 space-y-6">
        {scenarios.map((s) => (
          <article key={s.id} className="rounded-lg border p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-medium">{s.title}</h2>
              <code className="text-xs text-muted-foreground">{s.id}</code>
            </div>
            <div className="mt-2 flex gap-2 text-xs text-muted-foreground">
              <span className="rounded-full border px-2 py-0.5">{s.sector}</span>
              <span className="rounded-full border px-2 py-0.5">{s.task}</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {reflowProse(s.brief).split("\n\n")[0]}
            </p>
            <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Personas</dt>
                <dd className="mt-1">
                  <ul className="space-y-0.5">
                    {s.personas.map((p) => (
                      <li key={p.id}>
                        {p.name} <span className="text-xs text-muted-foreground">({p.role})</span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Stage gates</dt>
                <dd className="mt-1">
                  <ul className="space-y-0.5">
                    {s.stages.map((st) => (
                      <li key={st.id}>
                        {st.title}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({humanizeId(st.gate.kind)})
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div className="sm:col-span-3">
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                  Rubrics (what the judge scores at each gate)
                </dt>
                <dd className="mt-2 space-y-2">
                  {s.stages.map((st) => (
                    <details key={st.id} className="rounded-md border px-3 py-2">
                      <summary className="cursor-pointer text-sm">
                        {st.title}: {st.gate.rubric.length} criteria,{" "}
                        {st.gate.rubric.reduce((sum, c) => sum + c.maxScore, 0)} points
                      </summary>
                      <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">
                        {reflowProse(st.gate.instructions)}
                      </p>
                      <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                        {st.gate.rubric.map((c) => (
                          <li key={c.id} className="flex gap-2">
                            <span className="shrink-0 font-mono text-xs">[{c.maxScore}]</span>
                            <span>
                              <span className="font-medium text-foreground">
                                {humanizeId(c.id)}:
                              </span>{" "}
                              {c.criterion}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">Datasets</dt>
                <dd className="mt-1">
                  <ul className="space-y-0.5">
                    {s.datasets.map((d) => (
                      <li key={d.file}>
                        <code className="text-xs">{d.file}</code>{" "}
                        <span className="text-xs text-muted-foreground">
                          (released at {d.releasedAtStage})
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>

      <section id="prompt-provenance" className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Prompt provenance
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          The literal text of the versioned prompts, rendered from the same constants the rubric
          judge, the consistency auditor, the stakeholder personas and the analyst agent fill at
          call time, so what you read here is what the model receives. Tokens in guillemets, such
          as <code>«submission text»</code>, are placeholders replaced at call time with the
          scenario, rubric, engagement record, and the submission or reply under review; lines in
          square brackets mark sections sent only when they apply. Everything else is sent
          verbatim.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Every released version is listed, so a score or audit verdict stamped with an older
          version can be read against the text that produced it. Only the current version of each
          prompt runs.
        </p>
        <div className="mt-4 space-y-4">
          {PROMPT_HISTORY.map((v) => (
            <details key={v.id} className="rounded-lg border px-4 py-3">
              <summary className="cursor-pointer text-sm">
                {PROMPT_ROLE_LABELS[v.role]}{" "}
                <code className="text-xs text-muted-foreground">{v.id}</code>
                {v.current ? (
                  <span className="ml-2 text-xs text-primary">current</span>
                ) : (
                  <span className="ml-2 text-xs text-muted-foreground">earlier version</span>
                )}
              </summary>
              <p className="mt-2 text-xs text-muted-foreground">
                Introduced in commit <code>{v.introducedIn}</code>. {v.change}
              </p>
              <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border bg-muted/40 p-3 font-mono text-xs">
                {v.template}
              </pre>
            </details>
          ))}
        </div>
      </section>
    </section>
  );
}
