import { createAgentSession, updateAgentSessionStatus } from "../repositories/agent-sessions";
import { getConversation } from "../repositories/conversations";
import { completeAssistantMessage, createAssistantMessage } from "../repositories/messages";
import { getModelProfile } from "../repositories/model-profiles";
import { logServer, textPreview } from "../observability/logger";
import { completeTask, getRun, isRunCancelRequested, updateRunStatus } from "../repositories/runs";
import { createAgentAction, updateAgentActionStatus } from "../repositories/agent-actions";
import { createObservation } from "../repositories/observations";
import { listToolCapabilities } from "../repositories/tools";
import { createSkillUsage, listSkills, type SkillRecord } from "../repositories/skills";
import { completeTraceSpan, startTraceSpan } from "../repositories/trace";
import { executeToolAction, type TavilySource } from "../tools/registry";
import { createModelProvider, ModelProviderError, type ChatMessage } from "../models/provider";
import { nowIso } from "../storage/ids";
import type { AgentAction, CallToolAction, CreateArtifactAction, Observation, ToolCapability } from "./agentic-types";
import { evaluateRunAndRecommend } from "./evaluator";
import { publishRunEvent } from "./event-bus";
import { callPlannerModel } from "./planner";
import { executeSwarm } from "./swarm";

export async function runOrchestrator(runId: string) {
  const run = await getRun(runId);
  if (!run) {
    return;
  }

  const modelProfileId = run.modelProfile ?? "dmx:gpt-5.5-1m";
  const modelProfile = await getModelProfile(modelProfileId);
  if (!modelProfile) {
    throw new Error(`Model profile not found: ${modelProfileId}`);
  }

  const agent = await createAgentSession({
    runId,
    role: "orchestrator",
    name: "Orchestrator",
    modelProfile: modelProfile.id,
  });

  const agentSpan = await startTraceSpan({
    runId,
    agentSessionId: agent.id,
    spanKind: "agent.run",
    name: "Orchestrator run",
    attributes: {
      model_profile: modelProfile.id,
    },
  });

  let assistantMessageId: string | null = null;

  try {
    await updateRunStatus(runId, "running", { startedAt: nowIso() });
    await updateAgentSessionStatus(agent.id, "running");
    await publishRunEvent({
      runId,
      conversationId: run.conversationId,
      taskId: run.taskId,
      type: "run.started",
      producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
      trace: { trace_id: agentSpan.traceId, span_id: agentSpan.id },
      payload: { status: "running", started_at: nowIso() },
    });
    await assertRunNotCancelled(runId);

    const conversation = await getConversation(run.conversationId);
    const conversationMessages = toChatMessages(conversation?.messages ?? []);
    const latestUserIndex = findLastUserMessageIndex(conversationMessages);
    const latestUserMessage = latestUserIndex >= 0 ? conversationMessages[latestUserIndex].content : "";
    const modelHistory = trimChatHistory(conversationMessages.slice(0, Math.max(latestUserIndex, 0)));
    const dateContext = currentDateContext();
    const observations: Observation[] = [];
    const artifactIds: string[] = [];
    const freshWebEvidenceRequired = shouldRequireFreshWebEvidence(conversationMessages, latestUserMessage);
    const provider = createModelProvider();
    const toolCapabilities = await listToolCapabilities();
    const availableSkills = await listSkills();
    const activeSkills: SkillRecord[] = [];

    logServer("info", "orchestrator.context.loaded", {
      runId,
      conversationId: run.conversationId,
      conversationMessageCount: conversationMessages.length,
      modelHistoryCount: modelHistory.length,
      latestUserIndex,
      toolCapabilityCount: toolCapabilities.length,
      availableSkillCount: availableSkills.length,
      activeSkillNames: activeSkills.map((skill) => skill.name),
      ...textPreview(latestUserMessage),
    });

    const assistantMessage = await createAssistantMessage({
      conversationId: run.conversationId,
      runId,
      agentSessionId: agent.id,
    });
    assistantMessageId = assistantMessage.id;

    await publishRunEvent({
      runId,
      conversationId: run.conversationId,
      taskId: run.taskId,
      type: "message.created",
      producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
      trace: { trace_id: agentSpan.traceId, span_id: agentSpan.id },
      payload: {
        message_id: assistantMessage.id,
        role: "assistant",
        status: "streaming",
        agent_session_id: agent.id,
      },
    });

    await publishRunEvent({
      runId,
      conversationId: run.conversationId,
      taskId: run.taskId,
      type: "message.part.started",
      producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
      trace: { trace_id: agentSpan.traceId, span_id: agentSpan.id },
      payload: { message_id: assistantMessage.id, part_id: "part_text_1", part_type: "text" },
    });

    let text = "";
    let finalTraceSpanId = agentSpan.id;
    let finalActionType = "unknown";
    const configuredMaxAgentSteps = Number(process.env.DATASWARM_AGENT_MAX_STEPS ?? 4);
    const maxAgentSteps = Number.isFinite(configuredMaxAgentSteps)
      ? Math.max(1, Math.min(8, Math.trunc(configuredMaxAgentSteps)))
      : 4;

    for (let stepIndex = 1; stepIndex <= maxAgentSteps && !text; stepIndex += 1) {
      await assertRunNotCancelled(runId);
      const plannerSpan = await startTraceSpan({
        traceId: agentSpan.traceId,
        parentSpanId: agentSpan.id,
        runId,
        agentSessionId: agent.id,
        spanKind: "model.call",
        name: `Orchestrator planner model call step ${stepIndex}`,
        attributes: {
          model_profile: modelProfile.id,
          provider: modelProfile.provider,
          model: modelProfile.model,
          purpose: "orchestrator_planner",
          step_index: stepIndex,
          max_agent_steps: maxAgentSteps,
          observation_count: observations.length,
          tool_capability_count: toolCapabilities.length,
        },
      });
      finalTraceSpanId = plannerSpan.id;

      await publishRunEvent({
        runId,
        conversationId: run.conversationId,
        taskId: run.taskId,
        type: "model.call.started",
        producer: { kind: "model", id: modelProfile.id, name: modelProfile.displayName },
        trace: { trace_id: agentSpan.traceId, span_id: plannerSpan.id, parent_span_id: agentSpan.id },
        payload: {
          model_call_id: plannerSpan.id,
          provider: modelProfile.provider,
          model: modelProfile.model,
          model_profile: modelProfile.id,
          purpose: "orchestrator_planner",
          step_index: stepIndex,
          max_agent_steps: maxAgentSteps,
          input_summary: latestUserMessage.slice(0, 240),
          history_message_count: modelHistory.length,
          observation_count: observations.length,
          tool_capability_count: toolCapabilities.length,
        },
      });

      const plannerResult = await callPlannerModel({
        provider,
        profile: modelProfile,
        dateContext,
        history: modelHistory,
        latestUserMessage,
        observations,
        toolCapabilities,
        availableSkills,
        activeSkills,
      }).catch(async (error) => {
        await completeTraceSpan(plannerSpan.id, "failed", {
          error: {
            message: error instanceof Error ? error.message : "Unknown planner error",
          },
        });
        await publishRunEvent({
          runId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          type: "model.call.failed",
          producer: { kind: "model", id: modelProfile.id, name: modelProfile.displayName },
          trace: { trace_id: agentSpan.traceId, span_id: plannerSpan.id, parent_span_id: agentSpan.id },
          payload: {
            model_call_id: plannerSpan.id,
            purpose: "orchestrator_planner",
            step_index: stepIndex,
            error: {
              message: error instanceof Error ? error.message : "Unknown planner error",
            },
          },
        });
        throw error;
      });
      await assertRunNotCancelled(runId);
      await completeTraceSpan(plannerSpan.id, "completed", {
        output_summary: plannerResult.rawText.slice(0, 240),
      });
      await publishRunEvent({
        runId,
        conversationId: run.conversationId,
        taskId: run.taskId,
        type: "model.call.completed",
        producer: { kind: "model", id: modelProfile.id, name: modelProfile.displayName },
        trace: { trace_id: agentSpan.traceId, span_id: plannerSpan.id, parent_span_id: agentSpan.id },
        payload: {
          model_call_id: plannerSpan.id,
          purpose: "orchestrator_planner",
          step_index: stepIndex,
          output_summary: describeAction(plannerResult.output.action),
        },
      });

      const action = plannerResult.output.action;
      await assertRunNotCancelled(runId);
      const actionRecord = await createAgentAction({
        runId,
        agentSessionId: agent.id,
        action,
        status: "proposed",
        modelProfile: modelProfile.id,
        traceSpanId: plannerSpan.id,
      });
      finalActionType = action.type;

      await publishActionEvent({
        runId,
        conversationId: run.conversationId,
        taskId: run.taskId,
        traceId: agentSpan.traceId,
        spanId: plannerSpan.id,
        parentSpanId: agentSpan.id,
        eventType: "action.proposed",
        actionId: actionRecord.id,
        action,
        toolCapabilities,
        modelProfile: modelProfile.id,
        stepIndex,
      });

      await updateAgentActionStatus({ id: actionRecord.id, status: "validated" });
      await publishActionEvent({
        runId,
        conversationId: run.conversationId,
        taskId: run.taskId,
        traceId: agentSpan.traceId,
        spanId: plannerSpan.id,
        parentSpanId: agentSpan.id,
        eventType: "action.validated",
        actionId: actionRecord.id,
        action,
        toolCapabilities,
        modelProfile: modelProfile.id,
        stepIndex,
      });

      if (action.type === "use_skill") {
        await assertRunNotCancelled(runId);
        const skill = availableSkills.find((item) => item.name === action.skillName);
        if (skill && !activeSkills.some((item) => item.name === skill.name)) {
          activeSkills.push(skill);
          const skillObservation = await recordSelectedSkill({
            runId,
            conversationId: run.conversationId,
            taskId: run.taskId,
            agentSessionId: agent.id,
            traceId: agentSpan.traceId,
            parentSpanId: plannerSpan.id,
            skill,
            availableSkills,
            latestUserMessage,
            reason: action.reason,
            objective: action.objective,
            actionId: actionRecord.id,
          });
          observations.push(skillObservation);
          await publishObservationEvent({
            runId,
            conversationId: run.conversationId,
            taskId: run.taskId,
            traceId: agentSpan.traceId,
            spanId: plannerSpan.id,
            parentSpanId: agentSpan.id,
            observation: skillObservation,
          });
        }
        await updateAgentActionStatus({ id: actionRecord.id, status: "executed" });
        await publishRunEvent({
          runId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          type: "agent.replan.requested",
          producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
          trace: { trace_id: agentSpan.traceId, span_id: plannerSpan.id, parent_span_id: agentSpan.id },
          payload: {
            step_index: stepIndex,
            next_step_index: stepIndex + 1,
            max_agent_steps: maxAgentSteps,
            action_id: actionRecord.id,
            reason: `Skill ${action.skillName} activated by planner action; replan with active skill context.`,
            active_skill_names: activeSkills.map((item) => item.name),
            observation_ids: observations.filter((observation) => observation.sourceType === "skill").map((observation) => observation.id),
          },
        });
        continue;
      }

      if (action.type === "call_tool") {
        await assertRunNotCancelled(runId);
        const toolObservation = await executeValidatedToolAction({
          runId,
          taskId: run.taskId,
          conversationId: run.conversationId,
          agentSessionId: agent.id,
          traceId: agentSpan.traceId,
          parentSpanId: agentSpan.id,
          actionId: actionRecord.id,
          action,
          toolCapabilities,
          observations,
        });
        observations.push(toolObservation);
        artifactIds.push(...extractArtifactIdsFromObservation(toolObservation).filter((artifactId) => !artifactIds.includes(artifactId)));
        await updateAgentActionStatus({
          id: actionRecord.id,
          status: observationStatusToActionStatus(toolObservation.status),
        });

        const replanReason = shouldReplanAfterObservation({
          action,
          observation: toolObservation,
          observations,
          stepIndex,
          maxAgentSteps,
          freshWebEvidenceRequired,
          latestUserMessage,
        });
        if (replanReason) {
          await publishRunEvent({
            runId,
            conversationId: run.conversationId,
            taskId: run.taskId,
            type: "agent.replan.requested",
            producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
            trace: { trace_id: agentSpan.traceId, span_id: plannerSpan.id, parent_span_id: agentSpan.id },
            payload: {
              step_index: stepIndex,
              next_step_index: stepIndex + 1,
              max_agent_steps: maxAgentSteps,
              action_id: actionRecord.id,
              observation_id: toolObservation.id,
              reason: replanReason,
            },
          });
          continue;
        }

        const response = await streamFinalModelResponse({
          runId,
          taskId: run.taskId,
          conversationId: run.conversationId,
          agentSessionId: agent.id,
          traceId: agentSpan.traceId,
          parentSpanId: agentSpan.id,
          assistantMessageId: assistantMessage.id,
          provider,
          modelProfile,
          dateContext,
          history: modelHistory,
          latestUserMessage,
          observations,
        });
        text = ensureObservationEvidenceReferences(response.text, observations);
        if (text !== response.text) {
          await streamTextToMessage({
            runId,
            taskId: run.taskId,
            conversationId: run.conversationId,
            assistantMessageId: assistantMessage.id,
            agentSessionId: agent.id,
            traceId: agentSpan.traceId,
            spanId: response.traceSpanId,
            parentSpanId: agentSpan.id,
            text: text.slice(response.text.length),
          });
        }
        finalTraceSpanId = response.traceSpanId;
      } else if (action.type === "create_artifact") {
        await assertRunNotCancelled(runId);
        const toolObservation = await executeValidatedToolAction({
          runId,
          taskId: run.taskId,
          conversationId: run.conversationId,
          agentSessionId: agent.id,
          traceId: agentSpan.traceId,
          parentSpanId: agentSpan.id,
          actionId: actionRecord.id,
          action: artifactActionToToolAction(action),
          toolCapabilities,
          observations,
        });
        observations.push(toolObservation);
        artifactIds.push(...extractArtifactIdsFromObservation(toolObservation).filter((artifactId) => !artifactIds.includes(artifactId)));
        await updateAgentActionStatus({
          id: actionRecord.id,
          status: observationStatusToActionStatus(toolObservation.status),
        });

        await publishRunEvent({
          runId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          type: "agent.replan.requested",
          producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
          trace: { trace_id: agentSpan.traceId, span_id: plannerSpan.id, parent_span_id: agentSpan.id },
          payload: {
            step_index: stepIndex,
            next_step_index: stepIndex + 1,
            max_agent_steps: maxAgentSteps,
            action_id: actionRecord.id,
            observation_id: toolObservation.id,
            reason: "Artifact was created by model-selected action; replan for a final answer grounded in the artifact observation.",
          },
        });
        continue;
      } else if (action.type === "spawn_agent" || action.type === "spawn_swarm") {
        await assertRunNotCancelled(runId);
        const swarmResult = await executeSwarm({
          runId,
          taskId: run.taskId,
          conversationId: run.conversationId,
          parentAgentSessionId: agent.id,
          parentTraceId: agentSpan.traceId,
          parentSpanId: plannerSpan.id,
          actionId: actionRecord.id,
          objective: action.objective,
          action,
          reviewer: {
            provider,
            profile: modelProfile,
          },
        });
        artifactIds.push(...swarmResult.artifactIds.filter((artifactId) => !artifactIds.includes(artifactId)));
        const swarmObservation = await createObservation({
          runId,
          actionId: actionRecord.id,
          sourceType: "agent",
          sourceName: process.env.DATASWARM_SANDBOX_PROVIDER === "e2b" ? "swarm.e2b" : "swarm.mock",
          status: "completed",
          summary: swarmResult.observations.join("\n"),
          evidenceLevel: process.env.DATASWARM_SANDBOX_PROVIDER === "e2b" ? "real" : "mock",
          claims: swarmResult.observations.map((summary) => ({
            claim: summary,
            support: "direct",
            sourceRefs: [],
          })),
          metadata: {
            plan: swarmResult.plan,
            plan_source: swarmResult.plan.planSource,
            artifact_ids: swarmResult.artifactIds,
            branch_observation_ids: swarmResult.branchObservationIds,
            verification: swarmResult.verification,
            review: swarmResult.review,
            action_type: action.type,
            execution_mode: process.env.DATASWARM_SANDBOX_PROVIDER === "e2b" ? "e2b_deferred_or_real_provider" : "mock",
          },
        });
        observations.push(swarmObservation);
        await updateAgentActionStatus({ id: actionRecord.id, status: "executed" });
        await publishObservationEvent({
          runId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          traceId: agentSpan.traceId,
          spanId: plannerSpan.id,
          parentSpanId: agentSpan.id,
          observation: swarmObservation,
        });
        await publishRunEvent({
          runId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          type: "agent.replan.requested",
          producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
          trace: { trace_id: agentSpan.traceId, span_id: plannerSpan.id, parent_span_id: agentSpan.id },
          payload: {
            step_index: stepIndex,
            next_step_index: stepIndex + 1,
            max_agent_steps: maxAgentSteps,
            action_id: actionRecord.id,
            observation_id: swarmObservation.id,
            reason: "Swarm branch execution completed; replan for final synthesis from branch observations.",
          },
        });
        continue;
      } else if (action.type === "final_answer") {
        await assertRunNotCancelled(runId);
        text = action.content;
        await updateAgentActionStatus({ id: actionRecord.id, status: "executed" });
        await streamTextToMessage({
          runId,
          taskId: run.taskId,
          conversationId: run.conversationId,
          assistantMessageId: assistantMessage.id,
          agentSessionId: agent.id,
          traceId: agentSpan.traceId,
          spanId: plannerSpan.id,
          parentSpanId: agentSpan.id,
          text,
        });
      } else {
        const blockedObservation = await createObservation({
          runId,
          actionId: actionRecord.id,
          sourceType: "system",
          sourceName: "agentic-runtime-v2",
          status: "blocked",
          summary: `Action type ${action.type} is not executable in Phase 1 loop. Phase 1 executes validated use_skill, call_tool, or final_answer.`,
          evidenceLevel: "inferred",
          claims: [],
          metadata: { action, step_index: stepIndex },
        });
        observations.push(blockedObservation);
        await updateAgentActionStatus({ id: actionRecord.id, status: "blocked" });
        await publishRunEvent({
          runId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          type: "action.blocked",
          producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
          trace: { trace_id: agentSpan.traceId, span_id: plannerSpan.id, parent_span_id: agentSpan.id },
          payload: {
            action_id: actionRecord.id,
            action_type: action.type,
            observation_id: blockedObservation.id,
            step_index: stepIndex,
            reason: blockedObservation.summary,
          },
        });
        await publishObservationEvent({
          runId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          traceId: agentSpan.traceId,
          spanId: plannerSpan.id,
          parentSpanId: agentSpan.id,
          observation: blockedObservation,
        });
        text = blockedObservation.summary;
        await streamTextToMessage({
          runId,
          taskId: run.taskId,
          conversationId: run.conversationId,
          assistantMessageId: assistantMessage.id,
          agentSessionId: agent.id,
          traceId: agentSpan.traceId,
          spanId: plannerSpan.id,
          parentSpanId: agentSpan.id,
          text,
        });
      }
    }

    if (!text) {
      await assertRunNotCancelled(runId);
      const response = await streamFinalModelResponse({
        runId,
        taskId: run.taskId,
        conversationId: run.conversationId,
        agentSessionId: agent.id,
        traceId: agentSpan.traceId,
        parentSpanId: agentSpan.id,
        assistantMessageId: assistantMessage.id,
        provider,
        modelProfile,
        dateContext,
        history: modelHistory,
        latestUserMessage,
        observations,
      });
      text = ensureObservationEvidenceReferences(response.text, observations);
      finalTraceSpanId = response.traceSpanId;
    }

    await assertRunNotCancelled(runId);
    await evaluateRunAndRecommend({
      runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      agentSessionId: agent.id,
      traceId: agentSpan.traceId,
      parentSpanId: agentSpan.id,
      latestUserMessage,
      selectedSkillNames: activeSkills.map((skill) => skill.name),
      freshWebEvidenceRequired,
      responseText: text,
      artifactIds,
    });

    const finalParts = [
      { type: "text", text },
      ...artifactIds.map((artifactId) => ({ type: "artifact_preview", artifact_id: artifactId })),
    ];
    await completeAssistantMessage({ messageId: assistantMessage.id, parts: finalParts });
    await publishRunEvent({
      runId,
      conversationId: run.conversationId,
      taskId: run.taskId,
      type: "message.part.completed",
      producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
      trace: { trace_id: agentSpan.traceId, span_id: finalTraceSpanId, parent_span_id: agentSpan.id },
      payload: {
        message_id: assistantMessage.id,
        part_id: "part_text_1",
        part: finalParts[0],
      },
    });

    await publishRunEvent({
      runId,
      conversationId: run.conversationId,
      taskId: run.taskId,
      type: "message.completed",
      producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
      trace: { trace_id: agentSpan.traceId, span_id: agentSpan.id },
      payload: { message_id: assistantMessage.id, status: "completed" },
    });

    await updateAgentSessionStatus(agent.id, "completed");
    await updateRunStatus(runId, "completed", { endedAt: nowIso(), resultSummary: text.slice(0, 500) });
    await completeTask(run.taskId, "completed");
    await completeTraceSpan(agentSpan.id, "completed", {
      output_summary: text.slice(0, 240),
      agentic_runtime: "v2_loop_phase_1",
      action_type: finalActionType,
      model_history_count: modelHistory.length,
      observation_count: observations.length,
      artifact_ids: artifactIds,
    });
    await publishRunEvent({
      runId,
      conversationId: run.conversationId,
      taskId: run.taskId,
      type: "run.completed",
      producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
      trace: { trace_id: agentSpan.traceId, span_id: agentSpan.id },
      payload: { status: "completed", result_summary: text.slice(0, 240) },
    });
  } catch (error) {
    if (isRunCancelledError(error)) {
      const cancelledText = "Run was cancelled before completion.";
      await updateAgentSessionStatus(agent.id, "cancelled");
      await updateRunStatus(runId, "cancelled", { endedAt: nowIso(), resultSummary: cancelledText });
      await completeTask(run.taskId, "cancelled");
      await completeTraceSpan(agentSpan.id, "cancelled", {
        reason: error.message,
        agentic_runtime: "v2_loop_phase_1",
      });
      if (assistantMessageId) {
        await completeAssistantMessage({
          messageId: assistantMessageId,
          parts: [{ type: "text", text: cancelledText }],
        });
        await publishRunEvent({
          runId,
          conversationId: run.conversationId,
          taskId: run.taskId,
          type: "message.completed",
          producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
          trace: { trace_id: agentSpan.traceId, span_id: agentSpan.id },
          payload: { message_id: assistantMessageId, status: "cancelled" },
        });
      }
      await publishRunEvent({
        runId,
        conversationId: run.conversationId,
        taskId: run.taskId,
        type: "run.cancelled",
        producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
        trace: { trace_id: agentSpan.traceId, span_id: agentSpan.id },
        payload: { status: "cancelled", reason: error.message },
      });
      return;
    }

    const normalized =
      error instanceof ModelProviderError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : { code: "runtime_error", message: error instanceof Error ? error.message : "Unknown error", retryable: false };

    await updateAgentSessionStatus(agent.id, "failed");
    await updateRunStatus(runId, "failed", { endedAt: nowIso(), error: normalized });
    await completeTask(run.taskId, "failed");
    await completeTraceSpan(agentSpan.id, "failed", { error: normalized });
    await publishRunEvent({
      runId,
      conversationId: run.conversationId,
      taskId: run.taskId,
      type: "run.failed",
      producer: { kind: "orchestrator", id: agent.id, name: "Orchestrator" },
      trace: { trace_id: agentSpan.traceId, span_id: agentSpan.id },
      payload: { status: "failed", error: normalized },
    });
  }
}

