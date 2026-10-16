import { NextResponse, type NextRequest } from "next/server";
import { checkCohortBudget, checkDailyBudget, dailyBudgetUsd } from "@/lib/llm/budget";
import { activeProvider } from "@/lib/llm/model-names";
import { requirePseudonymSalt } from "@/lib/cohort/invite";
import { STUDENT_COOKIE_NAME, resolveCohortFromRequest, studentCookieOptions } from "@/lib/cohort/resolve";
import {
  addressHash,
  clientAddress,
  countAddressJoinsToday,
  countSandboxJoinsToday,
  createSandboxLearner,
  findOpenJoinCohort,
  noteAddressJoin,
  sandboxJoinRefusal,
} from "@/lib/cohort/sandbox";

// Shared by GET /try (the configured sandbox cohort) and GET /try/<slug>.
// A plain link has to work, because the paper and the landing page print
// one, so this answers GET. The daily join cap, the per-address throttle and
// the requirement for a spend budget bound what a crawler following the
// link can create.
export async function handleSandboxJoin(req: NextRequest, slug?: string): Promise<NextResponse> {
  const cohort = await findOpenJoinCohort(slug);

  // A visitor who already holds a learner session in this cohort goes back
  // to it instead of taking a second seat.
  if (cohort) {
    const existing = await resolveCohortFromRequest();
    if (existing && existing.cohortId === cohort.id) {
      return NextResponse.redirect(new URL("/workspace", req.url));
    }
  }

  // A public link with no spend limit behind it is refused, except on the
  // offline mock provider, which costs nothing.
  const budgetSet = dailyBudgetUsd() !== null || activeProvider() === "mock";
  // The sandbox cohort's own daily limit as well as the deployment's.
  const budget = cohort ? await checkCohortBudget(cohort) : await checkDailyBudget();
  const joinsToday = cohort ? await countSandboxJoinsToday(cohort.id) : 0;
  const address = clientAddress(req.headers);
  const hash = address ? addressHash(address, requirePseudonymSalt()) : null;
  const joinsFromAddressToday = cohort && hash ? await countAddressJoinsToday(hash) : 0;
  const refusal = sandboxJoinRefusal({ cohort, budgetOk: budget.ok, budgetSet, joinsToday, joinsFromAddressToday });
  if (refusal || !cohort) {
    return NextResponse.redirect(new URL(`/join/error?reason=${refusal ?? "sandbox-closed"}`, req.url));
  }

  if (hash) noteAddressJoin(hash);
  const learner = await createSandboxLearner(cohort.id, hash);
  const res = NextResponse.redirect(new URL("/workspace", req.url));
  res.cookies.set(STUDENT_COOKIE_NAME, learner.cookieToken, studentCookieOptions(learner.cookieExpiresAt));
  return res;
}
