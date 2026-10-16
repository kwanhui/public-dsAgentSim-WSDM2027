"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface NewCohortState {
  error?: string;
  // Echoed back so a rejected submission does not clear what was typed.
  name?: string;
}

// Cohort creation form. The action reports failures as state rather than
// throwing, so a rejected name (or an auth hiccup) leaves the instructor on
// the form with their input intact instead of on a full-page error.
export function NewCohortForm({
  action,
}: {
  action: (state: NewCohortState, formData: FormData) => Promise<NewCohortState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const invalid = Boolean(state.error);

  return (
    // noValidate hands every rejection to the server action. The browser's own
    // check fired first on a name of spaces and showed "Please match the
    // requested format." in a bubble that vanished on the next keystroke,
    // while the message written for that case never appeared.
    <form action={formAction} className="mt-6 space-y-4" noValidate>
      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Cohort name
        </label>
        <Input
          id="name"
          name="name"
          type="text"
          required
          minLength={2}
          maxLength={120}
          defaultValue={state.name ?? ""}
          placeholder="ANL305, Sem 2 2026"
          autoFocus
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? "name-error" : "name-hint"}
          className={invalid ? "mt-1.5 border-flag" : "mt-1.5"}
        />
        <p id="name-hint" className="mt-1.5 text-xs text-muted-foreground">
          A unique slug is generated automatically from this name.
        </p>
        {invalid ? (
          <p id="name-error" role="alert" className="mt-1.5 text-sm text-flag">
            {state.error}
          </p>
        ) : null}
      </div>
      <Button type="submit" variant="primary" loading={pending}>
        Create cohort
      </Button>
    </form>
  );
}
