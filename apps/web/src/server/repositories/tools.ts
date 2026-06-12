import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";
import type { ToolCapability, ToolCapabilityKind } from "../runtime/agentic-types";

export type ToolRecord = {
  id: string;
  name: string;
  kind: string;
  riskLevel: string;
  enabled: boolean;
};

type ToolRow = {
  id: string;
  name: string;
  kind: string;
  risk_level: string;
  enabled: number;
};

export async function getToolByName(name: string): Promise<ToolRecord | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT id, name, kind, risk_level, enabled
       FROM tools
       WHERE name = ? AND tenant_id = ?`,
    )
    .get(name, defaults.tenantId) as ToolRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    riskLevel: row.risk_level,
    enabled: row.enabled === 1,
  };
}

export async function listToolCapabilities(): Promise<ToolCapability[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, name, kind, schema_json, risk_level, enabled, metadata_json
       FROM tools
       WHERE tenant_id = ?
       ORDER BY name ASC`,
    )
    .all(defaults.tenantId) as Array<{
      id: string;
      name: string;
      kind: string;
      schema_json: string;
      risk_level: "low" | "medium" | "high";
      enabled: number;
      metadata_json: string | null;
    }>;

  return rows.map((row) => {
    const schema = parseJson(row.schema_json);
    const metadata = parseJson(row.metadata_json);
    const adapterStatus = inferAdapterStatus(row.name, row.enabled === 1, metadata);
    return {
      id: row.id,
      name: row.name,
      displayName: String(metadata.displayName ?? row.name),
      description: String(metadata.description ?? defaultToolDescription(row.name)),
      provider: String(metadata.provider ?? inferProvider(row.name)),
      adapterStatus,
      capabilityKind: String(metadata.capabilityKind ?? inferCapabilityKind(row.name)) as ToolCapabilityKind,
      inputSchema: isRecord(schema.input) ? schema.input : { type: "object" },
      outputSchema: isRecord(schema.output) ? schema.output : { type: "object" },
      riskLevel: row.risk_level,
      requiresApproval: Boolean(metadata.requiresApproval ?? row.risk_level !== "low"),
      authStatus: inferAuthStatus(row.name, metadata),
      freshness: inferFreshness(row.name, metadata),
      costHint: inferCostHint(metadata),
      latencyHintMs: inferLatencyHintMs(metadata),
      evidenceKind: inferEvidenceKind(String(metadata.evidenceKind ?? ""), row.name),
      enabled: row.enabled === 1,
    };
  });
}

