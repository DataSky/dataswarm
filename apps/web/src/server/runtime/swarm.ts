import { createAgentSession, updateAgentSessionStatus } from "../repositories/agent-sessions";
import { createTextArtifact, listRunArtifactsForBranch, mergeArtifactMetadata, type ArtifactRecord } from "../repositories/artifacts";
import { createContextBundle } from "../repositories/context-bundles";
import { createObservation } from "../repositories/observations";
import { createSandboxSession } from "../repositories/sandbox-sessions";
import { listSkills } from "../repositories/skills";
import { isRunCancelRequested } from "../repositories/runs";
import { completeTraceSpan, startTraceSpan } from "../repositories/trace";
import { getDb } from "../storage/db";
import { publishRunEvent } from "./event-bus";
import { createSandboxProvider, sandboxProviderSelection, type SandboxProvider } from "./sandbox-provider";
import { buildSandboxToolCatalog, buildSandboxToolProxyConfig, sandboxAgentBudgets, sandboxAgentProtocol, sandboxAllowedTools } from "./sandbox-tool-proxy";
import type { ModelProvider } from "../models/provider";
import type { ModelProfile } from "../repositories/model-profiles";
import type { SpawnAgentAction, SpawnSwarmAction, SwarmActionBranchDefinition } from "./agentic-types";
import { reviewSwarmResult, type SwarmReviewResult } from "./swarm-reviewer";
import { buildSwarmReduction, formatSwarmReductionEvidence, type SwarmReductionResult } from "./swarm-reducer";
import { buildSwarmVerification, buildSwarmVerificationGateCoverage, type SwarmVerificationResult } from "./swarm-verifier";

export type BranchArtifactRequirement = {
  type: "markdown" | "html" | "image" | "json" | "image_metadata";
  title: string;
  purpose: string;
};

export type BranchMinimumEvidence = {
  realModelActionCount: number;
  webSearchCount?: number;
  toolCallCount?: number;
  imageArtifactCount?: number;
  htmlArtifactCount?: number;
  markdownArtifactCount?: number;
};

export type BranchFinalOutputSchema = {
  requiredSections: string[];
  mustCiteObservationIds: boolean;
  mustCiteArtifactIds: boolean;
  unsupportedClaimPolicy: "mark_assumption" | "fail_verification";
};

export type BranchContract = {
  branchId: string;
  branchTitle: string;
  title: string;
  role: string;
  objective: string;
  preservedInstruction: string;
  requiredQuestions: string[];
  requiredTools: string[];
  requiredArtifacts: BranchArtifactRequirement[];
  minimumRealModelActions: number;
  minimumEvidence: BranchMinimumEvidence;
  finalOutputSchema: BranchFinalOutputSchema;
  fallbackPolicy: "degraded_or_failed_verification";
};

export type BranchFinal = {
  branchId: string;
  branchTitle: string;
  executiveSummary: string;
  sections?: Array<{
    title: string;
    content: string;
    evidenceObservationIds?: string[];
    evidenceArtifactIds?: string[];
  }>;
  claims?: Array<{
    claim: string;
    evidenceObservationIds?: string[];
    evidenceArtifactIds?: string[];
    confidence?: "high" | "medium" | "low" | "assumption";
  }>;
  keyFindings: string[];
  evidenceObservationIds: string[];
  artifactIds: string[];
  unsupportedClaims: string[];
  assumptions?: string[];
  limitations: string[];
};

export type SwarmBranch = {
  id: string;
  title: string;
  instruction: string;
  modelProfile: "deepseek:deepseek-v4-pro" | "deepseek:deepseek-v4-flash";
  contract?: BranchContract;
};

export type SwarmPlan = {
  strategy: "parallel_branch_then_merge";
  reason: string;
  planSource: "model_branches" | "model_single_agent" | "model_roles" | "runtime_fallback";
  branches: SwarmBranch[];
};

export type SwarmExecutionResult = {
  plan: SwarmPlan;
  observations: string[];
  artifactIds: string[];
  branchObservationIds: string[];
  reduction: SwarmReductionResult;
  verification: SwarmVerificationResult;
  review: SwarmReviewResult;
};

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function buildBranchContract(objective: string, branch: SwarmBranch): BranchContract {
  const searchableText = `${objective} ${branch.title} ${branch.instruction}`.toLowerCase();
  const requiredTools: string[] = [];
  const requiredArtifacts: BranchArtifactRequirement[] = [];

  if (/web|search|market|compet|policy|risk|benchmark|latest|current|调研|搜索|市场|竞品|政策|风险|外部/.test(searchableText)) {
    requiredTools.push("web.search");
  }
  if (/file|context|trace|artifact|历史|上下文|证据|产物/.test(searchableText)) {
    requiredTools.push("trace.query");
  }
  if (/image|chart|plot|visual|diagram|图片|图表|可视化|架构图|路线图/.test(searchableText)) {
    requiredTools.push("run_python");
    requiredArtifacts.push({ type: "image", title: `${branch.title} Evidence Chart`, purpose: "Visual evidence or synthesis required by the branch contract" });
  }
  if (/html|interactive|dashboard|网页|报告页/.test(searchableText)) {
    requiredArtifacts.push({ type: "html", title: `${branch.title} HTML Report`, purpose: "Structured branch deliverable suitable for preview and reduction" });
  }
  if (requiredArtifacts.length === 0 || /markdown|report|brief|analysis|报告|分析|方案/.test(searchableText)) {
    requiredArtifacts.push({ type: "markdown", title: `${branch.title} Evidence Report`, purpose: "Substantive branch final with claims tied to observations and artifacts" });
  }

  return {
    branchId: branch.id,
    branchTitle: branch.title,
    title: branch.title,
    role: branch.title,
    objective,
    preservedInstruction: branch.instruction,
    requiredQuestions: uniqueStrings([branch.title, branch.instruction]).slice(0, 4),
    requiredTools: uniqueStrings(requiredTools),
    requiredArtifacts,
    minimumRealModelActions: 3,
    minimumEvidence: {
      realModelActionCount: 3,
      toolCallCount: requiredTools.length > 0 ? 1 : 0,
      webSearchCount: requiredTools.includes("web.search") ? 1 : 0,
      imageArtifactCount: requiredArtifacts.some((artifact) => artifact.type === "image") ? 1 : 0,
      htmlArtifactCount: requiredArtifacts.some((artifact) => artifact.type === "html") ? 1 : 0,
      markdownArtifactCount: requiredArtifacts.some((artifact) => artifact.type === "markdown") ? 1 : 0,
    },
    finalOutputSchema: {
      requiredSections: uniqueStrings(["Executive Summary", branch.title, "Evidence", "Limitations"]),
      mustCiteObservationIds: true,
      mustCiteArtifactIds: requiredArtifacts.length > 0,
      unsupportedClaimPolicy: "fail_verification",
    },
    fallbackPolicy: "degraded_or_failed_verification",
  };
}

type BranchArtifactSummary = {
  id: string;
  type: string;
  title: string;
  mimeType: string;
  storageUri: string;
  deduped?: boolean;
  branchId?: string;
  branchIds?: string[];
  artifactKind?: string | null;
  qualitySignals?: Record<string, unknown>;
};

function branchArtifactFromArtifactRecord(artifact: ArtifactRecord, branchId: string): BranchArtifactSummary {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    mimeType: artifact.mimeType ?? "application/octet-stream",
    storageUri: artifact.storageUri ?? artifact.previewUri ?? "",
    deduped: false,
    branchId,
    branchIds: uniqueStrings([branchId, ...artifact.branchIds]),
    artifactKind: artifact.artifactKind,
    qualitySignals: artifact.qualitySignals,
  };
}

type SwarmConcurrencyPolicy = {
  requestedBranchCount: number;
  maxConcurrency: number;
  effectiveConcurrency: number;
  batchCount: number;
  executionMode: "single_branch" | "parallel" | "batched_parallel";
  explicitParallelRequest: boolean;
  configuredMaxConcurrency?: number;
};

type BranchLaunchMetadata = {
  branchIndex: number;
  launchOrder: number;
  batchIndex: number;
  concurrencySlot: number;
  effectiveConcurrency: number;
  queuedAt: string;
};

type BranchExecutionRecord = {
  branchIndex: number;
  branchId: string;
  status: "completed" | "failed" | "cancelled";
  observation: string;
  artifactIds: string[];
  branchObservationId?: string;
  qualitySignals?: Record<string, unknown>;
  branchArtifacts?: BranchArtifactSummary[];
  branchContract?: BranchContract;
  branchFinal?: BranchFinal;
};

const SWARM_BRANCH_LIMIT = 10;
const DEFAULT_SWARM_MAX_CONCURRENCY = 3;

export function shouldUseSwarm(text: string) {
  return /(^|[^a-z])swarm($|[^a-z])|蜂群|并行|多分支|多个沙箱|沙箱.*分支|复杂任务|多agent|multi-agent|multi agents/i.test(
    text,
  );
}

export function buildSwarmPlan(objective: string, action?: SpawnAgentAction | SpawnSwarmAction): SwarmPlan {
  if (action?.type === "spawn_agent") {
    const branch = action.branches?.[0] ?? {
      title: `${action.agentRole} Branch`,
      instruction: action.objective,
      modelProfile: action.modelProfile,
    };
    return alignSwarmPlanWithObjective(objective, {
      strategy: "parallel_branch_then_merge",
      reason: action.branches?.length
        ? "Planner selected spawn_agent with an explicit branch definition."
        : "Planner selected spawn_agent; runtime normalized the single delegated agent into a one-branch plan.",
      planSource: action.branches?.length ? "model_branches" : "model_single_agent",
      branches: ensureUniqueBranchIds([normalizeBranchDefinition(branch, 0, action.objective, action.agentRole)]),
    });
  }

  if (action?.type === "spawn_swarm") {
    if (action.branches?.length) {
      return alignSwarmPlanWithObjective(objective, {
        strategy: "parallel_branch_then_merge",
        reason: "Planner selected spawn_swarm with explicit model-provided branch definitions.",
        planSource: "model_branches",
        branches: ensureUniqueBranchIds(
          action.branches.map((branch, index) => normalizeBranchDefinition(branch, index, action.objective)),
        ),
      });
    }

    const roleBranches = buildRoleBranches(action);
    if (roleBranches.length > 0) {
      return alignSwarmPlanWithObjective(objective, {
        strategy: "parallel_branch_then_merge",
        reason: "Planner selected spawn_swarm with branch roles/count; runtime expanded them into executable branches.",
        planSource: "model_roles",
        branches: ensureUniqueBranchIds(roleBranches),
      });
    }
  }

  return alignSwarmPlanWithObjective(objective, {
    strategy: "parallel_branch_then_merge",
    reason: "The request asks for complex or parallel multi-agent execution.",
    planSource: "runtime_fallback",
    branches: [
      {
        id: "branch_research",
        title: "Research Branch",
        instruction: `Identify the strongest factual and contextual inputs needed for: ${objective}`,
        modelProfile: "deepseek:deepseek-v4-pro",
      },
      {
        id: "branch_analysis",
        title: "Analysis Branch",
        instruction: `Analyze trade-offs, risks, and implementation implications for: ${objective}`,
        modelProfile: "deepseek:deepseek-v4-flash",
      },
      {
        id: "branch_validation",
        title: "Validation Branch",
        instruction: `Design checks, acceptance criteria, and failure signals for: ${objective}`,
        modelProfile: "deepseek:deepseek-v4-pro",
      },
    ],
  });
}

