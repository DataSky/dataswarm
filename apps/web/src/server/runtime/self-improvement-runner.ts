import { getEvalResult } from "../repositories/eval-results";
import { diagnoseConversation } from "../repositories/diagnostics";
import {
  createSelfImprovementCandidate,
  findSelfImprovementCandidateForEvalCheck,
  findSelfImprovementCandidateForDiagnosticRemediation,
  type SelfImprovementCandidateInput,
} from "../repositories/self-improvement";
import { completeTraceSpan, startTraceSpan } from "../repositories/trace";
import { publishRunEvent } from "./event-bus";

export type SelfImprovementEvalCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type SelfImprovementRunInput = {
  runId: string;
  conversationId: string;
  taskId?: string;
  traceId?: string;
  parentSpanId?: string;
  evalResultId: string;
};
type DiagnosticsRemediationItem = {
  id: string;
  category: string;
  severity: "low" | "medium" | "high";
  title: string;
  evidence: string[];
  recommendedAction: string;
  verificationCommands: string[];
};

export async function enqueueSelfImprovementAnalysis(input: SelfImprovementRunInput) {
  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "self_improvement.analysis.queued",
    producer: { kind: "evaluator", id: input.evalResultId, name: "Self Improvement Queue" },
    trace: input.traceId
      ? { trace_id: input.traceId, span_id: input.parentSpanId, parent_span_id: input.parentSpanId }
      : undefined,
    payload: {
      visibility: "internal",
      status: "queued",
      eval_result_id: input.evalResultId,
      execution: "async_microtask",
    },
  });

  queueMicrotask(() => {
    void runSelfImprovementAnalysis(input).catch(async (error) => {
      await publishRunEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        type: "self_improvement.analysis.failed",
        producer: { kind: "evaluator", id: input.evalResultId, name: "Self Improvement Queue" },
        trace: input.traceId
          ? { trace_id: input.traceId, span_id: input.parentSpanId, parent_span_id: input.parentSpanId }
          : undefined,
        payload: {
          visibility: "internal",
          status: "failed",
          eval_result_id: input.evalResultId,
          error: error instanceof Error ? error.message : "Unknown self-improvement analysis error",
        },
      });
    });
  });
}

export async function runSelfImprovementAnalysis(input: SelfImprovementRunInput) {
  const evalResult = await getEvalResult(input.runId, input.evalResultId);
  if (!evalResult) {
    throw new Error(`Eval result not found: ${input.evalResultId}`);
  }

  const analysisSpan = await startTraceSpan({
    traceId: input.traceId,
    parentSpanId: input.parentSpanId ?? evalResult.traceSpanId ?? undefined,
    runId: input.runId,
    spanKind: "self_improvement.analysis",
    name: "Analyze eval result for self-improvement candidates",
    attributes: {
      eval_result_id: evalResult.id,
      eval_type: evalResult.evalType,
      score: evalResult.score,
      visibility: "internal",
      execution: "async_worker",
    },
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "self_improvement.analysis.started",
    producer: { kind: "evaluator", id: evalResult.id, name: "Self Improvement Worker" },
    trace: { trace_id: analysisSpan.traceId, span_id: analysisSpan.id, parent_span_id: input.parentSpanId },
    payload: {
      visibility: "internal",
      status: "running",
      eval_result_id: evalResult.id,
    },
  });

  try {
    const checks = evalResult.checks.filter(isSelfImprovementEvalCheck);
    const recommendations = buildRecommendations(checks, Number(evalResult.score ?? 0));
    const candidates = await createImprovementCandidatesFromEval({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      traceId: analysisSpan.traceId,
      evalSpanId: evalResult.traceSpanId ?? analysisSpan.id,
      evalResultId: evalResult.id,
      checks,
      recommendations,
      score: Number(evalResult.score ?? 0),
    });

    if (candidates.length > 0) {
      await publishRunEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        type: "self_improvement.candidates.queued",
        producer: { kind: "evaluator", id: evalResult.id, name: "Self Improvement Worker" },
        trace: { trace_id: analysisSpan.traceId, span_id: analysisSpan.id, parent_span_id: input.parentSpanId },
        payload: {
          visibility: "internal",
          status: "queued",
          eval_result_id: evalResult.id,
          candidate_count: candidates.length,
          candidate_ids: candidates.map((candidate) => candidate.id),
        },
      });
    }

    await completeTraceSpan(analysisSpan.id, "completed", {
      eval_result_id: evalResult.id,
      candidate_count: candidates.length,
      visibility: "internal",
      output_summary: `Self-improvement analysis queued ${candidates.length} candidate(s).`,
    });

    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "self_improvement.analysis.completed",
      producer: { kind: "evaluator", id: evalResult.id, name: "Self Improvement Worker" },
      trace: { trace_id: analysisSpan.traceId, span_id: analysisSpan.id, parent_span_id: input.parentSpanId },
      payload: {
        visibility: "internal",
        status: "completed",
        eval_result_id: evalResult.id,
        candidate_count: candidates.length,
        candidate_ids: candidates.map((candidate) => candidate.id),
      },
    });

    return { evalResultId: evalResult.id, candidates };
  } catch (error) {
    await completeTraceSpan(analysisSpan.id, "failed", {
      eval_result_id: evalResult.id,
      error: error instanceof Error ? error.message : "Unknown self-improvement analysis error",
    });
    throw error;
  }
}

