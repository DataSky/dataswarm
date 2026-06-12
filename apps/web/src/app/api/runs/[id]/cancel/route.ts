import { NextResponse } from "next/server";
import { createRequestId, logServer } from "@/server/observability/logger";
import { getRun, requestRunCancel } from "@/server/repositories/runs";
import { requestSandboxSessionsCancelForRun } from "@/server/repositories/sandbox-sessions";
import { publishRunEvent } from "@/server/runtime/event-bus";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: runId } = await context.params;
  const requestId = createRequestId("req_cancel");
  const body = (await request.json().catch(() => ({}))) as { reason?: string };
  const reason = body.reason?.trim() || "user_requested_cancel";

  logServer("info", "api.runs.cancel.start", { requestId, runId, reason });
  const run = await getRun(runId);
  if (!run) {
    logServer("warn", "api.runs.cancel.not_found", { requestId, runId });
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const runCancel = await requestRunCancel(runId, reason);
  const sandboxCancels = await requestSandboxSessionsCancelForRun(runId, reason);

  await publishRunEvent({
    runId,
    conversationId: run.conversationId,
    taskId: run.taskId,
    type: "run.cancel.requested",
    producer: { kind: "user", id: "usr_local", name: "Local User" },
    payload: {
      reason,
      previous_status: runCancel?.previousStatus ?? run.status,
      status: runCancel?.status ?? run.status,
      already_terminal: runCancel?.terminal ?? false,
      sandbox_cancel_count: sandboxCancels.length,
    },
  });

  for (const sandbox of sandboxCancels) {
    await publishRunEvent({
      runId,
      conversationId: run.conversationId,
      taskId: run.taskId,
      type: "sandbox.cancel.requested",
      producer: { kind: "system", id: sandbox.sandboxSessionId, name: "Sandbox Controller" },
      payload: {
        reason,
        sandbox_session_id: sandbox.sandboxSessionId,
        previous_status: sandbox.previousStatus,
        status: sandbox.status,
      },
    });
  }

  logServer("info", "api.runs.cancel.accepted", {
    requestId,
    runId,
    previousStatus: runCancel?.previousStatus,
    status: runCancel?.status,
    sandboxCancelCount: sandboxCancels.length,
  });

  return NextResponse.json(
    {
      run_id: runId,
      previous_status: runCancel?.previousStatus ?? run.status,
      status: runCancel?.status ?? run.status,
      already_terminal: runCancel?.terminal ?? false,
      sandbox_cancel_count: sandboxCancels.length,
    },
    { status: 202 },
  );
}
