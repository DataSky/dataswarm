import { executeToolAction } from "../tools/registry";
import { mergeArtifactMetadata } from "../repositories/artifacts";
import { createObservation } from "../repositories/observations";
import { publishRunEvent } from "./event-bus";
import type { CallToolAction } from "./agentic-types";
import type { SandboxToolProxyClaims } from "./sandbox-tool-proxy";

export type CapabilityManifestEntry = {
  name: string;
  description: string;
  capability: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  executionMode: "local" | "parent_proxy" | "public_http" | "sandbox_embedded" | "mcp";
  permissionPolicy: "branch_scoped";
  secretPolicy: "no_secrets" | "parent_only";
  artifactPolicy: "none" | "allowed";
  tracePolicy: "required";
  risk: "low" | "medium" | "high";
};

const CAPABILITY_MANIFEST: CapabilityManifestEntry[] = [
  {
    name: "web.search",
    description: "Search the web through the parent capability runtime and persist sources as evidence.",
    capability: "web_search",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    outputSchema: { type: "object", properties: { sources: { type: "array" } } },
    executionMode: "parent_proxy",
    permissionPolicy: "branch_scoped",
    secretPolicy: "parent_only",
    artifactPolicy: "none",
    tracePolicy: "required",
    risk: "low",
  },
  {
    name: "file.read",
    description: "Read an allowlisted workspace file through the parent capability runtime.",
    capability: "file_read",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    outputSchema: { type: "object", properties: { excerpt: { type: "string" } } },
    executionMode: "parent_proxy",
    permissionPolicy: "branch_scoped",
    secretPolicy: "no_secrets",
    artifactPolicy: "none",
    tracePolicy: "required",
    risk: "medium",
  },
  {
    name: "artifact.create",
    description: "Create Markdown, HTML, JSON, or image-metadata artifacts in the parent artifact store with source observation links.",
    capability: "artifact_create",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        type: {
          type: "string",
          enum: ["markdown", "html", "json", "application/json", "structured_json", "image_metadata", "image.metadata", "image-meta"],
        },
        artifactType: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        markdown: { type: "string" },
        html: { type: "string" },
        json: {},
        data: {},
        object: {},
        image_metadata: {},
        imageMetadata: {},
        sourceObservationIds: { type: "array", items: { type: "string" } },
        imageArtifactIds: { type: "array", items: { type: "string" } },
        previewUri: { type: "string" },
        mimeType: { type: "string" },
        instructions: { type: "string" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        artifact_id: { type: "string" },
        artifactIds: { type: "array", items: { type: "string" } },
        previewUri: { type: "string" },
        mimeType: { type: "string" },
        artifactKind: { type: "string" },
      },
    },
    executionMode: "parent_proxy",
    permissionPolicy: "branch_scoped",
    secretPolicy: "no_secrets",
    artifactPolicy: "allowed",
    tracePolicy: "required",
    risk: "low",
  },
  {
    name: "run_python",
    description: "Generate a sandbox-requested Python-style image artifact through the parent capability runtime.",
    capability: "run_python",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        purpose: { type: "string" },
        code: { type: "string" },
        python: { type: "string" },
        script: { type: "string" },
        chart_type: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        values: { type: "array", items: { type: "number" } },
        data: { type: "array" },
        svg: { type: "string" },
        content_base64: { type: "string" },
        mime_type: { type: "string" },
        sourceObservationIds: { type: "array", items: { type: "string" } },
      },
    },
    outputSchema: { type: "object", properties: { artifact_id: { type: "string" }, mime_type: { type: "string" } } },
    executionMode: "parent_proxy",
    permissionPolicy: "branch_scoped",
    secretPolicy: "no_secrets",
    artifactPolicy: "allowed",
    tracePolicy: "required",
    risk: "medium",
  },
  {
    name: "trace.query",
    description: "Query conversation diagnostics through the parent trace runtime.",
    capability: "trace_query",
    inputSchema: { type: "object", properties: { conversation_id: { type: "string" }, run_id: { type: "string" } } },
    outputSchema: { type: "object", properties: { diagnostic: { type: "object" } } },
    executionMode: "parent_proxy",
    permissionPolicy: "branch_scoped",
    secretPolicy: "no_secrets",
    artifactPolicy: "none",
    tracePolicy: "required",
    risk: "low",
  },
];

export function buildCapabilityManifest(allowedTools: string[]) {
  const allowed = new Set(allowedTools);
  return CAPABILITY_MANIFEST.filter((capability) => allowed.has(capability.name));
}