function alignSwarmPlanWithObjective(objective: string, plan: SwarmPlan): SwarmPlan {
  const branches = [...plan.branches];
  if (branches.length === 0) {
    return plan;
  }
  const patches: string[] = [];
  const explicitBranchPlan = extractExplicitBranchPlan([
    objective,
    ...branches.map((branch) => branch.instruction),
  ].join("\n"));
  if (explicitBranchPlan.requirements.length > 0) {
    for (const requirement of explicitBranchPlan.requirements) {
      const index = Math.min(requirement.branchIndex ?? requirement.ordinalIndex, branches.length - 1);
      if (index >= 0 && branches[index]) {
        branches[index] = specializeBranchInstruction(branches[index], requirement, explicitBranchPlan.globalContext);
      }
    }
    patches.push("explicit_branch_requirements");
  }
  if (requiresImageArtifact(objective) && !branches.some((branch) => branchMentionsImageArtifact(branch))) {
    const index = preferredDeliverableBranchIndex(branches, ["analysis", "compute", "plot", "visual", "artifact"]);
    branches[index] = appendBranchInstruction(
      branches[index],
      "This branch is responsible for the requested image/plot deliverable. It should use sandbox run_python when appropriate, create a recoverable image artifact, and verify the artifact before finalizing.",
    );
    patches.push("image_plot_deliverable");
  }
  if (requiresReportArtifact(objective) && !branches.some((branch) => branchMentionsReportArtifact(branch))) {
    const index = preferredDeliverableBranchIndex(branches, ["report", "artifact", "analysis", "synthesis"]);
    branches[index] = appendBranchInstruction(
      branches[index],
      "This branch is responsible for the requested report deliverable. It should create durable Markdown/HTML artifacts when enough observations exist and include provenance in the final answer.",
    );
    patches.push("report_deliverable");
  }
  if (patches.length === 0) {
    return plan;
  }
  return {
    ...plan,
    reason: `${plan.reason} Runtime added branch coverage requirements for explicit user deliverables: ${patches.join(", ")}.`,
    branches,
  };
}

function extractExplicitBranchPlan(objective: string) {
  const requirements: ExplicitBranchRequirement[] = [];
  const globalLines: string[] = [];
  const seenRequirements = new Set<string>();
  const seenGlobalLines = new Set<string>();
  const lines = objective
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(?:[-*]\s*)?(?:分支|branch)\s*([A-Za-z一二三四五六七八九十0-9]+)\s*[：:]\s*(.+)$/i);
    if (!match) {
      const globalLine = sanitizeExplicitBranchGlobalLine(line);
      if (globalLine && !seenGlobalLines.has(globalLine)) {
        seenGlobalLines.add(globalLine);
        globalLines.push(globalLine);
      }
      continue;
    }
    const label = match[1].trim();
    const text = match[2].trim();
    if (!text) {
      continue;
    }
    const requirementKey = `${label.toUpperCase()}:${text}`;
    if (seenRequirements.has(requirementKey)) {
      continue;
    }
    seenRequirements.add(requirementKey);
    requirements.push({
      label,
      text,
      branchIndex: branchLabelToIndex(label),
      ordinalIndex: requirements.length,
    });
  }
  return {
    requirements,
    globalContext: globalLines.join("\n"),
  };
}

function sanitizeExplicitBranchGlobalLine(line: string) {
  const sanitized = line.replace(/\s+(?:for|针对|关于)[：:]\s+.*$/i, "").trim();
  if (
    /^(Gather task-specific|Analyze trade-offs|Design checks|Identify the strongest|Execute the .+ branch)/i.test(
      sanitized,
    )
  ) {
    return "";
  }
  return sanitized;
}

type ExplicitBranchRequirement = {
  label: string;
  text: string;
  branchIndex?: number;
  ordinalIndex: number;
};

function branchLabelToIndex(label: string) {
  const normalized = label.trim().toUpperCase();
  if (/^[A-Z]$/.test(normalized)) {
    return normalized.charCodeAt(0) - "A".charCodeAt(0);
  }
  if (/^\d+$/.test(normalized)) {
    return Math.max(0, Number.parseInt(normalized, 10) - 1);
  }
  const chineseOrdinals: Record<string, number> = {
    一: 0,
    二: 1,
    三: 2,
    四: 3,
    五: 4,
    六: 5,
    七: 6,
    八: 7,
    九: 8,
    十: 9,
  };
  return chineseOrdinals[normalized];
}

function specializeBranchInstruction(
  branch: SwarmBranch,
  requirement: ExplicitBranchRequirement,
  globalContext: string,
): SwarmBranch {
  const instructionParts = [
    `Branch-specific explicit requirement (${requirement.label}): ${requirement.text}`,
    globalContext ? `Global swarm constraints:\n${globalContext}` : "",
    `Original planner role context: ${summarizePlannerInstruction(branch.instruction)}`,
  ].filter(Boolean);
  return {
    ...branch,
    instruction: instructionParts.join("\n\n"),
  };
}

function summarizePlannerInstruction(instruction: string) {
  const normalized = instruction
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const roleOnly = normalized.replace(/\s+(?:for|针对|关于)[：:]\s+.*$/i, "").trim();
  return (roleOnly || normalized).slice(0, 360);
}

function appendBranchInstruction(branch: SwarmBranch, addition: string): SwarmBranch {
  if (branch.instruction.includes(addition)) {
    return branch;
  }
  return {
    ...branch,
    instruction: `${branch.instruction}\n\nBranch coverage requirement: ${addition}`,
  };
}

function preferredDeliverableBranchIndex(branches: SwarmBranch[], preferredTerms: string[]) {
  const index = branches.findIndex((branch) => {
    const text = `${branch.id} ${branch.title} ${branch.instruction}`.toLowerCase();
    return preferredTerms.some((term) => text.includes(term));
  });
  return index >= 0 ? index : Math.min(1, Math.max(0, branches.length - 1));
}

function requiresImageArtifact(objective: string) {
  return /绘制|画图|图片|图像|可视化|plot|chart|image|figure|graph|sin\(x\)|f\s*=\s*sin/i.test(objective);
}

function branchMentionsImageArtifact(branch: SwarmBranch) {
  return /run_python|绘制|画图|图片|图像|可视化|plot|chart|image|figure|graph|sin\(x\)|f\s*=\s*sin/i.test(
    `${branch.title}\n${branch.instruction}`,
  );
}

function requiresReportArtifact(objective: string) {
  return /报告|markdown|html|artifact|产物|deliverable|report/i.test(objective);
}

function branchMentionsReportArtifact(branch: SwarmBranch) {
  return /create_artifact|报告|markdown|html|artifact|产物|deliverable|report/i.test(`${branch.title}\n${branch.instruction}`);
}

function buildRoleBranches(action: SpawnSwarmAction): SwarmBranch[] {
  const requestedCount = normalizeBranchCount(action.branchCount ?? action.branchRoles?.length ?? 0);
  if (requestedCount === 0) {
    return [];
  }
  const roles = action.branchRoles?.length ? action.branchRoles : [];
  return Array.from({ length: requestedCount }, (_, index) => {
    const role = roles[index] ?? `branch-${index + 1}`;
    return normalizeBranchDefinition(
      {
        title: `${titleCase(role)} Branch`,
        instruction: `Execute the ${role} branch for: ${action.objective}`,
        modelProfile: index % 2 === 0 ? "deepseek:deepseek-v4-pro" : "deepseek:deepseek-v4-flash",
      },
      index,
      action.objective,
      role,
    );
  });
}

function normalizeBranchDefinition(
  branch: SwarmActionBranchDefinition,
  index: number,
  objective: string,
  roleHint?: string,
): SwarmBranch {
  const title = (branch.title || roleHint || `Branch ${index + 1}`).trim();
  const instruction = (branch.instruction || objective).trim();
  return {
    id: normalizeBranchId(branch.id || roleHint || title, index),
    title,
    instruction,
    modelProfile: normalizeBranchModelProfile(branch.modelProfile, index),
  };
}

function normalizeBranchCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(SWARM_BRANCH_LIMIT, Math.floor(value)));
}