export async function createToolCall(input: {
  runId: string;
  agentSessionId?: string;
  toolId: string;
  traceSpanId?: string;
  status: string;
  inputSummary?: string;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("tc");

  db.prepare(
    `INSERT INTO tool_calls
     (id, tenant_id, project_id, run_id, agent_session_id, tool_id, trace_span_id, status, input_summary, output_summary, input_payload_uri, output_payload_uri, started_at, ended_at, error_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    input.agentSessionId ?? null,
    input.toolId,
    input.traceSpanId ?? null,
    input.status,
    input.inputSummary ?? null,
    null,
    null,
    null,
    input.status === "running" ? now : null,
    null,
    null,
    "{}",
    now,
    now,
  );

  return { id };
}

export async function updateToolCall(input: {
  id: string;
  status: string;
  outputSummary?: string;
  outputPayloadUri?: string;
  error?: unknown;
}) {
  const db = await getDb();
  const now = nowIso();
  db.prepare(
    `UPDATE tool_calls
     SET status = ?, output_summary = COALESCE(?, output_summary), output_payload_uri = COALESCE(?, output_payload_uri), ended_at = ?, error_json = COALESCE(?, error_json), updated_at = ?
     WHERE id = ?`,
  ).run(
    input.status,
    input.outputSummary ?? null,
    input.outputPayloadUri ?? null,
    now,
    input.error ? JSON.stringify(input.error) : null,
    now,
    input.id,
  );
}

function parseJson(value: string | null): Record<string, unknown> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferCapabilityKind(name: string): ToolCapabilityKind {
  if (name === "web.search" || name === "tavily.search") {
    return "web_search";
  }
  if (name === "artifact.create") {
    return "artifact_create";
  }
  if (name === "trace.query") {
    return "trace_query";
  }
  if (name === "file.read") {
    return "file_read";
  }
  if (name === "approval.request") {
    return "approval";
  }
  return "custom";
}

function inferProvider(name: string) {
  if (name === "web.search") {
    return "dataswarm";
  }
  if (name === "tavily.search") {
    return "tavily";
  }
  if (name.startsWith("artifact.")) {
    return "dataswarm";
  }
  if (name.startsWith("trace.")) {
    return "dataswarm";
  }
  if (name.startsWith("approval.")) {
    return "dataswarm";
  }
  return "custom";
}

function inferAdapterStatus(name: string, enabled: boolean, metadata: Record<string, unknown>): ToolCapability["adapterStatus"] {
  const value = metadata.adapterStatus;
  if (value === "implemented" || value === "planned" || value === "disabled") {
    return value;
  }
  if (!enabled) {
    return "disabled";
  }
  if (
    name === "web.search" ||
    name === "tavily.search" ||
    name === "trace.query" ||
    name === "artifact.create" ||
    name === "approval.request" ||
    name === "file.read"
  ) {
    return "implemented";
  }
  return "planned";
}

function inferAuthStatus(name: string, metadata: Record<string, unknown>): ToolCapability["authStatus"] {
  const value = metadata.authStatus;
  if (value === "available" || value === "missing_credentials" || value === "not_configured") {
    return value;
  }
  if (name === "web.search" || name === "tavily.search") {
    return process.env.TAVILY_API_KEY || process.env.DATASWARM_MOCK_TOOLS === "1" ? "available" : "missing_credentials";
  }
  return "available";
}

function inferFreshness(name: string, metadata: Record<string, unknown>): ToolCapability["freshness"] {
  const value = metadata.freshness;
  if (value === "realtime" || value === "near_realtime" || value === "static" || value === "local") {
    return value;
  }
  if (name === "web.search" || name === "tavily.search") {
    return "near_realtime";
  }
  if (name.startsWith("trace.") || name.startsWith("artifact.") || name.startsWith("approval.")) {
    return "local";
  }
  if (name === "file.read") {
    return "local";
  }
  return "static";
}

function inferCostHint(metadata: Record<string, unknown>): ToolCapability["costHint"] | undefined {
  const value = metadata.costHint;
  if (value === "free" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function inferLatencyHintMs(metadata: Record<string, unknown>): number | undefined {
  const value = metadata.latencyHintMs;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inferEvidenceKind(value: string, name: string): ToolCapability["evidenceKind"] {
  if (
    value === "external_source" ||
    value === "local_file" ||
    value === "computed_result" ||
    value === "artifact" ||
    value === "trace" ||
    value === "user_approval" ||
    value === "sandbox_result"
  ) {
    return value;
  }
  if (name === "web.search" || name === "tavily.search") {
    return "external_source";
  }
  if (name === "artifact.create") {
    return "artifact";
  }
  if (name === "file.read") {
    return "local_file";
  }
  if (name === "trace.query") {
    return "trace";
  }
  if (name === "approval.request") {
    return "user_approval";
  }
  return "computed_result";
}

function defaultToolDescription(name: string) {
  if (name === "web.search") {
    return "Search the web through the best available web_search provider adapter.";
  }
  if (name === "tavily.search") {
    return "Search the web for external sources and current facts.";
  }
  if (name === "artifact.create") {
    return "Create persisted artifacts such as Markdown or HTML reports.";
  }
  if (name === "file.read") {
    return "Read user-provided or workspace-local files and persist excerpts as observations.";
  }
  if (name === "trace.query") {
    return "Inspect persisted run events, traces, tool calls, and observations.";
  }
  if (name === "approval.request") {
    return "Ask the user to approve a medium or high risk action.";
  }
  return "Custom DataSwarm tool.";
}
