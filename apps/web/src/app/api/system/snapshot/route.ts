import { NextResponse } from "next/server";
import { getSystemSnapshot } from "@/server/repositories/system";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getSystemSnapshot());
}
