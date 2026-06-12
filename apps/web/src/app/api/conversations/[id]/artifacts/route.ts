import { NextResponse } from "next/server";
import { getConversation } from "@/server/repositories/conversations";
import { listArtifacts } from "@/server/repositories/artifacts";
import { createRequestId, logServer } from "@/server/observability/logger";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const requestId = createRequestId("req_artifacts");
  logServer("info", "api.artifacts.list.start", { requestId, conversationId: id });
  const conversation = await getConversation(id);
  if (!conversation) {
    logServer("warn", "api.artifacts.list.conversation_not_found", { requestId, conversationId: id });
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const artifacts = await listArtifacts(id);
  logServer("info", "api.artifacts.list.ok", {
    requestId,
    conversationId: id,
    artifactCount: artifacts.length,
    artifactIds: artifacts.map((artifact) => artifact.id),
  });

  return NextResponse.json({ artifacts });
}
