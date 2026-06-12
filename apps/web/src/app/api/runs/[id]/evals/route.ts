import { NextResponse } from "next/server";
import { listEvalResults } from "@/server/repositories/eval-results";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return NextResponse.json({ evals: await listEvalResults(id) });
}
