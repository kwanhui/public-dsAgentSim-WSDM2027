// The Data files pane lists a file's column names from the stage it becomes
// available, before the data owner releases it, and never the column
// descriptions that carry the data-quality caveats. A gate submission made
// while nothing is released asks the learner to confirm first.

import { describe, expect, it } from "vitest";
import { dictionaryColumns, pendingFiles } from "@/app/api/engagement/me/pending-files";
import { noReleaseQuestion } from "@/components/workspace/length-check";
import { loadScenario } from "@/lib/scenarios/load";

describe("pending files", () => {
  it("lists the churn extract's column names and none of their descriptions", async () => {
    const scenario = await loadScenario("customer-churn");
    const dataset = scenario.datasets[0];
    const columns = dictionaryColumns(dataset.dictionary);
    expect(columns).toContain("subscriber_id");
    expect(columns).toContain("total_charges");
    expect(columns).toContain("churn");
    expect(columns.join(" ")).not.toMatch(/TEXT|blank|outage|missing/i);
  });

  it("appears from the release stage, and goes once the file is released", async () => {
    const scenario = await loadScenario("customer-churn");
    const stageIds = scenario.stages.map((s) => s.id);
    const at = (stage: string, released: string[] = [], completed = false) =>
      pendingFiles(scenario.datasets, released, stageIds, stage, completed).map((f) => f.file);
    expect(at("formulation")).toEqual([]);
    expect(at("data-collection")).toEqual(["churn_extract.csv"]);
    expect(at("cleaning")).toEqual(["churn_extract.csv"]);
    expect(at("data-collection", ["churn_extract.csv"])).toEqual([]);
  });

  it("warns before a submission while no file is released", () => {
    expect(noReleaseQuestion({ releasedFiles: 0, pendingFiles: 1 })).toMatch(/^No file has been released yet; ask the data owner for the extract first\./);
    expect(noReleaseQuestion({ releasedFiles: 1, pendingFiles: 0 })).toBeNull();
    expect(noReleaseQuestion({ releasedFiles: 0, pendingFiles: 0 })).toBeNull();
  });
});
