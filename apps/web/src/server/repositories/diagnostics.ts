import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../storage/db";
import { dataDir, resolveLocalUri } from "../storage/paths";
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
      `SELECT id, run_id, type, mime_type, title, status, storage_uri, preview_uri, created_at
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
    artifacts,
    logs,
    selfImprovementCandidates,
    canonicalVerification,
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
  const canonicalVerification = input.canonicalVerification;
  const remediation = buildRemediationPlan({
    productHealth,
    qualityIssues,
    observations,
    sandbox,
    selfImprovement,
    canonicalVerification,
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
    canonicalVerification,
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
      ...canonicalVerification.diagnosis,
      remediation.length === 0
        ? "No structured remediation items generated."
        : `${remediation.length} structured remediation item(s) generated.`,
      failures.length === 0 ? "No failure markers detected." : `${failures.length} failure marker(s) detected.`,
    ],
  };
}

function buildRemediationPlan(input: {
  productHealth: ReturnType<typeof buildProductHealth>;
  qualityIssues: string[];
  observations: ReturnType<typeof buildObservationSummary>;
  sandbox: ReturnType<typeof buildSandboxSummary>;
  selfImprovement: ReturnType<typeof buildSelfImprovementSummary>;
  canonicalVerification: CanonicalVerificationReceiptSummary;
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
