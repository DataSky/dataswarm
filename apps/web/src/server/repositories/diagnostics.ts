import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../storage/db";
import { dataDir, resolveLocalUri } from "../storage/paths";
import { getSandboxCapabilityPlaneHealth } from "../runtime/sandbox-tool-proxy";
import { listObservedLogsForConversation } from "./logs";
import { listSelfImprovementCandidates } from "./self-improvement";

type Row = Record<string, unknown>;
type ObservedLog = {
  source?: string;
  event?: string;
  runId?: string | null;
  payload?: unknown;
};
type LiveSmokeEvidenceSummary = {
  verifiedCount: number;
  unverifiedCount: number;
  receiptPaths: Set<string>;
  receiptStatuses: Map<string, number>;
  verifiedAt: Set<string>;
  externalSandboxIds: Set<string>;
  elapsedMs: number[];
};
type RemediationItem = {
  id: string;
  category: string;
  severity: "low" | "medium" | "high";
  title: string;
  evidence: string[];
  recommendedAction: string;
  verificationCommands: string[];
};
type CanonicalVerificationReceiptSummary = {
  receiptCount: number;
  receiptPaths: string[];
  totalGates: number;
  passed: number;
  failed: number;
  gatedSkip: number;
  notRun: number;
  phases: Record<string, { total: number; passed: number; failed: number; gatedSkip: number; notRun: number }>;
  liveE2bRequired: boolean;
  liveE2bGated: boolean;
  latestCompletedAt: string | null;
  verificationCommands: string[];
  diagnosis: string[];
};
type CapabilityPlaneHealthSummary =
  | ReturnType<typeof getSandboxCapabilityPlaneHealth>
  | {
      status: "failed";
      runtimeProfile: string;
      realProfile: boolean;
      mockSignals: Record<string, unknown>;
      mockContamination: boolean;
      readiness: null;
      capabilityPlane: null;
      endpoints: null;
      hardFailures: string[];
      error: {
        code: string;
        message: string;
      };
    };

