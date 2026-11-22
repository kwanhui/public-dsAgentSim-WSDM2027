import { NextResponse } from "next/server";
import { purgeExpiredLogs, retentionDays } from "@/lib/logging/retention";

export const runtime = "nodejs";

// Scheduled log retention purge. Wired in vercel.json as a daily cron.
// Vercel attaches `Authorization: Bearer <CRON_SECRET>` to cron invocations;
// we reject anything without the matching secret so the endpoint can't be
// triggered by arbitrary callers. If CRON_SECRET is unset, the route refuses
// to run rather than purging unauthenticated.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET unset; retention purge disabled." },
      { status: 503 },
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await purgeExpiredLogs();
    return NextResponse.json({ ok: true, retentionDays: retentionDays(), ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "purge failed" },
      { status: 500 },
    );
  }
}
