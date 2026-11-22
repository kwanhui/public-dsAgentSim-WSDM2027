import { createHmac, createHash } from "node:crypto";
import { requireValidSalt } from "@/lib/logging/salt";

export function hashLearnerId(learnerId: string, salt: string): string {
  return createHmac("sha256", requireValidSalt(salt)).update(learnerId).digest("hex");
}

// Non-reversible digest of free text (e.g. an audited prompt). Used so the
// audit log can group identical prompts for analytics without persisting the
// raw learner message. Unsalted SHA-256 is sufficient here: the goal is to
// avoid storing readable text, not to authenticate the value.
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
