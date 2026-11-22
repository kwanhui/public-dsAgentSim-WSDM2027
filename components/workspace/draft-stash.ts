// Autosave for the stage-gate artifact. A gate artifact runs to several
// hundred words written over more than one evening, and a reload or a closed
// tab used to lose whatever had not been submitted. The draft is kept in the
// browser per engagement and stage, with the time it was saved, and cleared
// once a submission for that stage has gone through. Every storage access is
// wrapped, as in chat-stash.ts: a browser refusing storage only costs the
// autosave.

import { formatLearnerTime, type LearnerTimeOptions } from "./learner-time";

const DRAFT_KEY_PREFIX = "agenticpracticum:gate-draft:";

export interface SavedDraft {
  text: string;
  savedAt: string;
}

export function draftKey(engagementId: string, stage: string): string {
  return `${DRAFT_KEY_PREFIX}${engagementId}:${stage}`;
}

export function saveDraft(engagementId: string, stage: string, text: string, now = new Date()): SavedDraft | null {
  const key = draftKey(engagementId, stage);
  try {
    if (text.trim() === "") {
      window.localStorage.removeItem(key);
      return null;
    }
    const draft: SavedDraft = { text, savedAt: now.toISOString() };
    window.localStorage.setItem(key, JSON.stringify(draft));
    return draft;
  } catch {
    return null;
  }
}

export function loadDraft(engagementId: string, stage: string): SavedDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(engagementId, stage));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedDraft>;
    if (typeof parsed.text !== "string" || parsed.text.trim() === "") return null;
    return { text: parsed.text, savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "" };
  } catch {
    return null;
  }
}

export function clearDraft(engagementId: string, stage: string): void {
  try {
    window.localStorage.removeItem(draftKey(engagementId, stage));
  } catch {
    // At worst the submitted text comes back once as a draft.
  }
}

/** "Draft saved in this browser 14:32 SGT", in the learner's local time
 * with the zone, the same format as the chat timestamps. */
export function draftSavedLine(savedAt: string, opts: LearnerTimeOptions = {}): string {
  // "In this browser": the draft is not on the server, so it does not follow
  // the learner to another device.
  const time = formatLearnerTime(savedAt, opts);
  return time ? `Draft saved in this browser ${time}` : "Draft saved in this browser";
}
