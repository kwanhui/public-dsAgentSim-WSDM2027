"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

// Hydration detector, the same one the sign-in button uses: the server
// snapshot is false, the client snapshot is true, so the value flips exactly
// once, when React takes over the page.
const emptySubscribe = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

// Single-fire submit for server-action forms. PendingButton disables itself
// via useFormStatus, but that disable lands on the re-render after the action
// dispatches, roughly 100ms later, so a fast double-click fired the action
// twice (and minted two invites). The ref here is the synchronous half of the
// fix: it flips inside the first click's own handler, before any re-render,
// so a second click never dispatches. createInvite carries the server half
// for duplicate requests that get past any one button instance.
//
// The button also refocuses itself when the action completes: the page
// re-render otherwise drops focus to <body>, sending a keyboard user back to
// the top of the page.
//
// Before hydration the form cannot dispatch its action at all, so a click in
// the first second after page load was silently dropped. As on the sign-in
// button, the server render ships this button disabled with the loading
// spinner, and it enables once the client is interactive: an early click
// meets a visibly busy button rather than one that does nothing.
export function ActionSubmitButton({
  children,
  variant = "primary",
}: {
  children: React.ReactNode;
  variant?: "primary" | "outline";
}) {
  const hydrated = useHydrated();
  const { pending } = useFormStatus();
  const firedRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const busy = pending || !hydrated;

  // The action came back (the form left its pending state): restore focus if
  // this button's own submit was what ran, then accept the next click.
  useEffect(() => {
    if (!pending) {
      if (firedRef.current) buttonRef.current?.focus();
      firedRef.current = false;
    }
  }, [pending]);

  return (
    <Button
      ref={buttonRef}
      type="submit"
      variant={variant}
      loading={busy}
      disabled={busy}
      aria-busy={busy}
      onClick={(e) => {
        if (firedRef.current) {
          e.preventDefault();
          return;
        }
        firedRef.current = true;
      }}
    >
      {children}
    </Button>
  );
}

export function MintInviteButton({ children }: { children: React.ReactNode }) {
  return <ActionSubmitButton variant="primary">{children}</ActionSubmitButton>;
}
