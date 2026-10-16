import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Scenario YAML uses literal block scalars, so the source's hard line wraps
// survive into the UI when rendered with whitespace-pre-line. Join single
// newlines back into sentences; keep paragraph breaks and list items intact.
export function reflowProse(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) =>
      para.split("\n").reduce((joined, raw) => {
        const line = raw.trim();
        if (!joined) return line;
        if (/^([-*•]|\d+[.)])\s/.test(line)) return `${joined}\n${line}`;
        return `${joined} ${line}`;
      }, ""),
    )
    .join("\n\n");
}

// Slug identifiers (rubric criterion ids, gate kinds, stage ids) are stable
// keys for logging; learners and instructors should see words instead.
export function humanizeId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