export async function invokeSandboxCapability(input: {
  claims: SandboxToolProxyClaims;
  actionId: string;
  capabilityName: string;
  capabilityInput: Record<string, unknown>;
  legacyEventPrefix?: "sandbox.tool_proxy.call";
}) {
  if (!input.claims.allowedTools.includes(input.capabilityName)) {
    throw new Error(`Sandbox capability is not allowed for this branch: ${input.capabilityName}`);
  }

  const startedPayload = {
    branch_id: input.claims.branchId,
    sandbox_session_id: input.claims.sandboxSessionId,
    sandbox_action_id: input.actionId,
    capability_name: input.capabilityName,
    tool_name: input.capabilityName,
    input_summary: summarizeCapabilityInput(input.capabilityInput),
    capability_plane: {
      version: "dataswarm.capability-plane.v4",
      execution_mode: "parent_proxy",
    },
  };

  await publishCapabilityEvent(input.claims, "capability.invoke.started", startedPayload);
  if (input.legacyEventPrefix) {
    await publishCapabilityEvent(input.claims, `${input.legacyEventPrefix}.started`, startedPayload);
  }

  let createdToolCallId = "";
  try {
    const action: CallToolAction = {
      type: "call_tool",
      toolName: input.capabilityName,
      input: input.capabilityInput,
      reason: `Sandbox branch ${input.claims.branchId} requested ${input.capabilityName} through the DataSwarm capability plane.`,
      expectedEvidence: ["Sandbox branch observation"],
    };
    const result = await executeToolAction({
      runId: input.claims.runId,
      agentSessionId: input.claims.agentSessionId,
      traceSpanId: input.claims.traceSpanId,
      conversationId: input.claims.conversationId,
      action,
      toolCallMetadata: {
        branch_id: input.claims.branchId,
        branchId: input.claims.branchId,
        sandbox_session_id: input.claims.sandboxSessionId,
        sandboxSessionId: input.claims.sandboxSessionId,
        sandbox_action_id: input.actionId,
        sandboxActionId: input.actionId,
        capability_name: input.capabilityName,
        capabilityName: input.capabilityName,
        tool_name: input.capabilityName,
        toolName: input.capabilityName,
        capability_plane_version: "dataswarm.capability-plane.v4",
        execution_mode: "parent_proxy",
      },
      onToolCallCreated: async (toolCallId) => {
        createdToolCallId = toolCallId;
      },
    });
    const observation = await createObservation({
      runId: input.claims.runId,
      actionId: input.actionId,
      sourceType: "tool",
      sourceName: `sandbox.proxy.${input.capabilityName}`,
      status: result.observationStatus ?? "completed",
      summary: result.outputSummary,
      payloadUri: result.payloadUri,
      evidenceLevel: result.evidenceLevel,
      claims: result.claims ?? [],
      metadata: {
        branch_id: input.claims.branchId,
        sandbox_session_id: input.claims.sandboxSessionId,
        sandbox_action_id: input.actionId,
        tool_call_id: result.toolCallId,
        tool_name: input.capabilityName,
        capability_name: input.capabilityName,
        capability_plane_version: "dataswarm.capability-plane.v4",
        provider: result.provider,
        logical_tool_name: result.logicalToolName,
        provider_tool_name: result.providerToolName,
        sources: result.sources,
        artifacts: result.artifacts,
      },
    });
    await publishCapabilityEvent(input.claims, "sandbox.agent.observation", {
      branch_id: input.claims.branchId,
      sandbox_session_id: input.claims.sandboxSessionId,
      sandbox_action_id: input.actionId,
      capability_name: input.capabilityName,
      tool_name: input.capabilityName,
      tool_call_id: result.toolCallId,
      observation_id: observation.id,
      status: observation.status,
      summary: observation.summary,
      evidence_level: observation.evidenceLevel,
      payload_uri: observation.payloadUri,
      capability_plane: {
        version: "dataswarm.capability-plane.v4",
        execution_mode: "parent_proxy",
      },
    });

    for (const artifact of result.artifacts ?? []) {
      await mergeArtifactMetadata(artifact.id, {
        branchIds: [input.claims.branchId],
        sourceObservationIds: [observation.id],
        latestCapabilityObservationId: observation.id,
        latestSandboxActionId: input.actionId,
        producerActionId: input.actionId,
        latestSandboxSessionId: input.claims.sandboxSessionId,
        sandboxSessionId: input.claims.sandboxSessionId,
        toolCallId: result.toolCallId,
        producerToolCallId: result.toolCallId,
        createdByToolCallId: result.toolCallId,
        capabilityName: input.capabilityName,
        capabilityPlaneVersion: "dataswarm.capability-plane.v4",
        producer: {
          kind: "capability",
          capabilityName: input.capabilityName,
          toolCallId: result.toolCallId,
          branchId: input.claims.branchId,
          sandboxSessionId: input.claims.sandboxSessionId,
          sandboxActionId: input.actionId,
          agentSessionId: input.claims.agentSessionId,
        },
      });
    }

    const completedPayload = {
      branch_id: input.claims.branchId,
      sandbox_session_id: input.claims.sandboxSessionId,
      sandbox_action_id: input.actionId,
      capability_name: input.capabilityName,
      tool_name: input.capabilityName,
      tool_call_id: result.toolCallId,
      observation_id: observation.id,
      output_summary: result.outputSummary,
      execution_mode: result.executionMode,
      evidence_level: result.evidenceLevel,
      payload_uri: result.payloadUri,
      artifacts: result.artifacts,
      capability_plane: {
        version: "dataswarm.capability-plane.v4",
        execution_mode: "parent_proxy",
      },
    };

    await publishCapabilityEvent(input.claims, "capability.invoke.completed", completedPayload);
    if (input.legacyEventPrefix) {
      await publishCapabilityEvent(input.claims, `${input.legacyEventPrefix}.completed`, completedPayload);
    }

    return {
      status: observation.status,
      observation: {
        id: observation.id,
        sourceType: observation.sourceType,
        sourceName: observation.sourceName,
        status: observation.status,
        summary: observation.summary,
        payloadUri: observation.payloadUri,
        evidenceLevel: observation.evidenceLevel,
        claims: observation.claims,
        metadata: observation.metadata,
      },
      toolCallId: result.toolCallId,
      payloadUri: result.payloadUri,
      artifacts: result.artifacts ?? [],
      capability: {
        name: input.capabilityName,
        planeVersion: "dataswarm.capability-plane.v4",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Capability invocation failed.";
    const failedObservation = await createObservation({
      runId: input.claims.runId,
      actionId: input.actionId,
      sourceType: "tool",
      sourceName: `sandbox.proxy.${input.capabilityName}`,
      status: "failed",
      summary: `Sandbox capability ${input.capabilityName} failed for branch ${input.claims.branchId}: ${message}`,
      evidenceLevel: "real",
      claims: [
        {
          claim: `Capability ${input.capabilityName} failed before producing a successful tool observation.`,
          support: "direct",
          sourceRefs: [{ payloadPath: `tool_call:${createdToolCallId || "unknown"}` }],
        },
      ],
      metadata: {
        branch_id: input.claims.branchId,
        sandbox_session_id: input.claims.sandboxSessionId,
        sandbox_action_id: input.actionId,
        tool_call_id: createdToolCallId || undefined,
        tool_name: input.capabilityName,
        capability_name: input.capabilityName,
        capability_plane_version: "dataswarm.capability-plane.v4",
        error: {
          code: "capability_invoke_failed",
          message,
        },
      },
    });
    await publishCapabilityEvent(input.claims, "sandbox.agent.observation", {
      branch_id: input.claims.branchId,
      sandbox_session_id: input.claims.sandboxSessionId,
      sandbox_action_id: input.actionId,
      capability_name: input.capabilityName,
      tool_name: input.capabilityName,
      tool_call_id: createdToolCallId || "",
      observation_id: failedObservation.id,
      status: failedObservation.status,
      summary: failedObservation.summary,
      evidence_level: failedObservation.evidenceLevel,
      capability_plane: {
        version: "dataswarm.capability-plane.v4",
        execution_mode: "parent_proxy",
      },
      error: {
        code: "capability_invoke_failed",
        message,
      },
    });
    const failedPayload = {
      branch_id: input.claims.branchId,
      sandbox_session_id: input.claims.sandboxSessionId,
      sandbox_action_id: input.actionId,
      capability_name: input.capabilityName,
      tool_name: input.capabilityName,
      tool_call_id: createdToolCallId || "",
      observation_id: failedObservation.id,
      error: {
        code: "capability_invoke_failed",
        message,
      },
      capability_plane: {
        version: "dataswarm.capability-plane.v4",
        execution_mode: "parent_proxy",
      },
    };
    await publishCapabilityEvent(input.claims, "capability.invoke.failed", failedPayload);
    if (input.legacyEventPrefix) {
      await publishCapabilityEvent(input.claims, `${input.legacyEventPrefix}.failed`, failedPayload);
    }
    throw error;
  }
}

async function publishCapabilityEvent(
  claims: SandboxToolProxyClaims,
  type: string,
  payload: Record<string, unknown>,
) {
  await publishRunEvent({
    runId: claims.runId,
    conversationId: claims.conversationId,
    taskId: claims.taskId,
    type,
    producer: { kind: "agent", id: claims.agentSessionId, name: `Sandbox ${claims.branchId}` },
    trace: { trace_id: claims.traceId, span_id: claims.traceSpanId },
    payload,
  });
}

function summarizeCapabilityInput(input: Record<string, unknown>) {
  return JSON.stringify(input).slice(0, 500);
}
