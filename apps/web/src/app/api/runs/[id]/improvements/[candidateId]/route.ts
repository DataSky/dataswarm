import { NextResponse } from "next/server";
import {
  decideSelfImprovementCandidate,
  getSelfImprovementCandidate,
  prepareSelfImprovementPatchBundle,
  runSelfImprovementShadowTest,
} from "@/server/repositories/self-improvement";
import { appendObservedLog } from "@/server/repositories/logs";
import { publishRunEvent } from "@/server/runtime/event-bus";

export const runtime = "nodejs";

type ImprovementAction = "shadow_test" | "prepare_patch_bundle" | "approve" | "reject" | "defer" | "mark_applied";

export async function GET(_: Request, { params }: { params: Promise<{ id: string; candidateId: string }> }) {
  const { id, candidateId } = await params;
  const candidate = await getSelfImprovementCandidate(id, candidateId);
  if (!candidate) {
    return NextResponse.json({ error: "Self-improvement candidate not found" }, { status: 404 });
  }
  return NextResponse.json({ candidate });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; candidateId: string }> }) {
  const { id, candidateId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    comment?: unknown;
    verification_receipt?: unknown;
    verificationReceipt?: unknown;
  };
  const action = normalizeAction(body.action);
  if (!action) {
    return NextResponse.json(
      { error: "action must be one of shadow_test, prepare_patch_bundle, approve, reject, defer, mark_applied" },
      { status: 400 },
    );
  }

  try {
    const result =
      action === "shadow_test"
        ? await runSelfImprovementShadowTest(id, candidateId)
        : action === "prepare_patch_bundle"
          ? await prepareSelfImprovementPatchBundle(id, candidateId)
        : await decideSelfImprovementCandidate({
            runId: id,
            candidateId,
            action,
            comment: typeof body.comment === "string" ? body.comment : "",
            verificationReceipt: body.verification_receipt ?? body.verificationReceipt,
          });
    const candidate = result.candidate;
    const eventType =
      action === "shadow_test"
        ? "self_improvement.candidate.shadow_tested"
        : action === "prepare_patch_bundle"
          ? "self_improvement.candidate.patch_bundle_prepared"
        : "self_improvement.candidate.decision_recorded";

    await publishRunEvent({
      runId: id,
      conversationId: candidate.conversationId,
      type: eventType,
      producer: { kind: "orchestrator", id: "self-improvement", name: "Self-Improvement" },
      payload: {
        candidate_id: candidate.id,
        candidate_type: candidate.candidateType,
        action,
        status: candidate.status,
        severity: candidate.severity,
        shadow_test: "shadowTest" in result ? result.shadowTest : undefined,
        patch_bundle: "patchBundle" in result ? result.patchBundle : undefined,
        decision: "decision" in result ? result.decision : undefined,
      },
    });
    await appendObservedLog({
      source: "server",
      level: "info",
      event: `self_improvement.${action}`,
      payload: {
        runId: id,
        conversationId: candidate.conversationId,
        candidateId: candidate.id,
        status: candidate.status,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown self-improvement action error" },
      { status: 400 },
    );
  }
}

function normalizeAction(value: unknown): ImprovementAction | null {
  return value === "shadow_test" ||
    value === "prepare_patch_bundle" ||
    value === "approve" ||
    value === "reject" ||
    value === "defer" ||
    value === "mark_applied"
    ? value
    : null;
}