class RunCancelledError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} cancellation was requested.`);
    this.name = "RunCancelledError";
  }
}

async function assertRunNotCancelled(runId: string) {
  if (await isRunCancelRequested(runId)) {
    throw new RunCancelledError(runId);
  }
}

function isRunCancelledError(error: unknown): error is Error {
  return error instanceof RunCancelledError || (error instanceof Error && /cancellation was requested/i.test(error.message));
}

async function recordSelectedSkill(input: {
  runId: string;
  conversationId: string;
  taskId: string;
  agentSessionId: string;
  traceId: string;
  parentSpanId: string;
  skill: SkillRecord;
  availableSkills: SkillRecord[];
  latestUserMessage: string;
  objective?: string;
  reason?: string;
  actionId?: string;
}): Promise<Observation> {
  const usage = await createSkillUsage({
    skillId: input.skill.id,
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    status: "completed",
    inputSummary: input.latestUserMessage.slice(0, 240),
    traceSpanId: input.parentSpanId,
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "skill.selected",
    producer: { kind: "orchestrator", id: usage.id, name: "Skill Resolver" },
    trace: { trace_id: input.traceId, span_id: input.parentSpanId },
    payload: {
      skill_usage_id: usage.id,
      skill_id: input.skill.id,
      skill_name: input.skill.name,
      skill_version: input.skill.version,
      skill_path: input.skill.path,
      action_id: input.actionId ?? null,
      selection_mode: "planner_action",
      reason: input.reason ?? null,
      status: "completed",
      input_summary: input.latestUserMessage.slice(0, 240),
    },
  });

  const manifest = input.skill.manifest;
  const selectedAlternatives = input.availableSkills
    .filter((skill) => skill.name !== input.skill.name)
    .slice(0, 6)
    .map((skill) => ({
      skill_id: skill.id,
      skill_name: skill.name,
      version: skill.version,
      purpose: skill.manifest?.purpose ?? null,
      risk_level: skill.manifest?.riskLevel ?? null,
      required_tools: skill.manifest?.requiredTools ?? [],
      preferred_capabilities: skill.manifest?.preferredCapabilities ?? [],
    }));

  return createObservation({
    runId: input.runId,
    actionId: input.actionId,
    sourceType: "skill",
    sourceName: input.skill.name,
    status: "completed",
    summary: `Planner selected skill ${input.skill.name}${input.reason ? `: ${input.reason}` : "."}`,
    evidenceLevel: "real",
    claims: [
      {
        claim: `Skill ${input.skill.name} was selected by explicit planner action.`,
        support: "direct",
        sourceRefs: [],
      },
    ],
    metadata: {
      skill_usage_id: usage.id,
      skill_id: input.skill.id,
      skill_name: input.skill.name,
      skill_version: input.skill.version,
      skill_path: input.skill.path,
      action_id: input.actionId ?? null,
      selection_mode: "planner_action",
      reason: input.reason ?? null,
      objective: input.objective ?? null,
      input_summary: input.latestUserMessage.slice(0, 240),
      manifest: {
        purpose: manifest?.purpose ?? null,
        activation_guidance: manifest?.activationGuidance ?? [],
        required_tools: manifest?.requiredTools ?? [],
        preferred_capabilities: manifest?.preferredCapabilities ?? [],
        quality_checks: manifest?.qualityChecks ?? [],
        risk_level: manifest?.riskLevel ?? null,
      },
      selected_alternatives: selectedAlternatives,
      contribution_contract:
        "Skill observations are policy/workflow evidence for replanning and final trace diagnosis; they do not replace tool observations for factual claims.",
    },
  });
}

async function executeValidatedToolAction(input: {
  runId: string;
  taskId: string;
  conversationId: string;
  agentSessionId: string;
  traceId: string;
  parentSpanId: string;
  actionId: string;
  action: CallToolAction;
  toolCapabilities: ToolCapability[];
  observations?: Observation[];
}): Promise<Observation> {
  const toolCapability = input.toolCapabilities.find((tool) => tool.name === input.action.toolName);
  let toolCallId: string | null = null;
  const toolSpan = await startTraceSpan({
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    spanKind: "tool.call",
    name: `Tool call: ${input.action.toolName}`,
    attributes: {
      action_id: input.actionId,
      tool_name: input.action.toolName,
      capability_kind: toolCapability?.capabilityKind ?? "custom",
      input_summary: summarizeToolInput(input.action.input),
    },
  });

  try {
    const toolResult = await executeToolAction({
      runId: input.runId,
      agentSessionId: input.agentSessionId,
      traceSpanId: toolSpan.id,
      conversationId: input.conversationId,
      action: input.action,
      observations: input.observations ?? [],
      onToolCallCreated: async (createdToolCallId) => {
        toolCallId = createdToolCallId;
        await publishRunEvent({
          runId: input.runId,
          conversationId: input.conversationId,
          taskId: input.taskId,
          type: "tool.call.requested",
          producer: { kind: "tool", id: toolCapability?.id ?? input.action.toolName, name: input.action.toolName },
          trace: { trace_id: input.traceId, span_id: toolSpan.id, parent_span_id: input.parentSpanId },
          payload: {
            action_id: input.actionId,
            tool_call_id: createdToolCallId,
            tool_name: input.action.toolName,
            capability_kind: toolCapability?.capabilityKind ?? "custom",
            risk_level: toolCapability?.riskLevel ?? "low",
            requires_approval: toolCapability?.requiresApproval ?? false,
            input_summary: summarizeToolInput(input.action.input),
          },
        });
        await publishRunEvent({
          runId: input.runId,
          conversationId: input.conversationId,
          taskId: input.taskId,
          type: "tool.call.started",
          producer: { kind: "tool", id: toolCapability?.id ?? input.action.toolName, name: input.action.toolName },
          trace: { trace_id: input.traceId, span_id: toolSpan.id, parent_span_id: input.parentSpanId },
          payload: {
            action_id: input.actionId,
            tool_call_id: toolCallId,
            tool_name: input.action.toolName,
            capability_kind: toolCapability?.capabilityKind ?? "custom",
          },
        });
      },
    });

    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "tool.call.output",
      producer: { kind: "tool", id: toolCapability?.id ?? input.action.toolName, name: input.action.toolName },
      trace: { trace_id: input.traceId, span_id: toolSpan.id, parent_span_id: input.parentSpanId },
      payload: {
        action_id: input.actionId,
        tool_call_id: toolResult.toolCallId,
        tool_name: input.action.toolName,
        capability_kind: toolCapability?.capabilityKind ?? "custom",
        logical_tool_name: toolResult.logicalToolName ?? input.action.toolName,
        provider_tool_name: toolResult.providerToolName,
        provider: toolResult.provider,
        output_summary: toolResult.outputSummary,
        output_preview: toolResult.sources?.map((source) => ({ title: source.title, url: source.url })),
        payload_uri: toolResult.payloadUri,
        execution_mode: toolResult.executionMode,
        evidence_level: toolResult.evidenceLevel,
      },
    });

    const observation = await createObservation({
      runId: input.runId,
      actionId: input.actionId,
      sourceType: "tool",
      sourceName: input.action.toolName,
      status: toolResult.observationStatus ?? "completed",
      summary: toolResult.outputSummary,
      payloadUri: toolResult.payloadUri,
      evidenceLevel: toolResult.evidenceLevel,
      claims: toolResult.claims ?? [],
      metadata: {
        tool_call_id: toolResult.toolCallId,
        capability_kind: toolCapability?.capabilityKind ?? "custom",
        logical_tool_name: toolResult.logicalToolName ?? input.action.toolName,
        provider_tool_name: toolResult.providerToolName,
        provider: toolResult.provider,
        execution_mode: toolResult.executionMode,
        action_input: input.action.input,
        input_summary: summarizeToolInput(input.action.input),
        sources: toolResult.sources?.map((source) => ({ title: source.title, url: source.url, content: source.content })),
        artifact_ids: toolResult.artifacts?.map((artifact) => artifact.id),
        artifacts: toolResult.artifacts,
      },
    });

    for (const artifact of toolResult.artifacts ?? []) {
      await publishRunEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        type: "artifact.created",
        producer: { kind: "artifact", id: artifact.id, name: artifact.title },
        trace: { trace_id: input.traceId, span_id: toolSpan.id, parent_span_id: input.parentSpanId },
        payload: {
          action_id: input.actionId,
          tool_call_id: toolResult.toolCallId,
          artifact_id: artifact.id,
          artifact_version_id: artifact.versionId,
          type: artifact.type,
          mime_type: artifact.mimeType,
          title: artifact.title,
          storage_uri: artifact.storageUri,
          source_trace_id: input.traceId,
          deduped: artifact.deduped ?? false,
        },
      });
      await publishRunEvent({
        runId: input.runId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        type: "artifact.preview.ready",
        producer: { kind: "artifact", id: artifact.id, name: artifact.title },
        trace: { trace_id: input.traceId, span_id: toolSpan.id, parent_span_id: input.parentSpanId },
        payload: {
          action_id: input.actionId,
          tool_call_id: toolResult.toolCallId,
          artifact_id: artifact.id,
          artifact_version_id: artifact.versionId,
          preview_uri: artifact.previewUri,
          preview_type: "html",
        },
      });
    }

    await publishObservationEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      traceId: input.traceId,
      spanId: toolSpan.id,
      parentSpanId: input.parentSpanId,
      observation,
    });

    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "tool.call.completed",
      producer: { kind: "tool", id: toolCapability?.id ?? input.action.toolName, name: input.action.toolName },
      trace: { trace_id: input.traceId, span_id: toolSpan.id, parent_span_id: input.parentSpanId },
      payload: {
        action_id: input.actionId,
        tool_call_id: toolResult.toolCallId,
        tool_name: input.action.toolName,
        capability_kind: toolCapability?.capabilityKind ?? "custom",
        logical_tool_name: toolResult.logicalToolName ?? input.action.toolName,
        provider_tool_name: toolResult.providerToolName,
        provider: toolResult.provider,
        observation_id: observation.id,
        status: observation.status,
        output_summary: toolResult.outputSummary,
        execution_mode: toolResult.executionMode,
        evidence_level: observation.evidenceLevel,
        payload_uri: toolResult.payloadUri,
      },
    });

    await completeTraceSpan(toolSpan.id, "completed", {
      action_id: input.actionId,
      tool_call_id: toolResult.toolCallId,
      observation_id: observation.id,
      output_summary: toolResult.outputSummary,
    });
    return observation;
  } catch (error) {
    const observation = await createObservation({
      runId: input.runId,
      actionId: input.actionId,
      sourceType: "tool",
      sourceName: input.action.toolName,
      status: "failed",
      summary: error instanceof Error ? error.message : "Unknown tool execution error",
      evidenceLevel: "inferred",
      claims: [],
      metadata: { capability_kind: toolCapability?.capabilityKind ?? "custom" },
    });
    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "tool.call.failed",
      producer: { kind: "tool", id: toolCapability?.id ?? input.action.toolName, name: input.action.toolName },
      trace: { trace_id: input.traceId, span_id: toolSpan.id, parent_span_id: input.parentSpanId },
      payload: {
        action_id: input.actionId,
        tool_call_id: toolCallId,
        tool_name: input.action.toolName,
        capability_kind: toolCapability?.capabilityKind ?? "custom",
        observation_id: observation.id,
        status: "failed",
        evidence_level: observation.evidenceLevel,
        error: {
          message: error instanceof Error ? error.message : "Unknown tool error",
        },
      },
    });
    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "observation.failed",
      producer: { kind: "orchestrator", id: observation.id, name: "Observation Store" },
      trace: { trace_id: input.traceId, span_id: toolSpan.id, parent_span_id: input.parentSpanId },
      payload: {
        observation_id: observation.id,
        action_id: input.actionId,
        source_type: observation.sourceType,
        source_name: observation.sourceName,
        status: observation.status,
        summary: observation.summary,
      },
    });
    await completeTraceSpan(toolSpan.id, "failed", {
      action_id: input.actionId,
      tool_call_id: toolCallId,
      observation_id: observation.id,
      error: {
        message: error instanceof Error ? error.message : "Unknown tool error",
      },
    });
    return observation;
  }
}

async function publishActionEvent(input: {
  runId: string;
  conversationId: string;
  taskId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  eventType: "action.proposed" | "action.validated";
  actionId: string;
  action: AgentAction;
  toolCapabilities: ToolCapability[];
  modelProfile: string;
  stepIndex?: number;
}) {
  const toolName = input.action.type === "call_tool" ? input.action.toolName : null;
  const toolCapability = toolName ? input.toolCapabilities.find((tool) => tool.name === toolName) : undefined;

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: input.eventType,
    producer: { kind: "orchestrator", id: input.actionId, name: "AgentAction" },
    trace: { trace_id: input.traceId, span_id: input.spanId, parent_span_id: input.parentSpanId },
    payload: {
      action_id: input.actionId,
      action_type: input.action.type,
      tool_name: toolName,
      capability_kind: toolCapability?.capabilityKind ?? null,
      reason: "reason" in input.action ? input.action.reason : describeAction(input.action),
      model_profile: input.modelProfile,
      status: input.eventType === "action.proposed" ? "proposed" : "validated",
      step_index: input.stepIndex,
      action: input.action,
      policy_result: input.eventType === "action.validated" ? "allowed" : null,
      selected_tool_name: toolName,
    },
  });
}

async function publishObservationEvent(input: {
  runId: string;
  conversationId: string;
  taskId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  observation: Observation;
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

async function streamFinalModelResponse(input: {
  runId: string;
  taskId: string;
  conversationId: string;
  agentSessionId: string;
  traceId: string;
  parentSpanId: string;
  assistantMessageId: string;
  provider: ReturnType<typeof createModelProvider>;
  modelProfile: Awaited<ReturnType<typeof getModelProfile>> extends infer T ? NonNullable<T> : never;
  dateContext: string;
  history: ChatMessage[];
  latestUserMessage: string;
  observations: Observation[];
}) {
  const observationText = formatObservationsForModel(input.observations);
  const modelMessages = buildModelMessages({
    dateContext: input.dateContext,
    history: input.history,
    latestUserMessage: input.latestUserMessage,
    observations: observationText,
  });
  const maxOutputTokens = Number(process.env.DATASWARM_ORCHESTRATOR_MAX_TOKENS ?? 8192);

  logServer("info", "orchestrator.final_model.context_prepared", {
    runId: input.runId,
    conversationId: input.conversationId,
    modelProfile: input.modelProfile.id,
    modelMessageCount: modelMessages.length,
    historyMessageCount: input.history.length,
    observationCount: input.observations.length,
    latestUserTextLength: input.latestUserMessage.length,
    maxOutputTokens,
  });

  const modelSpan = await startTraceSpan({
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    spanKind: "model.call",
    name: "Orchestrator final answer model call",
    attributes: {
      model_profile: input.modelProfile.id,
      provider: input.modelProfile.provider,
      model: input.modelProfile.model,
      purpose: "orchestrator_response",
      model_message_count: modelMessages.length,
      history_message_count: input.history.length,
      observation_count: input.observations.length,
      max_output_tokens: maxOutputTokens,
    },
  });

  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "model.call.started",
    producer: { kind: "model", id: input.modelProfile.id, name: input.modelProfile.displayName },
    trace: { trace_id: input.traceId, span_id: modelSpan.id, parent_span_id: input.parentSpanId },
    payload: {
      model_call_id: modelSpan.id,
      provider: input.modelProfile.provider,
      model: input.modelProfile.model,
      model_profile: input.modelProfile.id,
      purpose: "orchestrator_response",
      input_summary: input.latestUserMessage.slice(0, 240),
      model_message_count: modelMessages.length,
      history_message_count: input.history.length,
      observation_count: input.observations.length,
      max_output_tokens: maxOutputTokens,
    },
  });

  let text = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const chunk of input.provider.streamChat({
    profile: input.modelProfile,
    purpose: "orchestrator_response",
    messages: modelMessages,
    maxOutputTokens,
  })) {
    if (chunk.type === "text-delta") {
      text += chunk.text;
      await streamTextToMessage({
        runId: input.runId,
        taskId: input.taskId,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId,
        agentSessionId: input.agentSessionId,
        traceId: input.traceId,
        spanId: modelSpan.id,
        parentSpanId: input.parentSpanId,
        text: chunk.text,
      });
    } else if (chunk.type === "usage") {
      inputTokens = chunk.inputTokens;
      outputTokens = chunk.outputTokens;
    }
  }

  await completeTraceSpan(modelSpan.id, "completed", {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    observation_ids: input.observations.map((observation) => observation.id),
    output_summary: text.slice(0, 240),
  });
  await publishRunEvent({
    runId: input.runId,
    conversationId: input.conversationId,
    taskId: input.taskId,
    type: "model.call.completed",
    producer: { kind: "model", id: input.modelProfile.id, name: input.modelProfile.displayName },
    trace: { trace_id: input.traceId, span_id: modelSpan.id, parent_span_id: input.parentSpanId },
    payload: {
      model_call_id: modelSpan.id,
      purpose: "orchestrator_response",
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_estimate: null,
      },
      output_summary: text.slice(0, 240),
      observation_ids: input.observations.map((observation) => observation.id),
    },
  });

  return { text, traceSpanId: modelSpan.id };
}

async function streamTextToMessage(input: {
  runId: string;
  taskId: string;
  conversationId: string;
  assistantMessageId: string;
  agentSessionId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  text: string;
}) {
  for (const uiDelta of splitTextForStreaming(input.text)) {
    await publishRunEvent({
      runId: input.runId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      type: "message.part.delta",
      producer: { kind: "orchestrator", id: input.agentSessionId, name: "Orchestrator" },
      trace: { trace_id: input.traceId, span_id: input.spanId, parent_span_id: input.parentSpanId },
      payload: {
        message_id: input.assistantMessageId,
        part_id: "part_text_1",
        delta: { text: uiDelta },
      },
    });
    if (input.text.length > uiDelta.length) {
      await delay(18);
    }
  }
}

function formatObservationsForModel(observations: Observation[]) {
  return observations.map((observation) => {
    const sources = Array.isArray(observation.metadata?.sources)
      ? observation.metadata.sources
          .slice(0, 8)
          .map((source) => {
            if (!source || typeof source !== "object") {
              return "";
            }
            const item = source as { title?: unknown; url?: unknown };
            return [item.title, item.url].filter(Boolean).join(" - ");
          })
          .filter(Boolean)
      : [];
    const claims = observation.claims
      .slice(0, 8)
      .map((claim, index) => {
        const refs = claim.sourceRefs
          .map((ref) => [ref.title, ref.url, ref.payloadPath].filter(Boolean).join(" - "))
          .filter(Boolean)
          .join("; ");
        return `  ${index + 1}. ${claim.claim}${refs ? ` (${refs})` : ""}`;
      })
      .join("\n");
    return [
      `${observation.id} [${observation.sourceType}:${observation.sourceName}] status=${observation.status} evidence=${observation.evidenceLevel}`,
      `Summary: ${observation.summary}`,
      `Source count: ${sources.length}`,
      sources.length > 0 ? `Sources:\n${sources.map((source, index) => `  ${index + 1}. ${source}`).join("\n")}` : "",
      observation.payloadUri ? `Payload: ${observation.payloadUri}` : "",
      claims ? `Claims:\n${claims}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
}