export async function diagnoseConversation(conversationId: string) {
  const db = await getDb();
  const conversation = db
    .prepare(
      `SELECT id, title, status, default_model, last_message_at, created_at, updated_at
       FROM conversations
       WHERE id = ?`,
    )
    .get(conversationId) as Row | undefined;

  if (!conversation) {
    return null;
  }

  const messages = db
    .prepare(
      `SELECT id, run_id, role, status, parts_json, created_at, updated_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as Row[];

  const runs = db
    .prepare(
      `SELECT id, task_id, mode, status, model_profile, started_at, ended_at, result_summary, error_json, created_at, updated_at
       FROM runs
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as Row[];
  const runIds = runs.map((run) => String(run.id));
  const runIdPlaceholders = runIds.map(() => "?").join(",");

  const events =
    runIds.length > 0
      ? (db
          .prepare(
            `SELECT id, run_id, seq, event_type, producer_kind, producer_id, payload_json, created_at
             FROM run_events
             WHERE run_id IN (${runIdPlaceholders})
             ORDER BY run_id ASC, seq ASC`,
          )
          .all(...runIds) as Row[])
      : [];

  const rawToolCalls =
    runIds.length > 0
      ? (db
          .prepare(
            `SELECT tc.id, tc.run_id, t.name AS tool_name, tc.status, tc.input_summary, tc.output_summary,
                    tc.output_payload_uri, tc.error_json, tc.started_at, tc.ended_at, tc.created_at, tc.updated_at
             FROM tool_calls tc
             JOIN tools t ON t.id = tc.tool_id
             WHERE tc.run_id IN (${runIdPlaceholders})
             ORDER BY tc.created_at ASC`,
          )
          .all(...runIds) as Row[])
      : [];
  const toolCalls: Row[] = await Promise.all(
    rawToolCalls.map(async (call) => ({
      ...call,
      output_payload: await readLocalJson(call.output_payload_uri),
    })),
  );

  const skillUsages =
    runIds.length > 0
      ? (db
          .prepare(
            `SELECT su.id, su.run_id, s.name AS skill_name, su.status, su.input_summary, su.output_summary,
                    su.trace_span_id, su.created_at, su.updated_at
             FROM skill_usages su
             JOIN skills s ON s.id = su.skill_id
             WHERE su.run_id IN (${runIdPlaceholders})
             ORDER BY su.created_at ASC`,
          )
          .all(...runIds) as Row[])
      : [];

  const observations =
    runIds.length > 0
      ? (db
          .prepare(
            `SELECT id, run_id, action_id, source_type, source_name, status, summary, payload_uri,
                    evidence_level, claims_json, metadata_json, created_at
             FROM observations
             WHERE run_id IN (${runIdPlaceholders})
             ORDER BY created_at ASC`,
          )
          .all(...runIds) as Row[])
      : [];

  const traceSpans =
    runIds.length > 0
      ? (db
          .prepare(
            `SELECT id, trace_id, parent_span_id, run_id, agent_session_id, span_kind, name, status,
                    started_at, ended_at, attributes_json, redaction_status
             FROM trace_spans
             WHERE run_id IN (${runIdPlaceholders})
             ORDER BY started_at ASC`,
          )
          .all(...runIds) as Row[])
      : [];

  const evals =
    runIds.length > 0
      ? (db
          .prepare(
            `SELECT id, run_id, artifact_id, eval_type, status, score, summary, checks_json, trace_span_id, created_at
             FROM eval_results
             WHERE run_id IN (${runIdPlaceholders})
             ORDER BY created_at ASC`,
          )
          .all(...runIds) as Row[])
      : [];

  const sandboxSessions =
    runIds.length > 0
      ? (db
          .prepare(
            `SELECT id, run_id, agent_session_id, provider, external_sandbox_id, status, template,
                    started_at, ended_at, last_heartbeat_at, metadata_json, created_at, updated_at
             FROM sandbox_sessions
             WHERE run_id IN (${runIdPlaceholders})
             ORDER BY created_at ASC`,
          )
          .all(...runIds) as Row[])
      : [];

  const artifacts = db
    .prepare(
      `SELECT id, run_id, type, mime_type, title, status, storage_uri, preview_uri, metadata_json, created_at
       FROM artifacts
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as Row[];
  const logs = await listObservedLogsForConversation(conversationId);
  const selfImprovementCandidates = (
    await Promise.all(runIds.map((runId) => listSelfImprovementCandidates(runId)))
  ).flat();
  const canonicalVerification = await readCanonicalVerificationSummary();
  const capabilityPlaneHealth = buildCapabilityPlaneHealthSummary();

  return {
    conversation,
    summary: buildSummary({
      messages,
      runs,
      events,
      toolCalls,
      skillUsages,
      observations,
      traceSpans,
      evals,
      sandboxSessions,
      artifacts,
      logs,
      selfImprovementCandidates,
      canonicalVerification,
      capabilityPlaneHealth,
    }),
    messages: messages.map((message) => ({
      ...message,
      parts: parseJson(message.parts_json),
      parts_json: undefined,
    })),
    runs,
    events: events.map((event) => ({
      ...event,
      payload: parseJson(event.payload_json),
      payload_json: undefined,
    })),
    skillUsages,
    observations: observations.map((observation) => ({
      ...observation,
      claims: parseJson(observation.claims_json),
      metadata: parseJson(observation.metadata_json),
      claims_json: undefined,
      metadata_json: undefined,
    })),
    toolCalls: toolCalls.map((call) => ({
      ...call,
      outputPayload: call.output_payload,
      output_payload: undefined,
      error: parseJson(call.error_json),
      error_json: undefined,
    })),
    traceSpans: traceSpans.map((span) => ({
      ...span,
      attributes: parseJson(span.attributes_json),
      attributes_json: undefined,
    })),
    evals: evals.map((item) => ({
      ...item,
      checks: parseJson(item.checks_json),
      checks_json: undefined,
    })),
    sandboxSessions: sandboxSessions.map((session) => ({
      ...session,
      metadata: parseJson(session.metadata_json),
      metadata_json: undefined,
    })),
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      metadata: parseJson(artifact.metadata_json),
      metadata_json: undefined,
    })),
    logs,
    selfImprovementCandidates,
    canonicalVerification,
    capabilityPlaneHealth,
  };
}

function buildSummary(input: {
  messages: Row[];
  runs: Row[];
  events: Row[];
  toolCalls: Row[];
  skillUsages: Row[];
  observations: Row[];
  traceSpans: Row[];
  evals: Row[];
  sandboxSessions: Row[];
  artifacts: Row[];
  logs: ObservedLog[];
  selfImprovementCandidates: Array<{
    id: string;
    runId: string;
    candidateType: string;
    status: string;
    severity: string;
    title: string;
    proposal: Record<string, unknown>;
    verificationPlan: Record<string, unknown>;
  }>;
  canonicalVerification: CanonicalVerificationReceiptSummary;
  capabilityPlaneHealth: CapabilityPlaneHealthSummary;
}) {
  const eventTypes = new Map<string, number>();
  for (const event of input.events) {
    const type = String(event.event_type);
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
  }
  const toolNames = input.toolCalls.map((call) => String(call.tool_name));
  const skillNames = input.skillUsages.map((usage) => String(usage.skill_name));
  const failures = [
    ...input.runs.filter((run) => run.status !== "completed").map((run) => `run:${run.id}:${run.status}`),
    ...input.toolCalls.filter((call) => call.status !== "completed").map((call) => `tool:${call.tool_name}:${call.status}`),
    ...input.events.filter((event) => /failed|error/i.test(String(event.event_type))).map((event) => `event:${event.event_type}`),
  ];
  const hasWebResearch = skillNames.includes("web-research");
  const hasWebSearchTool = toolNames.some(isWebSearchToolName);
  const hasTavily = toolNames.includes("tavily.search");
  const hasMockWebSearch = input.toolCalls.some((call) => {
    if (!isWebSearchToolName(String(call.tool_name))) {
      return false;
    }
    const outputPayload = call.output_payload;
    return (
      JSON.stringify(outputPayload).includes("Mock source") ||
      JSON.stringify(outputPayload).includes("local://docs/") ||
      String(call.output_summary ?? "").includes("mock")
    );
  });
  const productHealth = buildProductHealth(input.logs, input.events, input.toolCalls);
  const qualityIssues = buildQualityIssues(input.toolCalls, input.evals, input.events, input.messages);
  const observations = buildObservationSummary(input.observations);
  const sandbox = buildSandboxSummary(input.sandboxSessions, input.events);
  const selfImprovement = buildSelfImprovementSummary(input.selfImprovementCandidates);
  const runtimeConsistency = buildRuntimeConsistencySummary(input.runs, input.events, input.traceSpans);
  const swarmEvidence = buildSwarmEvidenceSummary(input.events, input.toolCalls, input.observations, input.artifacts);
  const canonicalVerification = input.canonicalVerification;
  const capabilityPlaneHealth = input.capabilityPlaneHealth;
  const finalAnswerEvidence = buildFinalAnswerEvidenceSummary(input.messages, input.observations, input.artifacts);
  const remediation = buildRemediationPlan({
    productHealth,
    qualityIssues,
    observations,
    sandbox,
    selfImprovement,
    runtimeConsistency,
    swarmEvidence,
    canonicalVerification,
    capabilityPlaneHealth,
    finalAnswerEvidence,
  });

  return {
    messageCount: input.messages.length,
    runCount: input.runs.length,
    eventCount: input.events.length,
    traceSpanCount: input.traceSpans.length,
    evalCount: input.evals.length,
    logCount: input.logs.length,
    visibleArtifactCandidateCount: input.artifacts.filter((artifact) => artifact.title !== "DataSwarm Self-Improvement Report").length,
    eventTypes: Object.fromEntries(eventTypes),
    skillNames,
    toolNames,
    hasWebResearch,
    hasWebSearchTool,
    hasTavily,
    likelyUsedMockSearch: hasMockWebSearch,
    productHealth,
    qualityIssues,
    observations,
    sandbox,
    selfImprovement,
    runtimeConsistency,
    swarmEvidence,
    canonicalVerification,
    capabilityPlaneHealth,
    finalAnswerEvidence,
    remediation,
    failures,
    diagnosis: [
      hasWebResearch ? "web-research skill selected." : "web-research skill was not selected.",
      hasWebSearchTool ? "web_search tool call recorded." : "web_search tool call not recorded.",
      hasTavily ? "Tavily provider/direct adapter appeared in the tool trace." : "Tavily provider/direct adapter did not appear in the tool trace.",
      hasMockWebSearch ? "Search output appears to be mock/local source content." : "Search output does not show mock/local source markers.",
      ...productHealth.diagnosis,
      ...qualityIssues.map((issue) => `Quality issue: ${issue}`),
      ...observations.diagnosis,
      ...sandbox.diagnosis,
      ...selfImprovement.diagnosis,
      ...runtimeConsistency.diagnosis,
      ...swarmEvidence.diagnosis,
      ...canonicalVerification.diagnosis,
      ...capabilityPlaneHealthDiagnosis(capabilityPlaneHealth),
      ...finalAnswerEvidence.diagnosis,
      remediation.length === 0
        ? "No structured remediation items generated."
        : `${remediation.length} structured remediation item(s) generated.`,
      failures.length === 0 ? "No failure markers detected." : `${failures.length} failure marker(s) detected.`,
    ],
  };
}

function buildSwarmEvidenceSummary(events: Row[], toolCalls: Row[], observations: Row[], artifacts: Row[]) {
  const verifyEvents = events.filter((event) => String(event.event_type) === "swarm.verify");
  const reduceEvents = events.filter((event) => String(event.event_type) === "swarm.reduce");
  const artifactContextEvents = events.filter((event) => String(event.event_type) === "artifact.context.prepared");
  const branchCompletedEvents = events.filter((event) => String(event.event_type) === "swarm.branch.completed");
  const branchContractMaterializedEvents = events.filter((event) => String(event.event_type) === "swarm.branch.contract.materialized");
  const branchFinalMaterializedEvents = events.filter((event) => String(event.event_type) === "swarm.branch.final.materialized");
  const branchPayloads = branchCompletedEvents.map(payloadOf);
  const branchQualitySignals = branchPayloads.map((payload) => recordOrEmpty(payload.quality_signals));
  const fallbackActionCount = branchQualitySignals.reduce((sum, signal) => sum + (Number(signal.fallbackActionCount ?? 0) || 0), 0);
  const degradedBranchCount = branchQualitySignals.filter((signal) => signal.degradedExecution === true || signal.fallbackPolicyStatus === "degraded").length;
  const e2bSandboxSessions = branchPayloads.filter((payload) => String(payload.external_sandbox_id ?? "").length > 0);
  const capabilityCompletedEvents = events.filter((event) => String(event.event_type) === "capability.invoke.completed");
  const capabilityFailedEvents = events.filter((event) => String(event.event_type) === "capability.invoke.failed");
  const proxyCompletedEvents = events.filter((event) => String(event.event_type) === "sandbox.tool_proxy.call.completed");
  const proxyFailedEvents = events.filter((event) => String(event.event_type) === "sandbox.tool_proxy.call.failed");
  const sandboxActionEvents = events.filter((event) => String(event.event_type).startsWith("sandbox.agent.action"));
  const sandboxObservationEvents = events.filter((event) => String(event.event_type) === "sandbox.agent.observation");
  const repairStartedEvents = events.filter((event) => String(event.event_type) === "sandbox.agent.action_repair_started");
  const repairSucceededEvents = events.filter((event) => String(event.event_type) === "sandbox.agent.action_repair_succeeded");
  const repairFailedEvents = events.filter((event) => String(event.event_type) === "sandbox.agent.action_repair_failed");
  const finalArtifactEvents = events.filter((event) => String(event.event_type) === "swarm.final_artifact.created");
  const latestVerifyPayload = payloadOf(verifyEvents.at(-1));
  const latestReducePayload = payloadOf(reduceEvents.at(-1));
  const reducerInputCoverage = recordOrEmpty(latestReducePayload.reducer_input_coverage);
  const latestEventEvidence = recordOrEmpty(latestVerifyPayload.event_evidence);
  const verificationGateCoverage = recordOrEmpty(latestVerifyPayload.gate_coverage);
  const latestChecks = Array.isArray(latestVerifyPayload.checks) ? latestVerifyPayload.checks.filter(isRecord) : [];
  const failedChecks = latestChecks.filter((check) => String(check.status) === "failed");
  const requiredToolEventFailedCheckCount = failedChecks.filter((check) => String(check.id) === "required_tool_event_coverage").length;
  const parentProxyFailedCheckCount = failedChecks.filter((check) => String(check.id) === "parent_proxy_event_coverage").length;
  const branchFinalContentPresentFailedCheckCount = failedChecks.filter((check) => String(check.id) === "branch_final_content_present").length;
  const successfulToolCallCoverageFailedCheckCount = failedChecks.filter((check) => String(check.id) === "successful_tool_call_coverage").length;
  const capabilityEventCoverageFailedCheckCount = failedChecks.filter((check) => String(check.id) === "capability_event_coverage").length;
  const parentProxyCoverageFailedCheckCount = failedChecks.filter((check) => String(check.id) === "parent_proxy_coverage").length;
  const fallbackActionPolicyFailedCheckCount = failedChecks.filter((check) => String(check.id) === "fallback_action_policy").length;
  const branchObservationMetadata = observations
    .filter((observation) => String(observation.source_name ?? "").startsWith("swarm.branch."))
    .map((observation) => parseJson(observation.metadata_json))
    .filter(isRecord);
  const branchContractCount = branchObservationMetadata.filter((metadata) => isRecord(metadata.branch_contract)).length;
  const branchFinalCount = branchObservationMetadata.filter((metadata) => isRecord(metadata.branch_final)).length;
  const branchFinalLimitationCount = branchObservationMetadata.reduce((sum, metadata) => {
    const branchFinal = recordOrEmpty(metadata.branch_final);
    return sum + (Array.isArray(branchFinal.limitations) ? branchFinal.limitations.length : 0);
  }, 0);
  const artifactMetadata = artifacts.map((artifact) => parseJson(artifact.metadata_json)).filter(isRecord);
  const branchLinkedArtifactCount = artifactMetadata.filter((metadata) => arrayOfStrings(metadata.branchIds ?? metadata.branchId).length > 0).length;
  const sourceObservationLinkedArtifactCount = artifactMetadata.filter((metadata) => arrayOfStrings(metadata.sourceObservationIds).length > 0).length;
  const imageArtifactCount = artifacts.filter((artifact) => String(artifact.type) === "image").length;
  const htmlArtifactCount = artifacts.filter((artifact) => String(artifact.type) === "html").length;
  const markdownArtifactCount = artifacts.filter((artifact) => String(artifact.type) === "markdown").length;
  const finalHtmlReportArtifactCount = artifactMetadata.filter((metadata) => String(metadata.artifactKind ?? "") === "final_html_report").length;
  const finalHtmlReportSourceCoveredCount = artifactMetadata.filter(
    (metadata) =>
      String(metadata.artifactKind ?? "") === "final_html_report" &&
      arrayOfStrings(metadata.sourceObservationIds).length > 0 &&
      arrayOfStrings(metadata.sourceArtifactIds).length > 0,
  ).length;
  const toolStatusByName: Record<string, Record<string, number>> = {};
  for (const call of toolCalls) {
    const name = String(call.tool_name ?? "unknown");
    const status = String(call.status ?? "unknown");
    toolStatusByName[name] = toolStatusByName[name] ?? {};
    toolStatusByName[name][status] = (toolStatusByName[name][status] ?? 0) + 1;
  }
  const traceQueryCalls = toolCalls.filter((call) => String(call.tool_name ?? "") === "trace.query");
  const traceQueryResolution = {
    callCount: traceQueryCalls.length,
    activeConversationFallbackCount: traceQueryCalls.filter((call) => {
      const metadata = recordOrEmpty(parseJson(call.metadata_json));
      return recordOrEmpty(metadata.trace_query).usedActiveConversationFallback === true;
    }).length,
    unresolvedCurrentLiteralCount: traceQueryCalls.filter((call) => {
      const metadata = recordOrEmpty(parseJson(call.metadata_json));
      const traceQuery = recordOrEmpty(metadata.trace_query);
      const resolvedConversationId = String(traceQuery.resolvedConversationId ?? "");
      return ["current", "this", "active", "current_conversation"].includes(resolvedConversationId.trim().toLowerCase());
    }).length,
    resolvedConversationIds: uniqueStrings(
      traceQueryCalls
        .map((call) => {
          const metadata = recordOrEmpty(parseJson(call.metadata_json));
          return String(recordOrEmpty(metadata.trace_query).resolvedConversationId ?? "");
        })
        .filter(Boolean),
    ),
  };
  const parentProxyCompletionCount = capabilityCompletedEvents.length + proxyCompletedEvents.length;
  const parentProxyFailureCount = capabilityFailedEvents.length + proxyFailedEvents.length;
  const traceReplayability = {
    branchCompletedEventCount: branchCompletedEvents.length,
    reduceEventCount: reduceEvents.length,
    finalArtifactEventCount: finalArtifactEvents.length,
    branchObservationIdCount: branchObservationMetadata.length,
    artifactCount: artifacts.length,
    capabilityOrProxyCompletionCount: parentProxyCompletionCount,
    replayable:
      branchCompletedEvents.length > 0 &&
      reduceEvents.length > 0 &&
      finalArtifactEvents.length > 0 &&
      branchObservationMetadata.length > 0 &&
      artifacts.length > 0,
  };
  const branchEvidenceMatrix = buildBranchEvidenceMatrix({
    branchPayloads,
    capabilityCompletedEvents,
    capabilityFailedEvents,
    proxyCompletedEvents,
    proxyFailedEvents,
    sandboxActionEvents,
    sandboxObservationEvents,
    branchContractMaterializedEvents,
    branchFinalMaterializedEvents,
    toolCalls,
    observations,
    artifacts,
  });
  const branchesMissingMinimumRealModelActions = branchEvidenceMatrix.filter(
    (branch) => branch.minimumRealModelActions > 0 && branch.realModelActionCount < branch.minimumRealModelActions,
  ).length;
  const branchesMissingBranchContractMaterializedEvent = branchEvidenceMatrix.filter((branch) => !branch.hasBranchContractMaterializedEvent).length;
  const branchesWithFallback = branchEvidenceMatrix.filter((branch) => branch.fallbackActionCount > 0 || branch.degraded).length;
  const branchesWithoutParentProxyEvidence = branchEvidenceMatrix.filter((branch) => branch.parentProxyCompletionCount === 0).length;
  const branchesWithoutArtifacts = branchEvidenceMatrix.filter((branch) => branch.artifactCount === 0).length;
  const branchesMissingRequiredToolEvidence = branchEvidenceMatrix.filter((branch) =>
    branch.requiredToolCoverage.some((coverage) => !coverage.hasCompletedParentEvidence),
  ).length;
  const branchesMissingMinimumEvidence = branchEvidenceMatrix.filter((branch) =>
    branch.minimumEvidenceCoverage.some((coverage) => !coverage.passed),
  ).length;
  const branchesMissingFinalOutputSchema = branchEvidenceMatrix.filter((branch) =>
    branch.finalOutputSchemaCoverage.some((coverage) => !coverage.passed),
  ).length;
  const branchesMissingBranchFinalMaterializedEvent = branchEvidenceMatrix.filter((branch) => !branch.hasBranchFinalMaterializedEvent).length;
  const branchesMissingWebSearchObservationCoverage = branchEvidenceMatrix.filter(
    (branch) => branch.webSearchObservationCoverage?.required === true && branch.webSearchObservationCoverage.passed !== true,
  ).length;
  const branchesMissingRunPythonImageArtifactCoverage = branchEvidenceMatrix.filter(
    (branch) => branch.runPythonImageArtifactCoverage?.required === true && branch.runPythonImageArtifactCoverage.passed !== true,
  ).length;
  const branchesMissingMarkdownSummaryArtifactCoverage = branchEvidenceMatrix.filter(
    (branch) => branch.markdownSummaryArtifactCoverage?.required === true && branch.markdownSummaryArtifactCoverage.passed !== true,
  ).length;
  const branchesMissingArtifactSourceObservationCoverage = branchEvidenceMatrix.filter((branch) =>
    branch.artifactSourceObservationCoverage?.some((coverage) => coverage.passed !== true),
  ).length;
  const branchesWithUnsupportedClaims = branchEvidenceMatrix.filter((branch) => Number(branch.unsupportedClaimCount ?? 0) > 0).length;
  const branchesWithoutEventRealModelActions = branchEvidenceMatrix.filter(
    (branch) => branch.eventRealModelActionCount < branch.minimumRealModelActions,
  ).length;
  const diagnosis = [
    verifyEvents.length > 0
      ? `Swarm verify event(s) recorded: ${verifyEvents.length}; latest failed checks=${failedChecks.length}.`
      : "No swarm.verify event recorded for this conversation.",
    `Parent-proxy evidence: capability completed=${capabilityCompletedEvents.length}, proxy completed=${proxyCompletedEvents.length}, capability failed=${capabilityFailedEvents.length}, proxy failed=${proxyFailedEvents.length}.`,
    `Branch evidence contracts/finals: contracts=${branchContractCount}, contractMaterializedEvents=${branchContractMaterializedEvents.length}, finals=${branchFinalCount}, finalMaterializedEvents=${branchFinalMaterializedEvents.length}, final limitations=${branchFinalLimitationCount}.`,
    `Branch evidence matrix: branches=${branchEvidenceMatrix.length}, below-min-real-model-actions=${branchesMissingMinimumRealModelActions}, below-min-event-real-model-actions=${branchesWithoutEventRealModelActions}, missing-contract-materialized-event=${branchesMissingBranchContractMaterializedEvent}, missing-minimum-evidence=${branchesMissingMinimumEvidence}, missing-final-output-schema=${branchesMissingFinalOutputSchema}, missing-final-materialized-event=${branchesMissingBranchFinalMaterializedEvent}, missing-web-search-observation=${branchesMissingWebSearchObservationCoverage}, missing-run-python-image=${branchesMissingRunPythonImageArtifactCoverage}, missing-markdown-summary=${branchesMissingMarkdownSummaryArtifactCoverage}, missing-artifact-source-observation=${branchesMissingArtifactSourceObservationCoverage}, with-unsupported-claims=${branchesWithUnsupportedClaims}, with-fallback/degraded=${branchesWithFallback}, without-parent-proxy=${branchesWithoutParentProxyEvidence}, missing-required-tool-evidence=${branchesMissingRequiredToolEvidence}, without-artifacts=${branchesWithoutArtifacts}.`,
    `Artifact coverage: image=${imageArtifactCount}, html=${htmlArtifactCount}, markdown=${markdownArtifactCount}, final-html-report=${finalHtmlReportArtifactCount}, final-html-source-covered=${finalHtmlReportSourceCoveredCount}, final-artifact-events=${finalArtifactEvents.length}, branch-linked=${branchLinkedArtifactCount}, sourceObservation-linked=${sourceObservationLinkedArtifactCount}.`,
    `Trace replayability: replayable=${traceReplayability.replayable}, branchCompletedEvents=${traceReplayability.branchCompletedEventCount}, reduceEvents=${traceReplayability.reduceEventCount}, finalArtifactEvents=${traceReplayability.finalArtifactEventCount}, branchObservationIds=${traceReplayability.branchObservationIdCount}, artifacts=${traceReplayability.artifactCount}.`,
    `Reducer input coverage: branchContracts=${Number(reducerInputCoverage.branchContractCount ?? 0)}, branchFinals=${Number(reducerInputCoverage.branchFinalCount ?? 0)}, branchObservations=${Number(reducerInputCoverage.branchObservationIdCount ?? 0)}, artifacts=${Number(reducerInputCoverage.artifactCount ?? 0)}, usesBranchFinals=${reducerInputCoverage.reducerUsesBranchFinals === true}.`,
    `Trace query resolution: calls=${traceQueryResolution.callCount}, activeFallback=${traceQueryResolution.activeConversationFallbackCount}, unresolvedCurrentLiteral=${traceQueryResolution.unresolvedCurrentLiteralCount}.`,
    `Verification gate coverage: complete=${verificationGateCoverage.complete === true}, presentExpected=${Number(verificationGateCoverage.presentExpectedGateCount ?? 0)}/${Number(verificationGateCoverage.expectedGateCount ?? 0)}, failed=${Number(verificationGateCoverage.failedGateCount ?? failedChecks.length)}.`,
    `Artifact context carry-forward events=${artifactContextEvents.length}.`,
    `Execution proof: real E2B branch payloads=${e2bSandboxSessions.length}, fallbackActionCount=${fallbackActionCount}, degradedBranchCount=${degradedBranchCount}.`,
  ];
  return {
    reduceCount: reduceEvents.length,
    swarmVerifyCount: verifyEvents.length,
    artifactContextPreparedCount: artifactContextEvents.length,
    latestArtifactContextPrepared: payloadOf(artifactContextEvents.at(-1)),
    branchCompletedEventCount: branchCompletedEvents.length,
    realE2bBranchPayloadCount: e2bSandboxSessions.length,
    fallbackActionCount,
    degradedBranchCount,
    capabilityCompletedCount: capabilityCompletedEvents.length,
    capabilityFailedCount: capabilityFailedEvents.length,
    proxyCompletedCount: proxyCompletedEvents.length,
    proxyFailedCount: proxyFailedEvents.length,
    repairStartedEventCount: repairStartedEvents.length,
    repairSucceededEventCount: repairSucceededEvents.length,
    repairFailedEventCount: repairFailedEvents.length,
    finalArtifactEventCount: finalArtifactEvents.length,
    parentProxyCompletionCount,
    parentProxyFailureCount,
    traceReplayability,
    reducerInputCoverage,
    traceQueryResolution,
    requiredToolEventFailedCheckCount,
    parentProxyFailedCheckCount,
    branchFinalContentPresentFailedCheckCount,
    successfulToolCallCoverageFailedCheckCount,
    capabilityEventCoverageFailedCheckCount,
    parentProxyCoverageFailedCheckCount,
    fallbackActionPolicyFailedCheckCount,
    branchContractCount,
    branchContractMaterializedEventCount: branchContractMaterializedEvents.length,
    branchFinalCount,
    branchFinalMaterializedEventCount: branchFinalMaterializedEvents.length,
    branchFinalLimitationCount,
    branchEvidenceMatrix,
    branchesMissingMinimumRealModelActions,
    branchesMissingBranchContractMaterializedEvent,
    branchesWithFallback,
    branchesWithoutParentProxyEvidence,
    branchesMissingRequiredToolEvidence,
    branchesMissingMinimumEvidence,
    branchesMissingFinalOutputSchema,
    branchesMissingBranchFinalMaterializedEvent,
    branchesMissingWebSearchObservationCoverage,
    branchesMissingRunPythonImageArtifactCoverage,
    branchesMissingMarkdownSummaryArtifactCoverage,
    branchesMissingArtifactSourceObservationCoverage,
    branchesWithUnsupportedClaims,
    branchesWithoutArtifacts,
    branchesWithoutEventRealModelActions,
    imageArtifactCount,
    htmlArtifactCount,
    markdownArtifactCount,
    finalHtmlReportArtifactCount,
    finalHtmlReportSourceCoveredCount,
    branchLinkedArtifactCount,
    sourceObservationLinkedArtifactCount,
    latestEventEvidence,
    verificationGateCoverage,
    toolStatusByName,
    failedVerifyChecks: failedChecks.map((check) => ({ id: check.id, detail: check.detail })),
    diagnosis,
  };
}

function buildBranchEvidenceMatrix(input: {
  branchPayloads: Record<string, unknown>[];
  capabilityCompletedEvents: Row[];
  capabilityFailedEvents: Row[];
  proxyCompletedEvents: Row[];
  proxyFailedEvents: Row[];
  sandboxActionEvents: Row[];
  sandboxObservationEvents: Row[];
  branchContractMaterializedEvents: Row[];
  branchFinalMaterializedEvents: Row[];
  toolCalls: Row[];
  observations: Row[];
  artifacts: Row[];
}) {
  const artifactRows = input.artifacts.map((artifact) => ({
    id: String(artifact.id ?? ""),
    type: String(artifact.type ?? ""),
    metadata: recordOrEmpty(parseJson(artifact.metadata_json)),
  }));
  return input.branchPayloads.map((payload) => {
    const branchId = String(payload.branch_id ?? "");
    const qualitySignals = recordOrEmpty(payload.quality_signals);
    const branchContract = recordOrEmpty(payload.branch_contract);
    const branchFinal = recordOrEmpty(payload.branch_final);
    const minimumEvidence = recordOrEmpty(branchContract.minimumEvidence);
    const realModelActionCount = firstNumericField(qualitySignals, [
      "realModelActionCount",
      "real_model_action_count",
      "modelActionCount",
      "model_action_count",
      "llmActionCount",
    ]);
    const fallbackActionCount = firstNumericField(qualitySignals, [
      "fallbackActionCount",
      "fallback_action_count",
      "deterministicFallbackActionCount",
      "deterministic_fallback_action_count",
    ]);
    const repairedActionCount = firstNumericField(qualitySignals, ["repairedActionCount", "repairCount", "repaired_action_count"]);
    const unrepairedActionCount = firstNumericField(qualitySignals, ["unrepairedActionCount", "unrepaired_action_count"]);
    const toolCallSuccessCount = firstNumericField(qualitySignals, [
      "toolCallSuccessCount",
      "tool_call_success_count",
      "successfulToolCallCount",
      "successful_tool_call_count",
    ]);
    const toolCallFailureCount = firstNumericField(qualitySignals, [
      "toolCallFailureCount",
      "tool_call_failure_count",
      "failedToolCallCount",
      "failed_tool_call_count",
    ]);
    const minimumRealModelActions = Number(minimumEvidence.realModelActionCount ?? 0) || 0;
    const branchArtifacts = arrayOfRecords(payload.branch_artifacts);
    const parentCapabilityArtifacts = arrayOfRecords(payload.parent_capability_artifacts);
    const artifactIds = uniqueStrings([
      ...arrayOfStrings(payload.artifact_ids),
      ...branchArtifacts.map((artifact) => String(artifact.id ?? "")).filter(Boolean),
      ...parentCapabilityArtifacts.map((artifact) => String(artifact.id ?? "")).filter(Boolean),
    ]);
    const artifactTypes = uniqueStrings([
      ...branchArtifacts.map((artifact) => String(artifact.type ?? "")).filter(Boolean),
      ...parentCapabilityArtifacts.map((artifact) => String(artifact.type ?? "")).filter(Boolean),
      ...artifactRows
        .filter((artifact) => artifactHasBranch(artifact.metadata, branchId))
        .map((artifact) => artifact.type)
        .filter(Boolean),
    ]);
    const linkedArtifactRows = artifactRows.filter(
      (artifact) => artifactIds.includes(artifact.id) || artifactHasBranch(artifact.metadata, branchId),
    );
    const artifactTypeOccurrences = [
      ...branchArtifacts.map((artifact) => String(artifact.type ?? "")).filter(Boolean),
      ...parentCapabilityArtifacts.map((artifact) => String(artifact.type ?? "")).filter(Boolean),
      ...linkedArtifactRows.map((artifact) => artifact.type).filter(Boolean),
    ];
    const sourceObservationLinkedArtifactCount = linkedArtifactRows.filter(
      (artifact) => arrayOfStrings(artifact.metadata.sourceObservationIds).length > 0,
    ).length;
    const runtimeSummaryArtifactCount = linkedArtifactRows.filter(
      (artifact) =>
        String(artifact.metadata.artifactKind ?? "") === "branch_runtime_summary" ||
        String(recordOrEmpty(artifact.metadata.qualitySignals).substanceStatus ?? "") === "runtime_summary",
    ).length;
    const thinTextArtifactCount = linkedArtifactRows.filter(
      (artifact) => String(recordOrEmpty(artifact.metadata.qualitySignals).substanceStatus ?? "") === "thin",
    ).length;
    const deliverableEligibleArtifactCount = linkedArtifactRows.filter(
      (artifact) => recordOrEmpty(artifact.metadata.qualitySignals).deliverableEligible === true,
    ).length;
    const observationIds = uniqueStrings([
      String(payload.observation_id ?? ""),
      ...input.observations
        .filter((observation) => {
          const metadata = recordOrEmpty(parseJson(observation.metadata_json));
          return String(metadata.branch_id ?? "") === branchId || String(observation.source_name ?? "") === `swarm.branch.${branchId}`;
        })
        .map((observation) => String(observation.id ?? "")),
    ]).filter(Boolean);
    const proxyCompleted = countEventsForBranch([...input.capabilityCompletedEvents, ...input.proxyCompletedEvents], branchId);
    const proxyFailed = countEventsForBranch([...input.capabilityFailedEvents, ...input.proxyFailedEvents], branchId);
    const parentProxyEventEvidence = [
      ...eventEvidenceForBranch(input.capabilityCompletedEvents, branchId),
      ...eventEvidenceForBranch(input.proxyCompletedEvents, branchId),
      ...eventEvidenceForBranch(input.capabilityFailedEvents, branchId),
      ...eventEvidenceForBranch(input.proxyFailedEvents, branchId),
    ];
    const toolCallEvidence = toolCallEvidenceForBranch(input.toolCalls, branchId);
    const requiredTools = arrayOfStrings(branchContract.requiredTools);
    const requiredArtifacts = arrayOfRecords(branchContract.requiredArtifacts);
    const requiredArtifactTypes = requiredArtifacts.map((artifact) => String(artifact.type ?? "")).filter(Boolean);
    const requiredToolCoverage = requiredTools.map((toolName) => ({
      toolName,
      hasCompletedToolCall: toolCallEvidence.some((call) => call.toolName === toolName && call.status === "completed"),
      hasCompletedCapabilityEvent: parentProxyEventEvidence.some(
        (event) => event.toolName === toolName && event.status === "completed" && event.eventType.startsWith("capability.invoke."),
      ),
      hasCompletedProxyEvent: parentProxyEventEvidence.some(
        (event) => event.toolName === toolName && event.status === "completed" && event.eventType.startsWith("sandbox.tool_proxy.call."),
      ),
      hasCompletedParentEvidence:
        toolCallEvidence.some((call) => call.toolName === toolName && call.status === "completed") ||
        parentProxyEventEvidence.some((event) => event.toolName === toolName && event.status === "completed"),
    }));
    const completedToolCallForTool = (toolName: string) =>
      toolCallEvidence.some((call) => call.toolName === toolName && call.status === "completed" && String(call.id ?? "").length > 0);
    const completedParentEventsForTool = (toolName: string) =>
      parentProxyEventEvidence.filter((event) => event.toolName === toolName && event.status === "completed");
    const completedParentToolCallRefForTool = (toolName: string) =>
      completedParentEventsForTool(toolName).some((event) => String(event.toolCallId ?? "").length > 0);
    const completedParentObservationForTool = (toolName: string) =>
      completedParentEventsForTool(toolName).some((event) => String(event.observationId ?? "").length > 0);
    const branchActionEventPayloads = input.sandboxActionEvents
      .map((event) => ({ ...payloadOf(event), eventType: String(event.event_type ?? "") }))
      .filter((event) => String(event.branchId ?? event.branch_id ?? "") === branchId);
    const branchObservationEventPayloads = input.sandboxObservationEvents
      .map(payloadOf)
      .filter((event) => String(event.branchId ?? event.branch_id ?? "") === branchId);
    const eventRealModelActionCount = branchActionEventPayloads.filter(
      (event) => String(event.actionSource ?? event.action_source ?? "") === "real_model" && String(event.status ?? "") === "proposed",
    ).length;
    const eventMockModelActionCount = branchActionEventPayloads.filter(
      (event) => String(event.actionSource ?? event.action_source ?? "") === "mock_model" && String(event.status ?? "") === "proposed",
    ).length;
    const eventFallbackActionCount = branchActionEventPayloads.filter(
      (event) => String(event.actionSource ?? event.action_source ?? "") === "deterministic_fallback" && String(event.status ?? "") === "proposed",
    ).length;
    const eventRepairedActionCount = branchActionEventPayloads.filter(
      (event) => String(event.status ?? "") === "repaired" || event.repaired === true,
    ).length;
    const repairStartedEventCount = branchActionEventPayloads.filter(
      (event) => String(event.eventType ?? event.event_type ?? "") === "sandbox.agent.action_repair_started",
    ).length;
    const repairSucceededEventCount = branchActionEventPayloads.filter(
      (event) => String(event.eventType ?? event.event_type ?? "") === "sandbox.agent.action_repair_succeeded",
    ).length;
    const repairFailedEventCount = branchActionEventPayloads.filter(
      (event) => String(event.eventType ?? event.event_type ?? "") === "sandbox.agent.action_repair_failed",
    ).length;
    const branchContractMaterializedEventCount = countEventsForBranch(input.branchContractMaterializedEvents, branchId);
    const branchFinalMaterializedEventCount = countEventsForBranch(input.branchFinalMaterializedEvents, branchId);
    const completedToolEvidenceCount = completedToolEvidenceForBranch(toolCallEvidence, parentProxyEventEvidence);
    const webSearchEvidenceCount = completedToolEvidenceForBranch(toolCallEvidence, parentProxyEventEvidence, "web.search");
    const imageArtifactCount = artifactTypeOccurrences.filter((type) => type === "image").length;
    const htmlArtifactCount = artifactTypeOccurrences.filter((type) => type === "html").length;
    const markdownArtifactCount = artifactTypeOccurrences.filter((type) => type === "markdown").length;
    const substantiveMarkdownArtifactCount = linkedArtifactRows.filter((artifact) => {
      if (artifact.type !== "markdown") {
        return false;
      }
      const qualitySignals = recordOrEmpty(artifact.metadata.qualitySignals);
      const substanceStatus = String(qualitySignals.substanceStatus ?? "substantive");
      return String(artifact.metadata.artifactKind ?? "") !== "branch_runtime_summary" && substanceStatus !== "runtime_summary" && substanceStatus !== "thin";
    }).length;
    const webSearchObservationCoverage = {
      required: requiredTools.includes("web.search"),
      hasCompletedToolCall: completedToolCallForTool("web.search"),
      hasCompletedParentToolCallRef: completedParentToolCallRefForTool("web.search"),
      hasCompletedObservationEvent: completedParentObservationForTool("web.search"),
      passed:
        !requiredTools.includes("web.search") ||
        ((completedToolCallForTool("web.search") || completedParentToolCallRefForTool("web.search")) &&
          completedParentObservationForTool("web.search")),
    };
    const runPythonImageArtifactCoverage = {
      required: requiredTools.includes("run_python") || requiredArtifactTypes.includes("image"),
      hasCompletedRunPythonEvidence:
        completedToolCallForTool("run_python") || completedParentEventsForTool("run_python").length > 0,
      imageArtifactCount,
      passed:
        !(requiredTools.includes("run_python") || requiredArtifactTypes.includes("image")) ||
        ((completedToolCallForTool("run_python") || completedParentEventsForTool("run_python").length > 0) &&
          imageArtifactCount > 0),
    };
    const markdownSummaryArtifactCoverage = {
      required: requiredArtifactTypes.includes("markdown"),
      markdownArtifactCount,
      substantiveMarkdownArtifactCount,
      runtimeSummaryArtifactCount,
      thinTextArtifactCount,
      passed: !requiredArtifactTypes.includes("markdown") || substantiveMarkdownArtifactCount > 0,
    };
    const artifactSourceObservationCoverage = requiredArtifactTypes.map((artifactType) => {
      const matchingArtifacts = linkedArtifactRows.filter((artifact) =>
        diagnosticArtifactMatchesRequiredType(artifact, artifactType),
      );
      const sourceLinkedArtifacts = matchingArtifacts.filter(
        (artifact) => arrayOfStrings(artifact.metadata.sourceObservationIds).length > 0,
      );
      return {
        artifactType,
        artifactCount: matchingArtifacts.length,
        sourceObservationLinkedArtifactCount: sourceLinkedArtifacts.length,
        passed: sourceLinkedArtifacts.length > 0,
      };
    });
    const minimumEvidenceCoverage = buildMinimumEvidenceCoverage(minimumEvidence, {
      realModelActionCount: Math.max(realModelActionCount, eventRealModelActionCount),
      toolCallCount: Math.max(toolCallSuccessCount, completedToolEvidenceCount),
      webSearchCount: webSearchEvidenceCount,
      imageArtifactCount,
      htmlArtifactCount,
      markdownArtifactCount,
    });
    const finalOutputSchema = recordOrEmpty(branchContract.finalOutputSchema);
    const finalOutputSchemaCoverage = buildFinalOutputSchemaCoverage(finalOutputSchema, branchFinal);
    const unsupportedClaims = arrayOfStrings(branchFinal.unsupportedClaims ?? branchFinal.unsupported_claims);
    const degraded =
      qualitySignals.degradedExecution === true ||
      qualitySignals.fallbackPolicyStatus === "degraded" ||
      fallbackActionCount > 0;
    return {
      branchId,
      title: String(branchContract.title ?? payload.branch_title ?? payload.output_summary ?? branchId),
      status: String(payload.status ?? "unknown"),
      executionMode: String(payload.execution_mode ?? "unknown"),
      externalSandboxId: String(payload.external_sandbox_id ?? ""),
      hasRealE2bSandbox: String(payload.external_sandbox_id ?? "").length > 0,
      hasBranchContract: Object.keys(branchContract).length > 0,
      hasBranchContractMaterializedEvent: branchContractMaterializedEventCount > 0,
      branchContractMaterializedEventCount,
      hasBranchFinal: Object.keys(branchFinal).length > 0,
      hasBranchFinalMaterializedEvent: branchFinalMaterializedEventCount > 0,
      branchFinalMaterializedEventCount,
      realModelActionCount,
      eventRealModelActionCount,
      eventMockModelActionCount,
      eventFallbackActionCount,
      minimumRealModelActions,
      meetsMinimumRealModelActions:
        minimumRealModelActions === 0 ||
        realModelActionCount >= minimumRealModelActions ||
        eventRealModelActionCount >= minimumRealModelActions,
      fallbackActionCount,
      repairedActionCount,
      unrepairedActionCount,
      eventRepairedActionCount,
      repairStartedEventCount,
      repairSucceededEventCount,
      repairFailedEventCount,
      minimumEvidence,
      minimumEvidenceCoverage,
      finalOutputSchema,
      finalOutputSchemaCoverage,
      sandboxAgentObservationEventCount: branchObservationEventPayloads.length,
      sandboxAgentFailedObservationEventCount: branchObservationEventPayloads.filter((event) => String(event.status ?? "") === "failed").length,
      degraded,
      toolCallSuccessCount,
      toolCallFailureCount,
      parentProxyCompletionCount: proxyCompleted,
      parentProxyFailureCount: proxyFailed,
      parentProxyEventEvidence,
      toolCallEvidence,
      requiredTools,
      requiredToolCoverage,
      webSearchObservationCoverage,
      runPythonImageArtifactCoverage,
      markdownSummaryArtifactCoverage,
      artifactSourceObservationCoverage,
      artifactCount: artifactIds.length,
      artifactIds,
      artifactTypes,
      imageArtifactCount,
      htmlArtifactCount,
      markdownArtifactCount,
      sourceObservationLinkedArtifactCount,
      runtimeSummaryArtifactCount,
      thinTextArtifactCount,
      deliverableEligibleArtifactCount,
      observationIds,
      unsupportedClaimCount: unsupportedClaims.length,
      unsupportedClaims,
    };
  });
}

function firstNumericField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function countEventsForBranch(events: Row[], branchId: string) {
  return events.filter((event) => branchIdFromPayload(payloadOf(event)) === branchId).length;
}

function eventEvidenceForBranch(events: Row[], branchId: string) {
  return events
    .map((event) => {
      const payload = payloadOf(event);
      return {
        eventType: String(event.event_type ?? ""),
        status: eventStatusFromType(String(event.event_type ?? "")),
        branchId: branchIdFromPayload(payload),
        toolName: toolNameFromPayload(payload),
        observationId: String(payload.observation_id ?? payload.observationId ?? ""),
        toolCallId: String(payload.tool_call_id ?? payload.toolCallId ?? ""),
      };
    })
    .filter((event) => event.branchId === branchId);
}

function toolCallEvidenceForBranch(toolCalls: Row[], branchId: string) {
  return toolCalls
    .map((call) => {
      const metadata = recordOrEmpty(parseJson(call.metadata_json));
      return {
        id: String(call.id ?? ""),
        status: String(call.status ?? "unknown"),
        toolName: String(call.tool_name ?? "unknown"),
        branchId: branchIdFromPayload(metadata),
      };
    })
    .filter((call) => call.branchId === branchId);
}

function branchIdFromPayload(payload: Record<string, unknown>) {
  return String(payload.branch_id ?? payload.branchId ?? "");
}

function toolNameFromPayload(payload: Record<string, unknown>) {
  return String(payload.tool_name ?? payload.toolName ?? payload.capability_name ?? payload.capabilityName ?? payload.name ?? "");
}

function diagnosticArtifactMatchesRequiredType(
  artifact: { type: string; mime_type?: string; metadata: Record<string, unknown> },
  requiredType: string,
) {
  const artifactKind = String(artifact.metadata.artifactKind ?? "");
  const mimeType = String(artifact.mime_type ?? "");
  if (requiredType === "image") {
    return artifact.type === "image" || /^image\//i.test(mimeType);
  }
  if (requiredType === "html") {
    return artifact.type === "html" || /html/i.test(mimeType) || artifactKind === "final_html_report" || artifactKind === "html_document";
  }
  if (requiredType === "markdown") {
    return artifact.type === "markdown" || /markdown/i.test(mimeType) || artifactKind === "branch_final_report" || artifactKind === "markdown_document";
  }
  if (requiredType === "json") {
    return artifact.type === "json" || /json/i.test(mimeType) || artifactKind === "structured_json";
  }
  if (requiredType === "image_metadata") {
    return artifact.type === "json" && artifactKind === "image_metadata";
  }
  return artifact.type === requiredType;
}

function eventStatusFromType(eventType: string) {
  const parts = eventType.split(".");
  return parts.at(-1) ?? "unknown";
}

function completedToolEvidenceForBranch(
  toolCalls: Array<{ toolName: string; status: string }>,
  parentProxyEvents: Array<{ toolName: string; status: string }>,
  toolName?: string,
) {
  const completedToolCalls = toolCalls.filter(
    (call) => call.status === "completed" && (!toolName || call.toolName === toolName),
  ).length;
  const completedParentEvents = parentProxyEvents.filter(
    (event) => event.status === "completed" && (!toolName || event.toolName === toolName),
  ).length;
  return Math.max(completedToolCalls, completedParentEvents);
}

function buildMinimumEvidenceCoverage(minimumEvidence: Record<string, unknown>, actual: Record<string, number>) {
  return [
    "realModelActionCount",
    "toolCallCount",
    "webSearchCount",
    "imageArtifactCount",
    "htmlArtifactCount",
    "markdownArtifactCount",
  ]
    .map((field) => {
      const required = Number(minimumEvidence[field] ?? 0) || 0;
      return {
        field,
        required,
        actual: Number(actual[field] ?? 0) || 0,
        passed: required <= 0 || (Number(actual[field] ?? 0) || 0) >= required,
      };
    })
    .filter((coverage) => coverage.required > 0);
}

function buildFinalOutputSchemaCoverage(finalOutputSchema: Record<string, unknown>, branchFinal: Record<string, unknown>) {
  const sections = arrayOfRecords(branchFinal.sections);
  const claims = arrayOfRecords(branchFinal.claims);
  const sectionTitles = sections.map((section) => String(section.title ?? "").toLowerCase());
  const requiredSectionCoverage = arrayOfStrings(finalOutputSchema.requiredSections).map((requiredSection) => {
    const normalized = requiredSection.toLowerCase();
    return {
      field: "requiredSections",
      required: requiredSection,
      actual: sectionTitles.join(", "),
      passed: normalized.length > 0 && sectionTitles.some((title) => title.length > 0 && (title.includes(normalized) || normalized.includes(title))),
    };
  });
  const hasObservationIds =
    arrayOfStrings(branchFinal.evidenceObservationIds).length > 0 ||
    sections.some((section) => arrayOfStrings(section.evidenceObservationIds).length > 0) ||
    claims.some((claim) => arrayOfStrings(claim.evidenceObservationIds).length > 0);
  const hasArtifactIds =
    arrayOfStrings(branchFinal.artifactIds).length > 0 ||
    sections.some((section) => arrayOfStrings(section.evidenceArtifactIds).length > 0) ||
    claims.some((claim) => arrayOfStrings(claim.evidenceArtifactIds).length > 0);
  const unsupportedClaims = arrayOfStrings(branchFinal.unsupportedClaims ?? branchFinal.unsupported_claims);
  const citationCoverage = [
    {
      field: "mustCiteObservationIds",
      required: finalOutputSchema.mustCiteObservationIds === true,
      actual: hasObservationIds,
      passed: finalOutputSchema.mustCiteObservationIds !== true || hasObservationIds,
    },
    {
      field: "mustCiteArtifactIds",
      required: finalOutputSchema.mustCiteArtifactIds === true,
      actual: hasArtifactIds,
      passed: finalOutputSchema.mustCiteArtifactIds !== true || hasArtifactIds,
    },
    {
      field: "unsupportedClaimPolicy",
      required: String(finalOutputSchema.unsupportedClaimPolicy ?? ""),
      actual: unsupportedClaims.length,
      passed: String(finalOutputSchema.unsupportedClaimPolicy ?? "") !== "fail_verification" || unsupportedClaims.length === 0,
    },
  ];
  return [...requiredSectionCoverage, ...citationCoverage];
}

function artifactHasBranch(metadata: Record<string, unknown>, branchId: string) {
  return uniqueStrings([
    ...arrayOfStrings(metadata.branchIds),
    ...arrayOfStrings(metadata.branchId),
    typeof metadata.branchId === "string" ? metadata.branchId : "",
  ]).includes(branchId);
}

function arrayOfRecords(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function payloadOf(event: Row | undefined) {
  if (!event) {
    return {};
  }
  const parsed = parseJson(event.payload_json);
  if (isRecord(parsed) && isRecord(parsed.payload)) {
    return parsed.payload;
  }
  return isRecord(parsed) ? parsed : {};
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function buildRemediationPlan(input: {
  productHealth: ReturnType<typeof buildProductHealth>;
  qualityIssues: string[];
  observations: ReturnType<typeof buildObservationSummary>;
  sandbox: ReturnType<typeof buildSandboxSummary>;
  selfImprovement: ReturnType<typeof buildSelfImprovementSummary>;
  runtimeConsistency: ReturnType<typeof buildRuntimeConsistencySummary>;
  swarmEvidence: ReturnType<typeof buildSwarmEvidenceSummary>;
  canonicalVerification: CanonicalVerificationReceiptSummary;
  capabilityPlaneHealth: CapabilityPlaneHealthSummary;
  finalAnswerEvidence: ReturnType<typeof buildFinalAnswerEvidenceSummary>;
}) {
  const items: RemediationItem[] = [];

  if (input.qualityIssues.length > 0) {
    items.push({
      id: "evidence-quality",
      category: "agentic_evidence",
      severity: "high",
      title: "Repair weak evidence handling before trusting final answers",
      evidence: input.qualityIssues.slice(0, 5),
      recommendedAction:
        "Require replanning after empty, stale, or constraint-mismatched observations and fail health checks when final claims are not observation-backed.",
      verificationCommands: ["node scripts/agentic-loop-v2-smoke.mjs"],
    });
  }

  if (input.productHealth.issues.length > 0) {
    items.push({
      id: "product-interaction-logs",
      category: "product_observability",
      severity: "medium",
      title: "Close product interaction logging gaps",
      evidence: input.productHealth.issues.slice(0, 5),
      recommendedAction:
        "Verify submit, SSE, runtime card, suggestion, and server handoff logs for the affected conversation before attributing the issue to model behavior.",
      verificationCommands: ["npm --prefix apps/web run typecheck", "npm --prefix apps/web run lint"],
    });
  }

  if (input.runtimeConsistency.issues.length > 0) {
    items.push({
      id: "runtime-event-consistency",
      category: "runtime_truth",
      severity: input.runtimeConsistency.staleRunningActivityCount > 0 ? "high" : "medium",
      title: "Repair runtime event lifecycle inconsistencies before trusting UI state",
      evidence: input.runtimeConsistency.issues.slice(0, 5),
      recommendedAction:
        "Ensure every started model/tool/artifact/swarm activity has a terminal event or a documented settlement rule, and keep trace span status aligned with terminal run state.",
      verificationCommands: [
        "npm run smoke:trace-diagnostics",
        "node scripts/trace-diagnostics-runtime-consistency-smoke.mjs",
      ],
    });
  }

  if (input.sandbox.preflightFailureCount > 0 || input.observations.sandboxPreflightBranchObservationCount > 0) {
    items.push({
      id: "e2b-preflight",
      category: "sandbox_e2b",
      severity: "high",
      title: "Resolve E2B preflight before expecting real swarm branches",
      evidence: [
        `sandbox preflight sessions=${input.sandbox.preflightFailureCount}`,
        `branch preflight observations=${input.observations.sandboxPreflightBranchObservationCount}`,
        `missing env=${input.sandbox.missingEnv.join(", ") || input.observations.missingEnv.join(", ") || "unknown"}`,
      ],
      recommendedAction:
        "Configure required E2B credentials and template verification receipt, then rerun the readiness and preflight e2e gates before enabling real branch execution.",
      verificationCommands: uniqueStrings([
        ...input.sandbox.verificationCommands,
        "node scripts/e2b-preflight-e2e-smoke.mjs",
        "node scripts/e2b-template-verification-e2e-smoke.mjs",
      ]),
    });
  }

  if (input.capabilityPlaneHealth.status !== "ready" || input.capabilityPlaneHealth.hardFailures.length > 0) {
    items.push({
      id: "capability-plane-health",
      category: "sandbox_e2b",
      severity: input.capabilityPlaneHealth.realProfile ? "high" : "medium",
      title: "Repair capability plane health before trusting real E2B branch tool use",
      evidence: [
        `runtimeProfile=${input.capabilityPlaneHealth.runtimeProfile}`,
        `status=${input.capabilityPlaneHealth.status}`,
        `hardFailures=${input.capabilityPlaneHealth.hardFailures.join(", ") || "none"}`,
      ],
      recommendedAction:
        "Start DataSwarm through the real tunnel profile, remove mock/degraded env contamination, and verify the public parent proxy plus required V4 capabilities before launching a complex E2B swarm.",
      verificationCommands: [
        "npm run dev:real",
        "curl -fsS https://dataswarm-dev.metad.ai/api/internal/sandbox/health",
        "node scripts/e2b-readiness-smoke.mjs",
      ],
    });
  }

  if (input.sandbox.liveSmokeUnverifiedCount > 0 || input.observations.liveSmokeUnverifiedCount > 0) {
    items.push({
      id: "e2b-live-smoke-receipt",
      category: "sandbox_e2b",
      severity: "medium",
      title: "Record live E2B smoke evidence after credentials and template verification",
      evidence: [
        `sandbox live smoke unverified=${input.sandbox.liveSmokeUnverifiedCount}`,
        `observation live smoke unverified=${input.observations.liveSmokeUnverifiedCount}`,
        `receipt paths=${uniqueStrings([...input.sandbox.liveSmokeReceiptPaths, ...input.observations.liveSmokeReceiptPaths]).join(", ") || "unknown"}`,
      ],
      recommendedAction:
        "Run a real E2B live smoke only after credentials and template verification are ready; preserve the generated receipt as auditable evidence.",
      verificationCommands: uniqueStrings([
        "node scripts/e2b-readiness-smoke.mjs",
        "node scripts/e2b-live-receipt-smoke.mjs",
        "node scripts/e2b-sandbox-smoke.mjs",
      ]),
    });
  }

  if (input.swarmEvidence.swarmVerifyCount > 0 && input.swarmEvidence.parentProxyCompletionCount === 0) {
    items.push({
      id: "swarm-parent-proxy-evidence",
      category: "swarm_verification",
      severity: "high",
      title: "Require parent-proxy evidence before trusting swarm verification",
      evidence: [
        `swarmVerifyCount=${input.swarmEvidence.swarmVerifyCount}`,
        `parentProxyCompletionCount=${input.swarmEvidence.parentProxyCompletionCount}`,
        `requiredToolEventFailedChecks=${input.swarmEvidence.requiredToolEventFailedCheckCount}`,
        `successfulToolCallCoverageFailedChecks=${input.swarmEvidence.successfulToolCallCoverageFailedCheckCount}`,
        `capabilityEventCoverageFailedChecks=${input.swarmEvidence.capabilityEventCoverageFailedCheckCount}`,
        `parentProxyCoverageFailedChecks=${input.swarmEvidence.parentProxyCoverageFailedCheckCount}`,
      ],
      recommendedAction:
        "Rerun a real parent-proxy swarm and require capability.invoke/sandbox.tool_proxy completion events plus completed tool_call rows for required tools.",
      verificationCommands: ["node scripts/parent-tool-proxy-smoke.mjs", "node scripts/e2b-parent-proxy-smoke.mjs"],
    });
  }

  if (
    input.swarmEvidence.swarmVerifyCount > 0 &&
    input.swarmEvidence.verificationGateCoverage?.complete === false
  ) {
    items.push({
      id: "swarm-verification-gate-coverage",
      category: "swarm_verification",
      severity: "high",
      title: "Require complete V4.1 swarm.verify gate coverage",
      evidence: [
        `expectedGateCount=${Number(input.swarmEvidence.verificationGateCoverage?.expectedGateCount ?? 0)}`,
        `presentExpectedGateCount=${Number(input.swarmEvidence.verificationGateCoverage?.presentExpectedGateCount ?? 0)}`,
        `missingGateIds=${arrayOfStrings(input.swarmEvidence.verificationGateCoverage?.missingGateIds).join(",") || "none"}`,
      ],
      recommendedAction:
        "Do not accept swarm.verify as V4.1 evidence until gate_coverage.complete=true and all expected hard gates are present.",
      verificationCommands: ["node scripts/e2b-complex-benchmark-smoke.mjs"],
    });
  }

  if (Number(input.swarmEvidence.traceQueryResolution?.unresolvedCurrentLiteralCount ?? 0) > 0) {
    items.push({
      id: "trace-query-current-resolution",
      category: "swarm_verification",
      severity: "high",
      title: "Resolve trace.query current conversation aliases before repository lookup",
      evidence: [
        `traceQueryCallCount=${input.swarmEvidence.traceQueryResolution.callCount}`,
        `activeConversationFallbackCount=${input.swarmEvidence.traceQueryResolution.activeConversationFallbackCount}`,
        `unresolvedCurrentLiteralCount=${input.swarmEvidence.traceQueryResolution.unresolvedCurrentLiteralCount}`,
      ],
      recommendedAction:
        "Ensure trace.query calls with conversation_id=current/active/this are rewritten to the active conversationId before diagnoseConversation or repository lookup.",
      verificationCommands: ["node scripts/parent-tool-proxy-smoke.mjs"],
    });
  }

  if (
    input.swarmEvidence.reduceCount > 0 &&
    input.swarmEvidence.reducerInputCoverage?.reducerUsesBranchFinals !== true
  ) {
    items.push({
      id: "swarm-reducer-input-coverage",
      category: "swarm_verification",
      severity: "high",
      title: "Ensure reducer uses BranchFinal evidence instead of runtime summaries",
      evidence: [
        `reduceCount=${input.swarmEvidence.reduceCount}`,
        `branchContractCount=${Number(input.swarmEvidence.reducerInputCoverage?.branchContractCount ?? 0)}`,
        `branchFinalCount=${Number(input.swarmEvidence.reducerInputCoverage?.branchFinalCount ?? 0)}`,
        `branchObservationIdCount=${Number(input.swarmEvidence.reducerInputCoverage?.branchObservationIdCount ?? 0)}`,
        `artifactCount=${Number(input.swarmEvidence.reducerInputCoverage?.artifactCount ?? 0)}`,
        `reducerUsesBranchFinals=${input.swarmEvidence.reducerInputCoverage?.reducerUsesBranchFinals === true}`,
      ],
      recommendedAction:
        "Do not accept swarm.reduce output until BranchFinal records are present and reducer_input_coverage shows reducerUsesBranchFinals=true.",
      verificationCommands: ["node scripts/e2b-complex-benchmark-smoke.mjs"],
    });
  }

  if (
    input.swarmEvidence.branchEvidenceMatrix.length > 0 &&
    (input.swarmEvidence.branchesMissingMinimumRealModelActions > 0 ||
      input.swarmEvidence.branchesMissingBranchContractMaterializedEvent > 0 ||
      input.swarmEvidence.branchesWithFallback > 0 ||
      input.swarmEvidence.branchesWithoutParentProxyEvidence > 0 ||
      input.swarmEvidence.branchesMissingRequiredToolEvidence > 0 ||
      input.swarmEvidence.branchesMissingMinimumEvidence > 0 ||
      input.swarmEvidence.branchesMissingFinalOutputSchema > 0 ||
      input.swarmEvidence.branchesMissingBranchFinalMaterializedEvent > 0 ||
      input.swarmEvidence.branchesMissingWebSearchObservationCoverage > 0 ||
      input.swarmEvidence.branchesMissingRunPythonImageArtifactCoverage > 0 ||
      input.swarmEvidence.branchesMissingMarkdownSummaryArtifactCoverage > 0 ||
      input.swarmEvidence.branchesMissingArtifactSourceObservationCoverage > 0 ||
      input.swarmEvidence.branchesWithUnsupportedClaims > 0 ||
      input.swarmEvidence.branchesWithoutArtifacts > 0)
  ) {
    items.push({
      id: "swarm-branch-evidence-matrix",
      category: "swarm_verification",
      severity: "high",
      title: "Close per-branch ReAct evidence gaps before accepting complex E2B benchmark",
      evidence: [
        `branches=${input.swarmEvidence.branchEvidenceMatrix.length}`,
        `below-min-real-model-actions=${input.swarmEvidence.branchesMissingMinimumRealModelActions}`,
        `below-min-event-real-model-actions=${input.swarmEvidence.branchesWithoutEventRealModelActions}`,
        `missing-contract-materialized-event=${input.swarmEvidence.branchesMissingBranchContractMaterializedEvent}`,
        `branch-final-content-present-failed-checks=${input.swarmEvidence.branchFinalContentPresentFailedCheckCount}`,
        `fallback-action-policy-failed-checks=${input.swarmEvidence.fallbackActionPolicyFailedCheckCount}`,
        `with-fallback/degraded=${input.swarmEvidence.branchesWithFallback}`,
        `without-parent-proxy=${input.swarmEvidence.branchesWithoutParentProxyEvidence}`,
        `missing-required-tool-evidence=${input.swarmEvidence.branchesMissingRequiredToolEvidence}`,
        `missing-minimum-evidence=${input.swarmEvidence.branchesMissingMinimumEvidence}`,
        `missing-final-output-schema=${input.swarmEvidence.branchesMissingFinalOutputSchema}`,
        `missing-final-materialized-event=${input.swarmEvidence.branchesMissingBranchFinalMaterializedEvent}`,
        `missing-web-search-observation=${input.swarmEvidence.branchesMissingWebSearchObservationCoverage}`,
        `missing-run-python-image=${input.swarmEvidence.branchesMissingRunPythonImageArtifactCoverage}`,
        `missing-markdown-summary=${input.swarmEvidence.branchesMissingMarkdownSummaryArtifactCoverage}`,
        `missing-artifact-source-observation=${input.swarmEvidence.branchesMissingArtifactSourceObservationCoverage}`,
        `with-unsupported-claims=${input.swarmEvidence.branchesWithUnsupportedClaims}`,
        `without-artifacts=${input.swarmEvidence.branchesWithoutArtifacts}`,
      ],
      recommendedAction:
        "Rerun the complex E2B swarm only after every branch has the required real_model action count, zero normal-path fallback, parent-proxy completion evidence, and branch-linked artifact coverage.",
      verificationCommands: ["node scripts/e2b-parent-proxy-smoke.mjs", "node scripts/e2b-complex-benchmark-smoke.mjs"],
    });
  }

  if (!input.finalAnswerEvidence.hasObservationCitation || !input.finalAnswerEvidence.hasArtifactCitation) {
    items.push({
      id: "final-answer-evidence-citations",
      category: "swarm_verification",
      severity: input.swarmEvidence.swarmVerifyCount > 0 ? "high" : "medium",
      title: "Ensure final answer cites persisted Observation and Artifact evidence",
      evidence: [
        `latestAssistantMessageId=${input.finalAnswerEvidence.latestAssistantMessageId || "missing"}`,
        `hasObservationCitation=${input.finalAnswerEvidence.hasObservationCitation}`,
        `hasArtifactCitation=${input.finalAnswerEvidence.hasArtifactCitation}`,
        `persistedObservationCount=${input.finalAnswerEvidence.persistedObservationCount}`,
        `persistedArtifactCount=${input.finalAnswerEvidence.persistedArtifactCount}`,
      ],
      recommendedAction:
        "Regenerate or patch the final answer so it cites persisted Observation IDs and Artifact IDs from the completed swarm evidence chain.",
      verificationCommands: ["node scripts/trace-diagnostics-sandbox-smoke.mjs", "node scripts/swarm-verifier-smoke.mjs"],
    });
  }

  if (input.selfImprovement.queuedCount > 0 || input.selfImprovement.patchPreparedCount > 0) {
    items.push({
      id: "self-improvement-review",
      category: "self_improvement",
      severity: "medium",
      title: "Review queued self-improvement candidates with shadow tests",
      evidence: [
        `queued=${input.selfImprovement.queuedCount}`,
        `patchPrepared=${input.selfImprovement.patchPreparedCount}`,
        `candidateTypes=${Object.keys(input.selfImprovement.candidateTypes).join(", ") || "unknown"}`,
      ],
      recommendedAction:
        "Run required verification commands, prepare patch bundles when appropriate, and record human approve/reject/defer decisions before applying changes.",
      verificationCommands: uniqueStrings(input.selfImprovement.requiredCommands),
    });
  }

  if (input.selfImprovement.appliedMissingVerificationReceiptCount > 0) {
    items.push({
      id: "self-improvement-receipt-coverage",
      category: "self_improvement",
      severity: "high",
      title: "Backfill missing verification receipts for applied self-improvement changes",
      evidence: [
        `applied=${input.selfImprovement.appliedCount}`,
        `missingReceipts=${input.selfImprovement.appliedMissingVerificationReceiptCount}`,
      ],
      recommendedAction:
        "Do not treat applied self-improvement changes as complete until command-level verification receipts cover every required command.",
      verificationCommands: uniqueStrings(input.selfImprovement.requiredCommands),
    });
  }

  if (input.canonicalVerification.failed > 0 || input.canonicalVerification.liveE2bGated) {
    items.push({
      id: "canonical-verification-gates",
      category: "verification",
      severity: input.canonicalVerification.failed > 0 ? "high" : "medium",
      title: "Resolve canonical verification gaps before marking the Real Swarm goal complete",
      evidence: [
        `receipts=${input.canonicalVerification.receiptCount}`,
        `failed=${input.canonicalVerification.failed}`,
        `gated=${input.canonicalVerification.gatedSkip}`,
        `liveE2BRequired=${input.canonicalVerification.liveE2bRequired}`,
        `liveE2BGated=${input.canonicalVerification.liveE2bGated}`,
      ],
      recommendedAction:
        "Run the grouped canonical verification runner and require live E2B only when real sandbox credentials and template receipts are configured.",
      verificationCommands: uniqueStrings(input.canonicalVerification.verificationCommands),
    });
  }

  return items;
}

function buildFinalAnswerEvidenceSummary(messages: Row[], observations: Row[], artifacts: Row[]) {
  const assistantMessages = messages.filter((message) => String(message.role) === "assistant");
  const latestAssistant = assistantMessages.at(-1);
  const latestText = latestAssistant ? messageText(latestAssistant) : "";
  const persistedObservationIds = uniqueStrings(observations.map((observation) => String(observation.id ?? "")));
  const persistedArtifactIds = uniqueStrings(artifacts.map((artifact) => String(artifact.id ?? "")));
  const citedObservationIds = persistedObservationIds.filter((id) => latestText.includes(id));
  const citedArtifactIds = persistedArtifactIds.filter((id) => latestText.includes(id));
  const artifactPreviewIds = latestAssistant ? extractArtifactPreviewIds(parseJson(latestAssistant.parts_json)) : [];
  const allCitedArtifactIds = uniqueStrings([...citedArtifactIds, ...artifactPreviewIds.filter((id) => persistedArtifactIds.includes(id))]);
  const hasObservationCitation = persistedObservationIds.length === 0 || citedObservationIds.length > 0;
  const hasArtifactCitation = persistedArtifactIds.length === 0 || allCitedArtifactIds.length > 0;
  const finalAnswerEvidenceCoverage = {
    id: "final_answer_evidence_coverage",
    passed: hasObservationCitation && hasArtifactCitation,
    hasObservationCitation,
    hasArtifactCitation,
    citedObservationCount: citedObservationIds.length,
    persistedObservationCount: persistedObservationIds.length,
    citedArtifactCount: allCitedArtifactIds.length,
    persistedArtifactCount: persistedArtifactIds.length,
  };
  return {
    latestAssistantMessageId: latestAssistant ? String(latestAssistant.id ?? "") : "",
    latestAssistantTextLength: latestText.length,
    persistedObservationCount: persistedObservationIds.length,
    persistedArtifactCount: persistedArtifactIds.length,
    citedObservationIds,
    citedArtifactIds: allCitedArtifactIds,
    missingObservationCitationCount: hasObservationCitation ? 0 : persistedObservationIds.length,
    missingArtifactCitationCount: hasArtifactCitation ? 0 : persistedArtifactIds.length,
    hasObservationCitation,
    hasArtifactCitation,
    final_answer_evidence_coverage: finalAnswerEvidenceCoverage,
    finalAnswerEvidenceCoverage,
    diagnosis: [
      `Final answer evidence citations: observations=${citedObservationIds.length}/${persistedObservationIds.length}, artifacts=${allCitedArtifactIds.length}/${persistedArtifactIds.length}.`,
    ],
  };
}

function messageText(message: Row) {
  const parts = parseJson(message.parts_json);
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "artifact_preview") {
        return String(part.artifact_id ?? part.artifactId ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractArtifactPreviewIds(parts: unknown) {
  if (!Array.isArray(parts)) {
    return [];
  }
  return uniqueStrings(
    parts
      .filter(isRecord)
      .filter((part) => part.type === "artifact_preview")
      .map((part) => String(part.artifact_id ?? part.artifactId ?? "")),
  );
}

function buildCapabilityPlaneHealthSummary(): CapabilityPlaneHealthSummary {
  try {
    return getSandboxCapabilityPlaneHealth();
  } catch (error) {
    const runtimeProfile = process.env.DATASWARM_RUNTIME_PROFILE || "unspecified";
    return {
      status: "failed",
      runtimeProfile,
      realProfile: runtimeProfile.startsWith("real"),
      mockSignals: {},
      mockContamination: false,
      readiness: null,
      capabilityPlane: null,
      endpoints: null,
      hardFailures: ["capability_plane_health_runtime_guard_failed"],
      error: {
        code: "capability_plane_health_runtime_guard_failed",
        message: error instanceof Error ? error.message : "Capability plane health check failed.",
      },
    };
  }
}

function capabilityPlaneHealthDiagnosis(health: CapabilityPlaneHealthSummary) {
  if (health.status === "ready" && health.hardFailures.length === 0) {
    return [`Capability plane health ready for runtime profile ${health.runtimeProfile}.`];
  }
  return [
    `Capability plane health failed for runtime profile ${health.runtimeProfile}: ${
      health.hardFailures.join(", ") || "unknown failure"
    }.`,
  ];
}

function buildSandboxSummary(sandboxSessions: Row[], events: Row[]) {
  const providers = new Map<string, number>();
  const statuses = new Map<string, number>();
  const missingEnv = new Set<string>();
  const verificationCommands = new Set<string>();
  const liveSmokeEvidence = createLiveSmokeEvidenceSummary();
  let preflightFailureCount = 0;
  let preflightFailureEventCount = 0;
  let e2bSessionCount = 0;

  for (const session of sandboxSessions) {
    const provider = String(session.provider ?? "unknown");
    const status = String(session.status ?? "unknown");
    providers.set(provider, (providers.get(provider) ?? 0) + 1);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    if (provider === "e2b") {
      e2bSessionCount += 1;
    }
    const metadata = parseJson(session.metadata_json);
    if (isRecord(metadata)) {
      let sessionHasPreflightFailure = false;
      if (metadata.error_code === "sandbox_preflight_failed") {
        sessionHasPreflightFailure = true;
      }
      const preflight = metadata.e2b_preflight;
      if (isRecord(preflight)) {
        for (const item of arrayOfStrings(preflight.missing_env)) {
          missingEnv.add(item);
        }
        for (const item of arrayOfStrings(preflight.verification_commands)) {
          verificationCommands.add(item);
        }
        collectLiveSmokeEvidence(preflight, liveSmokeEvidence);
      }
      for (const failure of Array.isArray(metadata.attempt_failures) ? metadata.attempt_failures : []) {
        if (!isRecord(failure)) {
          continue;
        }
        if (failure.code === "sandbox_preflight_failed") {
          sessionHasPreflightFailure = true;
        }
        for (const item of arrayOfStrings(failure.missing_env)) {
          missingEnv.add(item);
        }
        for (const item of arrayOfStrings(failure.verification_commands)) {
          verificationCommands.add(item);
        }
        collectLiveSmokeEvidence(failure, liveSmokeEvidence);
      }
      if (sessionHasPreflightFailure) {
        preflightFailureCount += 1;
      }
    }
  }

  for (const event of events.filter((item) => String(item.event_type) === "swarm.branch.failed")) {
    const envelope = parseJson(event.payload_json);
    const payload = isRecord(envelope) && isRecord(envelope.payload) ? envelope.payload : envelope;
    if (!isRecord(payload) || payload.error_code !== "sandbox_preflight_failed") {
      continue;
    }
    preflightFailureEventCount += 1;
    for (const failure of Array.isArray(payload.attempt_failures) ? payload.attempt_failures : []) {
      if (!isRecord(failure)) {
        continue;
      }
      for (const item of arrayOfStrings(failure.missing_env)) {
        missingEnv.add(item);
      }
      for (const item of arrayOfStrings(failure.verification_commands)) {
        verificationCommands.add(item);
      }
      collectLiveSmokeEvidence(failure, liveSmokeEvidence);
    }
  }

  const diagnosis: string[] = [];
  if (sandboxSessions.length === 0) {
    diagnosis.push("No sandbox sessions recorded for this conversation.");
  } else {
    diagnosis.push(`${sandboxSessions.length} sandbox session(s) recorded across providers: ${mapSummary(providers)}.`);
  }
  if (preflightFailureCount > 0) {
    diagnosis.push(
      `Sandbox preflight failures detected in ${preflightFailureCount} session(s); branch failure events: ${preflightFailureEventCount}; missing env: ${[...missingEnv].join(", ") || "unknown"}.`,
    );
  }
  if (verificationCommands.size > 0) {
    diagnosis.push(`Sandbox verification commands: ${[...verificationCommands].join(" | ")}.`);
  }
  if (liveSmokeEvidence.verifiedCount > 0 || liveSmokeEvidence.unverifiedCount > 0) {
    diagnosis.push(
      `E2B live smoke receipt coverage: ${liveSmokeEvidence.verifiedCount} verified, ${liveSmokeEvidence.unverifiedCount} missing/unverified; receipt paths: ${[...liveSmokeEvidence.receiptPaths].join(", ") || "unknown"}.`,
    );
  }

  return {
    sessionCount: sandboxSessions.length,
    e2bSessionCount,
    providers: Object.fromEntries(providers),
    statuses: Object.fromEntries(statuses),
    preflightFailureCount,
    preflightFailureEventCount,
    missingEnv: [...missingEnv],
    verificationCommands: [...verificationCommands],
    liveSmokeVerifiedCount: liveSmokeEvidence.verifiedCount,
    liveSmokeUnverifiedCount: liveSmokeEvidence.unverifiedCount,
    liveSmokeReceiptPaths: [...liveSmokeEvidence.receiptPaths],
    liveSmokeReceiptStatuses: Object.fromEntries(liveSmokeEvidence.receiptStatuses),
    liveSmokeVerifiedAt: [...liveSmokeEvidence.verifiedAt],
    liveSmokeExternalSandboxIds: [...liveSmokeEvidence.externalSandboxIds],
    liveSmokeElapsedMs: liveSmokeEvidence.elapsedMs,
    diagnosis,
  };
}

function buildObservationSummary(observations: Row[]) {
  const sourceTypes = new Map<string, number>();
  const sourceNames = new Map<string, number>();
  const statuses = new Map<string, number>();
  const evidenceLevels = new Map<string, number>();
  const branchObservations: Row[] = [];
  const failedBranchObservations: Row[] = [];
  const skillObservations: Row[] = [];
  const preflightBranchObservations: Row[] = [];
  const missingEnv = new Set<string>();
  const verificationCommands = new Set<string>();
  const liveSmokeEvidence = createLiveSmokeEvidenceSummary();

  for (const observation of observations) {
    const sourceType = String(observation.source_type ?? "unknown");
    const sourceName = String(observation.source_name ?? "unknown");
    const status = String(observation.status ?? "unknown");
    const evidenceLevel = String(observation.evidence_level ?? "unknown");
    sourceTypes.set(sourceType, (sourceTypes.get(sourceType) ?? 0) + 1);
    sourceNames.set(sourceName, (sourceNames.get(sourceName) ?? 0) + 1);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    evidenceLevels.set(evidenceLevel, (evidenceLevels.get(evidenceLevel) ?? 0) + 1);

    if (sourceType === "skill") {
      skillObservations.push(observation);
    }
    if (sourceType === "agent" && sourceName.startsWith("swarm.branch.")) {
      branchObservations.push(observation);
      if (status !== "completed") {
        failedBranchObservations.push(observation);
      }
      const metadata = parseJson(observation.metadata_json);
      if (isRecord(metadata) && metadata.error_code === "sandbox_preflight_failed") {
        preflightBranchObservations.push(observation);
        for (const failure of Array.isArray(metadata.attempt_failures) ? metadata.attempt_failures : []) {
          if (!isRecord(failure)) {
            continue;
          }
          for (const item of arrayOfStrings(failure.missing_env)) {
            missingEnv.add(item);
          }
          for (const item of arrayOfStrings(failure.verification_commands)) {
            verificationCommands.add(item);
          }
          collectLiveSmokeEvidence(failure, liveSmokeEvidence);
        }
      }
    }
  }

  const diagnosis: string[] = [];
  if (observations.length === 0) {
    diagnosis.push("No observations recorded for this conversation.");
  } else {
    diagnosis.push(
      `${observations.length} observation(s) recorded; source types: ${mapSummary(sourceTypes)}; statuses: ${mapSummary(statuses)}.`,
    );
  }
  if (skillObservations.length > 0) {
    diagnosis.push(`${skillObservations.length} planner-selected skill observation(s) recorded.`);
  }
  if (branchObservations.length > 0) {
    diagnosis.push(
      `${branchObservations.length} swarm branch observation(s) recorded; ${failedBranchObservations.length} failed branch observation(s).`,
    );
  }
  if (preflightBranchObservations.length > 0) {
    diagnosis.push(
      `${preflightBranchObservations.length} sandbox preflight branch observation(s) recorded; missing env: ${[...missingEnv].join(", ") || "unknown"}.`,
    );
  }
  if (verificationCommands.size > 0) {
    diagnosis.push(`Observation verification commands: ${[...verificationCommands].join(" | ")}.`);
  }
  if (liveSmokeEvidence.verifiedCount > 0 || liveSmokeEvidence.unverifiedCount > 0) {
    diagnosis.push(
      `Observation live smoke receipt coverage: ${liveSmokeEvidence.verifiedCount} verified, ${liveSmokeEvidence.unverifiedCount} missing/unverified; receipt paths: ${[...liveSmokeEvidence.receiptPaths].join(", ") || "unknown"}.`,
    );
  }

  return {
    observationCount: observations.length,
    sourceTypes: Object.fromEntries(sourceTypes),
    sourceNames: Object.fromEntries(sourceNames),
    statuses: Object.fromEntries(statuses),
    evidenceLevels: Object.fromEntries(evidenceLevels),
    skillObservationCount: skillObservations.length,
    branchObservationCount: branchObservations.length,
    failedBranchObservationCount: failedBranchObservations.length,
    sandboxPreflightBranchObservationCount: preflightBranchObservations.length,
    missingEnv: [...missingEnv],
    verificationCommands: [...verificationCommands],
    liveSmokeVerifiedCount: liveSmokeEvidence.verifiedCount,
    liveSmokeUnverifiedCount: liveSmokeEvidence.unverifiedCount,
    liveSmokeReceiptPaths: [...liveSmokeEvidence.receiptPaths],
    liveSmokeReceiptStatuses: Object.fromEntries(liveSmokeEvidence.receiptStatuses),
    liveSmokeVerifiedAt: [...liveSmokeEvidence.verifiedAt],
    liveSmokeExternalSandboxIds: [...liveSmokeEvidence.externalSandboxIds],
    liveSmokeElapsedMs: liveSmokeEvidence.elapsedMs,
    diagnosis,
  };
}

function buildSelfImprovementSummary(
  candidates: Array<{
    id: string;
    candidateType: string;
    status: string;
    severity: string;
    title: string;
    proposal: Record<string, unknown>;
    verificationPlan: Record<string, unknown>;
  }>,
) {
  const statuses = new Map<string, number>();
  const types = new Map<string, number>();
  const severities = new Map<string, number>();
  for (const candidate of candidates) {
    statuses.set(candidate.status, (statuses.get(candidate.status) ?? 0) + 1);
    types.set(candidate.candidateType, (types.get(candidate.candidateType) ?? 0) + 1);
    severities.set(candidate.severity, (severities.get(candidate.severity) ?? 0) + 1);
  }
  const queued = candidates.filter((candidate) => candidate.status === "queued");
  const patchPrepared = candidates.filter((candidate) => candidate.status === "patch_prepared");
  const applied = candidates.filter((candidate) => candidate.status === "applied");
  const appliedReceiptSummary = summarizeAppliedReceipts(applied);
  const requiredCommands = Array.from(
    new Set(
      candidates.flatMap((candidate) => {
        const value = candidate.verificationPlan.required_commands;
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      }),
    ),
  );

  return {
    candidateCount: candidates.length,
    queuedCount: queued.length,
    patchPreparedCount: patchPrepared.length,
    appliedCount: applied.length,
    appliedWithVerificationReceiptCount: appliedReceiptSummary.withReceiptCount,
    appliedMissingVerificationReceiptCount: appliedReceiptSummary.missingReceiptCount,
    appliedReceiptCommandResultCount: appliedReceiptSummary.commandResultCount,
    appliedReceiptRequiredCommandCoverage: appliedReceiptSummary.requiredCommandCoverage,
    statuses: Object.fromEntries(statuses),
    candidateTypes: Object.fromEntries(types),
    severities: Object.fromEntries(severities),
    requiredCommands,
    diagnosis:
      candidates.length === 0
        ? ["No self-improvement candidates are currently queued for this conversation."]
        : [
            `${candidates.length} self-improvement candidate(s) detected; ${queued.length} queued, ${patchPrepared.length} patch-prepared, ${applied.length} applied.`,
            applied.length > 0
              ? `Applied self-improvement receipt coverage: ${appliedReceiptSummary.withReceiptCount}/${applied.length} with command-level verification receipts; ${appliedReceiptSummary.commandResultCount} command result(s) recorded.`
              : "No applied self-improvement candidates detected.",
            requiredCommands.length > 0
              ? `Self-improvement verification commands: ${requiredCommands.join(" | ")}`
              : "Self-improvement candidates do not expose explicit verification commands.",
          ],
  };
}

function summarizeAppliedReceipts(
  applied: Array<{
    id: string;
    proposal: Record<string, unknown>;
    verificationPlan: Record<string, unknown>;
  }>,
) {
  let withReceiptCount = 0;
  let missingReceiptCount = 0;
  let commandResultCount = 0;
  const requiredCommandCoverage: Record<string, { required: number; passed: number; complete: boolean }> = {};
  for (const candidate of applied) {
    const receipt = latestAppliedVerificationReceipt(candidate.proposal);
    const requiredCommands = arrayOfStrings(candidate.verificationPlan.required_commands);
    if (!isRecord(receipt)) {
      missingReceiptCount += 1;
      requiredCommandCoverage[candidate.id] = { required: requiredCommands.length, passed: 0, complete: false };
      continue;
    }
    const commandResults = Array.isArray(receipt.commandResults) ? receipt.commandResults.filter(isRecord) : [];
    const passedCommands = new Set(
      commandResults
        .filter((result) => result.status === "passed" && typeof result.command === "string")
        .map((result) => String(result.command)),
    );
    const complete = requiredCommands.length > 0 && requiredCommands.every((command) => passedCommands.has(command));
    commandResultCount += commandResults.length;
    if (receipt.operatorConfirmed === true && complete) {
      withReceiptCount += 1;
    } else {
      missingReceiptCount += 1;
    }
    requiredCommandCoverage[candidate.id] = {
      required: requiredCommands.length,
      passed: requiredCommands.filter((command) => passedCommands.has(command)).length,
      complete,
    };
  }
  return { withReceiptCount, missingReceiptCount, commandResultCount, requiredCommandCoverage };
}

function latestAppliedVerificationReceipt(proposal: Record<string, unknown>) {
  const decisions = Array.isArray(proposal.decisions) ? proposal.decisions : [];
  const latest = [...decisions].reverse().find((decision) => isRecord(decision) && decision.action === "mark_applied");
  return isRecord(latest) ? latest.verificationReceipt : null;
}

function buildQualityIssues(toolCalls: Row[], evals: Row[], events: Row[], messages: Row[]) {
  const issues: string[] = [];
  const emptySourceToolCalls = toolCalls.filter((call) => {
    const outputPayload = call.output_payload;
    const sources = isRecord(outputPayload) && Array.isArray(outputPayload.sources) ? outputPayload.sources : [];
    return isWebSearchToolName(String(call.tool_name)) && call.status === "completed" && sources.length === 0;
  });
  const siteDomainMismatchToolCalls = toolCalls.filter((call) => {
    if (!isWebSearchToolName(String(call.tool_name)) || call.status !== "completed") {
      return false;
    }
    const requiredDomains = extractRequiredSiteDomains(userTextForRun(messages, String(call.run_id)));
    if (requiredDomains.length === 0) {
      return false;
    }
    const outputPayload = call.output_payload;
    const sources = isRecord(outputPayload) && Array.isArray(outputPayload.sources) ? outputPayload.sources : [];
    return sources.length > 0 && !sources.some((source) => sourceMatchesRequiredDomain(source, requiredDomains));
  });
  for (const call of emptySourceToolCalls) {
    issues.push(`${String(call.tool_name)} returned 0 sources for run ${String(call.run_id)} query "${String(call.input_summary ?? "")}".`);
  }
  for (const call of siteDomainMismatchToolCalls) {
    const requiredDomains = extractRequiredSiteDomains(userTextForRun(messages, String(call.run_id)));
    issues.push(
      `${String(call.tool_name)} returned sources that did not satisfy required site/domain constraint (${requiredDomains.join(", ")}) for run ${String(call.run_id)} query "${String(call.input_summary ?? "")}".`,
    );
  }

  const perfectEvals = evals.filter((evalResult) => Number(evalResult.score) >= 1);
  for (const evalResult of perfectEvals) {
    const hasEmptySourceInRun = emptySourceToolCalls.some((call) => call.run_id === evalResult.run_id);
    const hasSiteDomainMismatchInRun = siteDomainMismatchToolCalls.some((call) => call.run_id === evalResult.run_id);
    if (hasEmptySourceInRun) {
      issues.push(`eval ${String(evalResult.id)} scored 100% despite an empty web-search observation in run ${String(evalResult.run_id)}.`);
    }
    if (hasSiteDomainMismatchInRun) {
      issues.push(
        `eval ${String(evalResult.id)} scored 100% despite web-search sources missing the requested site/domain constraint in run ${String(evalResult.run_id)}.`,
      );
    }
  }

  const runToolCounts = new Map<string, number>();
  for (const event of events.filter((item) => String(item.event_type) === "tool.call.completed")) {
    const runId = String(event.run_id);
    runToolCounts.set(runId, (runToolCounts.get(runId) ?? 0) + 1);
  }
  for (const call of emptySourceToolCalls) {
    if ((runToolCounts.get(String(call.run_id)) ?? 0) <= 1) {
      issues.push(`run ${String(call.run_id)} stopped after one empty tool result; replan/fallback was not observed.`);
    }
  }
  const replanRunIds = new Set(
    events.filter((item) => String(item.event_type) === "agent.replan.requested").map((event) => String(event.run_id)),
  );
  for (const call of siteDomainMismatchToolCalls) {
    if (!replanRunIds.has(String(call.run_id))) {
      issues.push(`run ${String(call.run_id)} accepted web sources outside the required site/domain constraint; replan/fallback was not observed.`);
    }
  }

  return Array.from(new Set(issues));
}

function buildRuntimeConsistencySummary(runs: Row[], events: Row[], traceSpans: Row[]) {
  const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);
  const terminalRunIds = new Set(
    runs.filter((run) => terminalRunStatuses.has(String(run.status))).map((run) => String(run.id)),
  );
  const activities = new Map<
    string,
    {
      id: string;
      runId: string;
      kind: string;
      title: string;
      status: "running" | "completed" | "failed";
      startedSeq: number;
      lastSeq: number;
      settledBy?: string;
    }
  >();
  const swarmTerminalEventByRun = new Map<string, string>();

  for (const event of events) {
    const eventType = String(event.event_type);
    if (["swarm.reduce", "swarm.merge", "swarm.verify", "swarm.review", "swarm.cancelled"].includes(eventType)) {
      swarmTerminalEventByRun.set(String(event.run_id), eventType);
    }
  }

  for (const event of events) {
    const parsed = parseJson(event.payload_json);
    const envelope = isRecord(parsed) && isRecord(parsed.payload) ? parsed : {};
    const payload = isRecord(envelope.payload) ? envelope.payload : isRecord(parsed) ? parsed : {};
    const trace = isRecord(envelope.trace) ? envelope.trace : {};
    const activity = runtimeActivityFromEvent(event, payload, trace, swarmTerminalEventByRun.get(String(event.run_id)));
    if (!activity) {
      continue;
    }
    const current = activities.get(activity.id);
    if (!current) {
      activities.set(activity.id, activity);
      continue;
    }
    activities.set(activity.id, {
      ...current,
      ...activity,
      startedSeq: Math.min(current.startedSeq, activity.startedSeq),
      lastSeq: Math.max(current.lastSeq, activity.lastSeq),
      settledBy: activity.settledBy ?? current.settledBy,
    });
  }

  const openActivities = [...activities.values()].filter((activity) => activity.status === "running");
  const staleRunningActivities = openActivities.filter((activity) => terminalRunIds.has(activity.runId));
  const staleTraceSpans = traceSpans.filter(
    (span) => terminalRunIds.has(String(span.run_id)) && ["running", "queued"].includes(String(span.status)),
  );
  const swarmPlanSettledByLaterStageCount = [...activities.values()].filter(
    (activity) => activity.kind === "swarm.plan" && activity.status === "completed" && activity.settledBy,
  ).length;
  const issues = [
    ...staleRunningActivities.map(
      (activity) =>
        `run ${activity.runId} is terminal but runtime activity ${activity.title} (${activity.id}) is still ${activity.status}.`,
    ),
    ...staleTraceSpans.map(
      (span) =>
        `run ${String(span.run_id)} is terminal but trace span ${String(span.id)} (${String(span.name ?? span.span_kind)}) is still ${String(span.status)}.`,
    ),
  ];
  const diagnosis: string[] = [];
  if (activities.size === 0 && traceSpans.length === 0) {
    diagnosis.push("No runtime activities or trace spans recorded for lifecycle consistency checks.");
  } else {
    diagnosis.push(
      `Runtime lifecycle consistency: ${activities.size} activity item(s), ${openActivities.length} open/running, ${staleRunningActivities.length} stale after terminal run; ${traceSpans.length} trace span(s), ${staleTraceSpans.length} stale trace span(s).`,
    );
  }
  if (swarmPlanSettledByLaterStageCount > 0) {
    diagnosis.push(`${swarmPlanSettledByLaterStageCount} swarm.plan activity item(s) settled by later swarm terminal stages.`);
  }
  if (issues.length > 0) {
    diagnosis.push(`Runtime lifecycle inconsistencies detected: ${issues.slice(0, 3).join(" | ")}`);
  }

  return {
    activityCount: activities.size,
    openActivityCount: openActivities.length,
    staleRunningActivityCount: staleRunningActivities.length,
    traceSpanCount: traceSpans.length,
    staleTraceSpanCount: staleTraceSpans.length,
    terminalRunCount: terminalRunIds.size,
    swarmPlanSettledByLaterStageCount,
    openActivities: openActivities.map((activity) => ({
      id: activity.id,
      runId: activity.runId,
      kind: activity.kind,
      title: activity.title,
      status: activity.status,
      settledBy: activity.settledBy,
    })),
    staleTraceSpans: staleTraceSpans.map((span) => ({
      id: String(span.id),
      runId: String(span.run_id),
      name: String(span.name ?? span.span_kind ?? "trace span"),
      status: String(span.status),
    })),
    issues,
    diagnosis,
  };
}

function runtimeActivityFromEvent(
  event: Row,
  payload: Record<string, unknown>,
  trace: Record<string, unknown>,
  swarmTerminalEventType: string | undefined,
) {
  const type = String(event.event_type);
  const runId = String(event.run_id);
  const seq = Number(event.seq ?? 0);
  if (type.startsWith("tool.call.")) {
    const id = `tool:${String(payload.tool_call_id ?? trace.span_id ?? event.producer_id ?? "tool")}`;
    return {
      id,
      runId,
      kind: "tool",
      title: `Tool call: ${String(payload.tool_name ?? "tool")}`,
      status: terminalStatusFromEvent(type),
      startedSeq: seq,
      lastSeq: seq,
    };
  }
  if (type.startsWith("model.call.")) {
    const id = `model:${String(payload.model_call_id ?? trace.span_id ?? event.producer_id ?? "model")}`;
    return {
      id,
      runId,
      kind: "model",
      title: `Model call: ${String(payload.model ?? payload.model_profile ?? "model")}`,
      status: terminalStatusFromEvent(type),
      startedSeq: seq,
      lastSeq: seq,
    };
  }
  if (type.startsWith("artifact.")) {
    const id = `artifact:${String(trace.span_id ?? payload.artifact_id ?? payload.artifact_version_id ?? event.producer_id ?? "artifact")}`;
    return {
      id,
      runId,
      kind: "artifact",
      title: `Artifact: ${String(payload.title ?? payload.type ?? "artifact")}`,
      status: terminalStatusFromEvent(type),
      startedSeq: seq,
      lastSeq: seq,
    };
  }
  if (["swarm.plan", "swarm.reduce", "swarm.merge", "swarm.verify", "swarm.review", "swarm.cancelled"].includes(type)) {
    const isPlanSettled = type === "swarm.plan" && Boolean(swarmTerminalEventType);
    const payloadStatus = String(payload.status ?? "");
    const hasTerminalPayloadStatus = ["completed", "failed", "cancelled"].includes(payloadStatus);
    return {
      id: `swarm:${type}:${String(trace.span_id ?? event.seq ?? type)}`,
      runId,
      kind: type,
      title: type,
      status:
        isPlanSettled || type !== "swarm.plan" || hasTerminalPayloadStatus
          ? payloadStatus === "failed" || payloadStatus === "cancelled"
            ? "failed"
            : "completed"
          : terminalStatusFromEvent(type),
      startedSeq: seq,
      lastSeq: seq,
      settledBy: isPlanSettled ? swarmTerminalEventType : undefined,
    };
  }
  return null;
}

function terminalStatusFromEvent(type: string): "running" | "completed" | "failed" {
  if (/failed|error|cancelled/.test(type)) {
    return "failed";
  }
  if (/completed|output|ready|created|selected/.test(type)) {
    return "completed";
  }
  return "running";
}

function isWebSearchToolName(name: string) {
  return name === "web.search" || name === "tavily.search";
}

function userTextForRun(messages: Row[], runId: string) {
  const matched = messages
    .filter((message) => String(message.run_id ?? "") === runId && message.role === "user")
    .map((message) => extractTextFromParts(parseJson(message.parts_json)))
    .filter(Boolean);
  return matched.at(-1) ?? "";
}

function extractTextFromParts(parts: unknown) {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        return "";
      }
      return part.text;
    })
    .filter(Boolean)
    .join("\n\n");
}

function sourceMatchesRequiredDomain(source: unknown, requiredDomains: string[]) {
  if (!isRecord(source)) {
    return false;
  }
  const hostname = hostnameFromUrl(String(source.url ?? ""));
  return requiredDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
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

async function readCanonicalVerificationSummary(): Promise<CanonicalVerificationReceiptSummary> {
  const receiptFiles = [
    "canonical-verification-latest.json",
    "canonical-phase4-e2b-latest.json",
    "canonical-phase4-live-required-latest.json",
  ];
  const receipts: Array<{ path: string; payload: Record<string, unknown> }> = [];
  for (const fileName of receiptFiles) {
    const filePath = path.join(dataDir, "verification", fileName);
    try {
      const parsed = parseJson(await readFile(filePath, "utf8"));
      if (isRecord(parsed) && parsed.receiptSchema === "dataswarm.canonical-verification.v1") {
        receipts.push({ path: path.relative(process.cwd(), filePath), payload: parsed });
      }
    } catch {
      // Missing or invalid local receipts should not break conversation diagnostics.
    }
  }

  const phases: CanonicalVerificationReceiptSummary["phases"] = {};
  const verificationCommands = new Set<string>([
    "node scripts/canonical-verification-runner.mjs --dry-run",
    "node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-readiness,e2b-live-receipt,e2b-live-sandbox",
    "node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b",
  ]);
  let totalGates = 0;
  let passed = 0;
  let failed = 0;
  let gatedSkip = 0;
  let notRun = 0;
  let liveE2bRequired = false;
  let liveE2bGated = false;
  let latestCompletedAt: string | null = null;

  for (const receipt of receipts) {
    const summary = isRecord(receipt.payload.summary) ? receipt.payload.summary : {};
    totalGates += numericField(summary.total);
    passed += numericField(summary.passed);
    failed += numericField(summary.failed);
    gatedSkip += numericField(summary.gatedSkip);
    notRun += numericField(summary.notRun);

    const filters = isRecord(receipt.payload.filters) ? receipt.payload.filters : {};
    if (filters.requireLiveE2b === true) {
      liveE2bRequired = true;
    }
    const completedAt = typeof receipt.payload.completedAt === "string" ? receipt.payload.completedAt : "";
    if (completedAt && (!latestCompletedAt || completedAt > latestCompletedAt)) {
      latestCompletedAt = completedAt;
    }

    const phaseSummary = isRecord(receipt.payload.phaseSummary) ? receipt.payload.phaseSummary : {};
    for (const [phase, value] of Object.entries(phaseSummary)) {
      if (!isRecord(value)) {
        continue;
      }
      phases[phase] ??= { total: 0, passed: 0, failed: 0, gatedSkip: 0, notRun: 0 };
      phases[phase].total += numericField(value.total);
      phases[phase].passed += numericField(value.passed);
      phases[phase].failed += numericField(value.failed);
      phases[phase].gatedSkip += numericField(value.gatedSkip);
      phases[phase].notRun += numericField(value.notRun);
    }

    const results = Array.isArray(receipt.payload.results) ? receipt.payload.results : [];
    for (const result of results) {
      if (!isRecord(result)) {
        continue;
      }
      if (typeof result.command === "string" && result.command.length > 0) {
        verificationCommands.add(result.command);
      }
      if (result.key === "e2b-live-sandbox" && result.status === "gated_skip") {
        liveE2bGated = true;
      }
    }
  }

  const diagnosis =
    receipts.length === 0
      ? [
          "Canonical verification receipt not found; run node scripts/canonical-verification-runner.mjs --dry-run to create an auditable gate inventory.",
        ]
      : [
          `Canonical verification receipts: ${receipts.length}; gates total=${totalGates}, passed=${passed}, failed=${failed}, gated=${gatedSkip}, notRun=${notRun}.`,
          liveE2bGated
            ? "Canonical verification shows live E2B sandbox execution is still gated; the Real Swarm goal cannot be marked complete without live external evidence."
            : "Canonical verification does not show a gated live E2B sandbox gate.",
        ];

  return {
    receiptCount: receipts.length,
    receiptPaths: receipts.map((receipt) => receipt.path),
    totalGates,
    passed,
    failed,
    gatedSkip,
    notRun,
    phases,
    liveE2bRequired,
    liveE2bGated,
    latestCompletedAt,
    verificationCommands: [...verificationCommands],
    diagnosis,
  };
}

function numericField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildProductHealth(logs: ObservedLog[], events: Row[], toolCalls: Row[]) {
  const uiLogs = logs.filter((log) => log.source === "ui");
  const serverLogs = logs.filter((log) => log.source === "server");
  const logEvents = new Set(logs.map((log) => String(log.event ?? "")));
  const toolEventRunIds = new Set(
    events
      .filter((event) => String(event.event_type).startsWith("tool.call."))
      .map((event) => String(event.run_id)),
  );
  const runtimeUpsertRunIds = new Set(
    uiLogs
      .filter((log) => log.event === "runtime.item.upsert")
      .map((log) => String(log.runId ?? payloadField(log.payload, "runId") ?? "")),
  );
  const issues: string[] = [];

  if (!logEvents.has("message.submit.accepted")) {
    issues.push("UI did not record message.submit.accepted; submit handoff may not be observable.");
  }
  if (!logEvents.has("api.messages.post.accepted")) {
    issues.push("Server did not record api.messages.post.accepted; API handoff may not be observable.");
  }
  if (!logEvents.has("events.open")) {
    issues.push("UI did not record events.open; SSE stream connection cannot be confirmed from logs.");
  }
  if (toolEventRunIds.size > 0 && runtimeUpsertRunIds.size === 0) {
    issues.push("Tool events exist, but UI did not record runtime.item.upsert; tool-card rendering is not confirmed.");
  }
  if (!logEvents.has("suggestions.rendered")) {
    issues.push("UI did not record suggestions.rendered; follow-up prompt rendering is not confirmed.");
  }

  return {
    uiLogCount: uiLogs.length,
    serverLogCount: serverLogs.length,
    hasSubmitAccepted: logEvents.has("message.submit.accepted"),
    hasServerMessageAccepted: logEvents.has("api.messages.post.accepted"),
    hasSseOpen: logEvents.has("events.open"),
    hasMessageCompleted: logEvents.has("events.message.completed"),
    hasRuntimeItemRenderSignal: runtimeUpsertRunIds.size > 0,
    hasSuggestionsRenderSignal: logEvents.has("suggestions.rendered"),
    toolRunCount: toolEventRunIds.size,
    renderedToolRunCount: runtimeUpsertRunIds.size,
    recordedToolCallCount: toolCalls.length,
    issues,
    diagnosis:
      issues.length === 0
        ? ["Product interaction logs indicate submit, stream, runtime card, suggestion, and server handoff signals are present."]
        : issues,
  };
}

function payloadField(payload: unknown, field: string) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return (payload as Record<string, unknown>)[field] ?? null;
}

function createLiveSmokeEvidenceSummary(): LiveSmokeEvidenceSummary {
  return {
    verifiedCount: 0,
    unverifiedCount: 0,
    receiptPaths: new Set(),
    receiptStatuses: new Map(),
    verifiedAt: new Set(),
    externalSandboxIds: new Set(),
    elapsedMs: [],
  };
}

function collectLiveSmokeEvidence(record: Record<string, unknown>, summary: LiveSmokeEvidenceSummary) {
  const hasLiveSmokeFields = [
    "live_smoke_verified",
    "live_smoke_receipt_path",
    "live_smoke_receipt_status",
    "live_smoke_verified_at",
    "live_smoke_external_sandbox_id",
    "live_smoke_elapsed_ms",
  ].some((field) => record[field] !== undefined && record[field] !== null && record[field] !== "");
  if (!hasLiveSmokeFields) {
    return;
  }

  if (record.live_smoke_verified === true) {
    summary.verifiedCount += 1;
  } else {
    summary.unverifiedCount += 1;
  }
  if (typeof record.live_smoke_receipt_path === "string" && record.live_smoke_receipt_path.length > 0) {
    summary.receiptPaths.add(record.live_smoke_receipt_path);
  }
  if (typeof record.live_smoke_receipt_status === "string" && record.live_smoke_receipt_status.length > 0) {
    summary.receiptStatuses.set(
      record.live_smoke_receipt_status,
      (summary.receiptStatuses.get(record.live_smoke_receipt_status) ?? 0) + 1,
    );
  }
  if (typeof record.live_smoke_verified_at === "string" && record.live_smoke_verified_at.length > 0) {
    summary.verifiedAt.add(record.live_smoke_verified_at);
  }
  if (typeof record.live_smoke_external_sandbox_id === "string" && record.live_smoke_external_sandbox_id.length > 0) {
    summary.externalSandboxIds.add(record.live_smoke_external_sandbox_id);
  }
  if (typeof record.live_smoke_elapsed_ms === "number" && Number.isFinite(record.live_smoke_elapsed_ms)) {
    summary.elapsedMs.push(record.live_smoke_elapsed_ms);
  }
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function mapSummary(value: Map<string, number>) {
  return [...value.entries()].map(([key, count]) => `${key}:${count}`).join(", ") || "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function readLocalJson(uri: unknown) {
  if (typeof uri !== "string" || !uri.startsWith("local://")) {
    return null;
  }
  try {
    const content = await readFile(resolveLocalUri(uri), "utf8");
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}
