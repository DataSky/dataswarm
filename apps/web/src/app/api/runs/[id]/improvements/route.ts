import { NextResponse } from "next/server";
import { listSelfImprovementCandidates, summarizeSelfImprovementCandidates } from "@/server/repositories/self-improvement";
import { getRun } from "@/server/repositories/runs";
import { appendObservedLog } from "@/server/repositories/logs";
import { runSelfImprovementAnalysis, runSelfImprovementDiagnosticsAnalysis } from "@/server/runtime/self-improvement-runner";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const improvements = await listSelfImprovementCandidates(id);
  return NextResponse.json({ improvements, summary: summarizeSelfImprovementCandidates(improvements) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown; eval_result_id?: unknown; evalResultId?: unknown };
  if (body.action !== "run_async_analysis" && body.action !== "run_diagnostics_analysis") {
    return NextResponse.json({ error: "action must be run_async_analysis or run_diagnostics_analysis" }, { status: 400 });
  }
  const run = await getRun(id);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  try {
    if (body.action === "run_diagnostics_analysis") {
      const result = await runSelfImprovementDiagnosticsAnalysis({
        runId: id,
        conversationId: run.conversationId,
        taskId: run.taskId,
      });
      await appendObservedLog({
        source: "server",
        level: "info",
        event: "self_improvement.run_diagnostics_analysis",
        payload: {
          runId: id,
          conversationId: run.conversationId,
          remediationCount: result.remediationCount,
          candidateCount: result.candidates.length,
        },
      });
      return NextResponse.json({ analysis: result });
    }

    const evalResultId = typeof body.eval_result_id === "string" ? body.eval_result_id : typeof body.evalResultId === "string" ? body.evalResultId : "";
    if (!evalResultId) {
      return NextResponse.json({ error: "eval_result_id is required" }, { status: 400 });
    }
    const result = await runSelfImprovementAnalysis({
      runId: id,
      conversationId: run.conversationId,
      taskId: run.taskId,
      evalResultId,
    });
    await appendObservedLog({
      source: "server",
      level: "info",
      event: "self_improvement.run_async_analysis",
      payload: {
        runId: id,
        conversationId: run.conversationId,
        evalResultId,
        candidateCount: result.candidates.length,
      },
    });
    return NextResponse.json({ analysis: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown self-improvement analysis error" },
      { status: 400 },
    );
  }
}
