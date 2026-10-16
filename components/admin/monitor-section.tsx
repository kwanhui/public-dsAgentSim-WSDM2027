import type { ReactNode } from "react";

// One section of the engagement monitor behind a toggle, with an anchor the
// page's section links point at. A native details element, so it works
// without client script and a link to #id scrolls to the heading.
export function MonitorSection({
  id,
  title,
  count,
  defaultOpen = true,
  className,
  children,
}: {
  id: string;
  title: string;
  /** Shown after the title, such as "(42)". */
  count?: number;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details id={id} open={defaultOpen} className={`group scroll-mt-4 ${className ?? ""}`}>
      <summary className="flex cursor-pointer list-none items-baseline gap-2 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="w-3 text-xs text-muted-foreground group-open:hidden">+</span>
        <span aria-hidden="true" className="hidden w-3 text-xs text-muted-foreground group-open:inline">−</span>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {title}
          {count !== undefined ? <span className="ml-1 font-normal normal-case tracking-normal">({count})</span> : null}
        </h2>
      </summary>
      {children}
    </details>
  );
}

/** In-page links to the monitor's sections. */
export function MonitorSectionNav({ sections }: { sections: { id: string; title: string }[] }) {
  return (
    <nav aria-label="Sections of this page" className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} className="text-primary underline-offset-4 hover:underline">
          {s.title}
        </a>
      ))}
    </nav>
  );
}