function ensureObservationEvidenceReferences(text: string, observations: Observation[]) {
  if (observations.length === 0) {
    return text;
  }
  const missingIds = observations.map((observation) => observation.id).filter((id) => !text.includes(id));
  if (missingIds.length === 0) {
    return text;
  }
  return `${text.trim()}\n\nEvidence observations: ${observations.map((observation) => observation.id).join(", ")}`;
}

function shouldReplanAfterObservation(input: {
  action: CallToolAction;
  observation: Observation;
  observations: Observation[];
  stepIndex: number;
  maxAgentSteps: number;
  freshWebEvidenceRequired: boolean;
  latestUserMessage: string;
}) {
  if (input.stepIndex >= input.maxAgentSteps) {
    return "";
  }
  if (input.observation.status !== "completed") {
    return `Observation ${input.observation.id} was not completed; replan with failure context.`;
  }
  if (isWebSearchObservation(input.observation)) {
    const sourceCount = observationSourceCount(input.observation);
    if (sourceCount === 0) {
      return `Web search observation ${input.observation.id} returned 0 sources; replan with a broader or alternative query.`;
    }
    const requiredDomains = extractRequiredSiteDomains(input.latestUserMessage);
    if (requiredDomains.length > 0 && !observationHasRequiredDomain(input.observation, requiredDomains)) {
      return `Web search observation ${input.observation.id} did not satisfy required site/domain constraint (${requiredDomains.join(", ")}); replan with the requested domain constraint or explain the constraint failure after exhausting the step budget.`;
    }
    if (input.freshWebEvidenceRequired && input.observations.filter(isWebSearchObservation).length === 1 && sourceCount < 2) {
      return `Fresh web evidence is required but only ${sourceCount} source was returned; replan for corroborating sources.`;
    }
  }
  return "";
}

