import { NextResponse } from "next/server";
import { getConversation } from "@/server/repositories/conversations";
import { createUserMessage } from "@/server/repositories/messages";
import { createTaskAndRun } from "@/server/repositories/runs";
import { createRequestId, errorPayload, logServer, textPreview } from "@/server/observability/logger";
import { publishRunEvent } from "@/server/runtime/event-bus";
import { runOrchestrator } from "@/server/runtime/orchestrator";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await context.params;
  const requestId = createRequestId("req_msg");
  logServer("info", "api.messages.post.start", { requestId, conversationId });

  const conversation = await getConversation(conversationId);
  if (!conversation) {
    logServer("warn", "api.messages.post.conversation_not_found", { requestId, conversationId });
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    text?: string;
    model?: string;
    mode?: "chat" | "agent";
  };
  const text = body.text?.trim();
  if (!text) {
    logServer("warn", "api.messages.post.empty_text", { requestId, conversationId });
    return NextResponse.json({ error: "Message text is required" }, { status: 400 });
  }

  const modelProfile = body.model || conversation.defaultModel || "dmx:gpt-5.5-1m";
  logServer("info", "api.messages.post.parsed", {
    requestId,
    conversationId,
    modelProfile,
    mode: body.mode ?? "agent",
    ...textPreview(text),
  });

  const { taskId, runId } = await createTaskAndRun({
    conversationId,
    objective: text,
    modelProfile,
    mode: body.mode ?? "agent",
  });

  const userMessage = await createUserMessage({ conversationId, text, runId });
  logServer("info", "api.messages.post.created", {
    requestId,
    conversationId,
    runId,
    taskId,
    userMessageId: userMessage.id,
  });

  await publishRunEvent({
    runId,
    conversationId,
    taskId,
    type: "run.created",
    producer: { kind: "user", id: "usr_local", name: "Local User" },
    payload: {
      status: "queued",
      mode: body.mode ?? "agent",
      model_profile: modelProfile,
    },
  });

  await publishRunEvent({
    runId,
    conversationId,
    taskId,
    type: "message.created",
    producer: { kind: "user", id: "usr_local", name: "Local User" },
    payload: {
      message_id: userMessage.id,
      role: "user",
      status: "completed",
    },
  });

  setTimeout(() => {
    logServer("info", "api.messages.post.orchestrator.dispatch", { requestId, conversationId, runId, taskId });
    void runOrchestrator(runId).catch((error) => {
      logServer("error", "api.messages.post.orchestrator.dispatch_failed", {
        requestId,
        conversationId,
        runId,
        taskId,
        ...errorPayload(error),
      });
    });
  }, 0);

  logServer("info", "api.messages.post.accepted", {
    requestId,
    conversationId,
    runId,
    taskId,
    userMessageId: userMessage.id,
    streamUrl: `/api/runs/${runId}/events`,
  });

  return NextResponse.json(
    {
      message_id: userMessage.id,
      task_id: taskId,
      run_id: runId,
      stream_url: `/api/runs/${runId}/events`,
    },
    { status: 202 },
  );
}