function normalizeBranchId(value: string | undefined, index: number) {
  const base = String(value ?? `branch-${index + 1}`)
    .toLowerCase()
    .replace(/\bbranch\b/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `branch_${base || index + 1}`;
}

function ensureUniqueBranchIds(branches: SwarmBranch[]) {
  const seen = new Map<string, number>();
  return branches.map((branch) => {
    const count = seen.get(branch.id) ?? 0;
    seen.set(branch.id, count + 1);
    if (count === 0) {
      return branch;
    }
    return {
      ...branch,
      id: `${branch.id}_${count + 1}`,
    };
  });
}

function normalizeBranchModelProfile(
  value: string | undefined,
  index: number,
): "deepseek:deepseek-v4-pro" | "deepseek:deepseek-v4-flash" {
  if (value === "deepseek:deepseek-v4-pro" || value === "deepseek:deepseek-v4-flash") {
    return value;
  }
  return index % 2 === 0 ? "deepseek:deepseek-v4-pro" : "deepseek:deepseek-v4-flash";
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export async function executeSwarm(input: {
  runId: string;
  taskId: string;
  conversationId: string;
  parentAgentSessionId: string;
  parentTraceId: string;
  parentSpanId: string;
  actionId: string;
  objective: string;
  action?: SpawnAgentAction | SpawnSwarmAction;
  reviewer?: {
    provider: ModelProvider;
    profile: ModelProfile;
  };
}): Promise<SwarmExecutionResult> {
  await assertSwarmRunNotCancelled(input.runId);
  const plan = buildSwarmPlan(input.objective, input.action);
  const concurrency = buildSwarmConcurrencyPolicy({
    objective: input.objective,
    action: input.action,
    plan,
  });
  const swarmSpan = await startTraceSpan({
    traceId: input.parentTraceId,
    parentSpanId: input.parentSpanId,
    runId: input.runId,
    agentSessionId: input.parentAgentSessionId,
    spanKind: "swarm.plan",
    name: "Swarm branch plan",
    attributes: {
      strategy: plan.strategy,
      branch_count: plan.branches.length,
      requested_branch_count: concurrency.requestedBranchCount,
      plan_source: plan.planSource,
      max_concurrency: concurrency.maxConcurrency,
      effective_concurrency: concurrency.effectiveConcurrency,
      execution_mode: concurrency.executionMode,
      batch_count: concurrency.batchCount,
      explicit_parallel_request: concurrency.explicitParallelRequest,
      configured_max_concurrency: concurrency.configuredMaxConcurrency,
    },
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.plan",
    producer: { kind: "orchestrator", id: input.parentAgentSessionId, name: "Orchestrator" },
    trace: {
      trace_id: input.parentTraceId,
      span_id: swarmSpan.id,
      parent_span_id: input.parentSpanId,
    },
    payload: {
      strategy: plan.strategy,
      reason: plan.reason,
      plan_source: plan.planSource,
      requested_branch_count: concurrency.requestedBranchCount,
      branch_count: plan.branches.length,
      max_concurrency: concurrency.maxConcurrency,
      effective_concurrency: concurrency.effectiveConcurrency,
      execution_mode: concurrency.executionMode,
      batch_count: concurrency.batchCount,
      explicit_parallel_request: concurrency.explicitParallelRequest,
      configured_max_concurrency: concurrency.configuredMaxConcurrency,
      branches: plan.branches.map((branch) => ({
        branch_id: branch.id,
        title: branch.title,
        instruction: branch.instruction,
        model_profile: branch.modelProfile,
      })),
    },
  });

  const provider = createSandboxProvider();
  const branchRecords: BranchExecutionRecord[] = [];

  try {
    await executeSwarmBranchesConcurrently({
      ...input,
      plan,
      provider,
      parentSwarmSpanId: swarmSpan.id,
      concurrency,
      onRecord: (record) => branchRecords.push(record),
    });
  } catch (error) {
    if (isSwarmRunCancelledError(error)) {
      const partial = aggregateBranchRecords(plan, branchRecords);
      const cancelledSummary = `Swarm cancelled after ${partial.completedBranches}/${plan.branches.length} completed branches and ${partial.failedBranches} failed branches.`;
      await publishRunEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        type: "swarm.cancelled",
        producer: { kind: "orchestrator", id: input.parentAgentSessionId, name: "Orchestrator" },
        trace: {
          trace_id: input.parentTraceId,
          span_id: swarmSpan.id,
          parent_span_id: input.parentSpanId,
        },
        payload: {
          status: "cancelled",
          strategy: plan.strategy,
          plan_source: plan.planSource,
          branch_count: plan.branches.length,
          requested_branch_count: concurrency.requestedBranchCount,
          max_concurrency: concurrency.maxConcurrency,
          effective_concurrency: concurrency.effectiveConcurrency,
          execution_mode: concurrency.executionMode,
          batch_count: concurrency.batchCount,
          completed_branch_count: partial.completedBranches,
          failed_branch_count: partial.failedBranches,
          artifact_ids: partial.artifactIds,
          summary: cancelledSummary,
        },
      });
      await completeTraceSpan(swarmSpan.id, "cancelled", {
        branch_count: plan.branches.length,
        plan_source: plan.planSource,
        max_concurrency: concurrency.maxConcurrency,
        effective_concurrency: concurrency.effectiveConcurrency,
        completed_branch_count: partial.completedBranches,
        failed_branch_count: partial.failedBranches,
        artifact_ids: partial.artifactIds,
        branch_observation_ids: partial.branchObservationIds,
        output_summary: cancelledSummary,
      });
    }
    throw error;
  }

  const {
    observations,
    artifactIds,
    branchObservationIds,
    completedBranches,
    failedBranches,
    branchQualitySignals,
    branchArtifacts,
    branchContracts,
    branchFinals,
  } = aggregateBranchRecords(plan, branchRecords);

  const reduceSpan = await startTraceSpan({
    traceId: input.parentTraceId,
    parentSpanId: swarmSpan.id,
    runId: input.runId,
    agentSessionId: input.parentAgentSessionId,
    spanKind: "swarm.reduce",
    name: "Reduce swarm branch evidence",
    attributes: {
      branch_count: plan.branches.length,
      max_concurrency: concurrency.maxConcurrency,
      effective_concurrency: concurrency.effectiveConcurrency,
      batch_count: concurrency.batchCount,
    },
  });
  const reduction = buildSwarmReduction({
    plan,
    completedBranches,
    failedBranches,
    artifactIds,
    branchObservationIds,
    observations,
    branchFinals,
  });
  const reducerInputCoverage = {
    branchCount: plan.branches.length,
    completedBranchCount: completedBranches,
    failedBranchCount: failedBranches,
    branchContractCount: branchContracts.length,
    branchFinalCount: branchFinals.length,
    branchObservationIdCount: branchObservationIds.length,
    artifactCount: artifactIds.length,
    branchQualitySignalCount: branchQualitySignals.length,
    branchArtifactCount: branchArtifacts.length,
    branchItemCount: reduction.branchItems.length,
    branchItemsWithObservationEvidence: reduction.branchItems.filter((item) => item.evidenceObservationIds.length > 0).length,
    branchItemsWithArtifactEvidence: reduction.branchItems.filter((item) => item.artifactIds.length > 0).length,
    allCompletedBranchesHaveFinals: completedBranches === 0 || branchFinals.length >= completedBranches,
    allCompletedBranchesHaveObservations: completedBranches === 0 || branchObservationIds.length >= completedBranches,
    reducerUsesBranchFinals: branchFinals.length > 0,
  };

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.reduce",
    producer: { kind: "orchestrator", id: input.parentAgentSessionId, name: "Orchestrator" },
    trace: {
      trace_id: input.parentTraceId,
      span_id: reduceSpan.id,
      parent_span_id: swarmSpan.id,
    },
    payload: {
      status: reduction.status,
      strategy: plan.strategy,
      plan_source: plan.planSource,
      reducer_mode: reduction.reducerMode,
      assisted_by: reduction.assistedBy,
      branch_count: plan.branches.length,
      max_concurrency: concurrency.maxConcurrency,
      effective_concurrency: concurrency.effectiveConcurrency,
      execution_mode: concurrency.executionMode,
      batch_count: concurrency.batchCount,
      completed_branch_count: completedBranches,
      failed_branch_count: failedBranches,
      artifact_ids: artifactIds,
      branch_observation_ids: branchObservationIds,
      reducer_input_coverage: reducerInputCoverage,
      branch_items: reduction.branchItems,
      conflict_signals: reduction.conflictSignals,
      recommendations: reduction.recommendations,
      summary: reduction.summary,
    },
  });

  await completeTraceSpan(reduceSpan.id, reduction.status === "failed" ? "failed" : "completed", {
    status: reduction.status,
    reducer_mode: reduction.reducerMode,
    reducer_input_coverage: reducerInputCoverage,
    artifact_ids: artifactIds,
    branch_observation_ids: branchObservationIds,
    conflict_signal_count: reduction.conflictSignals.length,
    output_summary: reduction.summary,
  });

  const mergeSpan = await startTraceSpan({
    traceId: input.parentTraceId,
    parentSpanId: reduceSpan.id,
    runId: input.runId,
    agentSessionId: input.parentAgentSessionId,
    spanKind: "swarm.merge",
    name: "Merge swarm branch results",
    attributes: {
      branch_count: plan.branches.length,
      max_concurrency: concurrency.maxConcurrency,
      effective_concurrency: concurrency.effectiveConcurrency,
      batch_count: concurrency.batchCount,
    },
  });
  const mergeSummary = formatSwarmReductionEvidence(reduction);
  const finalHtmlArtifact = await createSwarmFinalHtmlArtifact({
    conversationId: input.conversationId,
    runId: input.runId,
    parentAgentSessionId: input.parentAgentSessionId,
    traceSpanId: mergeSpan.id,
    plan,
    reduction,
    branchObservationIds,
    artifactIds,
  });
  const mergedArtifactIds = uniqueStrings([...artifactIds, finalHtmlArtifact.id]);
  const verificationArtifacts = [
    ...branchArtifacts,
    {
      id: finalHtmlArtifact.id,
      type: finalHtmlArtifact.type,
      title: finalHtmlArtifact.title,
      mimeType: finalHtmlArtifact.mimeType ?? undefined,
      artifactKind: "final_html_report",
      sourceObservationIds: branchObservationIds,
      sourceArtifactIds: artifactIds,
      qualitySignals: {
        substanceStatus: "substantive",
        deliverableEligible: true,
      },
    },
  ];
  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.final_artifact.created",
    producer: { kind: "orchestrator", id: input.parentAgentSessionId, name: "Orchestrator" },
    trace: {
      trace_id: input.parentTraceId,
      span_id: mergeSpan.id,
      parent_span_id: reduceSpan.id,
    },
    payload: {
      artifact_id: finalHtmlArtifact.id,
      artifact_type: finalHtmlArtifact.type,
      mime_type: finalHtmlArtifact.mimeType,
      title: finalHtmlArtifact.title,
      storage_uri: finalHtmlArtifact.storageUri,
      preview_uri: finalHtmlArtifact.previewUri,
      source_observation_ids: branchObservationIds,
      source_artifact_ids: artifactIds,
      artifact_kind: "final_html_report",
    },
  });
  const eventEvidence = await loadSwarmEventEvidence(input.runId);
  const verification = buildSwarmVerification({
    plan,
    completedBranches,
    failedBranches,
    artifactIds: mergedArtifactIds,
    branchObservationIds,
    observations,
    branchQualitySignals,
    branchArtifacts: verificationArtifacts,
    branchContracts,
    branchFinals,
    eventEvidence,
  });
  const verificationGateCoverage = buildSwarmVerificationGateCoverage(verification.checks);

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.merge",
    producer: { kind: "orchestrator", id: input.parentAgentSessionId, name: "Orchestrator" },
    trace: {
      trace_id: input.parentTraceId,
      span_id: mergeSpan.id,
      parent_span_id: swarmSpan.id,
    },
    payload: {
      status: "completed",
      strategy: plan.strategy,
      plan_source: plan.planSource,
      branch_count: plan.branches.length,
      max_concurrency: concurrency.maxConcurrency,
      effective_concurrency: concurrency.effectiveConcurrency,
      execution_mode: concurrency.executionMode,
      batch_count: concurrency.batchCount,
      completed_branch_count: completedBranches,
      failed_branch_count: failedBranches,
      reduction_status: reduction.status,
      reducer_mode: reduction.reducerMode,
      reduction_summary: reduction.summary,
      artifact_ids: mergedArtifactIds,
      final_html_artifact_id: finalHtmlArtifact.id,
      branch_observation_ids: branchObservationIds,
      event_evidence: eventEvidence,
      summary: mergeSummary,
    },
  });

  await completeTraceSpan(mergeSpan.id, "completed", {
    artifact_ids: mergedArtifactIds,
    final_html_artifact_id: finalHtmlArtifact.id,
    plan_source: plan.planSource,
    output_summary: mergeSummary,
    event_evidence: eventEvidence,
  });

  const verifySpan = await startTraceSpan({
    traceId: input.parentTraceId,
    parentSpanId: mergeSpan.id,
    runId: input.runId,
    agentSessionId: input.parentAgentSessionId,
    spanKind: "swarm.verify",
    name: "Verify swarm branch results",
    attributes: {
      status: verification.status,
      check_count: verification.checks.length,
      branch_count: plan.branches.length,
      effective_concurrency: concurrency.effectiveConcurrency,
      branch_observation_count: branchObservationIds.length,
      gate_coverage: verificationGateCoverage,
      capability_invoke_completed_count: eventEvidence.capabilityInvokeCompletedCount,
      sandbox_tool_proxy_completed_count: eventEvidence.sandboxToolProxyCompletedCount,
      successful_tool_call_count: eventEvidence.successfulToolCallCount,
    },
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.verify",
    producer: { kind: "orchestrator", id: input.parentAgentSessionId, name: "Orchestrator" },
    trace: {
      trace_id: input.parentTraceId,
      span_id: verifySpan.id,
      parent_span_id: mergeSpan.id,
    },
    payload: {
      status: verification.status,
      strategy: plan.strategy,
      plan_source: plan.planSource,
      branch_count: plan.branches.length,
      max_concurrency: concurrency.maxConcurrency,
      effective_concurrency: concurrency.effectiveConcurrency,
      execution_mode: concurrency.executionMode,
      batch_count: concurrency.batchCount,
      completed_branch_count: completedBranches,
      failed_branch_count: failedBranches,
      artifact_ids: mergedArtifactIds,
      final_html_artifact_id: finalHtmlArtifact.id,
      branch_observation_ids: branchObservationIds,
      event_evidence: eventEvidence,
      gate_coverage: verificationGateCoverage,
      checks: verification.checks,
      summary: verification.summary,
    },
  });

  await completeTraceSpan(verifySpan.id, verification.status === "failed" ? "failed" : "completed", {
    status: verification.status,
    check_count: verification.checks.length,
    plan_source: plan.planSource,
    gate_coverage: verificationGateCoverage,
    output_summary: verification.summary,
    event_evidence: eventEvidence,
  });

  const reviewSpan = await startTraceSpan({
    traceId: input.parentTraceId,
    parentSpanId: verifySpan.id,
    runId: input.runId,
    agentSessionId: input.parentAgentSessionId,
    spanKind: "swarm.review",
    name: "Review swarm reducer and verifier output",
    attributes: {
      branch_count: plan.branches.length,
      effective_concurrency: concurrency.effectiveConcurrency,
      branch_observation_count: branchObservationIds.length,
    },
  });
  const review = await reviewSwarmResult({
    plan,
    reduction,
    verification,
    completedBranches,
    failedBranches,
    artifactIds: mergedArtifactIds,
    branchObservationIds,
    observations,
    provider: input.reviewer?.provider,
    profile: input.reviewer?.profile,
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.review",
    producer: { kind: "orchestrator", id: input.parentAgentSessionId, name: "Orchestrator" },
    trace: {
      trace_id: input.parentTraceId,
      span_id: reviewSpan.id,
      parent_span_id: verifySpan.id,
    },
    payload: {
      status: review.status,
      review_mode: review.reviewMode,
      model_profile: review.modelProfile,
      confidence: review.confidence,
      strategy: plan.strategy,
      plan_source: plan.planSource,
      branch_count: plan.branches.length,
      max_concurrency: concurrency.maxConcurrency,
      effective_concurrency: concurrency.effectiveConcurrency,
      execution_mode: concurrency.executionMode,
      batch_count: concurrency.batchCount,
      completed_branch_count: completedBranches,
      failed_branch_count: failedBranches,
      artifact_ids: mergedArtifactIds,
      final_html_artifact_id: finalHtmlArtifact.id,
      branch_observation_ids: branchObservationIds,
      finding_count: review.findings.length,
      findings: review.findings,
      recommendations: review.recommendations,
      required_follow_up: review.requiredFollowUp,
      summary: review.summary,
    },
  });

  await completeTraceSpan(reviewSpan.id, review.status === "failed" ? "failed" : "completed", {
    status: review.status,
    review_mode: review.reviewMode,
    model_profile: review.modelProfile,
    finding_count: review.findings.length,
    required_follow_up: review.requiredFollowUp,
    output_summary: review.summary,
  });

  await completeTraceSpan(swarmSpan.id, "completed", {
    branch_count: plan.branches.length,
    plan_source: plan.planSource,
    max_concurrency: concurrency.maxConcurrency,
    effective_concurrency: concurrency.effectiveConcurrency,
    execution_mode: concurrency.executionMode,
    batch_count: concurrency.batchCount,
    completed_branch_count: completedBranches,
    failed_branch_count: failedBranches,
    artifact_ids: mergedArtifactIds,
    final_html_artifact_id: finalHtmlArtifact.id,
    branch_observation_ids: branchObservationIds,
    verification_status: verification.status,
  });

  return {
    plan,
    observations: [
      `Swarm reduction (${reduction.status}): ${reduction.summary}`,
      `Swarm merge: ${mergeSummary}`,
      `Swarm verification (${verification.status}): ${verification.summary}`,
      `Swarm review (${review.status}/${review.reviewMode}): ${review.summary}`,
    ],
    artifactIds: mergedArtifactIds,
    branchObservationIds,
    reduction,
    verification,
    review,
  };
}

