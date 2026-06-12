import { NextResponse } from "next/server";
import { installOrUpdateLocalSkill, listAllSkills } from "@/server/repositories/skills";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ skills: await listAllSkills() });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    manifest?: unknown;
    skillMarkdown?: unknown;
    status?: unknown;
  };
  const action = body.action === "update" ? "update" : "install";
  if (!isRecord(body.manifest)) {
    return NextResponse.json({ error: "manifest is required" }, { status: 400 });
  }

  try {
    const result = await installOrUpdateLocalSkill({
      manifest: body.manifest,
      skillMarkdown: typeof body.skillMarkdown === "string" ? body.skillMarkdown : undefined,
      status: body.status === "disabled" ? "disabled" : body.status === "enabled" ? "enabled" : undefined,
    });
    return NextResponse.json({ skill: result.skill, operation: action === "update" ? "updated" : result.operation }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Skill install failed" }, { status: 400 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
