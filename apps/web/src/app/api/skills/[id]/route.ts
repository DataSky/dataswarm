import { NextRequest, NextResponse } from "next/server";
import { getSkill, updateSkillStatus } from "@/server/repositories/skills";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const skill = await getSkill(id);
  if (!skill) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
  return NextResponse.json({ skill });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { status?: unknown; action?: unknown };
  const status = normalizeSkillStatus(body.status ?? body.action);
  if (!status) {
    return NextResponse.json({ error: "status must be enabled or disabled" }, { status: 400 });
  }
  const skill = await updateSkillStatus(id, status);
  if (!skill) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }
  return NextResponse.json({ skill });
}

function normalizeSkillStatus(value: unknown): "enabled" | "disabled" | null {
  if (value === "enabled" || value === "enable") {
    return "enabled";
  }
  if (value === "disabled" || value === "disable") {
    return "disabled";
  }
  return null;
}
