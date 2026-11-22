"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Always-visible header content (the clickable summary). */
  title: ReactNode;
  /** Hidden body, revealed on click. */
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  bodyClassName?: string;
}

// Collapse/expand row. Mirrors the interaction in components/chat/audit-badge.tsx
// so progressive-disclosure sections feel consistent across the app.
export function Disclosure({
  title,
  children,
  defaultOpen = false,
  className,
  bodyClassName,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
        <span className="min-w-0 font-medium">{title}</span>
        <span className="shrink-0 text-base leading-none text-muted-foreground" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? (
        <div
          className={cn(
            "animate-fade-in border-t px-3 py-2.5 text-sm leading-relaxed text-muted-foreground",
            bodyClassName,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
