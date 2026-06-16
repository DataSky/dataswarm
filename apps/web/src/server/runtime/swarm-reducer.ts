import { detectContradictionSignals } from "./swarm-verifier";

export type SwarmReductionBranch = {
  id: string;
  title: string;
  instruction: string;
};

export type SwarmReductionPlan = {
  strategy: string;
  planSource?: string;
  branches: SwarmReductionBranch[];
};

export type SwarmReductionInput = {
  plan: SwarmReductionPlan;
  completedBranches: number;
  failedBranches: number;
  artifactIds: string[];
  branchObservationIds: string[];
  observations: string[];
  branchFinals?: SwarmReductionBranchFinal[];
};

export type SwarmReductionBranchFinal = {
  branchId: string;
  branchTitle?: string;
  executiveSummary?: string;
  sections?: Array<{
    title?: string;
    content?: string;
    evidenceObservationIds?: string[];
    evidenceArtifactIds?: string[];
  }>;
  claims?: Array<{
    claim?: string;
    evidenceObservationIds?: string[];
    evidenceArtifactIds?: string[];
    confidence?: string;
  }>;
  keyFindings?: string[];
  evidenceObservationIds?: string[];
  artifactIds?: string[];
  unsupportedClaims?: string[];
  assumptions?: string[];
  limitations?: string[];
};

export type SwarmReductionItem = {
  branchId: string;
  title: string;
  status: "completed" | "failed" | "unknown";
  observationId?: string;
  artifactId?: string;
  summary: string;
  source: "branch_final" | "runtime_observation";
  sections: Array<{
    title: string;
    content: string;
    evidenceObservationIds: string[];
    evidenceArtifactIds: string[];
  }>;
  claims: Array<{
    claim: string;
    evidenceObservationIds: string[];
    evidenceArtifactIds: string[];
    confidence: string;
  }>;
  evidenceObservationIds: string[];
  artifactIds: string[];
  unsupportedClaims: string[];
  limitations: string[];
};

export type SwarmReductionResult = {
  reducerMode: "deterministic_runtime";
  assistedBy: string[];
  status: "completed" | "partial" | "failed";
  summary: string;
  branchItems: SwarmReductionItem[];
  conflictSignals: ReturnType<typeof detectContradictionSignals>;
  recommendations: string[];
  coverage: {
    branchCount: number;
    completedBranches: number;
    failedBranches: number;
    artifactCount: number;
    branchObservationCount: number;
  };
};

export function buildSwarmReduction(input: SwarmReductionInput): SwarmReductionResult {
  const branchFinalById = new Map((input.branchFinals ?? []).map((final) => [final.branchId, final]));
  const branchItems = input.plan.branches.map((branch, index) => {
    const raw = input.observations[index] ?? "";
    const branchFinal = branchFinalById.get(branch.id);
    const evidenceObservationIds = uniqueStrings([
      ...(branchFinal?.evidenceObservationIds ?? []),
      input.branchObservationIds[index] ?? "",
    ]);
    const artifactIds = uniqueStrings([...(branchFinal?.artifactIds ?? []), input.artifactIds[index] ?? ""]);
    const sections = normalizeBranchFinalSections(branchFinal, evidenceObservationIds, artifactIds);
    const claims = normalizeBranchFinalClaims(branchFinal, evidenceObservationIds, artifactIds);
    return {
      branchId: branch.id,
      title: branchFinal?.branchTitle ?? branch.title,
      status: inferBranchStatus(raw),
      observationId: evidenceObservationIds[0] ?? extractFirst(raw, /\bobs_[a-z0-9]+\b/i),
      artifactId: artifactIds[0] ?? extractFirst(raw, /\bart_[a-z0-9]+\b/i),
      summary: normalizeSummary(branchFinal?.executiveSummary ?? "") || normalizeSummary(raw) || `${branch.title}: no branch summary recorded.`,
      source: branchFinal ? "branch_final" : "runtime_observation",
      sections,
      claims,
      evidenceObservationIds,
      artifactIds,
      unsupportedClaims: branchFinal?.unsupportedClaims ?? [],
      limitations: branchFinal?.limitations ?? [],
    };
  });
  const conflictSignals = detectContradictionSignals([
    ...input.observations,
    ...branchItems.flatMap((item) => item.claims.map((claim) => claim.claim)),
    ...branchItems.flatMap((item) => item.sections.map((section) => section.content)),
  ]);
  const branchCount = input.plan.branches.length;
  const status =
    input.completedBranches === branchCount && conflictSignals.length === 0
      ? "completed"
      : input.completedBranches > 0
        ? "partial"
        : "failed";
  const recommendations = buildReductionRecommendations({
    branchCount,
    completedBranches: input.completedBranches,
    failedBranches: input.failedBranches,
    artifactIds: input.artifactIds,
    branchObservationIds: input.branchObservationIds,
    conflictSignalCount: conflictSignals.length,
  });

  return {
    reducerMode: "deterministic_runtime",
    assistedBy: ["branch-final.sections.claims", "swarm-verifier.detectContradictionSignals"],
    status,
    summary: summarizeReduction(input, conflictSignals.length),
    branchItems,
    conflictSignals,
    recommendations,
    coverage: {
      branchCount,
      completedBranches: input.completedBranches,
      failedBranches: input.failedBranches,
      artifactCount: input.artifactIds.length,
      branchObservationCount: input.branchObservationIds.length,
    },
  };
}

