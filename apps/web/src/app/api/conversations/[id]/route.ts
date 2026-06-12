import { NextResponse } from "next/server";
import {
  deleteConversation,
  getConversation,
  renameConversation,
} from "@/server/repositories/conversations";
import { createRequestId, logServer } from "@/server/observability/logger";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const requestId = createRequestId("req_conv");
  logServer("info", "api.conversation.get.start", { requestId, conversationId: id });
  const conversation = await getConversation(id);

  if (!conversation) {
    logServer("warn", "api.conversation.get.not_found", { requestId, conversationId: id });
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  logServer("info", "api.conversation.get.ok", {
    requestId,
    conversationId: id,
    messageCount: conversation.messages.length,
    lastMessageRole: conversation.messages.at(-1)?.role ?? null,
    lastMessageStatus: conversation.messages.at(-1)?.status ?? null,
  });

  return NextResponse.json({ conversation });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const requestId = createRequestId("req_conv_patch");
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  const title = body.title?.trim();

  logServer("info", "api.conversation.patch.start", { requestId, conversationId: id });

  if (!title) {
    logServer("warn", "api.conversation.patch.invalid", { requestId, conversationId: id });
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const conversation = await renameConversation(id, title);
  if (!conversation) {
    logServer("warn", "api.conversation.patch.not_found", { requestId, conversationId: id });
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  logServer("info", "api.conversation.patch.ok", { requestId, conversationId: id });
  return NextResponse.json({ conversation });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const requestId = createRequestId("req_conv_del");
  logServer("warn", "api.conversation.delete.start", { requestId, conversationId: id });

  const deleted = await deleteConversation(id);
  if (!deleted) {
    logServer("warn", "api.conversation.delete.not_found", { requestId, conversationId: id });
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  logServer("warn", "api.conversation.delete.ok", { requestId, conversationId: id });
  return NextResponse.json({ ok: true });
}
