import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";
import type { AgentAction } from "../runtime/agentic-types";

export type AgentActionRecord = {
  id: string;
  runId: string;
  actionType: AgentAction["type"];
  status: string;
  action: AgentAction;
  modelProfile?: string;
  traceSpanId?: string;
  createdAt: string;
};

type AgentActionRow = {
  id: string;
  run_id: string;
  action_type: AgentAction["type"];
  status: string;
  action_json: string;
  model_profile: string | null;
  trace_span_id: string | null;
  created_at: string;
};

export async function createAgentAction(input: {
  runId: string;
  agentSessionId?: string;
  action: AgentAction;
  status: "proposed" | "validated" | "executed" | "blocked" | "failed";
  modelProfile?: string;
  traceSpanId?: string;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("act");

  db.prepare(
    `INSERT INTO agent_actions
     (id, tenant_id, project_id, run_id, step_id, agent_session_id, action_type, status, action_json, model_profile, trace_span_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    null,
    input.agentSessionId ?? null,
    input.action.type,
    input.status,
    JSON.stringify(input.action),
    input.modelProfile ?? null,
    input.traceSpanId ?? null,
    now,
    now,
  );

  return { id };
}

export async function updateAgentActionStatus(input: {
  id: string;
  status: "validated" | "executed" | "blocked" | "failed";
}) {
  const db = await getDb();
  db.prepare("UPDATE agent_actions SET status = ?, updated_at = ? WHERE id = ?").run(
    input.status,
    nowIso(),
    input.id,
  );
}

export async function listAgentActions(runId: string): Promise<AgentActionRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, run_id, action_type, status, action_json, model_profile, trace_span_id, created_at
       FROM agent_actions
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId) as AgentActionRow[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    actionType: row.action_type,
    status: row.status,
    action: JSON.parse(row.action_json) as AgentAction,
    modelProfile: row.model_profile ?? undefined,
    traceSpanId: row.trace_span_id ?? undefined,
    createdAt: row.created_at,
  }));
}
