import { NextResponse } from "next/server";
import { readReleasedDataset } from "@/lib/agents/data-environment";
import { resolveLearnerContext } from "@/lib/engagement/request";

export const runtime = "nodejs";

// Downloads a dataset file, but only after the data-owner persona has
// released it to this engagement.
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const res = await resolveLearnerContext();
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 401 });
  const { engagement, scenario } = res.ctx;

  const { file } = await params;
  const data = await readReleasedDataset(engagement, scenario, file);
  if (!data) return NextResponse.json({ error: "not-released" }, { status: 403 });

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
