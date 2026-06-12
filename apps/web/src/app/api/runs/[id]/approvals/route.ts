import { NextResponse } from "next/server";
import { listApprovals } from "@/server/repositories/approvals";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ approvals: await listApprovals(id) });
}
