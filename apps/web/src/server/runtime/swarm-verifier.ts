import type { BranchContract, BranchFinal } from "./swarm";
export type SwarmVerificationCheck = {
  id: string;
  status: "passed" | "warning" | "failed";
  detail: string;
};

export type SwarmVerificationResult = {
  status: "passed" | "warning" | "failed";
  summary: string;
  checks: SwarmVerificationCheck[];
};

export const V4_1_SWARM_VERIFY_GATE_IDS = [
  "branch_contract_coverage",
  "branch_final_content_present",
  "branch_final_substance",
  "branch_final_structured_evidence",
  "branch_final_output_schema_coverage",
  "branch_minimum_evidence_coverage",
  "required_tool_call_coverage",
  "parent_proxy_event_coverage",
  "required_tool_event_coverage",
  "successful_tool_call_coverage",
  "capability_event_coverage",
  "parent_proxy_coverage",
  "web_search_observation_coverage",
  "run_python_image_artifact_coverage",
  "fallback_action_policy",
  "invalid_action_repair_policy",
  "final_answer_evidence_coverage",
  "artifact_substance_coverage",
  "markdown_summary_artifact_coverage",
  "artifact_source_observation_coverage",
  "unsupported_claim_coverage",
  "html_report_artifact_coverage",
  "final_html_report_source_coverage",
  "contract_required_artifact_coverage",
  "trace_diagnostics_replayability",
] as const;

export function buildSwarmVerificationGateCoverage(checks: SwarmVerificationCheck[]) {
  const presentGateIds = Array.from(new Set(checks.map((check) => check.id)));
  const failedGateIds = checks.filter((check) => check.status === "failed").map((check) => check.id);
  const expectedGateIds = [...V4_1_SWARM_VERIFY_GATE_IDS];
  const missingGateIds = expectedGateIds.filter((id) => !presentGateIds.includes(id));
  const unexpectedGateIds = presentGateIds.filter((id) => !(expectedGateIds as readonly string[]).includes(id));
  return {
    scope: "swarm.verify",
    expectedGateIds,
    presentGateIds,
    missingGateIds,
    unexpectedGateIds,
    failedGateIds,
    expectedGateCount: expectedGateIds.length,
    presentExpectedGateCount: expectedGateIds.length - missingGateIds.length,
    failedGateCount: failedGateIds.length,
    complete: missingGateIds.length === 0,
  };
}

export type SwarmVerifierBranch = {
  id: string;
  title: string;
  instruction: string;
};

export type SwarmVerifierPlan = {
  planSource?: string;
  branches: SwarmVerifierBranch[];
};

export type SwarmEventEvidence = {
  eventTypeCounts?: Record<string, number>;
  toolCallStatusCounts?: Record<string, Record<string, number>>;
  toolCalls?: Array<{ id?: string; toolName?: string; status?: string; branchId?: string }>;
  capabilityEvents?: Array<{ type?: string; toolName?: string; capabilityName?: string; branchId?: string; status?: string; observationId?: string; toolCallId?: string }>;
  capabilityInvokeStartedCount?: number;
  capabilityInvokeCompletedCount?: number;
  capabilityInvokeFailedCount?: number;
  sandboxToolProxyStartedCount?: number;
  sandboxToolProxyCompletedCount?: number;
  sandboxToolProxyFailedCount?: number;
  successfulToolCallCount?: number;
  failedToolCallCount?: number;
  webSearchToolCallCompletedCount?: number;
  runPythonToolCallCompletedCount?: number;
  artifactCreateToolCallCompletedCount?: number;
  webSearchToolCallFailedCount?: number;
  runPythonToolCallFailedCount?: number;
  artifactCreateToolCallFailedCount?: number;
};

export type SwarmVerificationInput = {
  plan: SwarmVerifierPlan;
  completedBranches: number;
  failedBranches: number;
  artifactIds: string[];
  branchObservationIds: string[];
  observations: string[];
  branchQualitySignals?: Array<Record<string, unknown>>;
  branchArtifacts?: Array<{
    id: string;
    type: string;
    title: string;
    mimeType?: string;
    branchId?: string;
    branchIds?: string[];
    artifactKind?: string | null;
    qualitySignals?: Record<string, unknown>;
    sourceObservationIds?: string[];
    sourceArtifactIds?: string[];
  }>;
  branchContracts?: BranchContract[];
  branchFinals?: BranchFinal[];
  eventEvidence?: SwarmEventEvidence;
};

export type ContradictionSignal = {
  index: number;
  signal: string;
  excerpt: string;
};

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

const contradictionPatterns: Array<{ id: string; pattern: RegExp }> = [
  { id: "contradiction", pattern: /contradict|contradiction|互相矛盾|矛盾/i },
  { id: "conflict", pattern: /conflict|冲突/i },
  { id: "inconsistency", pattern: /inconsisten|不一致|不相符/i },
  { id: "unsupported", pattern: /unsupported|not supported|无证据|缺少证据|无法支持/i },
  { id: "source_mismatch", pattern: /source mismatch|domain mismatch|来源不匹配|来源偏离/i },
];

function buildBranchContractCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const contracts = input.branchContracts ?? [];
  const missingCount = Math.max(0, input.plan.branches.length - contracts.length);
  const materializedEventCount = Number(input.eventEvidence?.eventTypeCounts?.["swarm.branch.contract.materialized"] ?? 0);
  const missingMaterializedEventCount = Math.max(0, input.plan.branches.length - materializedEventCount);
  const passed = missingCount === 0 && missingMaterializedEventCount === 0;
  return {
    id: "branch_contract_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Every planned branch had an explicit BranchContract and a materialized contract event."
      : `${missingCount}/${input.plan.branches.length} planned branches are missing BranchContract records; ${missingMaterializedEventCount}/${input.plan.branches.length} are missing swarm.branch.contract.materialized events.`,
  };
}

function buildBranchFinalCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const finals = input.branchFinals ?? [];
  const substantiveFinals = finals.filter((final) => final.executiveSummary.trim().length >= 80);
  const materializedEventCount = Number(input.eventEvidence?.eventTypeCounts?.["swarm.branch.final.materialized"] ?? 0);
  const missingMaterializedEventCount = Math.max(0, input.completedBranches - materializedEventCount);
  const passed = substantiveFinals.length >= input.completedBranches && missingMaterializedEventCount === 0;
  return {
    id: "branch_final_substance",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `${substantiveFinals.length}/${input.completedBranches} completed branches produced substantive BranchFinal records and materialized final events.`
      : `${substantiveFinals.length}/${input.completedBranches} completed branches produced substantive BranchFinal records; ${missingMaterializedEventCount}/${input.completedBranches} are missing swarm.branch.final.materialized events.`,
  };
}

function buildBranchFinalContentPresentCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const finals = input.branchFinals ?? [];
  const contentBearingFinals = finals.filter((final) => {
    const sectionContent = (final.sections ?? []).some((section) => asText(section.content).trim().length >= 40);
    const claimContent = (final.claims ?? []).some((claim) => asText(claim.claim).trim().length >= 16);
    return final.executiveSummary.trim().length >= 40 || sectionContent || claimContent;
  });
  const materializedEventCount = Number(input.eventEvidence?.eventTypeCounts?.["swarm.branch.final.materialized"] ?? 0);
  const missingMaterializedEventCount = Math.max(0, input.completedBranches - materializedEventCount);
  const passed = contentBearingFinals.length >= input.completedBranches && missingMaterializedEventCount === 0;
  return {
    id: "branch_final_content_present",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `${contentBearingFinals.length}/${input.completedBranches} completed branches produced content-bearing BranchFinal records and materialized final events.`
      : `${contentBearingFinals.length}/${input.completedBranches} completed branches produced content-bearing BranchFinal records; ${missingMaterializedEventCount}/${input.completedBranches} are missing swarm.branch.final.materialized events; reduce must not proceed from runtime summaries alone.`,
  };
}

function buildStructuredBranchFinalSubstanceCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const finals = input.branchFinals ?? [];
  const structuredFinals = finals.filter((final) => {
    const sections = Array.isArray(final.sections) ? final.sections : [];
    const claims = Array.isArray(final.claims) ? final.claims : [];
    const hasSectionContent = sections.some((section) => asText(section.content).trim().length >= 80);
    const hasClaimContent = claims.some((claim) => asText(claim.claim).trim().length >= 24);
    const hasEvidence =
      (Array.isArray(final.evidenceObservationIds) && final.evidenceObservationIds.length > 0) ||
      (Array.isArray(final.artifactIds) && final.artifactIds.length > 0) ||
      sections.some(
        (section) =>
          (Array.isArray(section.evidenceObservationIds) && section.evidenceObservationIds.length > 0) ||
          (Array.isArray(section.evidenceArtifactIds) && section.evidenceArtifactIds.length > 0),
      ) ||
      claims.some(
        (claim) =>
          (Array.isArray(claim.evidenceObservationIds) && claim.evidenceObservationIds.length > 0) ||
          (Array.isArray(claim.evidenceArtifactIds) && claim.evidenceArtifactIds.length > 0),
      );
    return hasSectionContent && hasClaimContent && hasEvidence;
  });
  const passed = structuredFinals.length >= input.completedBranches;
  return {
    id: "branch_final_structured_evidence",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `${structuredFinals.length}/${input.completedBranches} completed BranchFinal records include sections, claims, and evidence ids.`
      : `${structuredFinals.length}/${input.completedBranches} completed BranchFinal records include sections, claims, and evidence ids; reducer must not rely on runtime summaries alone.`,
  };
}

function buildParentProxyEventCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const evidence = input.eventEvidence;
  const requiredTools = Array.from(new Set((input.branchContracts ?? []).flatMap((contract) => contract.requiredTools)));
  const requiresParentTools = requiredTools.length > 0;
  const completedCapability = Number(evidence?.capabilityInvokeCompletedCount ?? 0);
  const completedLegacyProxy = Number(evidence?.sandboxToolProxyCompletedCount ?? 0);
  const failedCapability = Number(evidence?.capabilityInvokeFailedCount ?? 0);
  const failedLegacyProxy = Number(evidence?.sandboxToolProxyFailedCount ?? 0);
  const passed = !requiresParentTools || (completedCapability + completedLegacyProxy > 0 && failedCapability + failedLegacyProxy === 0);
  return {
    id: "parent_proxy_event_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `Parent-proxy/capability events show ${completedCapability} capability completion(s) and ${completedLegacyProxy} legacy proxy completion(s).`
      : `Required tools (${requiredTools.join(", ") || "none"}) lack clean parent-proxy completion evidence: capability completed=${completedCapability}, proxy completed=${completedLegacyProxy}, capability failed=${failedCapability}, proxy failed=${failedLegacyProxy}.`,
  };
}

function buildRequiredToolEventCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const evidence = input.eventEvidence;
  const requiredPairs = (input.branchContracts ?? []).flatMap((contract) =>
    contract.requiredTools.map((toolName) => ({ branchId: contract.branchId, toolName })),
  );
  const missingRequiredToolEvidence = requiredPairs.filter(({ branchId, toolName }) => !branchHasCompletedToolEvidence(evidence, branchId, toolName));
  const failedRequiredToolCount = Number(evidence?.webSearchToolCallFailedCount ?? 0) + Number(evidence?.runPythonToolCallFailedCount ?? 0) + Number(evidence?.artifactCreateToolCallFailedCount ?? 0);
  const passed = missingRequiredToolEvidence.length === 0 && failedRequiredToolCount === 0;
  return {
    id: "required_tool_event_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Required tool calls have branch-linked parent-side completed tool/capability evidence and no required-tool failures."
      : `Missing required parent tool_call evidence for: ${missingRequiredToolEvidence.map((item) => `${item.branchId}:${item.toolName}`).join(", ") || "none"}; required-tool failed count=${failedRequiredToolCount}.`,
  };
}

function buildSuccessfulToolCallCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const evidence = input.eventEvidence;
  const requiredPairs = (input.branchContracts ?? []).flatMap((contract) =>
    contract.requiredTools.map((toolName) => ({ branchId: contract.branchId, toolName })),
  );
  const missing = requiredPairs.filter(({ branchId, toolName }) => !branchHasCompletedToolEvidence(evidence, branchId, toolName));
  const failedToolCalls = Number(evidence?.failedToolCallCount ?? 0);
  const passed = missing.length === 0 && failedToolCalls === 0;
  return {
    id: "successful_tool_call_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "All BranchContract required tools have branch-linked successful parent tool evidence and no failed tool calls."
      : `Successful tool coverage gaps: missing=${missing.map((item) => `${item.branchId}:${item.toolName}`).join(", ") || "none"}; failedToolCalls=${failedToolCalls}.`,
  };
}

function buildCapabilityEventCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const evidence = input.eventEvidence;
  const requiredPairs = (input.branchContracts ?? []).flatMap((contract) =>
    contract.requiredTools.map((toolName) => ({ branchId: contract.branchId, toolName })),
  );
  const missing = requiredPairs.filter(({ branchId, toolName }) => !branchHasCompletedCapabilityInvokeEvidence(evidence, branchId, toolName));
  const failedCapability = Number(evidence?.capabilityInvokeFailedCount ?? 0);
  const passed = missing.length === 0 && failedCapability === 0;
  return {
    id: "capability_event_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "All BranchContract required tools have branch-linked capability.invoke completion evidence and no capability failures."
      : `Capability event coverage gaps: missing=${missing.map((item) => `${item.branchId}:${item.toolName}`).join(", ") || "none"}; failedCapability=${failedCapability}.`,
  };
}

function buildParentProxyCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const evidence = input.eventEvidence;
  const requiredPairs = (input.branchContracts ?? []).flatMap((contract) =>
    contract.requiredTools.map((toolName) => ({ branchId: contract.branchId, toolName })),
  );
  const missing = requiredPairs.filter(({ branchId, toolName }) => !branchHasCompletedSandboxProxyEvidence(evidence, branchId, toolName));
  const failedProxy = Number(evidence?.sandboxToolProxyFailedCount ?? 0);
  const passed = missing.length === 0 && failedProxy === 0;
  return {
    id: "parent_proxy_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "All BranchContract required tools have branch-linked sandbox.tool_proxy completion evidence and no parent-proxy failures."
      : `Parent-proxy coverage gaps: missing=${missing.map((item) => `${item.branchId}:${item.toolName}`).join(", ") || "none"}; failedProxy=${failedProxy}.`,
  };
}

function buildWebSearchObservationCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const requiredBranches = (input.branchContracts ?? []).filter((contract) => contract.requiredTools.includes("web.search"));
  const missing = requiredBranches
    .filter((contract) => !branchHasCompletedToolObservationEvidence(input.eventEvidence, contract.branchId, "web.search"))
    .map((contract) => contract.branchId);
  const passed = missing.length === 0;
  return {
    id: "web_search_observation_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Every branch requiring web.search has branch-linked completed web.search evidence with both a tool_call and Observation reference."
      : `Branches requiring web.search are missing branch-linked completed web.search tool_call plus Observation evidence: ${missing.join(", ") || "none"}.`,
  };
}

function buildRunPythonImageArtifactCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const requiredBranches = (input.branchContracts ?? []).filter(
    (contract) => contract.requiredTools.includes("run_python") || contract.requiredArtifacts.some((artifact) => artifact.type === "image"),
  );
  const missingToolEvidence = requiredBranches
    .filter((contract) => !branchHasCompletedToolEvidence(input.eventEvidence, contract.branchId, "run_python"))
    .map((contract) => contract.branchId);
  const missingImageArtifact = requiredBranches
    .filter((contract) => countBranchArtifactsByType(input.branchArtifacts ?? [], contract.branchId, "image") < 1)
    .map((contract) => contract.branchId);
  const passed = missingToolEvidence.length === 0 && missingImageArtifact.length === 0;
  return {
    id: "run_python_image_artifact_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Every branch requiring run_python/image output has branch-linked run_python completion evidence and a recovered image artifact."
      : `run_python/image coverage gaps: missing run_python evidence for ${missingToolEvidence.join(", ") || "none"}; missing image artifacts for ${missingImageArtifact.join(", ") || "none"}.`,
  };
}

function buildRequiredToolCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const contracts = input.branchContracts ?? [];
  const branchSignals = input.branchQualitySignals ?? [];
  const successfulToolCalls = branchSignals.reduce((sum, signal) => sum + (Number(signal.toolCallSuccessCount ?? signal.toolCallCount ?? 0) || 0), 0);
  const failedToolCalls = branchSignals.reduce((sum, signal) => sum + (Number(signal.toolCallFailureCount ?? 0) || 0), 0);
  const requiredBranchCount = contracts.filter((contract) => contract.requiredTools.length > 0).length;
  const successfulBranchSignals = branchSignals.filter((signal) => Number(signal.toolCallSuccessCount ?? signal.toolCallCount ?? 0) > 0).length;
  const requiresTools = requiredBranchCount > 0;
  const passed = !requiresTools || (successfulBranchSignals >= requiredBranchCount && failedToolCalls === 0);
  return {
    id: "required_tool_call_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Required branch tools had successful sandbox tool-call evidence."
      : `Required tools were declared for ${requiredBranchCount} branch(es), but only ${successfulBranchSignals} branch quality signal(s) reported successful tool calls; successfulToolCalls=${successfulToolCalls}, failedToolCalls=${failedToolCalls}.`,
  };
}

function branchHasCompletedToolEvidence(evidence: SwarmEventEvidence | undefined, branchId: string, toolName: string) {
  if (!evidence) {
    return false;
  }
  if ((evidence.toolCalls ?? []).some((call) => call.branchId === branchId && call.toolName === toolName && call.status === "completed")) {
    return true;
  }
  return (evidence.capabilityEvents ?? []).some((event) => {
    const name = event.toolName || event.capabilityName;
    const type = event.type ?? "";
    const status = event.status ?? "";
    return event.branchId === branchId && name === toolName && (status === "completed" || type.endsWith(".completed"));
  });
}

function branchHasCompletedToolObservationEvidence(evidence: SwarmEventEvidence | undefined, branchId: string, toolName: string) {
  if (!evidence) {
    return false;
  }
  const completedToolCall = (evidence.toolCalls ?? []).some(
    (call) => call.branchId === branchId && call.toolName === toolName && call.status === "completed" && Boolean(call.id),
  );
  const completedCapabilityToolCall = (evidence.capabilityEvents ?? []).some((event) => {
    const name = event.toolName || event.capabilityName;
    const type = event.type ?? "";
    const status = event.status ?? "";
    return event.branchId === branchId && name === toolName && (status === "completed" || type.endsWith(".completed")) && Boolean(event.toolCallId);
  });
  const completedObservation = (evidence.capabilityEvents ?? []).some((event) => {
    const name = event.toolName || event.capabilityName;
    const type = event.type ?? "";
    const status = event.status ?? "";
    return event.branchId === branchId && name === toolName && (status === "completed" || type.endsWith(".completed")) && Boolean(event.observationId);
  });
  return (completedToolCall || completedCapabilityToolCall) && completedObservation;
}

function branchHasCompletedCapabilityInvokeEvidence(evidence: SwarmEventEvidence | undefined, branchId: string, toolName: string) {
  return (evidence?.capabilityEvents ?? []).some((event) => {
    const name = event.toolName || event.capabilityName;
    const type = event.type ?? "";
    const status = event.status ?? "";
    return event.branchId === branchId && name === toolName && type.startsWith("capability.invoke.") && (status === "completed" || type.endsWith(".completed"));
  });
}

function branchHasCompletedSandboxProxyEvidence(evidence: SwarmEventEvidence | undefined, branchId: string, toolName: string) {
  return (evidence?.capabilityEvents ?? []).some((event) => {
    const name = event.toolName || event.capabilityName;
    const type = event.type ?? "";
    const status = event.status ?? "";
    return event.branchId === branchId && name === toolName && type.startsWith("sandbox.tool_proxy.call.") && (status === "completed" || type.endsWith(".completed"));
  });
}

function buildBranchMinimumEvidenceCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const contracts = input.branchContracts ?? [];
  if (contracts.length === 0) {
    return {
      id: "branch_minimum_evidence_coverage",
      status: "failed",
      detail: "No BranchContract records were available, so minimumEvidence coverage cannot be verified.",
    };
  }
  const missing: string[] = [];
  for (const [index, contract] of contracts.entries()) {
    const minimumEvidence = contract.minimumEvidence ?? {};
    const signal = findBranchQualitySignal(input.branchQualitySignals ?? [], contract.branchId, index);
    const realModelActions = Number(signal.realModelActionCount ?? signal.real_model_action_count ?? signal.modelActionCount ?? 0) || 0;
    const successfulToolCalls = Math.max(
      Number(signal.toolCallSuccessCount ?? signal.toolCallCount ?? 0) || 0,
      completedBranchToolEvidenceCount(input.eventEvidence, contract.branchId),
    );
    const webSearchCount = completedBranchToolEvidenceCount(input.eventEvidence, contract.branchId, "web.search");
    const imageArtifactCount = countBranchArtifactsByType(input.branchArtifacts ?? [], contract.branchId, "image");
    const htmlArtifactCount = countBranchArtifactsByType(input.branchArtifacts ?? [], contract.branchId, "html");
    const markdownArtifactCount = countBranchArtifactsByType(input.branchArtifacts ?? [], contract.branchId, "markdown");
    if (minimumEvidence.realModelActionCount && realModelActions < minimumEvidence.realModelActionCount) {
      missing.push(`${contract.branchId}:realModelActionCount ${realModelActions}/${minimumEvidence.realModelActionCount}`);
    }
    if (minimumEvidence.toolCallCount && successfulToolCalls < minimumEvidence.toolCallCount) {
      missing.push(`${contract.branchId}:toolCallCount ${successfulToolCalls}/${minimumEvidence.toolCallCount}`);
    }
    if (minimumEvidence.webSearchCount && webSearchCount < minimumEvidence.webSearchCount) {
      missing.push(`${contract.branchId}:webSearchCount ${webSearchCount}/${minimumEvidence.webSearchCount}`);
    }
    if (minimumEvidence.imageArtifactCount && imageArtifactCount < minimumEvidence.imageArtifactCount) {
      missing.push(`${contract.branchId}:imageArtifactCount ${imageArtifactCount}/${minimumEvidence.imageArtifactCount}`);
    }
    if (minimumEvidence.htmlArtifactCount && htmlArtifactCount < minimumEvidence.htmlArtifactCount) {
      missing.push(`${contract.branchId}:htmlArtifactCount ${htmlArtifactCount}/${minimumEvidence.htmlArtifactCount}`);
    }
    if (minimumEvidence.markdownArtifactCount && markdownArtifactCount < minimumEvidence.markdownArtifactCount) {
      missing.push(`${contract.branchId}:markdownArtifactCount ${markdownArtifactCount}/${minimumEvidence.markdownArtifactCount}`);
    }
  }
  return {
    id: "branch_minimum_evidence_coverage",
    status: missing.length === 0 ? "passed" : "failed",
    detail:
      missing.length === 0
        ? `${contracts.length} BranchContract minimumEvidence requirement set(s) were satisfied by branch-linked evidence.`
        : `BranchContract minimumEvidence gaps: ${missing.join(", ")}.`,
  };
}

function buildBranchFinalOutputSchemaCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const contracts = input.branchContracts ?? [];
  if (contracts.length === 0) {
    return {
      id: "branch_final_output_schema_coverage",
      status: "failed",
      detail: "No BranchContract records were available, so BranchFinal output schema coverage cannot be verified.",
    };
  }
  const missing: string[] = [];
  for (const contract of contracts) {
    const final = findBranchFinal(input.branchFinals ?? [], contract.branchId);
    if (!final) {
      missing.push(`${contract.branchId}:branchFinal missing`);
      continue;
    }
    const schema = contract.finalOutputSchema;
    if (!schema) {
      missing.push(`${contract.branchId}:finalOutputSchema missing`);
      continue;
    }
    const sectionTitles = (final.sections ?? []).map((section) => asText(section.title).toLowerCase());
    for (const requiredSection of schema.requiredSections ?? []) {
      const normalized = asText(requiredSection).toLowerCase();
      if (normalized && !sectionTitles.some((title) => title.length > 0 && (title.includes(normalized) || normalized.includes(title)))) {
        missing.push(`${contract.branchId}:requiredSection ${requiredSection}`);
      }
    }
    const hasObservationIds =
      (final.evidenceObservationIds ?? []).length > 0 ||
      (final.sections ?? []).some((section) => (section.evidenceObservationIds ?? []).length > 0) ||
      (final.claims ?? []).some((claim) => (claim.evidenceObservationIds ?? []).length > 0);
    const hasArtifactIds =
      (final.artifactIds ?? []).length > 0 ||
      (final.sections ?? []).some((section) => (section.evidenceArtifactIds ?? []).length > 0) ||
      (final.claims ?? []).some((claim) => (claim.evidenceArtifactIds ?? []).length > 0);
    if (schema.mustCiteObservationIds && !hasObservationIds) {
      missing.push(`${contract.branchId}:observation citations missing`);
    }
    if (schema.mustCiteArtifactIds && !hasArtifactIds) {
      missing.push(`${contract.branchId}:artifact citations missing`);
    }
    if (schema.unsupportedClaimPolicy === "fail_verification" && (final.unsupportedClaims ?? []).length > 0) {
      missing.push(`${contract.branchId}:unsupportedClaims ${final.unsupportedClaims.length}`);
    }
  }
  return {
    id: "branch_final_output_schema_coverage",
    status: missing.length === 0 ? "passed" : "failed",
    detail:
      missing.length === 0
        ? `${contracts.length} BranchFinal record(s) satisfied their BranchContract finalOutputSchema.`
        : `BranchFinal finalOutputSchema gaps: ${missing.join(", ")}.`,
  };
}

function completedBranchToolEvidenceCount(evidence: SwarmEventEvidence | undefined, branchId: string, toolName?: string) {
  if (!evidence) {
    return 0;
  }
  const toolCallCount = (evidence.toolCalls ?? []).filter(
    (call) => call.branchId === branchId && call.status === "completed" && (!toolName || call.toolName === toolName),
  ).length;
  const capabilityEventCount = (evidence.capabilityEvents ?? []).filter((event) => {
    const name = event.toolName || event.capabilityName;
    const type = event.type ?? "";
    const status = event.status ?? "";
    return event.branchId === branchId && (!toolName || name === toolName) && (status === "completed" || type.endsWith(".completed"));
  }).length;
  return Math.max(toolCallCount, capabilityEventCount);
}

function findBranchQualitySignal(signals: Array<Record<string, unknown>>, branchId: string, index: number) {
  return signals.find((signal) => asText(signal.branchId ?? signal.branch_id ?? signal.id) === branchId) ?? signals[index] ?? {};
}

function findBranchFinal(finals: BranchFinal[], branchId: string) {
  return finals.find((final) => final.branchId === branchId);
}

function countBranchArtifactsByType(
  artifacts: NonNullable<SwarmVerificationInput["branchArtifacts"]>,
  branchId: string,
  requiredType: "image" | "html" | "markdown",
) {
  return artifacts.filter((artifact) => artifactMatchesBranchRequiredArtifact(artifact, branchId, requiredType)).length;
}

function buildContractArtifactCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const artifacts = input.branchArtifacts ?? [];
  const missing: string[] = [];
  for (const contract of input.branchContracts ?? []) {
    for (const required of contract.requiredArtifacts) {
      const matched = artifacts.some((artifact) => artifactMatchesBranchRequiredArtifact(artifact, contract.branchId, required.type));
      if (!matched) {
        missing.push(`${contract.branchId}:${required.type}`);
      }
    }
  }
  const requiredTypes = Array.from(new Set((input.branchContracts ?? []).flatMap((contract) => contract.requiredArtifacts.map((artifact) => artifact.type))));
  const available = artifacts.map((artifact) => `${artifact.branchId ?? artifact.branchIds?.join("|") ?? "unlinked"}:${artifact.type}:${artifact.id}`);
  return {
    id: "contract_required_artifact_coverage",
    status: missing.length === 0 ? "passed" : "failed",
    detail: missing.length === 0
      ? `All BranchContract required artifact types were present per branch: ${requiredTypes.join(", ") || "none"}.`
      : `Missing per-branch BranchContract artifact coverage: ${missing.join(", ")}. Available branch artifacts: ${available.join(", ") || "none"}.`,
  };
}

function artifactMatchesBranchRequiredArtifact(
  artifact: {
    id: string;
    type: string;
    title: string;
    mimeType?: string;
    branchId?: string;
    branchIds?: string[];
    artifactKind?: string | null;
    qualitySignals?: Record<string, unknown>;
  },
  branchId: string,
  requiredType: string,
) {
  const linkedBranchIds = new Set([artifact.branchId ?? "", ...(artifact.branchIds ?? [])].filter(Boolean));
  if (!linkedBranchIds.has(branchId)) {
    return false;
  }
  if (requiredType === "image") {
    return artifact.type === "image" || /^image\//i.test(artifact.mimeType ?? "");
  }
  if (requiredType === "html") {
    return (
      artifact.type === "html" ||
      /html/i.test(artifact.mimeType ?? "") ||
      artifact.artifactKind === "final_html_report" ||
      artifact.artifactKind === "html_document"
    );
  }
  if (requiredType === "markdown") {
    return (
      artifact.type === "markdown" ||
      /markdown/i.test(artifact.mimeType ?? "") ||
      artifact.artifactKind === "branch_final_report" ||
      artifact.artifactKind === "markdown_document"
    );
  }
  if (requiredType === "json") {
    return artifact.type === "json" || /json/i.test(artifact.mimeType ?? "") || artifact.artifactKind === "structured_json";
  }
  if (requiredType === "image_metadata") {
    return artifact.type === "json" && artifact.artifactKind === "image_metadata";
  }
  return artifact.type === requiredType;
}

function buildArtifactSubstanceCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const artifacts = input.branchArtifacts ?? [];
  const runtimeSummaryArtifacts = artifacts.filter(
    (artifact) =>
      artifact.artifactKind === "branch_runtime_summary" ||
      asText(artifact.qualitySignals?.substanceStatus).toLowerCase() === "runtime_summary",
  );
  const thinTextArtifacts = artifacts.filter((artifact) => {
    if (artifact.type !== "markdown" && artifact.type !== "html") {
      return false;
    }
    return asText(artifact.qualitySignals?.substanceStatus).toLowerCase() === "thin";
  });
  const descriptiveArtifacts = artifacts.filter((artifact) => {
    if (artifact.title.trim().length < 12 || artifact.type.trim().length === 0) {
      return false;
    }
    if (artifact.type === "image") {
      return true;
    }
    if (artifact.artifactKind === "branch_runtime_summary") {
      return false;
    }
    return asText(artifact.qualitySignals?.substanceStatus, "substantive").toLowerCase() !== "runtime_summary";
  });
  const passed = artifacts.length > 0 && descriptiveArtifacts.length === artifacts.length && runtimeSummaryArtifacts.length === 0;
  return {
    id: "artifact_substance_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Recovered sandbox artifacts included substantive deliverable metadata and no runtime-summary artifacts were counted as deliverables."
      : `${descriptiveArtifacts.length}/${artifacts.length} recovered sandbox artifacts were substantive; runtime-summary artifacts=${runtimeSummaryArtifacts.length}, thin text artifacts=${thinTextArtifacts.length}.`,
  };
}

function buildMarkdownSummaryArtifactCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const artifacts = input.branchArtifacts ?? [];
  const requiredBranches = (input.branchContracts ?? []).filter((contract) =>
    contract.requiredArtifacts.some((artifact) => artifact.type === "markdown"),
  );
  const missing = requiredBranches
    .filter(
      (contract) =>
        !artifacts.some(
          (artifact) =>
            artifactMatchesBranchRequiredArtifact(artifact, contract.branchId, "markdown") &&
            isSubstantiveTextDeliverableArtifact(artifact),
        ),
    )
    .map((contract) => contract.branchId);
  const passed = missing.length === 0;
  return {
    id: "markdown_summary_artifact_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Every branch requiring a Markdown report has a branch-linked substantive Markdown deliverable artifact."
      : `Branches requiring Markdown reports are missing substantive branch-linked Markdown artifacts: ${missing.join(", ") || "none"}.`,
  };
}

function buildArtifactSourceObservationCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const artifacts = input.branchArtifacts ?? [];
  const missing: string[] = [];
  for (const contract of input.branchContracts ?? []) {
    for (const required of contract.requiredArtifacts) {
      const matchedWithSourceObservation = artifacts.some(
        (artifact) =>
          artifactMatchesBranchRequiredArtifact(artifact, contract.branchId, required.type) &&
          (artifact.sourceObservationIds ?? []).length > 0,
      );
      if (!matchedWithSourceObservation) {
        missing.push(`${contract.branchId}:${required.type}`);
      }
    }
  }
  const passed = missing.length === 0;
  return {
    id: "artifact_source_observation_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Every BranchContract required artifact has branch-linked sourceObservationIds."
      : `Required artifacts missing sourceObservationIds: ${missing.join(", ") || "none"}.`,
  };
}

function buildUnsupportedClaimCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const unsupported = (input.branchFinals ?? [])
    .filter((final) => (final.unsupportedClaims ?? []).length > 0)
    .map((final) => `${final.branchId}:${(final.unsupportedClaims ?? []).length}`);
  const passed = unsupported.length === 0;
  return {
    id: "unsupported_claim_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? "No BranchFinal reported unsupported claims."
      : `BranchFinal unsupported claims remain unresolved: ${unsupported.join(", ")}.`,
  };
}

function buildFallbackActionPolicyCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const signals = input.branchQualitySignals ?? [];
  const fallbackBranches = signals.filter((signal) => Number(signal.fallbackActionCount ?? 0) > 0);
  const degradedFallbackBranches = fallbackBranches.filter((signal) => {
    const policyStatus = asText(signal.fallbackPolicyStatus).toLowerCase();
    return (
      signal.degradedExecution === true ||
      policyStatus === "degraded" ||
      policyStatus === "failed_verification" ||
      policyStatus === "completed_degraded"
    );
  });
  const fallbackActionCount = fallbackBranches.reduce((sum, signal) => sum + (Number(signal.fallbackActionCount ?? 0) || 0), 0);
  const passed = fallbackActionCount === 0 || degradedFallbackBranches.length === fallbackBranches.length;
  return {
    id: "fallback_action_policy",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `Fallback action policy satisfied: fallbackActionCount=${fallbackActionCount}, degradedFallbackBranches=${degradedFallbackBranches.length}/${fallbackBranches.length}.`
      : `Fallback actions were not fully marked degraded/failed_verification: fallbackActionCount=${fallbackActionCount}, degradedFallbackBranches=${degradedFallbackBranches.length}/${fallbackBranches.length}.`,
  };
}

function buildFinalAnswerEvidenceCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const contracts = input.branchContracts ?? [];
  if (contracts.length === 0) {
    return {
      id: "final_answer_evidence_coverage",
      status: "failed",
      detail: "No BranchContract records were available, so final-answer evidence coverage cannot be verified.",
    };
  }
  const missing: string[] = [];
  for (const contract of contracts) {
    const final = findBranchFinal(input.branchFinals ?? [], contract.branchId);
    if (!final) {
      missing.push(`${contract.branchId}:branchFinal missing`);
      continue;
    }

    const sectionEvidence = (final.sections ?? []).some(
      (section) =>
        (Array.isArray(section.evidenceObservationIds) && section.evidenceObservationIds.length > 0) ||
        (Array.isArray(section.evidenceArtifactIds) && section.evidenceArtifactIds.length > 0),
    );
    const claimEvidence = (final.claims ?? []).some(
      (claim) =>
        (Array.isArray(claim.evidenceObservationIds) && claim.evidenceObservationIds.length > 0) ||
        (Array.isArray(claim.evidenceArtifactIds) && claim.evidenceArtifactIds.length > 0),
    );
    const directEvidence =
      (Array.isArray(final.evidenceObservationIds) && final.evidenceObservationIds.length > 0) ||
      (Array.isArray(final.artifactIds) && final.artifactIds.length > 0);

    if (!sectionEvidence && !claimEvidence && !directEvidence) {
      missing.push(`${contract.branchId}:no final observation/artifact citations`);
    }
  }

  return {
    id: "final_answer_evidence_coverage",
    status: missing.length === 0 ? "passed" : "failed",
    detail:
      missing.length === 0
        ? `${contracts.length} final BranchFinal entries include evidence-linked final content.`
        : `Branches with final output missing observation/artifact citations: ${missing.join(", ")}.`,
  };
}

function isSubstantiveTextDeliverableArtifact(artifact: {
  type: string;
  title: string;
  artifactKind?: string | null;
  qualitySignals?: Record<string, unknown>;
}) {
  if (artifact.title.trim().length < 12) {
    return false;
  }
  const substanceStatus = asText(artifact.qualitySignals?.substanceStatus, "substantive").toLowerCase();
  if (substanceStatus === "runtime_summary" || substanceStatus === "thin") {
    return false;
  }
  return artifact.artifactKind !== "branch_runtime_summary";
}

function buildFinalHtmlReportArtifactCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const artifacts = input.branchArtifacts ?? [];
  const finalReports = artifacts.filter(
    (artifact) =>
      artifact.artifactKind === "final_html_report" ||
      (artifact.type === "html" && /final|report|html/i.test(`${artifact.title} ${artifact.mimeType ?? ""}`)),
  );
  const substantiveFinalReports = finalReports.filter(
    (artifact) => asText(artifact.qualitySignals?.substanceStatus, "substantive").toLowerCase() !== "thin",
  );
  const passed = substantiveFinalReports.length > 0;
  return {
    id: "html_report_artifact_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `${substantiveFinalReports.length} final HTML report artifact(s) were available for final delivery.`
      : `No substantive final HTML report artifact was available; finalReports=${finalReports.length}, total artifacts=${artifacts.length}.`,
  };
}

function buildFinalHtmlReportSourceCoverageCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const artifacts = input.branchArtifacts ?? [];
  const finalReports = artifacts.filter((artifact) => artifact.artifactKind === "final_html_report");
  const coveredReports = finalReports.filter(
    (artifact) =>
      (artifact.sourceObservationIds ?? []).length > 0 &&
      (artifact.sourceArtifactIds ?? []).length > 0,
  );
  const passed = finalReports.length > 0 && coveredReports.length === finalReports.length;
  return {
    id: "final_html_report_source_coverage",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `${coveredReports.length} final HTML report artifact(s) include source Observation and Artifact ids.`
      : `Final HTML report source coverage incomplete: covered=${coveredReports.length}, finalReports=${finalReports.length}.`,
  };
}

export function buildSwarmVerification(input: SwarmVerificationInput): SwarmVerificationResult {
  const checks: SwarmVerificationCheck[] = [];
  const branchCount = input.plan.branches.length;
  const completedBranchCount = input.completedBranches;
  const failedBranchCount = input.failedBranches;

  checks.push(buildBranchContractCoverageCheck(input));
  checks.push(buildBranchFinalContentPresentCheck(input));
  checks.push(buildBranchFinalCoverageCheck(input));
  checks.push(buildStructuredBranchFinalSubstanceCheck(input));
  checks.push(buildBranchFinalOutputSchemaCoverageCheck(input));
  checks.push(buildBranchMinimumEvidenceCoverageCheck(input));
  checks.push(buildRequiredToolCoverageCheck(input));
  checks.push(buildParentProxyEventCoverageCheck(input));
  checks.push(buildRequiredToolEventCoverageCheck(input));
  checks.push(buildSuccessfulToolCallCoverageCheck(input));
  checks.push(buildCapabilityEventCoverageCheck(input));
  checks.push(buildParentProxyCoverageCheck(input));
  checks.push(buildWebSearchObservationCoverageCheck(input));
  checks.push(buildRunPythonImageArtifactCoverageCheck(input));
  checks.push(buildFallbackActionPolicyCheck(input));
  checks.push(buildInvalidActionRepairPolicyCheck(input));
  checks.push(buildFinalAnswerEvidenceCoverageCheck(input));
  checks.push(buildArtifactSubstanceCheck(input));
  checks.push(buildMarkdownSummaryArtifactCoverageCheck(input));
  checks.push(buildArtifactSourceObservationCoverageCheck(input));
  checks.push(buildUnsupportedClaimCoverageCheck(input));
  checks.push(buildFinalHtmlReportArtifactCoverageCheck(input));
  checks.push(buildFinalHtmlReportSourceCoverageCheck(input));
  checks.push(buildContractArtifactCoverageCheck(input));
  checks.push(buildTraceDiagnosticsReplayabilityCheck(input));

  checks.push({
    id: "branch_observations_present",
    status: input.branchObservationIds.length === branchCount ? "passed" : "failed",
    detail: `${input.branchObservationIds.length}/${branchCount} branch observations were persisted.`,
  });

  checks.push({
    id: "artifact_coverage",
    status: input.artifactIds.length >= completedBranchCount ? "passed" : "warning",
    detail: `${input.artifactIds.length}/${completedBranchCount} completed branches produced artifacts.`,
  });

  checks.push({
    id: "failed_branch_isolation",
    status: failedBranchCount === 0 ? "passed" : failedBranchCount < branchCount ? "warning" : "failed",
    detail:
      failedBranchCount === 0
        ? "No branch failures observed."
        : `${failedBranchCount}/${branchCount} branches failed and were retained as partial observations.`,
  });

  checks.push(buildPlanSourceCheck(input.plan.planSource));
  checks.push(buildBranchInstructionCheck(input.plan.branches));
  checks.push(buildRequestedImageArtifactCheck(input.plan.branches, input.observations, input.branchArtifacts));
  checks.push(buildSandboxReactQualityCheck(input.branchQualitySignals ?? []));
  checks.push(buildRecoveredArtifactTypeCoverageCheck(input.plan.branches, input.branchArtifacts ?? []));
  checks.push(buildBranchSummaryUniquenessCheck(input.observations));
  checks.push(buildConflictSignalCheck(input.observations));

  checks.push({
    id: "merge_has_branch_evidence",
    status: input.observations.length > 0 && input.branchObservationIds.length > 0 ? "passed" : "failed",
    detail: `Merge used ${input.observations.length} branch summary item(s) and ${input.branchObservationIds.length} branch observation id(s).`,
  });

  return summarizeVerificationChecks(checks);
}

function buildSandboxReactQualityCheck(qualitySignals: Array<Record<string, unknown>>): SwarmVerificationCheck {
  const v3Signals = qualitySignals.filter((quality) => quality.runtimeVersion === "dataswarm.sandbox-runtime.v3");
  if (v3Signals.length === 0) {
    return {
      id: "sandbox_react_quality_signals",
      status: "passed",
      detail: "No sandbox-runtime.v3 quality signals were present for this swarm.",
    };
  }

  const fallbackCount = sumQualityNumber(v3Signals, "fallbackActionCount");
  const unsupportedClaimCount = sumQualityNumber(v3Signals, "evidenceUnsupportedClaimCount");
  const evidenceFailedCount = sumQualityNumber(v3Signals, "evidenceVerificationFailedCount");
  const toolCallCount = sumQualityNumber(v3Signals, "toolCallCount");
  const proxyModeMissingOrNonParentCount = v3Signals.filter((quality) => {
    const branchToolCalls = Number(quality.toolCallCount ?? 0);
    if (branchToolCalls <= 0) {
      return false;
    }
    const parentMode = asText(quality.parentToolProxyMode, "missing").toLowerCase();
    const modelUsed = quality.modelUsed === true;
    const realModelActions = Number(quality.realModelActionCount ?? 0);
    return (
      (modelUsed || realModelActions > 0) &&
      parentMode !== "parent" &&
      parentMode !== "mock"
    );
  }).length;
  const hiddenFallback = v3Signals.filter(
    (quality) =>
      Number(quality.fallbackActionCount ?? 0) > 0 &&
      quality.fallbackPolicyStatus !== "degraded" &&
      quality.fallbackPolicyStatus !== "failed_verification",
  );
  const weakRealModelBranches = v3Signals.filter(
    (quality) => quality.modelUsed === true && Number(quality.realModelActionCount ?? 0) < 3,
  );
  if (hiddenFallback.length > 0) {
    return {
      id: "sandbox_react_quality_signals",
      status: "failed",
      detail: `${hiddenFallback.length}/${v3Signals.length} V3 branch(es) used deterministic fallback without degraded/failed_verification status.`,
    };
  }
  if (fallbackCount > 0) {
    return {
      id: "sandbox_react_quality_signals",
      status: "warning",
      detail: `${fallbackCount} fallback action(s) occurred and were explicitly degraded; inspect branch trace before trusting the result.`,
    };
  }
  if (weakRealModelBranches.length > 0) {
    return {
      id: "sandbox_react_quality_signals",
      status: "warning",
      detail: `${weakRealModelBranches.length}/${v3Signals.length} real-model V3 branch(es) had fewer than 3 model-selected actions.`,
    };
  }
  if (unsupportedClaimCount > 0) {
    return {
      id: "sandbox_react_quality_signals",
      status: unsupportedClaimCount > 3 ? "failed" : "warning",
      detail: `${unsupportedClaimCount} unsupported claim(s) were surfaced during branch verification; review final evidence mapping before trusting results.`,
    };
  }
  if (evidenceFailedCount > 0) {
    return {
      id: "sandbox_react_quality_signals",
      status: "failed",
      detail: `${evidenceFailedCount} evidence verification check(s) explicitly failed in branch outputs; reduce should not trust these branches.`,
    };
  }
  if (proxyModeMissingOrNonParentCount > 0) {
    return {
      id: "sandbox_react_quality_signals",
      status: "warning",
      detail: `${proxyModeMissingOrNonParentCount}/${v3Signals.length} V3 branch(es) used tool calls but are not explicitly parent-proxied.`,
    };
  }
  return {
    id: "sandbox_react_quality_signals",
    status: "passed",
    detail: `${v3Signals.length} V3 branch(es) reported real/model-driven ReAct quality signals with ${
      toolCallCount > 0 ? `${toolCallCount} tool calls verified` : "no tool calls"
    } and explicit evidence review.`,
  };
}

function buildInvalidActionRepairPolicyCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const signals = input.branchQualitySignals ?? [];
  const eventCounts = input.eventEvidence?.eventTypeCounts ?? {};
  const repairStarted = Number(eventCounts["sandbox.agent.action_repair_started"] ?? 0);
  const repairSucceeded = Number(eventCounts["sandbox.agent.action_repair_succeeded"] ?? 0);
  const repairFailed = Number(eventCounts["sandbox.agent.action_repair_failed"] ?? 0);
  const repairedActionCount = sumQualityNumber(signals, "repairedActionCount") || sumQualityNumber(signals, "repairCount");
  const unrepairedActionCount = sumQualityNumber(signals, "unrepairedActionCount");
  const fallbackActionCount = sumQualityNumber(signals, "fallbackActionCount");
  const invalidFallbackBranches = signals.filter((quality) => {
    const reasons = Array.isArray(quality.fallbackReasons) ? quality.fallbackReasons.map((item) => asText(item)) : [];
    return reasons.some((reason) => reason.startsWith("unrepaired_invalid_action:"));
  });
  const degradedInvalidBranches = invalidFallbackBranches.filter(
    (quality) => quality.degradedExecution === true || quality.fallbackPolicyStatus === "degraded" || Number(quality.fallbackActionCount ?? 0) > 0,
  );
  const allRepairAttemptsSettled = repairStarted === 0 || repairStarted <= repairSucceeded + repairFailed;
  const unrepairedMarkedDegraded =
    unrepairedActionCount === 0 ||
    (repairFailed > 0 && fallbackActionCount >= unrepairedActionCount && degradedInvalidBranches.length === invalidFallbackBranches.length);
  const eventCoverageConsistent =
    repairStarted === 0 ||
    repairSucceeded > 0 ||
    repairFailed > 0 ||
    repairedActionCount > 0 ||
    unrepairedActionCount > 0;
  const passed = allRepairAttemptsSettled && unrepairedMarkedDegraded && eventCoverageConsistent;
  return {
    id: "invalid_action_repair_policy",
    status: passed ? "passed" : "failed",
    detail: passed
      ? `Invalid action repair policy is auditable: repairStarted=${repairStarted}, repairSucceeded=${repairSucceeded}, repairFailed=${repairFailed}, repairedActionCount=${repairedActionCount}, unrepairedActionCount=${unrepairedActionCount}.`
      : `Invalid action repair policy is incomplete: repairStarted=${repairStarted}, repairSucceeded=${repairSucceeded}, repairFailed=${repairFailed}, repairedActionCount=${repairedActionCount}, unrepairedActionCount=${unrepairedActionCount}, fallbackActionCount=${fallbackActionCount}, invalidFallbackBranches=${invalidFallbackBranches.length}, degradedInvalidBranches=${degradedInvalidBranches.length}.`,
  };
}

function buildTraceDiagnosticsReplayabilityCheck(input: SwarmVerificationInput): SwarmVerificationCheck {
  const eventCounts = input.eventEvidence?.eventTypeCounts ?? {};
  const branchCompletedEvents = Number(eventCounts["swarm.branch.completed"] ?? 0);
  const branchContractMaterializedEvents = Number(eventCounts["swarm.branch.contract.materialized"] ?? 0);
  const branchFinalMaterializedEvents = Number(eventCounts["swarm.branch.final.materialized"] ?? 0);
  const reduceEvents = Number(eventCounts["swarm.reduce"] ?? 0);
  const finalArtifactEvents = Number(eventCounts["swarm.final_artifact.created"] ?? 0);
  const sandboxActionEvents = Object.entries(eventCounts)
    .filter(([type]) => type.startsWith("sandbox.agent.action"))
    .reduce((total, [, count]) => total + Number(count ?? 0), 0);
  const sandboxObservationEvents =
    Number(eventCounts["sandbox.agent.observation.created"] ?? 0) +
    Number(eventCounts["sandbox.agent.observation_created"] ?? 0);
  const sandboxModelEvents =
    Number(eventCounts["sandbox.agent.model_call_completed"] ?? 0) +
    Number(eventCounts["sandbox.agent.model_call_failed"] ?? 0);
  const capabilityEvents =
    Number(input.eventEvidence?.capabilityInvokeCompletedCount ?? 0) +
    Number(input.eventEvidence?.sandboxToolProxyCompletedCount ?? 0);
  const hasSandboxRuntimeSignals = (input.branchQualitySignals ?? []).some((quality) =>
    asText(quality.runtimeVersion).startsWith("dataswarm.sandbox-runtime"),
  );
  const missing: string[] = [];
  if (branchContractMaterializedEvents < input.plan.branches.length) {
    missing.push(`swarm.branch.contract.materialized ${branchContractMaterializedEvents}/${input.plan.branches.length}`);
  }
  if (branchFinalMaterializedEvents < input.completedBranches) {
    missing.push(`swarm.branch.final.materialized ${branchFinalMaterializedEvents}/${input.completedBranches}`);
  }
  if (branchCompletedEvents < input.completedBranches) {
    missing.push(`swarm.branch.completed ${branchCompletedEvents}/${input.completedBranches}`);
  }
  if (reduceEvents < 1) {
    missing.push("swarm.reduce missing");
  }
  if (finalArtifactEvents < 1) {
    missing.push("swarm.final_artifact.created missing");
  }
  if (input.branchObservationIds.length < input.completedBranches) {
    missing.push(`branchObservationIds ${input.branchObservationIds.length}/${input.completedBranches}`);
  }
  if (input.artifactIds.length < 1) {
    missing.push("artifactIds missing");
  }
  if (hasSandboxRuntimeSignals && sandboxActionEvents < input.completedBranches) {
    missing.push(`sandbox.agent.action events ${sandboxActionEvents}/${input.completedBranches}`);
  }
  if (hasSandboxRuntimeSignals && sandboxObservationEvents < input.completedBranches) {
    missing.push(`sandbox.agent.observation events ${sandboxObservationEvents}/${input.completedBranches}`);
  }
  if (hasSandboxRuntimeSignals && sandboxModelEvents < input.completedBranches) {
    missing.push(`sandbox.agent.model_call events ${sandboxModelEvents}/${input.completedBranches}`);
  }
  if ((input.branchContracts ?? []).some((contract) => contract.requiredTools.length > 0) && capabilityEvents < 1) {
    missing.push("capability/proxy completion events missing");
  }
  return {
    id: "trace_diagnostics_replayability",
    status: missing.length === 0 ? "passed" : "failed",
    detail:
      missing.length === 0
        ? `Trace replay evidence is sufficient before verify publication: branchContractMaterializedEvents=${branchContractMaterializedEvents}, branchFinalMaterializedEvents=${branchFinalMaterializedEvents}, branchCompletedEvents=${branchCompletedEvents}, sandboxActionEvents=${sandboxActionEvents}, sandboxObservationEvents=${sandboxObservationEvents}, sandboxModelEvents=${sandboxModelEvents}, reduceEvents=${reduceEvents}, finalArtifactEvents=${finalArtifactEvents}, capability/proxy completions=${capabilityEvents}.`
        : `Trace replay evidence is incomplete: ${missing.join(", ")}.`,
  };
}

