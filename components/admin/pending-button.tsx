"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

// Submit button for server-action forms that disables itself while the
// action is in flight, so a double-click cannot fire the action twice.
export function PendingButton({
  children,
  variant = "outline",
  size = "md",
}: {
  children: React.ReactNode;
  variant?: "primary" | "outline";
  size?: "sm" | "md";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} loading={pending} disabled={pending}>
      {children}
    </Button>
  );
}
