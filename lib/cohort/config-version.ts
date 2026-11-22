import { createHash } from "node:crypto";

/**
 * A short fingerprint of a cohort's stored configJson, used as the
 * precondition on a config save.
 *
 * Two instructor tabs (or one instructor and one browser back button) both
 * hold a config loaded at different times, and the save replaces the whole
 * document. Without a precondition the later save silently discarded the
 * earlier one and still reported "Saved." The form sends back the version it
 * loaded; the API refuses the write when the stored config has moved on.
 *
 * Object keys are sorted before hashing so the fingerprint depends on the
 * content rather than on the key order jsonb happens to return.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = stable(source[key]);
    return out;
  }
  return value;
}

export function configVersion(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(config)) ?? "null").digest("hex").slice(0, 16);
}
