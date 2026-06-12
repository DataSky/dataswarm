import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export async function startTraceSpan(input: {
  traceId?: string;
  parentSpanId?: string | null;
  runId: string;
  agentSessionId?: string | null;
  spanKind: string;
  name: string;
  attributes?: Record<string, unknown>;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("span");
  const traceId = input.traceId ?? makeId("trace");

  db.prepare(
    `INSERT INTO trace_spans
     (id, tenant_id, project_id, trace_id, parent_span_id, run_id, agent_session_id, span_kind, name, status, started_at, ended_at, attributes_json, payload_uri, redaction_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    traceId,
    input.parentSpanId ?? null,
    input.runId,
    input.agentSessionId ?? null,
    input.spanKind,
    input.name,
    "started",
    now,
    null,
    JSON.stringify(input.attributes ?? {}),
    null,
    "redacted",
    now,
    now,
  );

  return { id, traceId };
}

export async function completeTraceSpan(
  spanId: string,
  status: "completed" | "failed" | "cancelled",
  attributes?: Record<string, unknown>,
) {
  const db = await getDb();
  const now = nowIso();
  const current = db
    .prepare("SELECT attributes_json FROM trace_spans WHERE id = ?")
    .get(spanId) as { attributes_json: string | null } | undefined;
  let mergedAttributes: Record<string, unknown> = {};
  if (current?.attributes_json) {
    try {
      mergedAttributes = JSON.parse(current.attributes_json) as Record<string, unknown>;
    } catch {
      mergedAttributes = {};
    }
  }

  db.prepare(
    `UPDATE trace_spans
     SET status = ?, ended_at = ?, attributes_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, now, JSON.stringify({ ...mergedAttributes, ...(attributes ?? {}) }), now, spanId);
}

export async function listTraceSpans(runId: string) {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, trace_id, parent_span_id, run_id, agent_session_id, span_kind, name, status, started_at, ended_at, attributes_json, redaction_status
       FROM trace_spans
       WHERE run_id = ?
       ORDER BY started_at ASC`,
    )
    .all(runId);

  return rows.map((row) => ({ ...(row as Record<string, unknown>) }));
}
