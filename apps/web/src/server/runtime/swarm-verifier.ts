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

export type SwarmVerifierBranch = {
  id: string;
  title: string;
  instruction: string;
};

export type SwarmVerifierPlan = {
  planSource?: string;
  branches: SwarmVerifierBranch[];
};

export type SwarmVerificationInput = {
  plan: SwarmVerifierPlan;
  completedBranches: number;
  failedBranches: number;
  artifactIds: string[];
  branchObservationIds: string[];
  observations: string[];
};

export type ContradictionSignal = {
  index: number;
  signal: string;
  excerpt: string;
};

const contradictionPatterns: Array<{ id: string; pattern: RegExp }> = [
  { id: "contradiction", pattern: /contradict|contradiction|互相矛盾|矛盾/i },
  { id: "conflict", pattern: /conflict|冲突/i },
  { id: "inconsistency", pattern: /inconsisten|不一致|不相符/i },
  { id: "unsupported", pattern: /unsupported|not supported|无证据|缺少证据|无法支持/i },
  { id: "source_mismatch", pattern: /source mismatch|domain mismatch|来源不匹配|来源偏离/i },
];

export function buildSwarmVerification(input: SwarmVerificationInput): SwarmVerificationResult {
  const checks: SwarmVerificationCheck[] = [];
  const branchCount = input.plan.branches.length;
  const completedBranchCount = input.completedBranches;
  const failedBranchCount = input.failedBranches;

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
  checks.push(buildRequestedImageArtifactCheck(input.plan.branches, input.observations));
  checks.push(buildBranchSummaryUniquenessCheck(input.observations));
  checks.push(buildConflictSignalCheck(input.observations));

  checks.push({
    id: "merge_has_branch_evidence",
    status: input.observations.length > 0 && input.branchObservationIds.length > 0 ? "passed" : "failed",
    detail: `Merge used ${input.observations.length} branch summary item(s) and ${input.branchObservationIds.length} branch observation id(s).`,
  });

  return summarizeVerificationChecks(checks);
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

function buildRequestedImageArtifactCheck(branches: SwarmVerifierBranch[], observations: string[]): SwarmVerificationCheck {
  const requestedImageBranches = branches.filter((branch) => requestsImageArtifact(branch.instruction));
  if (requestedImageBranches.length === 0) {
    return {
      id: "requested_image_artifact_present",
      status: "passed",
      detail: "No branch instruction explicitly requested an image artifact.",
    };
  }

  const imageArtifactCount = observations.filter((observation) => /\bimage\s*:/i.test(observation)).length;
  return {
    id: "requested_image_artifact_present",
    status: imageArtifactCount >= requestedImageBranches.length ? "passed" : "failed",
    detail:
      imageArtifactCount >= requestedImageBranches.length
        ? `${imageArtifactCount}/${requestedImageBranches.length} image-requesting branch(es) produced image artifacts.`
        : `${imageArtifactCount}/${requestedImageBranches.length} image-requesting branch(es) produced image artifacts; missing image output for: ${requestedImageBranches
            .map((branch) => branch.id)
            .join(", ")}.`,
  };
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
