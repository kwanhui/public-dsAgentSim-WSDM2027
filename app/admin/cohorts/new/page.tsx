import { redirect } from "next/navigation";

// /admin/cohorts/new is what an instructor types (or guesses) for the create
// form, but the form lives at /admin/cohorts, so "new" was read as a cohort id
// and answered with "That cohort or engagement does not exist". A static
// segment beats the [id] route, so this one lands them on the create page.
export default function NewCohortRedirect() {
  redirect("/admin/cohorts");
}
