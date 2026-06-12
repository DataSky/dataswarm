import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export type SandboxSessionRecord = {
  id: string;
  runId?: string;
  agentSessionId?: string;
  provider: string;
  externalSandboxId: string | null;
  status: string;
  template?: string | null;
  resourceLimits?: Record<string, unknown>;
  envPolicy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  startedAt?: string | null;
  endedAt?: string | null;
  lastHeartbeatAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type SandboxSessionRow = {
  id: string;
  run_id: string;
  agent_session_id: string;
  provider: string;
  external_sandbox_id: string | null;
  status: string;
  template: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_heartbeat_at: string | null;
  resource_limits_json: string | null;
  env_policy_json: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export async function createSandboxSession(input: {
  runId: string;
  agentSessionId: string;
  provider: string;
  externalSandboxId?: string | null;
  template?: string | null;
  resourceLimits?: Record<string, unknown>;
  envPolicy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<SandboxSessionRecord> {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("sandbox");

  db.prepare(
    `INSERT INTO sandbox_sessions
     (id, tenant_id, project_id, run_id, agent_session_id, provider, external_sandbox_id, status, template, started_at, ended_at, last_heartbeat_at, resource_limits_json, env_policy_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    input.agentSessionId,
    input.provider,
    input.externalSandboxId ?? null,
    "created",
    input.template ?? null,
    null,
    null,
    null,
    JSON.stringify(input.resourceLimits ?? { cpu: 1, memory_mb: 1024, timeout_seconds: 120 }),
    JSON.stringify(input.envPolicy ?? { allow_secret_env: false, allow_network: false }),
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );

  return { id, provider: input.provider, externalSandboxId: input.externalSandboxId ?? null, status: "created" };
}

export async function updateSandboxSessionStatus(
  id: string,
  status: "running" | "completed" | "failed" | "cancelling" | "cancelled",
  fields: {
    externalSandboxId?: string | null;
    endedAt?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const db = await getDb();
  const now = nowIso();
  const existing = db
    .prepare("SELECT metadata_json FROM sandbox_sessions WHERE id = ?")
    .get(id) as { metadata_json: string | null } | undefined;
  let metadata: Record<string, unknown> = {};
  if (existing?.metadata_json) {
    try {
      metadata = JSON.parse(existing.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }

  db.prepare(
    `UPDATE sandbox_sessions
     SET status = ?,
         external_sandbox_id = COALESCE(?, external_sandbox_id),
         started_at = COALESCE(started_at, ?),
         ended_at = COALESCE(?, ended_at),
         last_heartbeat_at = ?,
         metadata_json = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    fields.externalSandboxId ?? null,
    status === "running" ? now : null,
    fields.endedAt ?? (status === "completed" || status === "failed" || status === "cancelled" ? now : null),
    now,
    JSON.stringify({ ...metadata, ...(fields.metadata ?? {}) }),
    now,
    id,
  );
}

export async function updateSandboxSessionHeartbeat(
  id: string,
  fields: {
    heartbeatAt?: string;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const db = await getDb();
  const now = fields.heartbeatAt ?? nowIso();
  const existing = db
    .prepare("SELECT metadata_json FROM sandbox_sessions WHERE id = ?")
    .get(id) as { metadata_json: string | null } | undefined;
  const metadata = mergeMetadata(existing?.metadata_json, fields.metadata ?? {});

  db.prepare(
    `UPDATE sandbox_sessions
     SET last_heartbeat_at = ?,
         metadata_json = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(now, JSON.stringify(metadata), nowIso(), id);
}

export async function requestSandboxSessionCancel(id: string, reason = "manual_cancel_requested") {
  const db = await getDb();
  const row = db
    .prepare("SELECT status FROM sandbox_sessions WHERE id = ?")
    .get(id) as { status: string } | undefined;
  if (!row || isTerminalSandboxStatus(row.status)) {
    return { previousStatus: row?.status ?? null, status: row?.status ?? null, terminal: true };
  }

  await updateSandboxSessionStatus(id, "cancelling", {
    metadata: {
      cancel_requested: true,
      cancel_reason: reason,
      cancel_requested_at: nowIso(),
    },
  });
  return { previousStatus: row.status, status: "cancelling", terminal: false };
}

export async function requestSandboxSessionsCancelForRun(runId: string, reason = "run_cancel_requested") {
  const sessions = await listSandboxSessions(runId);
  const requested = [];
  for (const session of sessions) {
    const result = await requestSandboxSessionCancel(session.id, reason);
    if (!result.terminal) {
      requested.push({ sandboxSessionId: session.id, previousStatus: result.previousStatus, status: result.status });
    }
  }
  return requested;
}

export async function isSandboxSessionCancelRequested(id: string) {
  const db = await getDb();
  const row = db
    .prepare("SELECT status, metadata_json FROM sandbox_sessions WHERE id = ?")
    .get(id) as { status: string; metadata_json: string | null } | undefined;
  if (!row) {
    return false;
  }
  const metadata = parseJsonObject(row.metadata_json);
  return row.status === "cancelling" || row.status === "cancelled" || metadata.cancel_requested === true;
}

export async function listSandboxSessions(runId: string): Promise<SandboxSessionRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, run_id, agent_session_id, provider, external_sandbox_id, status, template, started_at, ended_at, last_heartbeat_at,
              resource_limits_json, env_policy_json, metadata_json, created_at, updated_at
       FROM sandbox_sessions
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId) as SandboxSessionRow[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    agentSessionId: row.agent_session_id,
    provider: row.provider,
    externalSandboxId: row.external_sandbox_id,
    status: row.status,
    template: row.template,
    resourceLimits: parseJsonObject(row.resource_limits_json),
    envPolicy: parseJsonObject(row.env_policy_json),
    metadata: parseJsonObject(row.metadata_json),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function mergeMetadata(value: string | null | undefined, patch: Record<string, unknown>) {
  return { ...parseJsonObject(value ?? null), ...patch };
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

function isTerminalSandboxStatus(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