export async function runSelfImprovementDiagnosticsAnalysis(input: {
  runId: string;
  conversationId: string;
  taskId?: string;
  traceId?: string;
  parentSpanId?: string;
}) {
  const diagnostic = await diagnoseConversation(input.conversationId);
  if (!diagnostic) {
    throw new Error(`Conversation not found: ${input.conversationId}`);
  }

  const analysisSpan = await startTraceSpan({
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    runId: input.runId,
    spanKind: "self_improvement.analysis",
    name: "Analyze diagnostics remediation for self-improvement candidates",
    attributes: {
      conversation_id: input.conversationId,
      source: "diagnostics.remediation",
      remediation_count: diagnostic.summary.remediation?.length ?? 0,
      visibility: "internal",
      execution: "sync_api",
    },
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "self_improvement.diagnostics_analysis.started",
    producer: { kind: "diagnostics", id: input.conversationId, name: "Diagnostics Remediation Worker" },
    trace: { trace_id: analysisSpan.traceId, span_id: analysisSpan.id, parent_span_id: input.parentSpanId },
    payload: {
      visibility: "internal",
      status: "running",
      conversation_id: input.conversationId,
      remediation_count: diagnostic.summary.remediation?.length ?? 0,
    },
  });

  try {
    const remediation = (diagnostic.summary.remediation ?? []).filter(isDiagnosticsRemediationItem);
    const candidates = await createImprovementCandidatesFromDiagnostics({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      traceId: analysisSpan.traceId,
      traceSpanId: analysisSpan.id,
      remediation,
    });

    if (candidates.length > 0) {
      await publishRunEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        type: "self_improvement.candidates.queued",
        producer: { kind: "diagnostics", id: input.conversationId, name: "Diagnostics Remediation Worker" },
        trace: { trace_id: analysisSpan.traceId, span_id: analysisSpan.id, parent_span_id: input.parentSpanId },
        payload: {
          visibility: "internal",
          status: "queued",
          source: "diagnostics.remediation",
          candidate_count: candidates.length,
          candidate_ids: candidates.map((candidate) => candidate.id),
        },
      });
    }

    await completeTraceSpan(analysisSpan.id, "completed", {
      conversation_id: input.conversationId,
      candidate_count: candidates.length,
      visibility: "internal",
      output_summary: `Diagnostics remediation analysis queued ${candidates.length} candidate(s).`,
    });

    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "self_improvement.diagnostics_analysis.completed",
      producer: { kind: "diagnostics", id: input.conversationId, name: "Diagnostics Remediation Worker" },
      trace: { trace_id: analysisSpan.traceId, span_id: analysisSpan.id, parent_span_id: input.parentSpanId },
      payload: {
        visibility: "internal",
        status: "completed",
        source: "diagnostics.remediation",
        candidate_count: candidates.length,
        candidate_ids: candidates.map((candidate) => candidate.id),
      },
    });

    return { conversationId: input.conversationId, remediationCount: remediation.length, candidates };
  } catch (error) {
    await completeTraceSpan(analysisSpan.id, "failed", {
      conversation_id: input.conversationId,
      error: error instanceof Error ? error.message : "Unknown diagnostics self-improvement analysis error",
    });
    throw error;
  }
}

