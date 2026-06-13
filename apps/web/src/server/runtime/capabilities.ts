import { executeToolAction } from "../tools/registry";
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
    description: "Create Markdown or HTML artifacts in the parent artifact store with source observation links.",
    capability: "artifact_create",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: { type: { type: "string" }, artifactType: { type: "string" }, title: { type: "string" } },
    },
    outputSchema: { type: "object", properties: { artifact_id: { type: "string" } } },
    executionMode: "parent_proxy",
    permissionPolicy: "branch_scoped",
    secretPolicy: "no_secrets",
    artifactPolicy: "allowed",
    tracePolicy: "required",
    risk: "low",
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
      capability: {
        name: input.capabilityName,
        planeVersion: "dataswarm.capability-plane.v4",
      },
    };
  } catch (error) {
    const failedPayload = {
      branch_id: input.claims.branchId,
      sandbox_session_id: input.claims.sandboxSessionId,
      sandbox_action_id: input.actionId,
      capability_name: input.capabilityName,
      tool_name: input.capabilityName,
      error: {
        code: "capability_invoke_failed",
        message: error instanceof Error ? error.message : "Capability invocation failed.",
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