async function createSwarmFinalHtmlArtifact(input: {
  conversationId: string;
  runId: string;
  parentAgentSessionId: string;
  traceSpanId: string;
  plan: SwarmPlan;
  reduction: SwarmReductionResult;
  branchObservationIds: string[];
  artifactIds: string[];
}) {
  const html = buildSwarmFinalHtmlReport(input.plan, input.reduction, input.branchObservationIds, input.artifactIds);
  return createTextArtifact({
    conversationId: input.conversationId,
    runId: input.runId,
    producerAgentSessionId: input.parentAgentSessionId,
    type: "html",
    title: "DataSwarm Final HTML Report",
    content: html,
    sourceTraceId: input.traceSpanId,
    metadata: {
      artifactKind: "final_html_report",
      generatedBy: "swarm.merge",
      sourceObservationIds: input.branchObservationIds,
      sourceArtifactIds: input.artifactIds,
      branchIds: input.plan.branches.map((branch) => branch.id),
      qualitySignals: {
        substanceStatus: "substantive",
        deliverableEligible: true,
        branchItemCount: input.reduction.branchItems.length,
        sourceObservationCount: input.branchObservationIds.length,
        sourceArtifactCount: input.artifactIds.length,
      },
    },
  });
}

function buildSwarmFinalHtmlReport(
  plan: SwarmPlan,
  reduction: SwarmReductionResult,
  branchObservationIds: string[],
  artifactIds: string[],
) {
  const branchSections = reduction.branchItems
    .map((item) => {
      const claims = item.claims.length
        ? `<ul>${item.claims.map((claim) => `<li>${escapeHtmlLocal(claim.claim)} <span class="muted">(${escapeHtmlLocal(claim.confidence)})</span></li>`).join("")}</ul>`
        : `<p class="muted">No structured claims were provided by this branch.</p>`;
      const sections = item.sections.length
        ? item.sections
            .map((section) => `<h4>${escapeHtmlLocal(section.title)}</h4><p>${escapeHtmlLocal(section.content)}</p>`)
            .join("")
        : `<p>${escapeHtmlLocal(item.summary)}</p>`;
      return `
        <section>
          <h3>${escapeHtmlLocal(item.title)}</h3>
          <p class="status">Status: ${escapeHtmlLocal(item.status)}</p>
          ${sections}
          <h4>Claims</h4>
          ${claims}
          <p class="muted">Observation IDs: ${escapeHtmlLocal(item.evidenceObservationIds.join(", ") || "none")}</p>
          <p class="muted">Artifact IDs: ${escapeHtmlLocal(item.artifactIds.join(", ") || "none")}</p>
        </section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>DataSwarm Final HTML Report</title>
    <style>
      body { margin: 0; font-family: ui-serif, Georgia, serif; background: #f6f2ea; color: #1f2933; }
      main { max-width: 1080px; margin: 0 auto; padding: 48px 24px 72px; }
      header { border-bottom: 2px solid #1f2933; padding-bottom: 24px; margin-bottom: 28px; }
      h1 { font-size: 42px; line-height: 1.05; margin: 0 0 12px; }
      h2 { margin-top: 36px; }
      section { background: #fffdf8; border: 1px solid #d6c7aa; border-radius: 18px; padding: 22px; margin: 18px 0; box-shadow: 0 10px 30px rgba(44, 36, 22, 0.06); }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
      .card { background: #efe7d6; border-radius: 14px; padding: 14px 16px; }
      .metric { font-size: 28px; font-weight: 700; }
      .muted { color: #647067; font-size: 14px; }
      .status { font-weight: 700; color: #7a4f12; }
      li { margin: 7px 0; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="muted">Generated by DataSwarm swarm.merge from BranchFinal, Observation, and Artifact evidence.</p>
        <h1>DataSwarm Final HTML Report</h1>
        <p>${escapeHtmlLocal(reduction.summary)}</p>
      </header>
      <div class="grid">
        <div class="card"><div class="metric">${plan.branches.length}</div><div class="muted">planned branches</div></div>
        <div class="card"><div class="metric">${reduction.coverage.completedBranches}</div><div class="muted">completed branches</div></div>
        <div class="card"><div class="metric">${branchObservationIds.length}</div><div class="muted">branch observations</div></div>
        <div class="card"><div class="metric">${artifactIds.length}</div><div class="muted">source artifacts</div></div>
      </div>
      <h2>Branch Evidence</h2>
      ${branchSections || "<section><p>No branch evidence was available.</p></section>"}
      <h2>Reducer Recommendations</h2>
      <section><ul>${reduction.recommendations.map((item) => `<li>${escapeHtmlLocal(item)}</li>`).join("") || "<li>No reducer recommendations.</li>"}</ul></section>
      <h2>Evidence Index</h2>
      <section>
        <p><strong>Observation IDs:</strong> ${escapeHtmlLocal(branchObservationIds.join(", ") || "none")}</p>
        <p><strong>Artifact IDs:</strong> ${escapeHtmlLocal(artifactIds.join(", ") || "none")}</p>
      </section>
    </main>
  </body>
</html>`;
}

function escapeHtmlLocal(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSwarmConcurrencyPolicy(input: {
  objective: string;
  action?: SpawnAgentAction | SpawnSwarmAction;
  plan: SwarmPlan;
}): SwarmConcurrencyPolicy {
  const requestedBranchCount = getRequestedBranchCount(input.action, input.plan);
  const configuredMaxConcurrency = parseConfiguredSwarmMaxConcurrency();
  const explicitParallelRequest = hasExplicitTenWayParallelRequest(input.objective, input.action);
  const maxConcurrency = configuredMaxConcurrency ?? (explicitParallelRequest ? SWARM_BRANCH_LIMIT : DEFAULT_SWARM_MAX_CONCURRENCY);
  const effectiveConcurrency = Math.max(1, Math.min(input.plan.branches.length || 1, maxConcurrency));
  const batchCount = input.plan.branches.length === 0 ? 0 : Math.ceil(input.plan.branches.length / effectiveConcurrency);
  const executionMode =
    input.plan.branches.length <= 1
      ? "single_branch"
      : effectiveConcurrency >= input.plan.branches.length
        ? "parallel"
        : "batched_parallel";
  return {
    requestedBranchCount,
    maxConcurrency,
    effectiveConcurrency,
    batchCount,
    executionMode,
    explicitParallelRequest,
    configuredMaxConcurrency,
  };
}

function getRequestedBranchCount(action: SpawnAgentAction | SpawnSwarmAction | undefined, plan: SwarmPlan) {
  if (action?.type === "spawn_swarm") {
    return normalizeBranchCount(action.branchCount ?? action.branches?.length ?? plan.branches.length);
  }
  if (action?.type === "spawn_agent") {
    return normalizeBranchCount(action.branches?.length ?? 1);
  }
  return plan.branches.length;
}

function parseConfiguredSwarmMaxConcurrency() {
  const raw = process.env.DATASWARM_SWARM_MAX_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SWARM_MAX_CONCURRENCY;
  }
  return Math.max(1, Math.min(SWARM_BRANCH_LIMIT, parsed));
}

function hasExplicitTenWayParallelRequest(objective: string, action?: SpawnAgentAction | SpawnSwarmAction) {
  const actionCount = action?.type === "spawn_swarm" ? action.branchCount : undefined;
  if (actionCount && actionCount >= SWARM_BRANCH_LIMIT) {
    return /\bparallel\b|并行|并发|多个沙箱|沙箱/i.test(objective);
  }
  return /(?:启动|使用|开启|创建|run|start|launch).{0,24}(?:10|十).{0,24}(?:并行|并发|沙箱|sandbox|branch)|(?:10|十).{0,24}(?:并行|并发|parallel).{0,24}(?:沙箱|sandbox|branch)/i.test(
    objective,
  );
}

async function executeSwarmBranchesConcurrently(input: {
  runId: string;
  taskId: string;
  conversationId: string;
  parentAgentSessionId: string;
  parentTraceId: string;
  parentSwarmSpanId: string;
  actionId: string;
  objective: string;
  plan: SwarmPlan;
  provider: SandboxProvider;
  concurrency: SwarmConcurrencyPolicy;
  onRecord: (record: BranchExecutionRecord) => void;
}) {
  let nextBranchIndex = 0;
  let launchOrder = 0;
  let cancelRequested = false;

  const workers = Array.from({ length: input.concurrency.effectiveConcurrency }, async (_, workerIndex) => {
    while (true) {
      if (cancelRequested) {
        return;
      }
      const branchIndex = nextBranchIndex;
      nextBranchIndex += 1;
      if (branchIndex >= input.plan.branches.length) {
        return;
      }

      try {
        await assertSwarmRunNotCancelled(input.runId);
      } catch (error) {
        if (isSwarmRunCancelledError(error)) {
          cancelRequested = true;
          return;
        }
        throw error;
      }

      const order = launchOrder;
      launchOrder += 1;
      const record = await executeSwarmBranch({
        ...input,
        branch: input.plan.branches[branchIndex],
        launch: {
          branchIndex,
          launchOrder: order,
          batchIndex: Math.floor(order / input.concurrency.effectiveConcurrency),
          concurrencySlot: workerIndex + 1,
          effectiveConcurrency: input.concurrency.effectiveConcurrency,
          queuedAt: new Date().toISOString(),
        },
      });
      input.onRecord(record);
    }
  });

  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) {
    throw rejected.reason;
  }
  if (cancelRequested) {
    throw new SwarmRunCancelledError(input.runId);
  }
}

async function executeSwarmBranch(input: {
  runId: string;
  taskId: string;
  conversationId: string;
  parentAgentSessionId: string;
  parentTraceId: string;
  parentSwarmSpanId: string;
  actionId: string;
  objective: string;
  plan: SwarmPlan;
  branch: SwarmBranch;
  provider: SandboxProvider;
  concurrency: SwarmConcurrencyPolicy;
  launch: BranchLaunchMetadata;
}): Promise<BranchExecutionRecord> {
  const { branch, launch } = input;
  const branchContract = branch.contract ?? buildBranchContract(input.objective, branch);
  const branchAgent = await createAgentSession({
    runId: input.runId,
    role: "swarm_branch",
    name: branch.title,
    modelProfile: branch.modelProfile,
    parentAgentSessionId: input.parentAgentSessionId,
    metadata: {
      branch_id: branch.id,
      branch_index: launch.branchIndex,
      launch_order: launch.launchOrder,
      batch_index: launch.batchIndex,
      concurrency_slot: launch.concurrencySlot,
      effective_concurrency: launch.effectiveConcurrency,
      branch_contract: branchContract,
    },
  });
  await updateAgentSessionStatus(branchAgent.id, "running");

  const branchSpan = await startTraceSpan({
    traceId: input.parentTraceId,
    parentSpanId: input.parentSwarmSpanId,
    runId: input.runId,
    agentSessionId: branchAgent.id,
    spanKind: "swarm.branch",
    name: branch.title,
    attributes: {
      branch_id: branch.id,
      branch_index: launch.branchIndex,
      launch_order: launch.launchOrder,
      batch_index: launch.batchIndex,
      concurrency_slot: launch.concurrencySlot,
      effective_concurrency: launch.effectiveConcurrency,
      model_profile: branch.modelProfile,
      branch_contract: branchContract,
    },
  });

  const branchForSandbox = { ...branch, contract: branchContract };
  const contextBundleContent = JSON.stringify(
    {
      objective: input.objective,
      branch: branchForSandbox,
      branch_contract: branchContract,
      parent_agent_session_id: input.parentAgentSessionId,
      trace_id: input.parentTraceId,
    },
    null,
    2,
  );
  const bundle = await createContextBundle({
    runId: input.runId,
    agentSessionId: branchAgent.id,
    branchId: branch.id,
    content: contextBundleContent,
    sourceRefs: [{ type: "user_message", summary: input.objective.slice(0, 240) }],
    metadata: { branch_id: branch.id, branch_contract: branchContract },
  });

  const sandbox = await createSandboxSession({
    runId: input.runId,
    agentSessionId: branchAgent.id,
    provider: sandboxProviderSelection(),
    template: "dataswarm-agent-runtime",
    resourceLimits: { cpu: 1, memory_mb: 1024, timeout_seconds: 120 },
    envPolicy: { allow_secret_env: false, allow_network: false },
    metadata: {
      branch_id: branch.id,
      branch_index: launch.branchIndex,
      launch_order: launch.launchOrder,
      batch_index: launch.batchIndex,
      concurrency_slot: launch.concurrencySlot,
      effective_concurrency: launch.effectiveConcurrency,
      context_bundle_id: bundle.id,
      branch_contract: branchContract,
    },
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.branch.contract.materialized",
    producer: { kind: "agent", id: branchAgent.id, name: branch.title },
    trace: {
      trace_id: input.parentTraceId,
      span_id: branchSpan.id,
      parent_span_id: input.parentSwarmSpanId,
    },
    payload: {
      branch_id: branch.id,
      branch_index: launch.branchIndex,
      launch_order: launch.launchOrder,
      batch_index: launch.batchIndex,
      concurrency_slot: launch.concurrencySlot,
      effective_concurrency: launch.effectiveConcurrency,
      agent_session_id: branchAgent.id,
      sandbox_session_id: sandbox.id,
      context_bundle_id: bundle.id,
      title: branchContract.title,
      role: branchContract.role,
      required_tool_count: branchContract.requiredTools.length,
      required_artifact_count: branchContract.requiredArtifacts.length,
      required_question_count: branchContract.requiredQuestions.length,
      minimum_real_model_actions: branchContract.minimumRealModelActions,
      minimum_evidence: branchContract.minimumEvidence,
      final_output_schema: branchContract.finalOutputSchema,
      fallback_policy: branchContract.fallbackPolicy,
      branch_contract: branchContract,
    },
  });

  const startedAt = new Date().toISOString();
  const allowedTools = sandboxAllowedTools();
  const sandboxSkillManifests = await buildSandboxSkillManifests(branch);
  const agentProtocol = sandboxAgentProtocol();
  const budgets = sandboxAgentBudgets();
  const parentToolProxy = buildSandboxToolProxyConfig({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    branchId: branch.id,
    sandboxSessionId: sandbox.id,
    agentSessionId: branchAgent.id,
    traceId: input.parentTraceId,
    traceSpanId: branchSpan.id,
    allowedTools,
  });
  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.branch.started",
    producer: { kind: "agent", id: branchAgent.id, name: branch.title },
    trace: {
      trace_id: input.parentTraceId,
      span_id: branchSpan.id,
      parent_span_id: input.parentSwarmSpanId,
    },
    payload: {
      branch_id: branch.id,
      branch_index: launch.branchIndex,
      launch_order: launch.launchOrder,
      batch_index: launch.batchIndex,
      concurrency_slot: launch.concurrencySlot,
      effective_concurrency: launch.effectiveConcurrency,
      queued_at: launch.queuedAt,
      started_at: startedAt,
      agent_session_id: branchAgent.id,
      sandbox_session_id: sandbox.id,
      model_profile: branch.modelProfile,
      context_bundle_id: bundle.id,
      context_bundle_uri: bundle.storageUri,
      agent_protocol: agentProtocol,
      sandbox_budgets: budgets,
      branch_contract: branchContract,
      sandbox_tool_proxy: {
        mode: parentToolProxy.mode,
        url_configured: Boolean(parentToolProxy.url),
        allowed_tools: parentToolProxy.allowedTools,
      },
      skill_manifest_count: sandboxSkillManifests.length,
    },
  });

  const result = await input.provider
    .executeBranch({
      runId: input.runId,
      branchId: branch.id,
      sandboxSessionId: sandbox.id,
      agentSessionId: branchAgent.id,
      agentName: branch.title,
      modelProfile: branch.modelProfile,
      objective: input.objective,
      instruction: branch.instruction,
      branchContract: branchContract,
      contextBundleUri: bundle.storageUri,
      contextBundleContent,
      conversationId: input.conversationId,
      taskId: input.taskId,
      traceId: input.parentTraceId,
      traceSpanId: branchSpan.id,
      agentProtocol,
      budgets,
      toolCatalog: buildSandboxToolCatalog(),
      skillManifests: sandboxSkillManifests,
      parentToolProxy,
      artifactPolicy: {
        allowedKinds: ["markdown", "html", "json", "csv", "image"],
        maxBytes: 2_000_000,
        allowBase64: true,
      },
    })
    .catch(async (error) => {
      const normalized = normalizeBranchError(error);
      const branchObservation = await createObservation({
        runId: input.runId,
        actionId: input.actionId,
        sourceType: "agent",
        sourceName: `swarm.branch.${branch.id}`,
        status: "failed",
        summary: `${branch.title}: ${normalized.status} (${normalized.code}) ${normalized.message}`,
        evidenceLevel: branchEvidenceLevel(),
        claims: [
          {
            claim: `${branch.title} failed with ${normalized.code}.`,
            support: "direct",
            sourceRefs: [],
          },
        ],
        metadata: {
          branch_id: branch.id,
          branch_index: launch.branchIndex,
          launch_order: launch.launchOrder,
          batch_index: launch.batchIndex,
          concurrency_slot: launch.concurrencySlot,
          effective_concurrency: launch.effectiveConcurrency,
          branch_title: branch.title,
          plan_source: input.plan.planSource,
          agent_session_id: branchAgent.id,
          sandbox_session_id: sandbox.id,
          context_bundle_id: bundle.id,
          model_profile: branch.modelProfile,
          status: normalized.status,
          error_code: normalized.code,
          error: normalized.message,
          attempt_failures: normalized.attemptFailures,
        },
      });
      await publishBranchObservationEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        traceId: input.parentTraceId,
        spanId: branchSpan.id,
        parentSpanId: input.parentSwarmSpanId,
        observation: branchObservation,
      });
      const endedAt = new Date().toISOString();
      await publishRunEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        type: "swarm.branch.failed",
        producer: { kind: "agent", id: branchAgent.id, name: branch.title },
        trace: {
          trace_id: input.parentTraceId,
          span_id: branchSpan.id,
          parent_span_id: input.parentSwarmSpanId,
        },
        payload: {
          branch_id: branch.id,
          branch_index: launch.branchIndex,
          launch_order: launch.launchOrder,
          batch_index: launch.batchIndex,
          concurrency_slot: launch.concurrencySlot,
          effective_concurrency: launch.effectiveConcurrency,
          queued_at: launch.queuedAt,
          started_at: startedAt,
          ended_at: endedAt,
          agent_session_id: branchAgent.id,
          sandbox_session_id: sandbox.id,
          status: normalized.status,
          error_code: normalized.code,
          error: normalized.message,
          attempt_failures: normalized.attemptFailures,
          observation_id: branchObservation.id,
        },
      });
      await updateAgentSessionStatus(branchAgent.id, normalized.status === "cancelled" ? "cancelled" : "failed");
      await completeTraceSpan(branchSpan.id, normalized.status === "cancelled" ? "cancelled" : "failed", {
        branch_id: branch.id,
        branch_index: launch.branchIndex,
        batch_index: launch.batchIndex,
        concurrency_slot: launch.concurrencySlot,
        sandbox_session_id: sandbox.id,
        error_code: normalized.code,
        error: normalized.message,
      });
      return {
        status: normalized.status,
        observationId: branchObservation.id,
        summary: `${branch.title}: ${normalized.status} (${normalized.code}) ${normalized.message}`,
      };
    });

  if ("summary" in result) {
    return {
      branchIndex: launch.branchIndex,
      branchId: branch.id,
      status: result.status,
      observation: `${result.summary} Observation: ${result.observationId}`,
      artifactIds: [],
      branchObservationId: result.observationId,
    };
  }

  for (const event of result.agentEvents) {
    const sandboxEventPayload = event.payload ?? {};
    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: event.type || "sandbox.agent.event",
      producer: { kind: "agent", id: branchAgent.id, name: branch.title },
      trace: {
        trace_id: input.parentTraceId,
        span_id: branchSpan.id,
        parent_span_id: input.parentSwarmSpanId,
      },
      payload: {
        branch_id: branch.id,
        branch_index: launch.branchIndex,
        launch_order: launch.launchOrder,
        batch_index: launch.batchIndex,
        concurrency_slot: launch.concurrencySlot,
        effective_concurrency: launch.effectiveConcurrency,
        agent_session_id: branchAgent.id,
        sandbox_session_id: sandbox.id,
        execution_mode: result.executionMode,
        external_sandbox_id: result.externalSandboxId,
        agent_event_type: event.type,
        level: event.level ?? "info",
        message: event.message,
        timestamp: event.timestamp,
        event_payload: sandboxEventPayload,
        ...sandboxEventPayload,
        protocol_version: event.protocolVersion,
      },
    });
  }

  const artifact = await createTextArtifact({
    conversationId: input.conversationId,
    runId: input.runId,
    producerAgentSessionId: branchAgent.id,
    type: "markdown",
    title: `${branch.title} Result`,
    content: result.outputMarkdown,
    sourceTraceId: input.parentTraceId,
    metadata: {
      branchId: branch.id,
      branchIds: [branch.id],
      branchIndex: launch.branchIndex,
      launchOrder: launch.launchOrder,
      batchIndex: launch.batchIndex,
      concurrencySlot: launch.concurrencySlot,
      branchTitle: branch.title,
      planSource: input.plan.planSource,
      sandboxSessionId: sandbox.id,
      agentSessionId: branchAgent.id,
      contextBundleId: bundle.id,
      branchContract,
      branchFinal: result.branchFinal,
    },
  });

  const branchArtifacts: BranchArtifactSummary[] = [
    {
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      mimeType: artifact.mimeType,
      storageUri: artifact.storageUri,
      deduped: artifact.deduped,
      branchId: branch.id,
      branchIds: [branch.id],
    },
  ];

  if (!artifact.deduped) {
    await publishArtifactEvents({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      traceId: input.parentTraceId,
      spanId: branchSpan.id,
      parentSpanId: input.parentSwarmSpanId,
      artifact,
      previewType: "html",
    });
  }

  const recoveredArtifacts = await recoverSandboxArtifacts({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    producerAgentSessionId: branchAgent.id,
    traceId: input.parentTraceId,
    spanId: branchSpan.id,
    parentSpanId: input.parentSwarmSpanId,
    branchId: branch.id,
    sandboxArtifacts: result.sandboxArtifacts,
  });
  for (const recoveredArtifact of recoveredArtifacts) {
    branchArtifacts.push(recoveredArtifact);
  }

  const parentCapabilityArtifacts = await listRunArtifactsForBranch({
    runId: input.runId,
    branchId: branch.id,
    producerAgentSessionId: branchAgent.id,
  });
  const existingBranchArtifactIds = new Set(branchArtifacts.map((item) => item.id));
  for (const parentArtifact of parentCapabilityArtifacts) {
    if (!existingBranchArtifactIds.has(parentArtifact.id)) {
      branchArtifacts.push(branchArtifactFromArtifactRecord(parentArtifact, branch.id));
      existingBranchArtifactIds.add(parentArtifact.id);
    }
  }

  const imageArtifactIds = branchArtifacts.filter((item) => item.type === "image").map((item) => item.id);
  const branchArtifactSummary = formatBranchArtifacts(branchArtifacts);
  const branchArtifactIds = uniqueStrings(branchArtifacts.map((item) => item.id));

  const branchObservation = await createObservation({
    runId: input.runId,
    actionId: input.actionId,
    sourceType: "agent",
    sourceName: `swarm.branch.${branch.id}`,
    status: "completed",
    summary: `${branch.title}: ${result.outputSummary} Artifacts: ${branchArtifactSummary}`,
    evidenceLevel: branchEvidenceLevel(),
    claims: [
      {
        claim: result.outputSummary,
        support: "direct",
        sourceRefs: branchArtifacts.map((item) => ({ payloadPath: item.storageUri })),
      },
    ],
    metadata: {
      branch_id: branch.id,
      branch_index: launch.branchIndex,
      launch_order: launch.launchOrder,
      batch_index: launch.batchIndex,
      concurrency_slot: launch.concurrencySlot,
      effective_concurrency: launch.effectiveConcurrency,
      branch_title: branch.title,
      plan_source: input.plan.planSource,
      agent_session_id: branchAgent.id,
      sandbox_session_id: sandbox.id,
      context_bundle_id: bundle.id,
      model_profile: branch.modelProfile,
      status: result.status,
      execution_mode: result.executionMode,
      external_sandbox_id: result.externalSandboxId,
      artifact_id: artifact.id,
      artifact_ids: branchArtifactIds,
      image_artifact_ids: imageArtifactIds,
      branch_artifacts: branchArtifacts.map(publicBranchArtifact),
      parent_capability_artifacts: parentCapabilityArtifacts.map(publicBranchArtifact),
      artifact_version_id: artifact.versionId,
      output_summary: result.outputSummary,
      agent_event_count: result.agentEvents.length,
      quality_signals: result.qualitySignals,
      sandbox_artifacts: result.sandboxArtifacts,
      sandbox_runtime: result.sandboxRuntime,
      branch_contract: branchContract,
      branch_final: result.branchFinal,
      attempt: result.attempt,
      max_attempts: result.maxAttempts,
    },
  });
  for (const branchArtifact of branchArtifacts) {
    await mergeArtifactMetadata(branchArtifact.id, {
      sourceObservationIds: [branchObservation.id],
      branchIds: [branch.id],
      latestBranchObservationId: branchObservation.id,
    });
  }
  await publishBranchObservationEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    traceId: input.parentTraceId,
    spanId: branchSpan.id,
    parentSpanId: input.parentSwarmSpanId,
    observation: branchObservation,
  });

  if (result.branchFinal) {
    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "swarm.branch.final.materialized",
      producer: { kind: "agent", id: branchAgent.id, name: branch.title },
      trace: {
        trace_id: input.parentTraceId,
        span_id: branchSpan.id,
        parent_span_id: input.parentSwarmSpanId,
      },
      payload: {
        branch_id: branch.id,
        branch_index: launch.branchIndex,
        agent_session_id: branchAgent.id,
        sandbox_session_id: sandbox.id,
        external_sandbox_id: result.externalSandboxId,
        observation_id: branchObservation.id,
        artifact_ids: branchArtifactIds,
        image_artifact_ids: imageArtifactIds,
        evidence_observation_ids: result.branchFinal.evidenceObservationIds ?? [],
        evidence_artifact_ids: result.branchFinal.artifactIds ?? [],
        section_count: result.branchFinal.sections?.length ?? 0,
        claim_count: result.branchFinal.claims?.length ?? 0,
        unsupported_claim_count: result.branchFinal.unsupportedClaims?.length ?? 0,
        quality_signals: result.branchFinal.qualitySignals ?? result.qualitySignals,
        branch_contract: branchContract,
        branch_final: result.branchFinal,
      },
    });
  }

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "swarm.branch.completed",
    producer: { kind: "agent", id: branchAgent.id, name: branch.title },
    trace: {
      trace_id: input.parentTraceId,
      span_id: branchSpan.id,
      parent_span_id: input.parentSwarmSpanId,
    },
    payload: {
      branch_id: branch.id,
      branch_index: launch.branchIndex,
      launch_order: launch.launchOrder,
      batch_index: launch.batchIndex,
      concurrency_slot: launch.concurrencySlot,
      effective_concurrency: launch.effectiveConcurrency,
      queued_at: launch.queuedAt,
      agent_session_id: branchAgent.id,
      sandbox_session_id: sandbox.id,
      status: result.status,
      execution_mode: result.executionMode,
      external_sandbox_id: result.externalSandboxId,
      attempt: result.attempt,
      max_attempts: result.maxAttempts,
      output_summary: result.outputSummary,
      agent_event_count: result.agentEvents.length,
      quality_signals: result.qualitySignals,
      sandbox_artifacts: result.sandboxArtifacts,
      sandbox_runtime: result.sandboxRuntime,
      branch_contract: branchContract,
      branch_final: result.branchFinal,
      artifact_recovery_ready: result.qualitySignals?.artifactRecoveryReady,
      artifact_id: artifact.id,
      artifact_ids: branchArtifactIds,
      image_artifact_ids: imageArtifactIds,
      branch_artifacts: branchArtifacts.map(publicBranchArtifact),
      parent_capability_artifacts: parentCapabilityArtifacts.map(publicBranchArtifact),
      observation_id: branchObservation.id,
      plan_source: input.plan.planSource,
      started_at: result.startedAt,
      ended_at: result.endedAt,
    },
  });

  await updateAgentSessionStatus(branchAgent.id, "completed");
  await completeTraceSpan(branchSpan.id, "completed", {
    branch_id: branch.id,
    branch_index: launch.branchIndex,
    batch_index: launch.batchIndex,
    concurrency_slot: launch.concurrencySlot,
    sandbox_session_id: sandbox.id,
    artifact_id: artifact.id,
    artifact_ids: branchArtifactIds,
    image_artifact_ids: imageArtifactIds,
    branch_artifacts: branchArtifacts.map(publicBranchArtifact),
    parent_capability_artifacts: parentCapabilityArtifacts.map(publicBranchArtifact),
    observation_id: branchObservation.id,
    output_summary: result.outputSummary,
    agent_event_count: result.agentEvents.length,
    quality_signals: result.qualitySignals,
    sandbox_runtime: result.sandboxRuntime,
    branch_contract: branchContract,
    branch_final: result.branchFinal,
  });

  return {
    branchIndex: launch.branchIndex,
    branchId: branch.id,
    status: "completed",
    observation: `${branch.title}: ${result.outputSummary} Artifacts: ${branchArtifactSummary} Observation: ${branchObservation.id}`,
    artifactIds: branchArtifactIds,
    branchObservationId: branchObservation.id,
    qualitySignals: result.qualitySignals,
    branchArtifacts,
    branchContract,
    branchFinal: result.branchFinal,
  };
}