async function createImprovementCandidatesFromEval(input: {
  runId: string;
  conversationId: string;
  taskId?: string;
  traceId: string;
  evalSpanId: string;
  evalResultId: string;
  checks: SelfImprovementEvalCheck[];
  recommendations: string[];
  score: number;
}) {
  const failedChecks = input.checks.filter((check) => !check.passed);
  if (failedChecks.length === 0 && input.score >= 0.95) {
    return [];
  }

  const candidates = [];
  for (const check of failedChecks.slice(0, 5)) {
    const existing = await findSelfImprovementCandidateForEvalCheck({
      runId: input.runId,
      evalResultId: input.evalResultId,
      checkId: check.id,
    });
    if (existing) {
      candidates.push({ id: existing.id });
      continue;
    }

    const candidate = await createSelfImprovementCandidate({
      runId: input.runId,
      conversationId: input.conversationId,
      evalResultId: input.evalResultId,
      candidateType: classifyCandidateType(check),
      severity: input.score < 0.7 ? "high" : input.score < 0.9 ? "medium" : "low",
      title: `Improve ${check.label}`,
      rationale: check.detail,
      evidence: {
        check_id: check.id,
        trace_id: input.traceId,
        eval_span_id: input.evalSpanId,
        task_id: input.taskId,
      },
      proposal: {
        recommendation: input.recommendations.find((recommendation) => recommendation.includes(check.label)) ?? check.detail,
        requires_human_approval: true,
        generated_by: "self_improvement.analysis",
      },
      verificationPlan: {
        required_commands: verificationCommandsForCheck(check),
        acceptance: `The ${check.id} eval check passes on a representative rerun.`,
      },
      traceSpanId: input.evalSpanId,
    });
    candidates.push(candidate);
  }
  return candidates;
}

async function createImprovementCandidatesFromDiagnostics(input: {
  runId: string;
  conversationId: string;
  taskId?: string;
  traceId: string;
  traceSpanId: string;
  remediation: DiagnosticsRemediationItem[];
}) {
  const candidates = [];
  for (const item of input.remediation.slice(0, 8)) {
    if (item.category === "self_improvement") {
      continue;
    }
    const existing = await findSelfImprovementCandidateForDiagnosticRemediation({
      runId: input.runId,
      remediationId: item.id,
      source: "diagnostics.remediation",
    });
    if (existing) {
      candidates.push({ id: existing.id });
      continue;
    }
    const candidate = await createSelfImprovementCandidate({
      runId: input.runId,
      conversationId: input.conversationId,
      candidateType: classifyDiagnosticCandidateType(item),
      severity: item.severity,
      title: item.title,
      rationale: item.recommendedAction,
      evidence: {
        source: "diagnostics.remediation",
        remediation_id: item.id,
        remediation_category: item.category,
        trace_id: input.traceId,
        trace_span_id: input.traceSpanId,
        task_id: input.taskId,
        evidence: item.evidence,
      },
      proposal: {
        recommendation: item.recommendedAction,
        remediation_category: item.category,
        requires_human_approval: true,
        generated_by: "self_improvement.diagnostics_analysis",
      },
      verificationPlan: {
        required_commands: item.verificationCommands.length > 0 ? item.verificationCommands : ["npm --prefix apps/web run typecheck"],
        acceptance: `The diagnostics remediation item ${item.id} is resolved or no longer emitted for a representative rerun.`,
      },
      traceSpanId: input.traceSpanId,
    });
    candidates.push(candidate);
  }
  return candidates;
}