export function formatSwarmReductionEvidence(reduction: SwarmReductionResult) {
  const branchSections = reduction.branchItems.map((item) => {
    const claimLines = item.claims
      .slice(0, 6)
      .map((claim) => {
        const evidence = uniqueStrings([...claim.evidenceObservationIds, ...claim.evidenceArtifactIds]);
        return `- Claim (${claim.confidence}): ${claim.claim}${evidence.length > 0 ? ` [evidence: ${evidence.join(", ")}]` : ""}`;
      })
      .join("\n");
    const sectionLines = item.sections
      .slice(0, 4)
      .map((section) => {
        const evidence = uniqueStrings([...section.evidenceObservationIds, ...section.evidenceArtifactIds]);
        return `### ${section.title}\n${truncateReductionText(section.content, 1200)}${evidence.length > 0 ? `\nEvidence: ${evidence.join(", ")}` : ""}`;
      })
      .join("\n\n");
    const unsupported =
      item.unsupportedClaims.length > 0
        ? `\nUnsupported claims: ${item.unsupportedClaims.join("; ")}`
        : "";
    const limitations =
      item.limitations.length > 0
        ? `\nLimitations: ${item.limitations.join("; ")}`
        : "";
    return [
      `## Branch ${item.branchId}: ${item.title}`,
      `Status: ${item.status}; source: ${item.source}`,
      `Observation IDs: ${item.evidenceObservationIds.join(", ") || item.observationId || "none"}`,
      `Artifact IDs: ${item.artifactIds.join(", ") || item.artifactId || "none"}`,
      "",
      truncateReductionText(item.summary, 1200),
      sectionLines ? `\n${sectionLines}` : "",
      claimLines ? `\n### Claims\n${claimLines}` : "",
      unsupported,
      limitations,
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  });

  return [
    "# Swarm Reduction Evidence",
    reduction.summary,
    "",
    ...branchSections,
    "",
    "## Reducer Recommendations",
    ...reduction.recommendations.map((item) => `- ${item}`),
  ].join("\n\n");
}

function normalizeBranchFinalSections(
  branchFinal: SwarmReductionBranchFinal | undefined,
  evidenceObservationIds: string[],
  artifactIds: string[],
): SwarmReductionItem["sections"] {
  const sections = (branchFinal?.sections ?? [])
    .map((section) => ({
      title: normalizeSummary(section.title ?? "Section"),
      content: normalizeSummary(section.content ?? ""),
      evidenceObservationIds: uniqueStrings(section.evidenceObservationIds ?? evidenceObservationIds),
      evidenceArtifactIds: uniqueStrings(section.evidenceArtifactIds ?? artifactIds),
    }))
    .filter((section) => section.content.length > 0);
  if (sections.length > 0) {
    return sections;
  }
  const fallback = normalizeSummary(branchFinal?.executiveSummary ?? "");
  return fallback
    ? [
        {
          title: "Executive Summary",
          content: fallback,
          evidenceObservationIds,
          evidenceArtifactIds: artifactIds,
        },
      ]
    : [];
}

function normalizeBranchFinalClaims(
  branchFinal: SwarmReductionBranchFinal | undefined,
  evidenceObservationIds: string[],
  artifactIds: string[],
): SwarmReductionItem["claims"] {
  const claims = (branchFinal?.claims ?? [])
    .map((claim) => ({
      claim: normalizeSummary(claim.claim ?? ""),
      evidenceObservationIds: uniqueStrings(claim.evidenceObservationIds ?? evidenceObservationIds),
      evidenceArtifactIds: uniqueStrings(claim.evidenceArtifactIds ?? artifactIds),
      confidence: normalizeSummary(claim.confidence ?? "unknown"),
    }))
    .filter((claim) => claim.claim.length > 0);
  if (claims.length > 0) {
    return claims;
  }
  return (branchFinal?.keyFindings ?? [])
    .map((finding) => ({
      claim: normalizeSummary(finding),
      evidenceObservationIds,
      evidenceArtifactIds: artifactIds,
      confidence: evidenceObservationIds.length > 0 || artifactIds.length > 0 ? "medium" : "assumption",
    }))
    .filter((claim) => claim.claim.length > 0);
}

function summarizeReduction(input: SwarmReductionInput, conflictSignalCount: number) {
  const branchCount = input.plan.branches.length;
  const statusText =
    input.failedBranches === 0
      ? `${input.completedBranches}/${branchCount} branches completed`
      : `${input.completedBranches}/${branchCount} branches completed, ${input.failedBranches} failed`;
  const artifactText = `${input.artifactIds.length} artifact(s), ${input.branchObservationIds.length} branch observation(s)`;
  const signalText =
    conflictSignalCount === 0
      ? "no explicit contradiction/source-mismatch signals"
      : `${conflictSignalCount} contradiction/source-mismatch signal(s)`;
  return `Reducer synthesized ${statusText}; ${artifactText}; ${signalText}.`;
}

function buildReductionRecommendations(input: {
  branchCount: number;
  completedBranches: number;
  failedBranches: number;
  artifactIds: string[];
  branchObservationIds: string[];
  conflictSignalCount: number;
}) {
  const recommendations: string[] = [];
  if (input.branchObservationIds.length < input.branchCount) {
    recommendations.push("Do not finalize high-confidence conclusions until every branch has a persisted Observation.");
  }
  if (input.artifactIds.length < input.completedBranches) {
    recommendations.push("Recover or regenerate missing branch artifacts before producing a report artifact.");
  }
  if (input.failedBranches > 0) {
    recommendations.push("Preserve failed branch evidence in the final answer and avoid treating partial swarm output as complete.");
  }
  if (input.conflictSignalCount > 0) {
    recommendations.push("Run a focused verification/research pass before merging conflicting branch claims.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Proceed to merge and verification using the reduced branch evidence.");
  }
  return recommendations;
}

function inferBranchStatus(summary: string): SwarmReductionItem["status"] {
  if (/cancelled|failed|sandbox_preflight_failed|error/i.test(summary)) {
    return "failed";
  }
  if (summary.trim().length > 0) {
    return "completed";
  }
  return "unknown";
}

function normalizeSummary(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function truncateReductionText(value: string, maxLength: number) {
  const normalized = normalizeSummary(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function extractFirst(value: string, pattern: RegExp) {
  return value.match(pattern)?.[0];
}
