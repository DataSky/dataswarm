import { NextResponse } from "next/server";
import { getProject, updateProject } from "@/server/repositories/projects";
import { createRequestId, logServer } from "@/server/observability/logger";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const requestId = createRequestId("req_project_patch");
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    localRoot?: string;
    defaultModel?: string;
  };

  logServer("info", "api.project.patch.start", { requestId, projectId: id });

  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: "Project name is required" }, { status: 400 });
  }

  const project = await updateProject(id, body);
  if (!project) {
    logServer("warn", "api.project.patch.not_found", { requestId, projectId: id });
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  logServer("info", "api.project.patch.ok", { requestId, projectId: id });
  return NextResponse.json({ project });
}