function classifyDiagnosticCandidateType(item: DiagnosticsRemediationItem): SelfImprovementCandidateInput["candidateType"] {
  if (item.category === "product_observability") {
    return "ui_bug_report";
  }
  if (item.category === "agentic_evidence") {
    return "runtime_policy_patch";
  }
  if (item.category === "self_improvement") {
    return "runtime_policy_patch";
  }
  if (/tool|artifact/i.test(item.category)) {
    return "tool_adapter_patch";
  }
  return "runtime_policy_patch";
}

function buildRecommendations(checks: SelfImprovementEvalCheck[], score: number) {
  const recommendations = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.label}: ${check.detail}`);
  if (recommendations.length === 0 && score < 0.95) {
    recommendations.push("Run health score is below the target threshold; inspect trace spans and event coverage.");
  }
  return recommendations;
}

function verificationCommandsForCheck(check: SelfImprovementEvalCheck) {
  if (/skill/i.test(check.id)) {
    return ["npm --prefix apps/web run typecheck", "node scripts/skills-v2-smoke.mjs"];
  }
  if (/e2b|template/i.test(check.id)) {
    return [
      "npm --prefix apps/web run typecheck",
      "node scripts/e2b-template-smoke.mjs",
      "node scripts/e2b-template-receipt-smoke.mjs",
      "node scripts/e2b-readiness-smoke.mjs",
      "node scripts/e2b-live-receipt-smoke.mjs",
    ];
  }
  if (/sandbox|swarm/i.test(check.id)) {
    return [
      "npm --prefix apps/web run typecheck",
      "node scripts/sandbox-agent-smoke.mjs",
      "node scripts/sandbox-retry-policy-smoke.mjs",
    ];
  }
  return ["npm --prefix apps/web run typecheck", "node scripts/agentic-loop-v2-smoke.mjs"];
}

function classifyCandidateType(check: SelfImprovementEvalCheck): SelfImprovementCandidateInput["candidateType"] {
  if (/artifact/i.test(check.id)) {
    return "tool_adapter_patch";
  }
  if (/tool|web|site/i.test(check.id)) {
    return "tool_adapter_patch";
  }
  if (/skill/i.test(check.id)) {
    return "skill_patch";
  }
  if (/e2b|sandbox|swarm|template/i.test(check.id)) {
    return "runtime_policy_patch";
  }
  if (/message|final_answer|claim/i.test(check.id)) {
    return "prompt_patch";
  }
  if (/event|run|action|observation/i.test(check.id)) {
    return "runtime_policy_patch";
  }
  return "runtime_policy_patch";
}

function isSelfImprovementEvalCheck(value: unknown): value is SelfImprovementEvalCheck {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SelfImprovementEvalCheck).id === "string" &&
    typeof (value as SelfImprovementEvalCheck).label === "string" &&
    typeof (value as SelfImprovementEvalCheck).passed === "boolean" &&
    typeof (value as SelfImprovementEvalCheck).detail === "string"
  );
}

function isDiagnosticsRemediationItem(value: unknown): value is DiagnosticsRemediationItem {
  const item = value as DiagnosticsRemediationItem;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof item.id === "string" &&
    typeof item.category === "string" &&
    (item.severity === "low" || item.severity === "medium" || item.severity === "high") &&
    typeof item.title === "string" &&
    Array.isArray(item.evidence) &&
    item.evidence.every((entry) => typeof entry === "string") &&
    typeof item.recommendedAction === "string" &&
    Array.isArray(item.verificationCommands) &&
    item.verificationCommands.every((entry) => typeof entry === "string")
  );
}
