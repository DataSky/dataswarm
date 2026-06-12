import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  source: string;
  level: LogLevel;
  event: string;
  conversation_id: string | null;
  run_id: string | null;
  request_id: string | null;
  payload_json: string;
  created_at: string;
};

let ensured = false;

export async function appendObservedLog(input: {
  source: "server" | "ui";
  level: LogLevel;
  event: string;
  payload?: Record<string, unknown>;
}) {
  const db = await getDb();
  ensureLogTable(db);
  const payload = input.payload ?? {};
  db.prepare(
    `INSERT INTO app_logs
     (id, tenant_id, project_id, source, level, event, conversation_id, run_id, request_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    makeId("log"),
    defaults.tenantId,
    defaults.projectId,
    input.source,
    input.level,
    input.event,
    stringField(payload.conversationId),
    stringField(payload.runId),
    stringField(payload.requestId),
    JSON.stringify(redactPayload(payload)),
    nowIso(),
  );
}

export async function listObservedLogsForConversation(conversationId: string, limit = 300) {
  const db = await getDb();
  ensureLogTable(db);
  const runs = db
    .prepare("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at ASC")
    .all(conversationId) as Array<{ id: string }>;
  const runIds = runs.map((run) => run.id);

  const rows = db
    .prepare(
      `SELECT id, tenant_id, project_id, source, level, event, conversation_id, run_id, request_id, payload_json, created_at
       FROM app_logs
       WHERE conversation_id = ?
          OR (${runIds.length > 0 ? `run_id IN (${runIds.map(() => "?").join(",")})` : "0"})
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(conversationId, ...runIds, limit) as LogRow[];

  return rows.reverse().map((row) => ({
    id: row.id,
    source: row.source,
    level: row.level,
    event: row.event,
    conversationId: row.conversation_id,
    runId: row.run_id,
    requestId: row.request_id,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  }));
}

function ensureLogTable(db: Awaited<ReturnType<typeof getDb>>) {
  if (ensured) {
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      conversation_id TEXT,
      run_id TEXT,
      request_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_app_logs_conversation_id ON app_logs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_app_logs_run_id ON app_logs(run_id);
    CREATE INDEX IF NOT EXISTS idx_app_logs_created_at ON app_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_app_logs_event ON app_logs(event);
  `);
  ensured = true;
}

function stringField(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function redactPayload(payload: Record<string, unknown>) {
  return JSON.parse(
    JSON.stringify(payload).replace(
      /(sk-|e2b_|tvly-)[A-Za-z0-9_-]{8,}/g,
      "[REDACTED_SECRET]",
    ),
  ) as Record<string, unknown>;
}
