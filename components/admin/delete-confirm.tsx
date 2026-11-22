"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deletionRowsLine, deletionScopeLine, type DeletionKind } from "@/lib/admin/deletion-phrase";

// Deleting a learner, an engagement or a cohort: a button that opens a form
// where the instructor types the target's phrase (its slug or short id)
// before the Delete button enables. The server checks the phrase again
// (app/api/admin/deletions/route.ts).
export function DeleteConfirm({
  kind,
  id,
  phrase,
  buttonLabel,
  redirectTo,
  size = "sm",
  startOpen = false,
  onCancel,
}: {
  kind: DeletionKind;
  id: string;
  phrase: string;
  buttonLabel: string;
  /** Where to go after the deletion; the current page is refreshed when
   * absent. */
  redirectTo?: string;
  size?: "sm" | "md";
  /** Open the form at once (the caller shows its own trigger). */
  startOpen?: boolean;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const inputId = useId();
  const [open, setOpen] = useState(startOpen);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The receipt: what the deletion removed, shown until the page moves on.
  const [receipt, setReceipt] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/deletions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, id, confirm: typed }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string; rows?: unknown } | null;
      if (!res.ok) {
        setError(body?.message ?? "The deletion failed. Nothing was deleted.");
        return;
      }
      setOpen(false);
      setReceipt(`Deleted. Rows removed: ${deletionRowsLine(body?.rows)}. The deletion is recorded under Deletions.`);
      // The receipt travels to the next page in the URL (row counts only, no
      // content), because the row holding this form is gone after a refresh.
      const next = redirectTo ?? window.location.pathname;
      router.push(`${next}?deleted=${encodeURIComponent(deletionRowsLine(body?.rows))}`);
      router.refresh();
    } catch {
      setError("The deletion failed. Nothing was deleted.");
    } finally {
      setPending(false);
    }
  }

  if (receipt) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {receipt}
      </p>
    );
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size={size} onClick={() => setOpen(true)}>
        {buttonLabel}
      </Button>
    );
  }

  return (
    <div
      role="group"
      aria-label={buttonLabel}
      className="mt-2 w-full space-y-2 rounded-md border border-flag/40 bg-background p-3 text-xs"
    >
      <p className="text-foreground">{deletionScopeLine(kind)}</p>
      <label htmlFor={inputId} className="block text-muted-foreground">
        Type <span className="font-mono text-foreground">{phrase}</span> to confirm.
      </label>
      <Input
        id={inputId}
        value={typed}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
        className="h-8 max-w-xs font-mono text-xs"
      />
      {error ? (
        <p role="alert" className="text-flag">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={typed.trim() !== phrase}
          loading={pending}
          onClick={() => void submit()}
        >
          Delete permanently
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setTyped("");
            setError(null);
            onCancel?.();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