async function loadSwarmEventEvidence(runId: string) {
  const db = await getDb();
  const eventRows = db
    .prepare(`SELECT event_type, COUNT(*) AS count FROM run_events WHERE run_id = ? GROUP BY event_type`)
    .all(runId) as Array<{ event_type: string; count: number }>;
  const eventTypeCounts = Object.fromEntries(eventRows.map((row) => [row.event_type, Number(row.count) || 0]));
  const eventCount = (eventType: string) => Number(eventTypeCounts[eventType] ?? 0);
  const toolRows = db
    .prepare(
      `SELECT COALESCE(t.name, 'unknown') AS tool_name, tc.status, COUNT(*) AS count
       FROM tool_calls tc
       LEFT JOIN tools t ON t.id = tc.tool_id
       WHERE tc.run_id = ?
       GROUP BY COALESCE(t.name, 'unknown'), tc.status`,
    )
    .all(runId) as Array<{ tool_name: string; status: string; count: number }>;
  const toolCallRows = db
    .prepare(
      `SELECT tc.id, tc.status, COALESCE(t.name, 'unknown') AS tool_name, tc.metadata_json
       FROM tool_calls tc
       LEFT JOIN tools t ON t.id = tc.tool_id
       WHERE tc.run_id = ?`,
    )
    .all(runId) as Array<{ id: string; status: string; tool_name: string; metadata_json: string | null }>;
  const eventDetailRows = db
    .prepare(
      `SELECT event_type, payload_json
       FROM run_events
       WHERE run_id = ?
         AND (event_type LIKE 'capability.invoke.%' OR event_type LIKE 'sandbox.tool_proxy.call.%')`,
    )
    .all(runId) as Array<{ event_type: string; payload_json: string | null }>;
  const toolCallStatusCounts: Record<string, Record<string, number>> = {};
  for (const row of toolRows) {
    const toolName = row.tool_name || "unknown";
    toolCallStatusCounts[toolName] = toolCallStatusCounts[toolName] ?? {};
    toolCallStatusCounts[toolName][row.status] = Number(row.count) || 0;
  }
  const completedToolCount = (toolName: string) => Number(toolCallStatusCounts[toolName]?.completed ?? 0);
  const failedToolCount = (toolName: string) => Number(toolCallStatusCounts[toolName]?.failed ?? 0);
  const successfulToolCallCount = Object.values(toolCallStatusCounts).reduce((sum, statuses) => sum + Number(statuses.completed ?? 0), 0);
  const failedToolCallCount = Object.values(toolCallStatusCounts).reduce((sum, statuses) => sum + Number(statuses.failed ?? 0), 0);
  const toolCalls = toolCallRows.map((row) => {
    const metadata = parseJsonObject(row.metadata_json);
    return {
      id: row.id,
      status: row.status,
      toolName: row.tool_name,
      branchId: String(metadata.branch_id ?? metadata.branchId ?? ""),
    };
  });
  const capabilityEvents = eventDetailRows.map((row) => {
    const payload = parseJsonObject(row.payload_json);
    return {
      type: row.event_type,
      branchId: String(payload.branch_id ?? payload.branchId ?? ""),
      toolName: String(payload.tool_name ?? payload.toolName ?? ""),
      capabilityName: String(payload.capability_name ?? payload.capabilityName ?? ""),
      observationId: String(payload.observation_id ?? payload.observationId ?? ""),
      toolCallId: String(payload.tool_call_id ?? payload.toolCallId ?? ""),
      status: row.event_type.split(".").at(-1),
    };
  });
  return {
    eventTypeCounts,
    toolCallStatusCounts,
    toolCalls,
    capabilityEvents,
    capabilityInvokeStartedCount: eventCount("capability.invoke.started"),
    capabilityInvokeCompletedCount: eventCount("capability.invoke.completed"),
    capabilityInvokeFailedCount: eventCount("capability.invoke.failed"),
    sandboxToolProxyStartedCount: eventCount("sandbox.tool_proxy.call.started"),
    sandboxToolProxyCompletedCount: eventCount("sandbox.tool_proxy.call.completed"),
    sandboxToolProxyFailedCount: eventCount("sandbox.tool_proxy.call.failed"),
    successfulToolCallCount,
    failedToolCallCount,
    webSearchToolCallCompletedCount: completedToolCount("web.search") + completedToolCount("tavily.search"),
    runPythonToolCallCompletedCount: completedToolCount("run_python"),
    artifactCreateToolCallCompletedCount: completedToolCount("artifact.create"),
    webSearchToolCallFailedCount: failedToolCount("web.search") + failedToolCount("tavily.search"),
    runPythonToolCallFailedCount: failedToolCount("run_python"),
    artifactCreateToolCallFailedCount: failedToolCount("artifact.create"),
  };
}

