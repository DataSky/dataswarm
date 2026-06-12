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
};

export type SwarmReductionItem = {
  branchId: string;
  title: string;
  status: "completed" | "failed" | "unknown";
  observationId?: string;
  artifactId?: string;
  summary: string;
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
  const branchItems = input.plan.branches.map((branch, index) => {
    const raw = input.observations[index] ?? "";
    return {
      branchId: branch.id,
      title: branch.title,
      status: inferBranchStatus(raw),
      observationId: extractFirst(raw, /\bobs_[a-z0-9]+\b/i) ?? input.branchObservationIds[index],
      artifactId: extractFirst(raw, /\bart_[a-z0-9]+\b/i) ?? input.artifactIds[index],
      summary: normalizeSummary(raw) || `${branch.title}: no branch summary recorded.`,
    };
  });
  const conflictSignals = detectContradictionSignals(input.observations);
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
    assistedBy: ["swarm-verifier.detectContradictionSignals"],
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

function extractFirst(value: string, pattern: RegExp) {
  return value.match(pattern)?.[0];
}