function isWebSearchObservation(observation: Observation) {
  return (
    observation.sourceName === "web.search" ||
    observation.sourceName === "tavily.search" ||
    observation.metadata?.capability_kind === "web_search"
  );
}

function observationSourceCount(observation: Observation) {
  const sources = observation.metadata?.sources;
  return Array.isArray(sources) ? sources.length : 0;
}

function observationHasRequiredDomain(observation: Observation, requiredDomains: string[]) {
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

function describeAction(action: AgentAction) {
  if (action.type === "call_tool") {
    return `call_tool ${action.toolName}: ${action.reason}`;
  }
  if (action.type === "final_answer") {
    return `final_answer: ${action.content.slice(0, 160)}`;
  }
  if (action.type === "use_skill") {
    return `use_skill ${action.skillName}: ${action.reason}`;
  }
  if (action.type === "spawn_agent") {
    return `spawn_agent ${action.agentRole}: ${action.objective}`;
  }
  if (action.type === "spawn_swarm") {
    return `spawn_swarm ${action.strategy ?? "parallel_branch_then_merge"}: ${action.objective}`;
  }
  if (action.type === "create_artifact") {
    return `create_artifact ${action.artifactType}: ${action.title}`;
  }
  if (action.type === "ask_user") {
    return `ask_user: ${action.question}`;
  }
  return `think: ${action.summary}`;
}

function artifactActionToToolAction(action: CreateArtifactAction): CallToolAction {
  return {
    type: "call_tool",
    toolName: "artifact.create",
    input: {
      artifactType: action.artifactType,
      title: action.title,
      sourceObservationIds: action.sourceObservationIds,
      instructions: action.instructions,
    },
    reason: `Create ${action.artifactType} artifact: ${action.title}`,
    expectedEvidence: ["persisted artifact record", "artifact preview uri"],
    fallbackToolNames: [],
  };
}

function extractArtifactIdsFromObservation(observation: Observation) {
  const artifactIds = observation.metadata?.artifact_ids;
  if (!Array.isArray(artifactIds)) {
    return [];
  }
  return artifactIds.map(String).filter(Boolean);
}

function observationStatusToActionStatus(status: Observation["status"]) {
  if (status === "completed") {
    return "executed";
  }
  if (status === "blocked") {
    return "blocked";
  }
  return "failed";
}

function summarizeToolInput(input: Record<string, unknown>) {
  return JSON.stringify(input).slice(0, 240);
}

type ConversationMessageLike = {
  role: string;
  parts: unknown[];
};

function toChatMessages(messages: ConversationMessageLike[]): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: extractTextFromParts(message.parts).trim(),
    }))
    .filter((message) => message.content.length > 0);
}

