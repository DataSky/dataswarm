import { NextResponse } from "next/server";
import { listTraceSpans } from "@/server/repositories/trace";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const spans = await listTraceSpans(id);
  return NextResponse.json({ spans });
}
