// Small per-browser flags (a dismissed notice, a collapsed help panel). Every
// localStorage access is wrapped, as in chat-stash.ts: private windows and
// browsers blocking site data throw on the accessor itself, and a refusal
// should only cost the remembered choice.

export function readLocalFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeLocalFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Without storage the choice lasts for this page view only.
  }
}
