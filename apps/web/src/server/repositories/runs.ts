import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export type RunRecord = {
  id: string;
  taskId: string;
  conversationId: string;
  mode: string;
  status: string;
  modelProfile: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type RunRow = {
  id: string;
  task_id: string;
  conversation_id: string;
  mode: string;
  status: string;
  model_profile: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export async function createTaskAndRun(input: {
  conversationId: string;
  objective: string;
  modelProfile: string;
  mode?: "chat" | "agent";
}) {
  const db = await getDb();
  const now = nowIso();
  const taskId = makeId("task");
  const runId = makeId("run");

  db.exec("BEGIN;");
  try {
    db.prepare(
      `INSERT INTO tasks
       (id, tenant_id, project_id, conversation_id, parent_task_id, title, objective, task_type, status, priority, risk_level, input_refs_json, acceptance_criteria_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      defaults.tenantId,
      defaults.projectId,
      input.conversationId,
      null,
      "User message",
      input.objective,
      "chat",
      "running",
      0,
      "low",
      "[]",
      "[]",
      "{}",
      now,
      now,
    );

    db.prepare(
      `INSERT INTO runs
       (id, tenant_id, project_id, conversation_id, task_id, mode, status, model_profile, attempt, started_at, ended_at, budget_json, result_summary, error_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      defaults.tenantId,
      defaults.projectId,
      input.conversationId,
      taskId,
      input.mode ?? "agent",
      "queued",
      input.modelProfile,
      1,
      null,
      null,
      JSON.stringify({ max_tokens: 200000, max_seconds: 600, max_tool_calls: 0, max_sandboxes: 0 }),
      null,
      null,
      "{}",
      now,
      now,
    );

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  return { taskId, runId };
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT id, task_id, conversation_id, mode, status, model_profile, metadata_json, created_at, updated_at
       FROM runs
       WHERE id = ?`,
    )
    .get(id) as RunRow | undefined;

  return row ? mapRun(row) : null;
}

export async function getLatestRunForConversation(conversationId: string): Promise<RunRecord | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT id, task_id, conversation_id, mode, status, model_profile, metadata_json, created_at, updated_at
       FROM runs
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(conversationId) as RunRow | undefined;

  return row ? mapRun(row) : null;
}

export async function updateRunStatus(
  id: string,
  status: string,
  fields: { startedAt?: string | null; endedAt?: string | null; resultSummary?: string | null; error?: unknown } = {},
) {
  const db = await getDb();
  const now = nowIso();
  db.prepare(
    `UPDATE runs
     SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at), result_summary = COALESCE(?, result_summary), error_json = COALESCE(?, error_json), updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    fields.startedAt ?? null,
    fields.endedAt ?? null,
    fields.resultSummary ?? null,
    fields.error ? JSON.stringify(fields.error) : null,
    now,
    id,
  );
}

export async function requestRunCancel(id: string, reason = "user_requested_cancel") {
  const db = await getDb();
  const row = db
    .prepare("SELECT status, metadata_json FROM runs WHERE id = ?")
    .get(id) as { status: string; metadata_json: string | null } | undefined;
  if (!row) {
    return null;
  }

  const terminal = isTerminalRunStatus(row.status);
  const metadata = {
    ...parseJsonObject(row.metadata_json),
    cancel_requested: true,
    cancel_reason: reason,
    cancel_requested_at: nowIso(),
  };
  db.prepare(
    `UPDATE runs
     SET status = ?,
         metadata_json = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(terminal ? row.status : "cancelling", JSON.stringify(metadata), nowIso(), id);

  return { previousStatus: row.status, status: terminal ? row.status : "cancelling", terminal };
}

export async function isRunCancelRequested(id: string) {
  const db = await getDb();
  const row = db
    .prepare("SELECT status, metadata_json FROM runs WHERE id = ?")
    .get(id) as { status: string; metadata_json: string | null } | undefined;
  if (!row) {
    return false;
  }
  const metadata = parseJsonObject(row.metadata_json);
  return row.status === "cancelling" || row.status === "cancelled" || metadata.cancel_requested === true;
}

export async function completeTask(taskId: string, status: "completed" | "failed" | "cancelled") {
  const db = await getDb();
  const now = nowIso();
  db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now, taskId);
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    mode: row.mode,
    status: row.status,
    modelProfile: row.model_profile,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isTerminalRunStatus(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled";
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