function buildRecoveredArtifactTypeCoverageCheck(
  branches: SwarmVerifierBranch[],
  artifacts: Array<{ id: string; type: string; title: string; mimeType?: string }>,
): SwarmVerificationCheck {
  const text = branches.map((branch) => `${branch.title}\n${branch.instruction}`).join("\n");
  const wantsImage = /图片|图像|绘制|画图|生成图|image|png|jpe?g|svg|plot|chart|matplotlib/i.test(text);
  const wantsReport = /报告|markdown|html|artifact|产物|deliverable|report/i.test(text);
  const hasImage = artifacts.some((artifact) => artifact.type === "image" || /^image\//i.test(artifact.mimeType ?? ""));
  const hasMarkdown = artifacts.some((artifact) => artifact.type === "markdown" || /markdown/i.test(artifact.mimeType ?? ""));
  const hasHtml = artifacts.some((artifact) => artifact.type === "html" || /html/i.test(artifact.mimeType ?? ""));
  const missing: string[] = [];
  if (wantsImage && !hasImage) {
    missing.push("image");
  }
  if (wantsReport && !hasMarkdown && !hasHtml) {
    missing.push("markdown/html");
  }
  return {
    id: "recovered_artifact_type_coverage",
    status: missing.length === 0 ? "passed" : "failed",
    detail:
      missing.length === 0
        ? `Recovered artifact types satisfy requested deliverables (${artifacts.length} artifact(s)).`
        : `Requested deliverables are missing recovered artifact type(s): ${missing.join(", ")}.`,
  };
}

function sumQualityNumber(qualitySignals: Array<Record<string, unknown>>, key: string) {
  return qualitySignals.reduce((sum, quality) => sum + Number(quality[key] ?? 0), 0);
}

export function detectContradictionSignals(observations: string[]): ContradictionSignal[] {
  const signals: ContradictionSignal[] = [];
  for (const [index, observation] of observations.entries()) {
    for (const { id, pattern } of contradictionPatterns) {
      if (pattern.test(observation)) {
        signals.push({
          index,
          signal: id,
          excerpt: observation.slice(0, 240),
        });
      }
    }
  }
  return signals;
}

export function summarizeVerificationChecks(checks: SwarmVerificationCheck[]): SwarmVerificationResult {
  const failedChecks = checks.filter((check) => check.status === "failed");
  const warningChecks = checks.filter((check) => check.status === "warning");
  const status = failedChecks.length > 0 ? "failed" : warningChecks.length > 0 ? "warning" : "passed";
  const summary =
    status === "passed"
      ? `All ${checks.length} verification checks passed.`
      : `${failedChecks.length} failed and ${warningChecks.length} warning verification check(s) out of ${checks.length}.`;

  return { status, summary, checks };
}

function buildPlanSourceCheck(planSource: string | undefined): SwarmVerificationCheck {
  if (!planSource) {
    return {
      id: "plan_source_traceable",
      status: "failed",
      detail: "Swarm plan source is missing; diagnostics cannot distinguish model-owned branches from fallback.",
    };
  }
  if (planSource === "runtime_fallback") {
    return {
      id: "plan_source_traceable",
      status: "warning",
      detail: "Swarm used runtime_fallback; branch plan was explicit in trace but not model-provided.",
    };
  }
  return {
    id: "plan_source_traceable",
    status: "passed",
    detail: `Swarm plan source is traceable as ${planSource}.`,
  };
}

function buildBranchInstructionCheck(branches: SwarmVerifierBranch[]): SwarmVerificationCheck {
  const missing = branches.filter((branch) => !branch.instruction || branch.instruction.trim().length < 12);
  return {
    id: "branch_instructions_present",
    status: missing.length === 0 ? "passed" : "warning",
    detail:
      missing.length === 0
        ? `${branches.length}/${branches.length} branches include executable instructions.`
        : `${missing.length}/${branches.length} branches have empty or too-short instructions: ${missing
            .map((branch) => branch.id)
            .join(", ")}.`,
  };
}

function buildRequestedImageArtifactCheck(
  branches: SwarmVerifierBranch[],
  observations: string[],
  branchArtifacts: Array<{ id: string; type: string; title: string; mimeType?: string; branchId?: string; branchIds?: string[] }> = [],
): SwarmVerificationCheck {
  const requestedImageBranches = branches.filter((branch) => requestsImageArtifact(branch.instruction));
  if (requestedImageBranches.length === 0) {
    return {
      id: "requested_image_artifact_present",
      status: "passed",
      detail: "No branch instruction explicitly requested an image artifact.",
    };
  }

  let imageArtifactCount = 0;
  const artifactAwareCount = requestedImageBranches.filter((branch) => branchIdHasImageArtifact(branch.id, branchArtifacts)).length;
  if (branchArtifacts.length > 0) {
    imageArtifactCount = artifactAwareCount;
  } else {
    imageArtifactCount = observations.filter((observation) => /\bimage\s*:/i.test(observation)).length;
  }

  const missingBranches =
    artifactAwareCount < requestedImageBranches.length
      ? requestedImageBranches.filter((branch) => !branchIdHasImageArtifact(branch.id, branchArtifacts))
      : [];
  return {
    id: "requested_image_artifact_present",
    status: imageArtifactCount >= requestedImageBranches.length ? "passed" : "failed",
    detail:
      imageArtifactCount >= requestedImageBranches.length
        ? `${imageArtifactCount}/${requestedImageBranches.length} image-requesting branch(es) produced image artifacts.`
        : `${imageArtifactCount}/${requestedImageBranches.length} image-requesting branch(es) produced image artifacts; missing image output for: ${missingBranches
            .map((branch) => branch.id)
            .join(", ")}.`,
  };
}

function branchIdHasImageArtifact(
  branchId: string,
  branchArtifacts: Array<{ id: string; type: string; title: string; mimeType?: string; branchId?: string; branchIds?: string[] }>,
) {
  return branchArtifacts.some((artifact) => {
    if (artifact.type !== "image") {
      return false;
    }
    const branchIds = new Set<string>([artifact.branchId ?? "", ...(artifact.branchIds ?? [])]);
    return branchIds.has(branchId);
  });
}

function requestsImageArtifact(instruction: string) {
  return /图片|图像|绘制|画图|生成图|image|png|jpe?g|svg|plot|chart|matplotlib/i.test(instruction);
}

function buildBranchSummaryUniquenessCheck(observations: string[]): SwarmVerificationCheck {
  const normalized = observations.map((observation) => normalizeObservationSummary(observation)).filter(Boolean);
  const duplicateCount = normalized.length - new Set(normalized).size;
  return {
    id: "branch_summary_uniqueness",
    status: duplicateCount === 0 ? "passed" : "warning",
    detail:
      duplicateCount === 0
        ? `${normalized.length} branch summary item(s) are distinct after normalization.`
        : `${duplicateCount} duplicate-like branch summary item(s) detected; reduce should review branch diversity.`,
  };
}

function buildConflictSignalCheck(observations: string[]): SwarmVerificationCheck {
  const signals = detectContradictionSignals(observations);
  return {
    id: "conflict_signal_scan",
    status: signals.length === 0 ? "passed" : "warning",
    detail:
      signals.length === 0
        ? "No explicit conflict, contradiction, unsupported-claim, or source-mismatch signal found in branch summaries."
        : `${signals.length} branch summary signal(s) require reducer/model review: ${signals
            .map((signal) => `${signal.signal}@${signal.index + 1}`)
            .join(", ")}.`,
  };
}

function normalizeObservationSummary(value: string) {
  return value
    .toLowerCase()
    .replace(/art_[a-z0-9]+/g, "art")
    .replace(/obs_[a-z0-9]+/g, "obs")
    .replace(/branch_[a-z0-9_]+/g, "branch")
    .replace(/\s+/g, " ")
    .trim();
}
