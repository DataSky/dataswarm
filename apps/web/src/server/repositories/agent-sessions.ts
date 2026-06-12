import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export type AgentSessionRecord = {
  id: string;
  runId: string;
  parentAgentSessionId: string | null;
  role: string;
  name: string;
  modelProfile: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type AgentSessionRow = {
  id: string;
  run_id: string;
  parent_agent_session_id: string | null;
  agent_role: string;
  agent_name: string;
  model_profile: string;
  status: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export async function createAgentSession(input: {
  runId: string;
  role: string;
  name: string;
  modelProfile: string;
  parentAgentSessionId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("agent");

  db.prepare(
    `INSERT INTO agent_sessions
     (id, tenant_id, project_id, run_id, parent_agent_session_id, agent_role, agent_name, model_profile, status, instructions_hash, context_bundle_id, tool_policy_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    input.parentAgentSessionId ?? null,
    input.role,
    input.name,
    input.modelProfile,
    "created",
    null,
    null,
    "{}",
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );

  return { id };
}

export async function updateAgentSessionStatus(id: string, status: string) {
  const db = await getDb();
  db.prepare("UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    nowIso(),
    id,
  );
}

export async function listAgentSessions(runId: string): Promise<AgentSessionRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, run_id, parent_agent_session_id, agent_role, agent_name, model_profile, status, metadata_json, created_at, updated_at
       FROM agent_sessions
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId) as AgentSessionRow[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    parentAgentSessionId: row.parent_agent_session_id,
    role: row.agent_role,
    name: row.agent_name,
    modelProfile: row.model_profile,
    status: row.status,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function parseJsonObject(value: string | null) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
