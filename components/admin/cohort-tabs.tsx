"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function CohortTabs({ cohortId }: { cohortId: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: `/admin/cohorts/${cohortId}`, label: "Overview" },
    { href: `/admin/cohorts/${cohortId}/config`, label: "Configuration" },
    { href: `/admin/cohorts/${cohortId}/analytics`, label: "Analytics" },
    { href: `/admin/cohorts/${cohortId}/agent`, label: "Agent runs" },
  ];
  return (
    <nav className="mt-5 flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative -mb-px whitespace-nowrap px-4 py-2.5 text-sm transition-colors",
              active
                ? "border-b-2 border-primary font-medium text-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
