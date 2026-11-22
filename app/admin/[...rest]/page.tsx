import { notFound } from "next/navigation";

// Catch-all for admin paths nothing else matches (/admin/cohort/abc,
// /admin/setting, a truncated link). Without it the request fell through to
// the root not-found page, which drops the admin header and the cohort
// navigation, so a mistyped URL read as if the instructor had been signed out.
// Next.js prefers static and single-segment dynamic routes over a catch-all,
// so every real admin page still wins here.
export default function AdminCatchAll() {
  notFound();
}
