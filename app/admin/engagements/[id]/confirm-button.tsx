"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

// Submit control for a server action that cannot be undone. Activating it
// swaps in an inline confirm step (the same idiom as invite revoke in
// components/admin/invite-list.tsx) instead of window.confirm, which blocks
// the page and cannot be styled. Confirm submits the enclosing form; cancel
// closes the step and puts focus back on the opening button.
export function ConfirmButton({
  children,
  message,
  confirmLabel = "Confirm",
  variant = "outline",
  size = "md",
}: {
  children: React.ReactNode;
  message: string;
  confirmLabel?: string;
  variant?: "primary" | "outline" | "danger";
  size?: "sm" | "md";
}) {
  const { pending } = useFormStatus();
  const [confirming, setConfirming] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  const refocusOpener = useRef(false);

  // Once the action has run, the decision is spent: close the confirm step so
  // the re-rendered page does not keep a live Confirm button on screen.
  useEffect(() => {
    if (wasPending.current && !pending) setConfirming(false);
    wasPending.current = pending;
  }, [pending]);

  // Keyboard flow: opening moves focus onto the confirm step; cancelling puts
  // it back on the button that opened it.
  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    } else if (refocusOpener.current) {
      refocusOpener.current = false;
      openerRef.current?.focus();
    }
  }, [confirming]);

  if (!confirming) {
    return (
      <Button
        ref={openerRef}
        type="button"
        variant={variant}
        size={size}
        onClick={() => setConfirming(true)}
      >
        {children}
      </Button>
    );
  }

  return (
    // Escape cancels the confirm step the same way the Cancel button does,
    // refocusing the opener, except while the action is already pending,
    // when Cancel is disabled too.
    <div
      className="max-w-sm rounded-md border border-flag/40 bg-flag/5 p-2.5 text-left"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) {
          e.stopPropagation();
          refocusOpener.current = true;
          setConfirming(false);
        }
      }}
    >
      <p className="text-xs text-flag">{message}</p>
      <div className="mt-2 flex gap-1.5">
        <Button
          ref={confirmRef}
          type="submit"
          variant="danger"
          size="sm"
          loading={pending}
          disabled={pending}
        >
          {confirmLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            refocusOpener.current = true;
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
