import type { NextRequest } from "next/server";
import { handleSandboxJoin } from "@/lib/cohort/sandbox-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sandbox join for one named cohort; refused unless that cohort has
// sandbox.openJoin set. See lib/cohort/sandbox.ts.
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return handleSandboxJoin(req, slug);
}