function extractTextFromParts(parts: unknown[]) {
  return parts
    .map((part) => {
      if (typeof part !== "object" || part === null) {
        return "";
      }
      if (!("type" in part) || !("text" in part)) {
        return "";
      }
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function findLastUserMessageIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return index;
    }
  }
  return -1;
}

function trimChatHistory(messages: ChatMessage[]) {
  const maxMessages = 12;
  const maxChars = 16000;
  const selected: ChatMessage[] = [];
  let totalChars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const nextTotal = totalChars + message.content.length;
    if (selected.length >= maxMessages || nextTotal > maxChars) {
      break;
    }
    selected.unshift(message);
    totalChars = nextTotal;
  }

  return selected;
}

function shouldRequireFreshWebEvidence(messages: ChatMessage[], latestUserMessage: string) {
  const latest = latestUserMessage.toLowerCase();
  if (/搜索|联网|查询|新闻|research|web|tavily|source|来源|latest|recent|news/.test(latest)) {
    return true;
  }
  if (!requiresFreshWebEvidence(latestUserMessage)) {
    return false;
  }
  if (isFollowUpMessage(latestUserMessage)) {
    return true;
  }
  const latestUserIndex = findLastUserMessageIndex(messages);
  const priorContext = messages
    .slice(0, Math.max(latestUserIndex, 0))
    .map((message) => message.content)
    .join("\n")
    .toLowerCase();
  return /搜索|联网|查询|新闻|research|web|tavily|source|来源|检索/.test(priorContext);
}

