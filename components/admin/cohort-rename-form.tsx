"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface RenameState {
  error?: string;
  renamed?: string;
}

// Renaming a cohort is a display-name change only: the slug stays put so
// invite URLs already in learners' hands keep working.
export function CohortRenameForm({
  currentName,
  action,
}: {
  currentName: string;
  action: (state: RenameState, formData: FormData) => Promise<RenameState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const invalid = Boolean(state.error);

  return (
    // noValidate: the rename action's own messages are what the instructor
    // reads, rather than a native bubble that says only "Please match the
    // requested format." and disappears on the next keystroke.
    <form action={formAction} className="mt-3 flex flex-wrap items-end gap-3" noValidate>
      <div className="min-w-[16rem] flex-1">
        <label htmlFor="cohort-name" className="block text-sm">
          Cohort name
        </label>
        <Input
          id="cohort-name"
          name="name"
          type="text"
          required
          minLength={2}
          maxLength={120}
          defaultValue={currentName}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? "cohort-name-error" : undefined}
          className={invalid ? "mt-1.5 border-flag" : "mt-1.5"}
        />
        {invalid ? (
          <p id="cohort-name-error" role="alert" className="mt-1.5 text-sm text-flag">
            {state.error}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-3 pb-0.5">
        <Button type="submit" variant="outline" loading={pending}>
          Rename
        </Button>
        {state.renamed ? (
          <span className="text-sm text-primary">Renamed to {state.renamed}.</span>
        ) : null}
      </div>
    </form>
  );
}