function aggregateBranchRecords(plan: SwarmPlan, records: BranchExecutionRecord[]) {
  const byBranchIndex = new Map(records.map((record) => [record.branchIndex, record]));
  const orderedRecords = plan.branches.map((_, index) => byBranchIndex.get(index)).filter((record): record is BranchExecutionRecord => Boolean(record));
  return {
    observations: orderedRecords.map((record) => record.observation),
    artifactIds: uniqueStrings(orderedRecords.flatMap((record) => record.artifactIds)),
    branchObservationIds: orderedRecords.map((record) => record.branchObservationId).filter((id): id is string => Boolean(id)),
    completedBranches: orderedRecords.filter((record) => record.status === "completed").length,
    failedBranches: orderedRecords.filter((record) => record.status === "failed" || record.status === "cancelled").length,
    branchQualitySignals: orderedRecords.map((record) => record.qualitySignals).filter((item): item is Record<string, unknown> => Boolean(item)),
    branchArtifacts: orderedRecords.flatMap((record) => record.branchArtifacts ?? []),
    branchContracts: orderedRecords.flatMap((record) => record.branchContract ? [record.branchContract] : []),
    branchFinals: orderedRecords.flatMap((record) => record.branchFinal ? [record.branchFinal] : []),
  };
}

async function buildSandboxSkillManifests(branch: SwarmBranch) {
  const skills = await listSkills().catch(() => []);
  const branchText = `${branch.title} ${branch.instruction}`.toLowerCase();
  const selected = skills.filter((skill) => {
    const manifest = skill.manifest;
    if (!manifest) {
      return false;
    }
    const searchable = [
      skill.name,
      manifest.purpose,
      ...manifest.tags,
      ...manifest.requiredTools,
      ...manifest.preferredCapabilities,
    ]
      .join(" ")
      .toLowerCase();
    return (
      branchText.includes(skill.name.toLowerCase()) ||
      manifest.requiredTools.some((tool) => sandboxAllowedTools().includes(tool)) ||
      searchable
        .split(/\s+/)
        .filter((token) => token.length >= 5)
        .some((token) => branchText.includes(token))
    );
  });
  const fallback = selected.length > 0 ? selected : skills.slice(0, 2);
  return fallback.slice(0, 4).map((skill) => ({
    name: skill.name,
    version: skill.version,
    purpose: skill.manifest?.purpose ?? skill.description,
    activationGuidance: skill.manifest?.activationGuidance ?? [],
    requiredTools: skill.manifest?.requiredTools ?? [],
    preferredCapabilities: skill.manifest?.preferredCapabilities ?? [],
    qualityChecks: skill.manifest?.qualityChecks ?? [],
    outputExpectations: skill.manifest?.outputContract ?? {},
  }));
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

async function publishBranchObservationEvent(input: {
  runId: string;
  conversationId: string;
  taskId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  observation: Awaited<ReturnType<typeof createObservation>>;
}) {
  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "observation.created",
    producer: { kind: "orchestrator", id: input.observation.id, name: "Observation Store" },
    trace: { trace_id: input.traceId, span_id: input.spanId, parent_span_id: input.parentSpanId },
    payload: {
      observation_id: input.observation.id,
      action_id: input.observation.actionId,
      source_type: input.observation.sourceType,
      source_name: input.observation.sourceName,
      status: input.observation.status,
      summary: input.observation.summary,
      payload_uri: input.observation.payloadUri,
      evidence_level: input.observation.evidenceLevel,
      claim_count: input.observation.claims.length,
    },
  });
}

