import { createEvalResult } from "../repositories/eval-results";
import { listRunEventsAfter } from "../repositories/events";
import { listAgentActions } from "../repositories/agent-actions";
import { listObservations } from "../repositories/observations";
import { completeTraceSpan, listTraceSpans, startTraceSpan } from "../repositories/trace";
import { publishRunEvent } from "./event-bus";
import { enqueueSelfImprovementAnalysis } from "./self-improvement-runner";

type EvalCheck = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
};

export async function evaluateRunAndRecommend(input: {
  runId: string;
  taskId: string;
  conversationId: string;
  agentSessionId: string;
  traceId: string;
  parentSpanId: string;
  latestUserMessage: string;
  selectedSkillNames: string[];
  freshWebEvidenceRequired: boolean;
  responseText: string;
  artifactIds: string[];
}) {
  const evalSpan = await startTraceSpan({
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    spanKind: "eval.run",
    name: "Evaluate run protocol and output",
    attributes: { artifact_count: input.artifactIds.length },
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "eval.started",
    producer: { kind: "evaluator", id: evalSpan.id, name: "Run Evaluator" },
    trace: { trace_id: input.traceId, span_id: evalSpan.id, parent_span_id: input.parentSpanId },
    payload: { eval_type: "run_health", status: "running" },
  });

  const events = await listRunEventsAfter(input.runId, 0);
  const spans = await listTraceSpans(input.runId);
  const actions = await listAgentActions(input.runId);
  const observations = await listObservations(input.runId);
  const eventTypes = new Set(events.map((event) => event.type));
  const spanKinds = new Set(
    spans
      .map((span) => (span as { span_kind?: unknown }).span_kind)
      .filter((value): value is string => typeof value === "string"),
  );
  const failedEvents = events.filter((event) => /failed|error/i.test(event.type));
  const toolEvents = events.filter((event) => event.type.startsWith("tool.call."));
  const toolEventsWithActionId = toolEvents.filter((event) => hasPayloadKey(event, "action_id"));
  const terminalToolEvents = toolEvents.filter((event) => event.type === "tool.call.completed" || event.type === "tool.call.failed");
  const terminalToolEventsWithObservationEvidence = terminalToolEvents.filter(
    (event) => hasPayloadKey(event, "observation_id") && hasPayloadKey(event, "evidence_level"),
  );
  const executedToolActions = actions.filter(
    (action) => action.actionType === "call_tool" && action.status !== "proposed",
  );
  const completedToolActions = actions.filter(
    (action) => action.actionType === "call_tool" && action.status === "executed",
  );
  const completedToolObservations = observations.filter(
    (observation) => observation.sourceType === "tool" && observation.status === "completed",
  );
  const webSearchObservations = completedToolObservations.filter(isWebSearchObservation);
  const emptyWebSearchObservations = webSearchObservations.filter((observation) => observationSourceCount(observation) === 0);
  const nonEmptyWebSearchObservations = webSearchObservations.filter((observation) => observationSourceCount(observation) > 0);
  const requiredSiteDomains = extractRequiredSiteDomains(input.latestUserMessage);
  const siteMatchedWebSearchObservations = webSearchObservations.filter((observation) =>
    observationHasRequiredDomain(observation, requiredSiteDomains),
  );
  const claimsFreshWebExecution = claimsWebToolExecution(input.responseText);

  const checks: EvalCheck[] = [
    {
      id: "run_started",
      label: "Run start event exists",
      passed: eventTypes.has("run.started"),
      detail: "The run should expose a durable start event.",
    },
    {
      id: "planner_action_exists",
      label: "Planner action exists",
      passed: eventTypes.has("action.proposed") && actions.length > 0,
      detail: `Agentic Runtime v2 requires structured model actions; persisted actions: ${actions.length}.`,
    },
    {
      id: "action_validated",
      label: "Planner action was validated",
      passed: eventTypes.has("action.validated") && actions.some((action) => action.status !== "proposed"),
      detail: "Runtime should validate model-proposed actions before execution or final answer.",
    },
    {
      id: "model_completed",
      label: "Model call completed",
      passed: eventTypes.has("model.call.completed") && spanKinds.has("model.call"),
      detail: "The final response should be backed by a completed model span.",
    },
    {
      id: "message_completed",
      label: "Assistant response text exists",
      passed: eventTypes.has("message.created") && input.responseText.trim().length > 0,
      detail: "The assistant message should exist and the generated response text must be non-empty before evaluation.",
    },
    {
      id: "artifact_contract",
      label: "Artifact previews are ready",
      passed:
        input.artifactIds.length === 0 ||
        events.filter((event) => event.type === "artifact.preview.ready").length >= input.artifactIds.length,
      detail: "Every artifact produced before evaluation should have a preview-ready event.",
    },
    {
      id: "failure_signals",
      label: "No failure events observed",
      passed: failedEvents.length === 0,
      detail: `${failedEvents.length} failure-like events found.`,
    },
    {
      id: "required_web_evidence",
      label: "Fresh web evidence exists when required",
      passed: !input.freshWebEvidenceRequired || nonEmptyWebSearchObservations.length > 0,
      detail: input.freshWebEvidenceRequired
        ? `Latest user message required fresh external evidence; selected skills: ${
            input.selectedSkillNames.join(", ") || "none"
          }; non-empty web observations: ${nonEmptyWebSearchObservations.length}; empty web observations: ${emptyWebSearchObservations.length}.`
        : "Latest user message did not require fresh external evidence.",
    },
    {
      id: "empty_web_result_recovery",
      label: "Empty web results trigger recovery",
      passed: emptyWebSearchObservations.length === 0 || nonEmptyWebSearchObservations.length > 0,
      detail:
        emptyWebSearchObservations.length > 0
          ? `${emptyWebSearchObservations.length} empty web observation(s), ${nonEmptyWebSearchObservations.length} non-empty recovery observation(s).`
          : "No empty web observations were created.",
    },
    {
      id: "required_site_domain_respected",
      label: "Required site/domain constraints are respected",
      passed: requiredSiteDomains.length === 0 || siteMatchedWebSearchObservations.length > 0,
      detail:
        requiredSiteDomains.length > 0
          ? `Required domain(s): ${requiredSiteDomains.join(", ")}; matching web observations: ${siteMatchedWebSearchObservations.length}.`
          : "Latest user message did not include a site/domain constraint.",
    },
    {
      id: "tool_claim_consistency",
      label: "Tool claims are backed by trace evidence",
      passed: !claimsFreshWebExecution || completedToolObservations.length > 0,
      detail: claimsFreshWebExecution
        ? `Assistant claimed fresh search/tool execution; completed tool observations: ${completedToolObservations.length}.`
        : "Assistant did not claim fresh web/tool execution.",
    },
    {
      id: "tool_events_have_action_id",
      label: "Tool events reference model action",
      passed: toolEvents.length === 0 || toolEventsWithActionId.length === toolEvents.length,
      detail: `${toolEventsWithActionId.length}/${toolEvents.length} tool events include action_id.`,
    },
    {
      id: "terminal_tool_events_have_observation_evidence",
      label: "Terminal tool events reference observation evidence",
      passed:
        executedToolActions.length === 0
          ? terminalToolEvents.length === 0
          : terminalToolEvents.length >= executedToolActions.length &&
            terminalToolEventsWithObservationEvidence.length === terminalToolEvents.length,
      detail: `${terminalToolEventsWithObservationEvidence.length}/${terminalToolEvents.length} terminal tool events include observation_id and evidence_level for ${executedToolActions.length} executed tool action(s).`,
    },
    {
      id: "tool_action_observation",
      label: "Executed tool actions create observations",
      passed: completedToolActions.length === 0 || completedToolObservations.length >= completedToolActions.length,
      detail: `${completedToolActions.length} executed tool action(s), ${completedToolObservations.length} completed tool observation(s).`,
    },
    {
      id: "final_answer_evidence_refs",
      label: "Final answer references observations when tool evidence exists",
      passed:
        completedToolObservations.length === 0 ||
        completedToolObservations.some((observation) => input.responseText.includes(observation.id)),
      detail:
        completedToolObservations.length > 0
          ? `Final answer should cite at least one of: ${completedToolObservations
              .map((observation) => observation.id)
              .join(", ")}.`
          : "No tool observations were created.",
    },
  ];

  const score = checks.filter((check) => check.passed).length / checks.length;
  const summary = `Run health score ${(score * 100).toFixed(0)}% (${checks.filter((check) => check.passed).length}/${checks.length} checks passed).`;
  const recommendations = buildRecommendations(checks, {
    eventCount: events.length,
    spanCount: spans.length,
    artifactCount: input.artifactIds.length,
  });

  const evalResult = await createEvalResult({
    runId: input.runId,
    artifactId: null,
    evalType: "run_health",
    status: "completed",
    score,
    summary,
    checks,
    traceSpanId: evalSpan.id,
    metadata: {
      recommendation_count: recommendations.length,
      recommendations,
      visibility: "internal",
      schedule: "post_run_async_candidate",
    },
  });
  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "eval.completed",
    producer: { kind: "evaluator", id: evalResult.id, name: "Run Evaluator" },
    trace: { trace_id: input.traceId, span_id: evalSpan.id, parent_span_id: input.parentSpanId },
    payload: {
      eval_result_id: evalResult.id,
      eval_type: "run_health",
      status: "completed",
      score,
      summary,
      visibility: "internal",
      recommendation_count: recommendations.length,
    },
  });

  await enqueueSelfImprovementAnalysis({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    traceId: input.traceId,
    parentSpanId: evalSpan.id,
    evalResultId: evalResult.id,
  });

  await completeTraceSpan(evalSpan.id, "completed", {
    eval_result_id: evalResult.id,
    score,
    visibility: "internal",
    recommendation_count: recommendations.length,
    output_summary: summary,
  });

  return {
    evalResultId: evalResult.id,
    summary,
    score,
  };
}

