import { NextResponse } from "next/server";
import { listAllModelProfiles } from "@/server/repositories/model-profiles";

export const runtime = "nodejs";

export async function GET() {
  const models = await listAllModelProfiles();
  return NextResponse.json({ models });
}
