import { NextResponse } from "next/server";
import { decideApproval, getApproval } from "@/server/repositories/approvals";
import { appendObservedLog } from "@/server/repositories/logs";
import { getRun } from "@/server/repositories/runs";
import { publishRunEvent } from "@/server/runtime/event-bus";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string; approvalId: string }> }) {
  const { id, approvalId } = await params;
  const approval = await getApproval(id, approvalId);
  if (!approval) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }
  return NextResponse.json({ approval });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; approvalId: string }> }) {
  const { id, approvalId } = await params;
  const body = (await request.json().catch(() => ({}))) as { decision?: unknown; comment?: unknown };
  const decision = normalizeDecision(body.decision);
  if (!decision) {
    return NextResponse.json({ error: "decision must be approve or reject" }, { status: 400 });
  }

  try {
    const result = await decideApproval({
      runId: id,
      approvalId,
      decision,
      comment: typeof body.comment === "string" ? body.comment : "",
    });
    const run = await getRun(id);
    if (run) {
      await publishRunEvent({
        runId: id,
        conversationId: run.conversationId,
        taskId: run.taskId,
        type: "approval.decision.recorded",
        producer: { kind: "user", id: result.approval.decisionByUserId ?? "usr_local", name: "Local User" },
        payload: {
          approval_id: result.approval.id,
          decision,
          status: result.approval.status,
          risk_level: result.approval.riskLevel,
          tool_call_id: result.approval.toolCallId,
        },
      });
    }
    await appendObservedLog({
      source: "server",
      level: "info",
      event: `approval.${decision}`,
      payload: {
        runId: id,
        conversationId: run?.conversationId,
        approvalId: result.approval.id,
        status: result.approval.status,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown approval decision error" },
      { status: 400 },
    );
  }
}

function normalizeDecision(value: unknown) {
  return value === "approve" || value === "reject" ? value : null;
}
