"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

// Hydration detector: the server snapshot is false, the client snapshot is
// true, so the value flips exactly once, when React takes over the page.
const emptySubscribe = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

// The sign-in form posts to a server action, so a click in the first second
// after page load, before React has hydrated, was dropped with no feedback at
// all. The server render ships this button disabled with the loading spinner,
// and it enables once the client is interactive, so an early click meets a
// visibly busy button rather than one that does nothing.
export function SignInButton() {
  const hydrated = useHydrated();
  return (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      className="w-full"
      loading={!hydrated}
      aria-busy={!hydrated}
    >
      Sign in
    </Button>
  );
}