function isFollowUpMessage(message: string) {
  return /继续|接着|上面|刚才|之前|前面|前几|上轮|上一轮|上一季|前作|前几部|最近|进展|follow\s*up|continue|previous|above|recent|latest/.test(
    message.toLowerCase(),
  );
}

function requiresFreshWebEvidence(message: string) {
  return /表现|口碑|评分|播放量|播放|追番|热度|数据|来源|证据|事实|进展|历史|各季|系列|评价|怎么样|如何|排名|对比|票房|营收|价格|股价|趋势/.test(
    message.toLowerCase(),
  );
}

function buildModelMessages(input: {
  dateContext: string;
  history: ChatMessage[];
  latestUserMessage: string;
  observations: string[];
}): ChatMessage[] {
  const latestUserContent =
    input.observations.length > 0
      ? `${input.latestUserMessage}\n\nDataSwarm observations:\n${input.observations.join("\n\n")}`
      : input.latestUserMessage;

  return [
    {
      role: "system",
      content: [
        "You are DataSwarm Orchestrator, the entry agent for a multi-agent research, data, and execution workspace.",
        `Current date context: ${input.dateContext}.`,
        "",
        "Response contract:",
        "1. Answer in the user's language unless they ask otherwise.",
        "2. Treat prior user and assistant messages as working memory. Resolve follow-ups, pronouns, numbered references, and phrases such as '继续', '上面', '刚才', '我刚才问了几个问题', and '最近一周' from the provided history.",
        "3. Use DataSwarm observations as the only evidence for tool-backed claims. Observations may come from tools, skills, swarm branches, artifacts, or diagnostics.",
        "4. Never invent sources, tool results, files, artifacts, versions, dates, prices, metrics, or trace findings.",
        "5. You may say you searched, queried, generated, diagnosed, or used a tool only when a completed Observation explicitly supports it. Cite relevant Observation IDs.",
        "6. For web research, cite concrete source titles and URLs from observations. Separate high-confidence findings from weak, off-topic, duplicated, or constraint-mismatched sources.",
        "7. If evidence is weak, empty, or contradictory, say exactly what is missing and give the best bounded conclusion. Do not pretend the task succeeded.",
        "8. If a user requested a report/artifact, summarize the produced artifact purpose and provenance. Do not dump raw HTML/CSS unless the user asks for source.",
        "9. For complex tasks, structure the answer as: conclusion, evidence, limitations, useful next actions.",
        "10. Do not ask for confirmation before using already available low-risk tools; the runtime should have executed them before this final answer.",
        "11. Do not end with generic confirmation prompts such as '请告诉我', '是否需要我', '如果你想', or '回复我再继续'. Give specific next-step options instead.",
        "12. Be concise for simple chat, but do not truncate substantive analysis, reports, or multi-part answers.",
        "",
        "Capability boundary:",
        "- The planner action protocol chooses skills and tools before this response.",
        "- Active skills are guidance, not evidence.",
        "- Tool names should appear only when the user named them or an Observation shows they ran.",
      ].join("\n"),
    },
    ...input.history,
    {
      role: "user",
      content: latestUserContent,
    },
  ];
}