async function publishArtifactEvents(input: {
  runId: string;
  conversationId: string;
  taskId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  artifact: {
    id: string;
    versionId: string;
    type: string;
    mimeType: string;
    title: string;
    storageUri: string;
    previewUri: string;
    deduped?: boolean;
  };
  previewType: "html" | "image";
}) {
  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "artifact.created",
    producer: { kind: "artifact", id: input.artifact.id, name: input.artifact.title },
    trace: {
      trace_id: input.traceId,
      span_id: input.spanId,
      parent_span_id: input.parentSpanId,
    },
    payload: {
      artifact_id: input.artifact.id,
      artifact_version_id: input.artifact.versionId,
      type: input.artifact.type,
      mime_type: input.artifact.mimeType,
      title: input.artifact.title,
      storage_uri: input.artifact.storageUri,
      source_trace_id: input.traceId,
      deduped: input.artifact.deduped ?? false,
    },
  });
  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "artifact.preview.ready",
    producer: { kind: "artifact", id: input.artifact.id, name: input.artifact.title },
    trace: {
      trace_id: input.traceId,
      span_id: input.spanId,
      parent_span_id: input.parentSpanId,
    },
    payload: {
      artifact_id: input.artifact.id,
      artifact_version_id: input.artifact.versionId,
      preview_uri: input.artifact.previewUri,
      preview_type: input.previewType,
    },
  });
}