function hasPayloadKey(event: { payload?: unknown }, key: string) {
  return typeof event.payload === "object" && event.payload !== null && key in event.payload;
}

function claimsWebToolExecution(text: string) {
  return /(?:本轮|刚刚|已经|已完成|我已|我已经|重新|直接)(?:.{0,18})(?:联网|搜索|检索|查询|查到|找到了)|Tavily(?:.{0,12})(?:返回|搜索|检索|结果)|(?:本轮搜索|本轮检索|搜索结果|检索结果|查询结果|来源显示)(?:.{0,12})(?:返回|结果|来源|显示)?/i.test(
    text,
  );
}

function observationSourceCount(observation: { metadata?: Record<string, unknown> }) {
  const sources = observation.metadata?.sources;
  return Array.isArray(sources) ? sources.length : 0;
}

function isWebSearchObservation(observation: { sourceName?: string; metadata?: Record<string, unknown> }) {
  return (
    observation.sourceName === "web.search" ||
    observation.sourceName === "tavily.search" ||
    observation.metadata?.capability_kind === "web_search"
  );
}

function observationHasRequiredDomain(observation: { metadata?: Record<string, unknown> }, requiredDomains: string[]) {
  if (requiredDomains.length === 0) {
    return false;
  }
  const sources = observation.metadata?.sources;
  if (!Array.isArray(sources)) {
    return false;
  }
  return sources.some((source) => {
    if (!source || typeof source !== "object") {
      return false;
    }
    const url = String((source as { url?: unknown }).url ?? "");
    const hostname = hostnameFromUrl(url);
    return requiredDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  });
}

function extractRequiredSiteDomains(text: string) {
  const domains = new Set<string>();
  for (const match of text.matchAll(/\bsite:([a-z0-9.-]+\.[a-z]{2,})(?:\/[^\s]*)?/gi)) {
    const domain = normalizeDomain(match[1]);
    if (domain) {
      domains.add(domain);
    }
  }
  return [...domains];
}

function hostnameFromUrl(url: string) {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return "";
  }
}

function normalizeDomain(domain: string) {
  return domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/:?#].*$/, "");
}

function buildRecommendations(
  checks: EvalCheck[],
  counts: { eventCount: number; spanCount: number; artifactCount: number },
) {
  const recommendations = [
    `Keep run replay tests focused on persisted events; this run recorded ${counts.eventCount} event(s).`,
    `Use trace span count (${counts.spanCount}) as a regression signal for missing runtime phases.`,
  ];
  if (counts.artifactCount > 0) {
    recommendations.push(`Verify preview/download endpoints for all ${counts.artifactCount} generated artifact(s).`);
  }
  for (const check of checks.filter((item) => !item.passed)) {
    recommendations.push(`Improve ${check.label}: ${check.detail}`);
  }
  return recommendations;
}