function splitTextForStreaming(text: string) {
  const maxChars = 44;
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    const next = text.slice(index, index + maxChars);
    const breakAt = Math.max(next.lastIndexOf("，"), next.lastIndexOf("。"), next.lastIndexOf(" "), next.lastIndexOf("\n"));
    const size = breakAt > 16 ? breakAt + 1 : maxChars;
    chunks.push(text.slice(index, index + size));
    index += size;
  }
  return chunks;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kept temporarily for the upcoming artifact.create adapter migration.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildMarkdownReport(input: {
  title: string;
  prompt: string;
  responseText: string;
  sources: TavilySource[];
  dateContext: string;
  generatedFromNewWebSearch: boolean;
}) {
  const reportBody = cleanResponseForReport(input.responseText);
  return [
    `# ${input.title}`,
    "",
    "## Objective",
    "",
    input.prompt,
    "",
    "## Executive Summary",
    "",
    reportBody || "No assistant synthesis was captured for this run.",
    "",
    "## Evidence Sources",
    "",
    ...(input.sources.length > 0
      ? input.sources.map((source, index) => `${index + 1}. [${source.title}](${source.url}) - ${source.content}`)
      : [
          input.generatedFromNewWebSearch
            ? "No Tavily sources were returned in this run."
            : "No new web tool call was recorded in this run; this artifact is based on the assistant synthesis and conversation context.",
        ]),
    "",
    "## Provenance And Reliability Notes",
    "",
    `- Generated by DataSwarm Orchestrator on ${input.dateContext}.`,
    `- New web search in this run: ${input.generatedFromNewWebSearch ? "yes" : "no"}.`,
    "- Artifact versions are immutable.",
    "- Source trace is linked from the artifact metadata.",
  ].join("\n");
}