async function recoverSandboxArtifacts(input: {
  runId: string;
  conversationId: string;
  taskId: string;
  producerAgentSessionId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  branchId: string;
  sandboxArtifacts?: Array<Record<string, unknown>>;
}) {
  const recovered: BranchArtifactSummary[] = [];
  for (const sandboxArtifact of input.sandboxArtifacts ?? []) {
    const kind = String(sandboxArtifact.kind ?? "");
    const contentBase64 = typeof sandboxArtifact.contentBase64 === "string" ? sandboxArtifact.contentBase64 : "";
    if (!contentBase64) {
      continue;
    }
    if (kind === "markdown" || kind === "html") {
      const content = Buffer.from(contentBase64, "base64").toString("utf8");
      const artifact = await createTextArtifact({
        conversationId: input.conversationId,
        runId: input.runId,
        producerAgentSessionId: input.producerAgentSessionId,
        type: kind,
        title: String(sandboxArtifact.title ?? `${input.branchId} ${kind} Artifact`),
        content,
        sourceTraceId: input.traceId,
        metadata: {
          branchId: input.branchId,
          branchIds: [input.branchId],
          sandboxArtifactKind: kind,
          sandboxSha256: sandboxArtifact.sha256,
          sandboxBytes: sandboxArtifact.bytes,
          filename: sandboxArtifact.filename,
          sourceObservationIds: Array.isArray(sandboxArtifact.localSandboxObservationIds)
            ? sandboxArtifact.localSandboxObservationIds
            : [],
        },
      });
      recovered.push({
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        mimeType: artifact.mimeType,
        storageUri: artifact.storageUri,
        deduped: artifact.deduped,
        branchId: input.branchId,
        branchIds: [input.branchId],
      });
      if (!artifact.deduped) {
        await publishArtifactEvents({
          runId: input.runId,
          conversationId: input.conversationId,
          taskId: input.taskId,
          traceId: input.traceId,
          spanId: input.spanId,
          parentSpanId: input.parentSpanId,
          artifact,
          previewType: "html",
        });
      }
      continue;
    }
    if (kind !== "image") {
      continue;
    }
    const mimeType = normalizeImageMimeType(sandboxArtifact.mimeType);
    const extension = imageExtension(mimeType);
    const artifact = await createBinaryArtifact({
      conversationId: input.conversationId,
      runId: input.runId,
      producerAgentSessionId: input.producerAgentSessionId,
      type: "image",
      title: String(sandboxArtifact.title ?? `${input.branchId} Image`),
      content: Buffer.from(contentBase64, "base64"),
      mimeType,
      extension,
      sourceTraceId: input.traceId,
      metadata: {
        branchId: input.branchId,
        branchIds: [input.branchId],
        sandboxArtifactKind: kind,
        sandboxSha256: sandboxArtifact.sha256,
        sandboxBytes: sandboxArtifact.bytes,
        filename: sandboxArtifact.filename,
      },
    });
    recovered.push({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      mimeType: artifact.mimeType,
      storageUri: artifact.storageUri,
      deduped: artifact.deduped,
      branchId: input.branchId,
      branchIds: [input.branchId],
      artifactKind: artifact.artifactKind,
      qualitySignals: artifact.qualitySignals,
    });
    if (!artifact.deduped) {
      await publishArtifactEvents({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        traceId: input.traceId,
        spanId: input.spanId,
        parentSpanId: input.parentSpanId,
        artifact,
        previewType: "image",
      });
    }
  }
  return recovered;
}

function formatBranchArtifacts(
  artifacts: Array<{ id: string; type: string; title: string; mimeType?: string }>,
) {
  if (artifacts.length === 0) {
    return "none";
  }
  return artifacts
    .map((artifact) => `${artifact.type}: ${artifact.title} (${artifact.id}${artifact.mimeType ? `, ${artifact.mimeType}` : ""})`)
    .join("; ");
}

function publicBranchArtifact(artifact: BranchArtifactSummary) {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    mimeType: artifact.mimeType,
    deduped: artifact.deduped,
    branchId: artifact.branchId,
    branchIds: artifact.branchIds,
    artifactKind: artifact.artifactKind,
    qualitySignals: artifact.qualitySignals,
  };
}

function normalizeImageMimeType(value: unknown): "image/png" | "image/svg+xml" | "image/jpeg" {
  if (value === "image/svg+xml" || value === "image/jpeg") {
    return value;
  }
  return "image/png";
}

function imageExtension(value: "image/png" | "image/svg+xml" | "image/jpeg"): "png" | "svg" | "jpg" {
  if (value === "image/svg+xml") {
    return "svg";
  }
  if (value === "image/jpeg") {
    return "jpg";
  }
  return "png";
}

function branchEvidenceLevel() {
  return sandboxProviderSelection() === "e2b" ? "real" : "mock";
}

function normalizeBranchError(error: unknown): {
  status: "failed" | "cancelled";
  code: string;
  message: string;
  attemptFailures: Record<string, unknown>[];
} {
  const message = error instanceof Error ? error.message : "Unknown swarm branch error";
  if (isRecord(error) && typeof error.code === "string") {
    return {
      status: error.status === "cancelled" ? "cancelled" : ("failed" as const),
      code: error.code,
      message,
      attemptFailures: Array.isArray(error.attemptFailures) ? error.attemptFailures.filter(isRecord) : [],
    };
  }
  const cancelled = /cancel/i.test(message);
  const timeout = /timeout|ETIMEDOUT/i.test(message);
  return {
    status: cancelled ? "cancelled" : ("failed" as const),
    code: cancelled ? "sandbox_cancelled" : timeout ? "sandbox_timeout" : "sandbox_execution_failed",
    message,
    attemptFailures: [],
  };
}

class SwarmRunCancelledError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} cancellation was requested during swarm execution.`);
    this.name = "SwarmRunCancelledError";
  }
}

async function assertSwarmRunNotCancelled(runId: string) {
  if (await isRunCancelRequested(runId)) {
    throw new SwarmRunCancelledError(runId);
  }
}

function isSwarmRunCancelledError(error: unknown) {
  return error instanceof SwarmRunCancelledError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
