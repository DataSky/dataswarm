import { createAgentSession, updateAgentSessionStatus } from "../repositories/agent-sessions";
import { createBinaryArtifact, createTextArtifact, mergeArtifactMetadata } from "../repositories/artifacts";
import { createContextBundle } from "../repositories/context-bundles";
import { createObservation } from "../repositories/observations";
import { createSandboxSession } from "../repositories/sandbox-sessions";
import { isRunCancelRequested } from "../repositories/runs";
import { completeTraceSpan, startTraceSpan } from "../repositories/trace";
import { publishRunEvent } from "./event-bus";
import { createSandboxProvider } from "./sandbox-provider";
import type { ModelProvider } from "../models/provider";
import type { ModelProfile } from "../repositories/model-profiles";
import type { SpawnAgentAction, SpawnSwarmAction, SwarmActionBranchDefinition } from "./agentic-types";
import { reviewSwarmResult, type SwarmReviewResult } from "./swarm-reviewer";
import { buildSwarmReduction, type SwarmReductionResult } from "./swarm-reducer";
import { buildSwarmVerification, type SwarmVerificationResult } from "./swarm-verifier";

export type SwarmBranch = {
  id: string;
  title: string;
  instruction: string;
  modelProfile: "deepseek:deepseek-v4-pro" | "deepseek:deepseek-v4-flash";
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

type BranchArtifactSummary = {
  id: string;
  type: string;
  title: string;
  mimeType: string;
  storageUri: string;
  deduped?: boolean;
};

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
    return {
      strategy: "parallel_branch_then_merge",
      reason: action.branches?.length
        ? "Planner selected spawn_agent with an explicit branch definition."
        : "Planner selected spawn_agent; runtime normalized the single delegated agent into a one-branch plan.",
      planSource: action.branches?.length ? "model_branches" : "model_single_agent",
      branches: ensureUniqueBranchIds([normalizeBranchDefinition(branch, 0, action.objective, action.agentRole)]),
    };
  }

  if (action?.type === "spawn_swarm") {
    if (action.branches?.length) {
      return {
        strategy: "parallel_branch_then_merge",
        reason: "Planner selected spawn_swarm with explicit model-provided branch definitions.",
        planSource: "model_branches",
        branches: ensureUniqueBranchIds(
          action.branches.map((branch, index) => normalizeBranchDefinition(branch, index, action.objective)),
        ),
      };
    }

    const roleBranches = buildRoleBranches(action);
    if (roleBranches.length > 0) {
      return {
        strategy: "parallel_branch_then_merge",
        reason: "Planner selected spawn_swarm with branch roles/count; runtime expanded them into executable branches.",
        planSource: "model_roles",
        branches: ensureUniqueBranchIds(roleBranches),
      };
    }
  }

  return {
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
  };
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
  return Math.max(1, Math.min(6, Math.floor(value)));
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
      plan_source: plan.planSource,
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
      requested_branch_count: input.action?.type === "spawn_swarm" ? input.action.branchCount : undefined,
      branches: plan.branches.map((branch) => ({
        branch_id: branch.id,
        title: branch.title,
        instruction: branch.instruction,
        model_profile: branch.modelProfile,
      })),
    },
  });

  const provider = createSandboxProvider();
  const observations: string[] = [];
  const artifactIds: string[] = [];
  const branchObservationIds: string[] = [];
  let completedBranches = 0;
  let failedBranches = 0;

  try {
    for (const branch of plan.branches) {
      await assertSwarmRunNotCancelled(input.runId);
      const branchAgent = await createAgentSession({
        runId: input.runId,
        role: "swarm_branch",
        name: branch.title,
        modelProfile: branch.modelProfile,
        parentAgentSessionId: input.parentAgentSessionId,
        metadata: { branch_id: branch.id },
      });
      await updateAgentSessionStatus(branchAgent.id, "running");

      const branchSpan = await startTraceSpan({
        traceId: input.parentTraceId,
        parentSpanId: swarmSpan.id,
        runId: input.runId,
        agentSessionId: branchAgent.id,
        spanKind: "swarm.branch",
        name: branch.title,
        attributes: {
          branch_id: branch.id,
          model_profile: branch.modelProfile,
        },
      });

    const bundle = await createContextBundle({
      runId: input.runId,
      agentSessionId: branchAgent.id,
      branchId: branch.id,
      content: JSON.stringify(
        {
          objective: input.objective,
          branch,
          parent_agent_session_id: input.parentAgentSessionId,
          trace_id: input.parentTraceId,
        },
        null,
        2,
      ),
      sourceRefs: [{ type: "user_message", summary: input.objective.slice(0, 240) }],
      metadata: { branch_id: branch.id },
    });

    const sandbox = await createSandboxSession({
      runId: input.runId,
      agentSessionId: branchAgent.id,
      provider: process.env.DATASWARM_SANDBOX_PROVIDER === "e2b" ? "e2b" : "mock",
      template: "dataswarm-agent-runtime",
      resourceLimits: { cpu: 1, memory_mb: 1024, timeout_seconds: 120 },
      envPolicy: { allow_secret_env: false, allow_network: false },
      metadata: { branch_id: branch.id, context_bundle_id: bundle.id },
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
        parent_span_id: swarmSpan.id,
      },
      payload: {
        branch_id: branch.id,
        agent_session_id: branchAgent.id,
        sandbox_session_id: sandbox.id,
        model_profile: branch.modelProfile,
        context_bundle_id: bundle.id,
        context_bundle_uri: bundle.storageUri,
      },
    });

    const result = await provider
      .executeBranch({
        runId: input.runId,
        branchId: branch.id,
        sandboxSessionId: sandbox.id,
        agentSessionId: branchAgent.id,
        agentName: branch.title,
        modelProfile: branch.modelProfile,
        objective: input.objective,
        instruction: branch.instruction,
        contextBundleUri: bundle.storageUri,
      })
      .catch(async (error) => {
        const normalized = normalizeBranchError(error);
        failedBranches += 1;
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
            branch_title: branch.title,
            plan_source: plan.planSource,
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
        branchObservationIds.push(branchObservation.id);
        await publishBranchObservationEvent({
          runId: input.runId,
          conversationId: input.conversationId,
          taskId: input.taskId,
          traceId: input.parentTraceId,
          spanId: branchSpan.id,
          parentSpanId: swarmSpan.id,
          observation: branchObservation,
        });
        await publishRunEvent({
          runId: input.runId,
          conversationId: input.conversationId,
          taskId: input.taskId,
          type: "swarm.branch.failed",
          producer: { kind: "agent", id: branchAgent.id, name: branch.title },
          trace: {
            trace_id: input.parentTraceId,
            span_id: branchSpan.id,
            parent_span_id: swarmSpan.id,
          },
          payload: {
            branch_id: branch.id,
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
          sandbox_session_id: sandbox.id,
          error_code: normalized.code,
          error: normalized.message,
        });
        observations.push(`${branch.title}: ${normalized.status} (${normalized.code}) ${normalized.message}`);
        return null;
      });

    if (!result) {
      continue;
    }
    completedBranches += 1;

    for (const event of result.agentEvents) {
      await publishRunEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        type: "sandbox.agent.event",
        producer: { kind: "agent", id: branchAgent.id, name: branch.title },
        trace: {
          trace_id: input.parentTraceId,
          span_id: branchSpan.id,
          parent_span_id: swarmSpan.id,
        },
        payload: {
          branch_id: branch.id,
          agent_session_id: branchAgent.id,
          sandbox_session_id: sandbox.id,
          execution_mode: result.executionMode,
          external_sandbox_id: result.externalSandboxId,
          agent_event_type: event.type,
          level: event.level ?? "info",
          message: event.message,
          timestamp: event.timestamp,
          event_payload: event.payload ?? {},
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
        branchTitle: branch.title,
        planSource: plan.planSource,
        sandboxSessionId: sandbox.id,
        agentSessionId: branchAgent.id,
        contextBundleId: bundle.id,
      },
    });
    pushUnique(artifactIds, artifact.id);

    if (!artifact.deduped) {
      await publishArtifactEvents({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        traceId: input.parentTraceId,
        spanId: branchSpan.id,
        parentSpanId: swarmSpan.id,
        artifact,
        previewType: "html",
      });
    }

    const branchArtifacts: BranchArtifactSummary[] = [
      {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        mimeType: artifact.mimeType,
        storageUri: artifact.storageUri,
        deduped: artifact.deduped,
      },
    ];
    const recoveredArtifacts = await recoverSandboxArtifacts({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      producerAgentSessionId: branchAgent.id,
      traceId: input.parentTraceId,
      spanId: branchSpan.id,
      parentSpanId: swarmSpan.id,
      branchId: branch.id,
      sandboxArtifacts: result.sandboxArtifacts,
    });
    for (const recoveredArtifact of recoveredArtifacts) {
      pushUnique(artifactIds, recoveredArtifact.id);
      branchArtifacts.push(recoveredArtifact);
    }
    const imageArtifactIds = branchArtifacts.filter((item) => item.type === "image").map((item) => item.id);
    const branchArtifactSummary = formatBranchArtifacts(branchArtifacts);

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
        branch_title: branch.title,
        plan_source: plan.planSource,
        agent_session_id: branchAgent.id,
        sandbox_session_id: sandbox.id,
        context_bundle_id: bundle.id,
        model_profile: branch.modelProfile,
        status: result.status,
        execution_mode: result.executionMode,
        external_sandbox_id: result.externalSandboxId,
        artifact_id: artifact.id,
        artifact_ids: branchArtifacts.map((item) => item.id),
        image_artifact_ids: imageArtifactIds,
        branch_artifacts: branchArtifacts.map(publicBranchArtifact),
        artifact_version_id: artifact.versionId,
        output_summary: result.outputSummary,
        agent_event_count: result.agentEvents.length,
        quality_signals: result.qualitySignals,
        sandbox_artifacts: result.sandboxArtifacts,
        sandbox_runtime: result.sandboxRuntime,
        attempt: result.attempt,
        max_attempts: result.maxAttempts,
      },
    });
    branchObservationIds.push(branchObservation.id);
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
      parentSpanId: swarmSpan.id,
      observation: branchObservation,
    });

    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "swarm.branch.completed",
      producer: { kind: "agent", id: branchAgent.id, name: branch.title },
      trace: {
        trace_id: input.parentTraceId,
        span_id: branchSpan.id,
        parent_span_id: swarmSpan.id,
      },
      payload: {
        branch_id: branch.id,
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
        artifact_recovery_ready: result.qualitySignals?.artifactRecoveryReady,
        artifact_id: artifact.id,
        artifact_ids: branchArtifacts.map((item) => item.id),
        image_artifact_ids: imageArtifactIds,
        branch_artifacts: branchArtifacts.map(publicBranchArtifact),
        observation_id: branchObservation.id,
        plan_source: plan.planSource,
        started_at: result.startedAt,
        ended_at: result.endedAt,
      },
    });

    await updateAgentSessionStatus(branchAgent.id, "completed");
    await completeTraceSpan(branchSpan.id, "completed", {
      branch_id: branch.id,
      sandbox_session_id: sandbox.id,
      artifact_id: artifact.id,
      artifact_ids: branchArtifacts.map((item) => item.id),
      image_artifact_ids: imageArtifactIds,
      branch_artifacts: branchArtifacts.map(publicBranchArtifact),
      observation_id: branchObservation.id,
      output_summary: result.outputSummary,
      agent_event_count: result.agentEvents.length,
      quality_signals: result.qualitySignals,
      sandbox_runtime: result.sandboxRuntime,
    });

    observations.push(`${branch.title}: ${result.outputSummary} Artifacts: ${branchArtifactSummary} Observation: ${branchObservation.id}`);
  }
  } catch (error) {
    if (isSwarmRunCancelledError(error)) {
      const cancelledSummary = `Swarm cancelled after ${completedBranches}/${plan.branches.length} completed branches and ${failedBranches} failed branches.`;
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
          completed_branch_count: completedBranches,
          failed_branch_count: failedBranches,
          artifact_ids: artifactIds,
          summary: cancelledSummary,
        },
      });
      await completeTraceSpan(swarmSpan.id, "cancelled", {
        branch_count: plan.branches.length,
        plan_source: plan.planSource,
        completed_branch_count: completedBranches,
        failed_branch_count: failedBranches,
        artifact_ids: artifactIds,
        branch_observation_ids: branchObservationIds,
        output_summary: cancelledSummary,
      });
    }
    throw error;
  }

  const reduceSpan = await startTraceSpan({
    traceId: input.parentTraceId,
    parentSpanId: swarmSpan.id,
    runId: input.runId,
    agentSessionId: input.parentAgentSessionId,
    spanKind: "swarm.reduce",
    name: "Reduce swarm branch evidence",
    attributes: { branch_count: plan.branches.length },
  });
  const reduction = buildSwarmReduction({
    plan,
    completedBranches,
    failedBranches,
    artifactIds,
    branchObservationIds,
    observations,
  });

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
      completed_branch_count: completedBranches,
      failed_branch_count: failedBranches,
      artifact_ids: artifactIds,
      branch_observation_ids: branchObservationIds,
      branch_items: reduction.branchItems,
      conflict_signals: reduction.conflictSignals,
      recommendations: reduction.recommendations,
      summary: reduction.summary,
    },
  });

  await completeTraceSpan(reduceSpan.id, reduction.status === "failed" ? "failed" : "completed", {
    status: reduction.status,
    reducer_mode: reduction.reducerMode,
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
    attributes: { branch_count: plan.branches.length },
  });
  const mergeSummary = `${reduction.summary} ${observations.join(" | ")}`;
  const verification = buildSwarmVerification({
    plan,
    completedBranches,
    failedBranches,
    artifactIds,
    branchObservationIds,
    observations,
  });

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
      completed_branch_count: completedBranches,
      failed_branch_count: failedBranches,
      reduction_status: reduction.status,
      reducer_mode: reduction.reducerMode,
      reduction_summary: reduction.summary,
      artifact_ids: artifactIds,
      branch_observation_ids: branchObservationIds,
      summary: mergeSummary,
    },
  });

  await completeTraceSpan(mergeSpan.id, "completed", {
    artifact_ids: artifactIds,
    plan_source: plan.planSource,
    output_summary: mergeSummary,
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
      branch_observation_count: branchObservationIds.length,
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
      completed_branch_count: completedBranches,
      failed_branch_count: failedBranches,
      artifact_ids: artifactIds,
      branch_observation_ids: branchObservationIds,
      checks: verification.checks,
      summary: verification.summary,
    },
  });

  await completeTraceSpan(verifySpan.id, verification.status === "failed" ? "failed" : "completed", {
    status: verification.status,
    check_count: verification.checks.length,
    plan_source: plan.planSource,
    output_summary: verification.summary,
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
      branch_observation_count: branchObservationIds.length,
    },
  });
  const review = await reviewSwarmResult({
    plan,
    reduction,
    verification,
    completedBranches,
    failedBranches,
    artifactIds,
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
      completed_branch_count: completedBranches,
      failed_branch_count: failedBranches,
      artifact_ids: artifactIds,
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
    completed_branch_count: completedBranches,
    failed_branch_count: failedBranches,
    artifact_ids: artifactIds,
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
    artifactIds,
    branchObservationIds,
    reduction,
    verification,
    review,
  };
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
    if (kind !== "image" || !contentBase64) {
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

function pushUnique(target: string[], value: string) {
  if (!target.includes(value)) {
    target.push(value);
  }
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
  return process.env.DATASWARM_SANDBOX_PROVIDER === "e2b" ? "real" : "mock";
}

function normalizeBranchError(error: unknown) {
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