// Kept temporarily for the upcoming artifact.create adapter migration.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildHtmlReport(input: {
  title: string;
  prompt: string;
  responseText: string;
  sources: TavilySource[];
  dateContext: string;
  generatedFromNewWebSearch: boolean;
}) {
  const reportBody = cleanResponseForReport(input.responseText);
  const sourceItems =
    input.sources.length > 0
      ? input.sources
          .map(
            (source, index) => `<article class="source-card">
              <div class="source-index">${index + 1}</div>
              <div>
                <h3><a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a></h3>
                <p>${escapeHtml(source.content)}</p>
                <code>${escapeHtml(source.url)}</code>
              </div>
            </article>`,
          )
          .join("")
      : `<p class="empty-note">${
          input.generatedFromNewWebSearch
            ? "No Tavily sources were returned in this run."
            : "No new web tool call was recorded in this run; this artifact is based on the assistant synthesis and conversation context."
        }</p>`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root { color-scheme: light; --ink:#17212b; --muted:#5f6b7a; --line:#dce4ee; --soft:#f5f8fb; --brand:#087568; --brand-soft:#e6f4f1; --warn:#9a5b00; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #f7f9fc; color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.62; }
      .page { max-width: 1120px; margin: 0 auto; padding: 40px 28px 56px; }
      header { border-bottom: 1px solid var(--line); padding-bottom: 22px; margin-bottom: 24px; }
      .eyebrow { color: var(--brand); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 8px 0 10px; font-size: 34px; line-height: 1.15; color: #0d3f39; }
      h2 { margin: 28px 0 12px; font-size: 20px; color: #10202e; }
      h3 { margin: 0 0 4px; font-size: 15px; }
      .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; color: var(--muted); font-size: 13px; }
      .pill { border: 1px solid var(--line); border-radius: 999px; background: white; padding: 4px 10px; }
      section { background: white; border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-top: 16px; }
      .objective { font-size: 16px; font-weight: 600; }
      .synthesis :is(h1,h2,h3) { color: #10202e; }
      .synthesis table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px; }
      .synthesis th, .synthesis td { border: 1px solid var(--line); padding: 8px 10px; vertical-align: top; }
      .synthesis th { background: var(--soft); text-align: left; }
      .synthesis code, code { background: var(--soft); border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px; color: #22303c; }
      .source-list { display: grid; gap: 10px; }
      .source-card { display: grid; grid-template-columns: 36px minmax(0,1fr); gap: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfdff; }
      .source-index { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: var(--brand-soft); color: var(--brand); font-weight: 700; }
      .source-card p { margin: 4px 0 8px; color: var(--muted); }
      a { color: var(--brand); text-decoration-thickness: 1px; text-underline-offset: 3px; }
      .empty-note { margin: 0; color: var(--warn); background: #fff8e8; border: 1px solid #f1d99f; border-radius: 8px; padding: 10px 12px; }
      .provenance { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; color: var(--muted); }
      @media (max-width: 720px) { .page { padding: 24px 14px 40px; } h1 { font-size: 26px; } section { padding: 14px; } }
    </style>
  </head>
  <body>
    <main class="page">
      <header>
        <div class="eyebrow">DataSwarm Analysis Artifact</div>
        <h1>${escapeHtml(input.title)}</h1>
        <div class="meta">
          <span class="pill">Generated: ${escapeHtml(input.dateContext)}</span>
          <span class="pill">New web search: ${input.generatedFromNewWebSearch ? "yes" : "no"}</span>
          <span class="pill">Sources: ${input.sources.length}</span>
        </div>
      </header>
      <section>
        <h2>Objective</h2>
        <p class="objective">${escapeHtml(input.prompt)}</p>
      </section>
      <section>
        <h2>Assistant Synthesis</h2>
        <div class="synthesis">${markdownToHtml(reportBody || "No assistant synthesis was captured for this run.")}</div>
      </section>
      <section>
        <h2>Evidence Sources</h2>
        <div class="source-list">${sourceItems}</div>
      </section>
      <section>
        <h2>Provenance And Reliability Notes</h2>
        <ul class="provenance">
          <li>Generated by DataSwarm Orchestrator after the model response completed.</li>
          <li>Artifact versions are immutable and linked to run trace metadata.</li>
          <li>Claims should be treated as grounded only when matched to listed sources or prior conversation evidence.</li>
        </ul>
      </section>
    </main>
  </body>
</html>`;
}

// Kept temporarily for the upcoming artifact.create adapter migration.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function inferReportTitle(latestUserMessage: string, history: ChatMessage[]) {
  const recentText = [latestUserMessage, ...history.slice(-4).map((message) => message.content)].join("\n");
  const explicitEnglish = /\b(OpenAI Agent SDK|OpenAI Agents SDK|Hermes Agent|NVIDIA|DeepSeek|DataSwarm|OpenClaw|opencode)\b/i.exec(recentText)?.[1];
  const topic =
    explicitEnglish ??
    extractChineseReportTopic(recentText) ??
    (/\b(NVIDIA|Hermes Agent|DataSwarm|OpenClaw|opencode|DeepSeek)\b/i.exec(recentText)?.[1] ?? "DataSwarm Analysis");
  if (/管理层摘要|executive summary/i.test(latestUserMessage)) {
    return `${topic} 管理层摘要`;
  }
  if (/验证清单|校验|核验|verify|validation/i.test(latestUserMessage)) {
    return `${topic} 验证报告`;
  }
  if (/html|报告|report/i.test(latestUserMessage)) {
    return `${topic} 分析报告`;
  }
  return `${topic} 分析报告`;
}

function cleanResponseForReport(text: string) {
  return text
    .replace(/```html[\s\S]*?```/gi, "\n\n> Raw HTML code block omitted because the rendered HTML artifact is generated by DataSwarm.\n\n")
    .replace(/```css[\s\S]*?```/gi, "\n\n> Raw CSS code block omitted because styling is owned by the artifact renderer.\n\n")
    .replace(/<(!doctype|html|head|body|style|script)[\s\S]*?<\/html>/gi, "\n\n> Raw HTML block omitted because the rendered HTML artifact is generated by DataSwarm.\n\n")
    .trim();
}

function extractChineseReportTopic(text: string) {
  const patterns = [
    /把\s*([\u4e00-\u9fa5A-Za-z0-9\s-]{2,28}?)(?:报告|调研|新闻)/,
    /([\u4e00-\u9fa5A-Za-z0-9\s-]{2,28}?)(?:相关)?(?:新闻|调研|分析|报告|验证清单)/,
    /(?:检索|搜索|调研|分析|关于)\s*([\u4e00-\u9fa5A-Za-z0-9\s-]{2,28}?)(?:相关|的|新闻|报告|，|,|。|$)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      const topic = match[1]
        .replace(/^(本次|当前|完整|管理层|下一轮|HTML|Markdown)\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (topic && !/^(DataSwarm Analysis|HTML|Markdown|Tavily)$/i.test(topic)) {
        return topic;
      }
    }
  }
  return null;
}

function markdownToHtml(markdown: string) {
  const lines = markdown.split("\n");
  const html: string[] = [];
  let listOpen = false;
  let paragraph: string[] = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      html.push(`<p>${inlineMarkdownToHtml(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  }

  function closeList() {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
      continue;
    }
    if (isMarkdownTableLine(trimmed) && isMarkdownTableSeparator(lines[index + 1]?.trim() ?? "")) {
      flushParagraph();
      closeList();
      const headers = splitMarkdownTableRow(trimmed);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isMarkdownTableLine(lines[index].trim())) {
        rows.push(splitMarkdownTableRow(lines[index].trim()));
        index += 1;
      }
      index -= 1;
      html.push(renderHtmlTable(headers, rows));
      continue;
    }
    if (isMarkdownTableLine(trimmed)) {
      flushParagraph();
      closeList();
      html.push(`<pre>${escapeHtml(trimmed)}</pre>`);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inlineMarkdownToHtml(bullet[1])}</li>`);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  closeList();
  return html.join("\n");
}

function isMarkdownTableLine(line: string) {
  return /^\|.*\|$/.test(line);
}

function isMarkdownTableSeparator(line: string) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}

function splitMarkdownTableRow(line: string) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderHtmlTable(headers: string[], rows: string[][]) {
  const headerHtml = headers.map((header) => `<th>${inlineMarkdownToHtml(header)}</th>`).join("");
  const bodyHtml = rows
    .map((row) => `<tr>${headers.map((_, index) => `<td>${inlineMarkdownToHtml(row[index] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

function inlineMarkdownToHtml(value: string) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function currentDateContext() {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  });
  return formatter.format(new Date());
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
