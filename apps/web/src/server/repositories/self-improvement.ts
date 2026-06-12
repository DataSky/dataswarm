import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";
import { atomicWriteText, localUri, resolveLocalUri } from "../storage/paths";

export type SelfImprovementCandidateInput = {
  runId: string;
  conversationId: string;
  evalResultId?: string;
  candidateType: "prompt_patch" | "skill_patch" | "tool_adapter_patch" | "ui_bug_report" | "runtime_policy_patch";
  severity: "low" | "medium" | "high";
  title: string;
  rationale: string;
  evidence?: Record<string, unknown>;
  proposal?: Record<string, unknown>;
  verificationPlan?: Record<string, unknown>;
  traceSpanId?: string;
};

export type SelfImprovementCandidateStatus =
  | "queued"
  | "shadow_tested"
  | "shadow_failed"
  | "patch_prepared"
  | "approved"
  | "rejected"
  | "deferred"
  | "applied";

export type SelfImprovementCandidateRecord = {
  id: string;
  runId: string;
  conversationId: string;
  evalResultId: string | null;
  candidateType: string;
  status: SelfImprovementCandidateStatus;
  severity: string;
  title: string;
  rationale: string;
  evidence: Record<string, unknown>;
  proposal: Record<string, unknown>;
  verificationPlan: Record<string, unknown>;
  traceSpanId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SelfImprovementQueueSummary = {
  total: number;
  open: number;
  applied: number;
  appliedWithReceipt: number;
  appliedMissingReceipt: number;
  receiptCommandResults: number;
  highSeverityOpen: number;
  pendingShadowTest: number;
  readyForPatchBundle: number;
  readyForHumanDecision: number;
  approvedAwaitingApplication: number;
  deferred: number;
  rejected: number;
  queueHealth: "clear" | "needs_review" | "needs_attention";
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
  byType: Record<string, number>;
  requiredCommands: string[];
  nextOperatorActions: Array<{
    id: string;
    label: string;
    count: number;
    severity: "low" | "medium" | "high";
  }>;
};

type SelfImprovementCandidateRow = {
  id: string;
  run_id: string;
  conversation_id: string;
  eval_result_id: string | null;
  candidate_type: string;
  status: SelfImprovementCandidateStatus;
  severity: string;
  title: string;
  rationale: string;
  evidence_json: string | null;
  proposal_json: string | null;
  verification_plan_json: string | null;
  trace_span_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function createSelfImprovementCandidate(input: SelfImprovementCandidateInput) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("sic");

  db.prepare(
    `INSERT INTO self_improvement_candidates
     (id, tenant_id, project_id, run_id, conversation_id, eval_result_id, candidate_type, status, severity, title, rationale,
      evidence_json, proposal_json, verification_plan_json, trace_span_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    input.conversationId,
    input.evalResultId ?? null,
    input.candidateType,
    "queued",
    input.severity,
    input.title,
    input.rationale,
    JSON.stringify(input.evidence ?? {}),
    JSON.stringify(input.proposal ?? {}),
    JSON.stringify(input.verificationPlan ?? {}),
    input.traceSpanId ?? null,
    now,
    now,
  );

  return { id };
}

export async function listSelfImprovementCandidates(runId: string): Promise<SelfImprovementCandidateRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, run_id, conversation_id, eval_result_id, candidate_type, status, severity, title, rationale,
              evidence_json, proposal_json, verification_plan_json, trace_span_id, created_at, updated_at
       FROM self_improvement_candidates
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId) as SelfImprovementCandidateRow[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    evalResultId: row.eval_result_id,
    candidateType: row.candidate_type,
    status: row.status,
    severity: row.severity,
    title: row.title,
    rationale: row.rationale,
    evidence: parseJsonRecord(row.evidence_json),
    proposal: parseJsonRecord(row.proposal_json),
    verificationPlan: parseJsonRecord(row.verification_plan_json),
    traceSpanId: row.trace_span_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getSelfImprovementCandidate(runId: string, candidateId: string) {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT id, run_id, conversation_id, eval_result_id, candidate_type, status, severity, title, rationale,
              evidence_json, proposal_json, verification_plan_json, trace_span_id, created_at, updated_at
       FROM self_improvement_candidates
       WHERE run_id = ? AND id = ?`,
    )
    .get(runId, candidateId) as SelfImprovementCandidateRow | undefined;
  return row ? mapCandidateRow(row) : null;
}

export function summarizeSelfImprovementCandidates(
  candidates: SelfImprovementCandidateRecord[],
): SelfImprovementQueueSummary {
  const byStatus: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const requiredCommands = new Set<string>();
  let applied = 0;
  let appliedWithReceipt = 0;
  let receiptCommandResults = 0;
  let highSeverityOpen = 0;
  let pendingShadowTest = 0;
  let readyForPatchBundle = 0;
  let readyForHumanDecision = 0;
  let approvedAwaitingApplication = 0;
  let deferred = 0;
  let rejected = 0;

  for (const candidate of candidates) {
    byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
    bySeverity[candidate.severity] = (bySeverity[candidate.severity] ?? 0) + 1;
    byType[candidate.candidateType] = (byType[candidate.candidateType] ?? 0) + 1;

    for (const command of stringArray(candidate.verificationPlan.required_commands)) {
      requiredCommands.add(command);
    }

    if (candidate.status === "rejected") {
      rejected += 1;
      continue;
    }
    if (candidate.status === "deferred") {
      deferred += 1;
      continue;
    }
    if (candidate.status === "applied") {
      applied += 1;
      const receipt = latestAppliedVerificationReceipt(candidate.proposal);
      if (receipt) {
        appliedWithReceipt += 1;
        const commandResults = Array.isArray(receipt.commandResults) ? receipt.commandResults : [];
        receiptCommandResults += commandResults.length;
      }
      continue;
    }

    if (candidate.severity === "high") {
      highSeverityOpen += 1;
    }
    if (candidate.status === "queued" || candidate.status === "shadow_failed") {
      pendingShadowTest += 1;
    }
    if (candidate.status === "shadow_tested") {
      readyForPatchBundle += 1;
    }
    if (candidate.status === "patch_prepared") {
      readyForHumanDecision += 1;
    }
    if (candidate.status === "approved") {
      approvedAwaitingApplication += 1;
    }
  }

  const appliedMissingReceipt = Math.max(applied - appliedWithReceipt, 0);
  const open = Math.max(candidates.length - applied - rejected - deferred, 0);
  const queueHealth =
    highSeverityOpen > 0 || appliedMissingReceipt > 0
      ? "needs_attention"
      : open > 0
        ? "needs_review"
        : "clear";

  return {
    total: candidates.length,
    open,
    applied,
    appliedWithReceipt,
    appliedMissingReceipt,
    receiptCommandResults,
    highSeverityOpen,
    pendingShadowTest,
    readyForPatchBundle,
    readyForHumanDecision,
    approvedAwaitingApplication,
    deferred,
    rejected,
    queueHealth,
    byStatus,
    bySeverity,
    byType,
    requiredCommands: Array.from(requiredCommands).sort(),
    nextOperatorActions: buildNextOperatorActions({
      highSeverityOpen,
      appliedMissingReceipt,
      pendingShadowTest,
      readyForPatchBundle,
      readyForHumanDecision,
      approvedAwaitingApplication,
    }),
  };
}

export async function findSelfImprovementCandidateForEvalCheck(input: {
  runId: string;
  evalResultId: string;
  checkId: string;
}) {
  const candidates = await listSelfImprovementCandidates(input.runId);
  return (
    candidates.find(
      (candidate) =>
        candidate.evalResultId === input.evalResultId &&
        typeof candidate.evidence.check_id === "string" &&
        candidate.evidence.check_id === input.checkId,
    ) ?? null
  );
}

export async function findSelfImprovementCandidateForDiagnosticRemediation(input: {
  runId: string;
  remediationId: string;
  source: string;
}) {
  const candidates = await listSelfImprovementCandidates(input.runId);
  return (
    candidates.find(
      (candidate) =>
        candidate.evalResultId === null &&
        candidate.evidence.source === input.source &&
        candidate.evidence.remediation_id === input.remediationId,
    ) ?? null
  );
}

export async function runSelfImprovementShadowTest(runId: string, candidateId: string) {
  const candidate = await getSelfImprovementCandidate(runId, candidateId);
  if (!candidate) {
    throw new Error(`Self-improvement candidate not found: ${candidateId}`);
  }

  const testedAt = nowIso();
  const checks = buildShadowChecks(candidate);
  const passed = checks.every((check) => check.passed);
  const shadowTest = {
    testedAt,
    status: passed ? "passed" : "failed",
    checks,
    policy: {
      autoApply: false,
      allowedVerificationCommands: allowedVerificationCommands,
    },
  };
  const evidence = {
    ...candidate.evidence,
    shadowTests: [...arrayValue(candidate.evidence.shadowTests), shadowTest],
  };
  const status: SelfImprovementCandidateStatus = passed ? "shadow_tested" : "shadow_failed";
  await updateSelfImprovementCandidate(candidate.id, { status, evidence });
  return { candidate: { ...candidate, status, evidence, updatedAt: testedAt }, shadowTest };
}

export async function decideSelfImprovementCandidate(input: {
  runId: string;
  candidateId: string;
  action: "approve" | "reject" | "defer" | "mark_applied";
  comment?: string;
  verificationReceipt?: unknown;
}) {
  const candidate = await getSelfImprovementCandidate(input.runId, input.candidateId);
  if (!candidate) {
    throw new Error(`Self-improvement candidate not found: ${input.candidateId}`);
  }

  const status = nextStatusForDecision(candidate.status, input.action);
  const decidedAt = nowIso();
  const decision = {
    action: input.action,
    status,
    decidedAt,
    comment: input.comment ?? "",
    actor: "local_user",
    verificationReceipt: input.action === "mark_applied"
      ? buildAppliedVerificationReceipt(candidate, decidedAt, input.comment ?? "", input.verificationReceipt)
      : undefined,
  };
  const proposal = {
    ...candidate.proposal,
    decisions: [...arrayValue(candidate.proposal.decisions), decision],
  };
  await updateSelfImprovementCandidate(candidate.id, { status, proposal });
  return { candidate: { ...candidate, status, proposal, updatedAt: decidedAt }, decision };
}

export async function prepareSelfImprovementPatchBundle(runId: string, candidateId: string) {
  const candidate = await getSelfImprovementCandidate(runId, candidateId);
  if (!candidate) {
    throw new Error(`Self-improvement candidate not found: ${candidateId}`);
  }
  if (candidate.status !== "shadow_tested") {
    throw new Error(`Candidate must be shadow_tested before preparing a patch bundle; current status is ${candidate.status}`);
  }

  const preparedAt = nowIso();
  const content = buildPatchBundleMarkdown(candidate, preparedAt);
  const bundleUri = localUri("self-improvement", defaults.projectId, runId, `${candidateId}.patch-bundle.md`);
  await atomicWriteText(resolveLocalUri(bundleUri), content);
  const patchBundle = {
    preparedAt,
    storageUri: bundleUri,
    format: "markdown",
    autoApply: false,
    summary: `Review bundle prepared for ${candidate.candidateType} candidate ${candidate.id}.`,
  };
  const proposal = {
    ...candidate.proposal,
    patchBundle,
  };
  await updateSelfImprovementCandidate(candidate.id, { status: "patch_prepared", proposal });
  return { candidate: { ...candidate, status: "patch_prepared" as const, proposal, updatedAt: preparedAt }, patchBundle };
}

function mapCandidateRow(row: SelfImprovementCandidateRow): SelfImprovementCandidateRecord {
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    evalResultId: row.eval_result_id,
    candidateType: row.candidate_type,
    status: row.status,
    severity: row.severity,
    title: row.title,
    rationale: row.rationale,
    evidence: parseJsonRecord(row.evidence_json),
    proposal: parseJsonRecord(row.proposal_json),
    verificationPlan: parseJsonRecord(row.verification_plan_json),
    traceSpanId: row.trace_span_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildNextOperatorActions(input: {
  highSeverityOpen: number;
  appliedMissingReceipt: number;
  pendingShadowTest: number;
  readyForPatchBundle: number;
  readyForHumanDecision: number;
  approvedAwaitingApplication: number;
}) {
  const actions: SelfImprovementQueueSummary["nextOperatorActions"] = [];
  if (input.appliedMissingReceipt > 0) {
    actions.push({
      id: "repair-applied-receipts",
      label: "Review applied candidates missing verification receipts",
      count: input.appliedMissingReceipt,
      severity: "high",
    });
  }
  if (input.highSeverityOpen > 0) {
    actions.push({
      id: "triage-high-severity",
      label: "Triage high-severity open candidates",
      count: input.highSeverityOpen,
      severity: "high",
    });
  }
  if (input.pendingShadowTest > 0) {
    actions.push({
      id: "run-shadow-tests",
      label: "Run shadow tests for queued candidates",
      count: input.pendingShadowTest,
      severity: "medium",
    });
  }
  if (input.readyForPatchBundle > 0) {
    actions.push({
      id: "prepare-review-bundles",
      label: "Prepare review patch bundles",
      count: input.readyForPatchBundle,
      severity: "medium",
    });
  }
  if (input.readyForHumanDecision > 0) {
    actions.push({
      id: "record-human-decisions",
      label: "Approve, reject, or defer prepared candidates",
      count: input.readyForHumanDecision,
      severity: "medium",
    });
  }
  if (input.approvedAwaitingApplication > 0) {
    actions.push({
      id: "record-applied-receipts",
      label: "Record external application receipts",
      count: input.approvedAwaitingApplication,
      severity: "medium",
    });
  }
  return actions;
}

async function updateSelfImprovementCandidate(
  id: string,
  fields: {
    status: SelfImprovementCandidateStatus;
    evidence?: Record<string, unknown>;
    proposal?: Record<string, unknown>;
    verificationPlan?: Record<string, unknown>;
  },
) {
  const db = await getDb();
  db.prepare(
    `UPDATE self_improvement_candidates
     SET status = ?,
         evidence_json = COALESCE(?, evidence_json),
         proposal_json = COALESCE(?, proposal_json),
         verification_plan_json = COALESCE(?, verification_plan_json),
         updated_at = ?
     WHERE id = ?`,
  ).run(
    fields.status,
    fields.evidence ? JSON.stringify(fields.evidence) : null,
    fields.proposal ? JSON.stringify(fields.proposal) : null,
    fields.verificationPlan ? JSON.stringify(fields.verificationPlan) : null,
    nowIso(),
    id,
  );
}

const allowedVerificationCommands = [
  "npm --prefix apps/web run typecheck",
  "npm --prefix apps/web run lint",
  "npm --prefix apps/web run build",
  "node scripts/agentic-loop-v2-smoke.mjs",
  "node scripts/skills-v2-smoke.mjs",
  "node scripts/skills-install-api-smoke.mjs",
  "node scripts/approval-lifecycle-smoke.mjs",
  "node scripts/self-improvement-async-smoke.mjs",
  "node scripts/self-improvement-diagnostics-smoke.mjs",
  "node scripts/self-improvement-lifecycle-smoke.mjs",
  "node scripts/self-improvement-ui-smoke.mjs",
  "node scripts/self-improvement-summary-smoke.mjs",
  "node scripts/self-improvement-summary-api-smoke.mjs",
  "node scripts/trace-diagnostics-improvements-smoke.mjs",
  "node scripts/sandbox-agent-smoke.mjs",
  "node scripts/sandbox-agent-model-smoke.mjs",
  "node scripts/e2b-template-smoke.mjs",
  "node scripts/e2b-template-receipt-smoke.mjs",
  "node scripts/e2b-readiness-smoke.mjs",
  "node scripts/e2b-live-receipt-smoke.mjs",
  "node scripts/e2b-preflight-e2e-smoke.mjs",
  "node scripts/e2b-template-verification-e2e-smoke.mjs",
  "node scripts/sandbox-retry-policy-smoke.mjs",
  "node scripts/run-cancel-lifecycle-smoke.mjs",
  "node scripts/run-cancel-api-smoke.mjs",
  "node scripts/sandbox-retry-e2e-smoke.mjs",
  "node scripts/e2b-sandbox-smoke.mjs",
];

function buildShadowChecks(candidate: SelfImprovementCandidateRecord) {
  const requiredCommands = stringArray(candidate.verificationPlan.required_commands);
  return [
    {
      id: "candidate_has_evidence",
      passed: Object.keys(candidate.evidence).length > 0,
      detail: "Candidate must reference eval, trace, run, or diagnostic evidence.",
    },
    {
      id: "candidate_requires_human_approval",
      passed: candidate.proposal.requires_human_approval !== false,
      detail: "Self-improvement candidates must not auto-apply without human approval.",
    },
    {
      id: "verification_commands_allowlisted",
      passed:
        requiredCommands.length > 0 &&
        requiredCommands.every((command) => allowedVerificationCommands.includes(command)),
      detail: `Verification commands: ${requiredCommands.join(" | ") || "none"}`,
    },
    {
      id: "acceptance_criteria_present",
      passed: typeof candidate.verificationPlan.acceptance === "string" && candidate.verificationPlan.acceptance.trim().length > 0,
      detail: String(candidate.verificationPlan.acceptance ?? ""),
    },
    {
      id: "proposal_is_non_destructive",
      passed: !/(rm\s+-rf|git\s+reset|delete\s+all|drop\s+table)/i.test(JSON.stringify(candidate.proposal)),
      detail: "Proposal must not include destructive commands.",
    },
  ];
}

function nextStatusForDecision(status: SelfImprovementCandidateStatus, action: "approve" | "reject" | "defer" | "mark_applied") {
  if (action === "reject") {
    return "rejected" as const;
  }
  if (action === "defer") {
    return "deferred" as const;
  }
  if (action === "approve") {
    if (status !== "patch_prepared") {
      throw new Error(`Candidate must have a prepared patch bundle before approval; current status is ${status}`);
    }
    return "approved" as const;
  }
  if (status !== "approved") {
    throw new Error(`Candidate must be approved before mark_applied; current status is ${status}`);
  }
  return "applied" as const;
}

function buildAppliedVerificationReceipt(
  candidate: SelfImprovementCandidateRecord,
  decidedAt: string,
  comment: string,
  submittedReceipt: unknown,
) {
  const requiredCommands = stringArray(candidate.verificationPlan.required_commands);
  const normalized = normalizeAppliedVerificationReceipt(submittedReceipt, requiredCommands);
  return {
    recordedAt: decidedAt,
    actor: "local_user",
    operatorConfirmed: true,
    submittedAt: normalized.submittedAt,
    requiredCommands,
    commandResults: normalized.commandResults,
    evidenceUri: normalized.evidenceUri,
    acceptance: typeof candidate.verificationPlan.acceptance === "string" ? candidate.verificationPlan.acceptance : "",
    comment,
    policy: {
      autoApply: false,
      sourcePatchAppliedBySystem: false,
      note: "mark_applied records a reviewed external/manual application after verification; it does not modify source code.",
    },
  };
}

function normalizeAppliedVerificationReceipt(
  submittedReceipt: unknown,
  requiredCommands: string[],
): {
  submittedAt: string;
  evidenceUri?: string;
  commandResults: Array<{ command: string; status: "passed"; summary: string }>;
} {
  if (!isRecord(submittedReceipt)) {
    throw new Error("mark_applied requires verification_receipt with operatorConfirmed=true and commandResults.");
  }
  if (submittedReceipt.operatorConfirmed !== true) {
    throw new Error("verification_receipt.operatorConfirmed must be true before mark_applied.");
  }
  const commandResults = Array.isArray(submittedReceipt.commandResults) ? submittedReceipt.commandResults : [];
  if (requiredCommands.length === 0) {
    throw new Error("Candidate verification plan must include required_commands before mark_applied.");
  }
  const normalizedResults = commandResults
    .filter(isRecord)
    .map((item) => ({
      command: typeof item.command === "string" ? item.command.trim() : "",
      status: typeof item.status === "string" ? item.status.trim().toLowerCase() : "",
      summary: typeof item.summary === "string" ? item.summary.trim() : "",
    }));
  for (const command of requiredCommands) {
    const result = normalizedResults.find((item) => item.command === command);
    if (!result) {
      throw new Error(`verification_receipt.commandResults is missing required command: ${command}`);
    }
    if (result.status !== "passed") {
      throw new Error(`verification_receipt command must be passed before mark_applied: ${command}`);
    }
    if (!result.summary) {
      throw new Error(`verification_receipt command summary is required: ${command}`);
    }
  }
  const submittedAt = typeof submittedReceipt.submittedAt === "string" && submittedReceipt.submittedAt.trim()
    ? submittedReceipt.submittedAt.trim()
    : nowIso();
  const evidenceUri = typeof submittedReceipt.evidenceUri === "string" && submittedReceipt.evidenceUri.trim()
    ? submittedReceipt.evidenceUri.trim()
    : undefined;
  return {
    submittedAt,
    evidenceUri,
    commandResults: requiredCommands.map((command) => {
      const result = normalizedResults.find((item) => item.command === command);
      return {
        command,
        status: "passed" as const,
        summary: result?.summary ?? "",
      };
    }),
  };
}

function buildPatchBundleMarkdown(candidate: SelfImprovementCandidateRecord, preparedAt: string) {
  return [
    `# Self-Improvement Patch Bundle`,
    "",
    `- Candidate: \`${candidate.id}\``,
    `- Run: \`${candidate.runId}\``,
    `- Conversation: \`${candidate.conversationId}\``,
    `- Type: \`${candidate.candidateType}\``,
    `- Severity: \`${candidate.severity}\``,
    `- Prepared at: \`${preparedAt}\``,
    `- Auto apply: \`false\``,
    "",
    "## Title",
    "",
    candidate.title,
    "",
    "## Rationale",
    "",
    candidate.rationale,
    "",
    "## Evidence",
    "",
    "```json",
    JSON.stringify(candidate.evidence, null, 2),
    "```",
    "",
    "## Proposed Change",
    "",
    "```json",
    JSON.stringify(candidate.proposal, null, 2),
    "```",
    "",
    "## Verification Plan",
    "",
    "```json",
    JSON.stringify(candidate.verificationPlan, null, 2),
    "```",
    "",
    "## Human Review Checklist",
    "",
    "- Confirm the evidence really supports the proposed change.",
    "- Run the listed verification commands before marking applied.",
    "- Record the verification receipt when marking the candidate applied.",
    "- Do not apply destructive changes or unreviewed generated patches.",
  ].join("\n");
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function latestAppliedVerificationReceipt(proposal: unknown) {
  const proposalRecord = isRecord(proposal) ? proposal : {};
  const decisions = Array.isArray(proposalRecord.decisions) ? proposalRecord.decisions : [];
  for (const item of [...decisions].reverse()) {
    const decision = isRecord(item) ? item : {};
    if (decision.action === "mark_applied" && decision.status === "applied") {
      const receipt = isRecord(decision.verificationReceipt) ? decision.verificationReceipt : {};
      return Object.keys(receipt).length > 0 ? receipt : null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
