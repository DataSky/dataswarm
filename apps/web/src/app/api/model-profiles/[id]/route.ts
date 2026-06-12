import { NextResponse } from "next/server";
import { updateModelProfile } from "@/server/repositories/model-profiles";
import { createRequestId, logServer } from "@/server/observability/logger";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const requestId = createRequestId("req_model_patch");
  const body = (await request.json().catch(() => ({}))) as {
    displayName?: string;
    role?: string;
    enabled?: boolean;
  };

  logServer("info", "api.model_profile.patch.start", { requestId, modelId: id });
  const model = await updateModelProfile(id, body);
  if (!model) {
    logServer("warn", "api.model_profile.patch.not_found", { requestId, modelId: id });
    return NextResponse.json({ error: "Model profile not found" }, { status: 404 });
  }

  logServer("info", "api.model_profile.patch.ok", { requestId, modelId: id });
  return NextResponse.json({ model });
}
