import { NextResponse } from "next/server";
import { diagnoseConversation } from "@/server/repositories/diagnostics";
import { createRequestId, logServer } from "@/server/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const requestId = createRequestId("req_diag");
  logServer("info", "api.diagnostics.conversation.start", { requestId, conversationId: id });

  const diagnostic = await diagnoseConversation(id);
  if (!diagnostic) {
    logServer("warn", "api.diagnostics.conversation.not_found", { requestId, conversationId: id });
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  logServer("info", "api.diagnostics.conversation.ok", {
    requestId,
    conversationId: id,
    runCount: diagnostic.summary.runCount,
    eventCount: diagnostic.summary.eventCount,
    hasWebResearch: diagnostic.summary.hasWebResearch,
    hasWebSearchTool: diagnostic.summary.hasWebSearchTool,
    hasTavily: diagnostic.summary.hasTavily,
    likelyUsedMockSearch: diagnostic.summary.likelyUsedMockSearch,
  });

  return NextResponse.json({ diagnostic });
}
