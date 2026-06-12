import { NextResponse } from "next/server";
import { clearConversationData } from "@/server/repositories/maintenance";
import { createRequestId, logServer } from "@/server/observability/logger";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = createRequestId("req_maint");
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    confirmation?: string;
    deleteLocalFiles?: boolean;
  };

  if (body.action !== "clear_conversation_data") {
    return NextResponse.json({ error: "Unsupported maintenance action" }, { status: 400 });
  }
  if (body.confirmation !== "CLEAR DATA") {
    logServer("warn", "api.maintenance.clear_conversation_data.rejected", { requestId });
    return NextResponse.json({ error: "Confirmation must be CLEAR DATA" }, { status: 400 });
  }

  logServer("warn", "api.maintenance.clear_conversation_data.start", {
    requestId,
    deleteLocalFiles: body.deleteLocalFiles === true,
  });
  const result = await clearConversationData({ deleteLocalFiles: body.deleteLocalFiles === true });
  logServer("warn", "api.maintenance.clear_conversation_data.ok", {
    requestId,
    deletedRows: result.deletedRows,
    deletedPaths: result.deletedPaths,
  });

  return NextResponse.json({ ok: true, result });
}
