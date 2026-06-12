import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export type RunEventEnvelope = {
  schema_version: "2026-06-08.v1";
  id: string;
  run_id: string;
  conversation_id: string;
  task_id?: string;
  seq: number;
  type: string;
  timestamp: string;
  producer: {
    kind: string;
    id?: string;
    name?: string;
  };
  trace?: {
    trace_id?: string;
    span_id?: string;
    parent_span_id?: string | null;
  };
  payload: unknown;
};

type RunEventRow = {
  id: string;
  run_id: string;
  seq: number;
  event_type: string;
  producer_kind: string;
  producer_id: string | null;
  payload_json: string;
  created_at: string;
};

export async function appendRunEvent(input: {
  runId: string;
  conversationId: string;
  taskId?: string;
  type: string;
  producer: RunEventEnvelope["producer"];
  payload: unknown;
  trace?: RunEventEnvelope["trace"];
}) {
  const db = await getDb();
  const seqRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM run_events WHERE run_id = ?")
    .get(input.runId) as { seq: number };
  const event: RunEventEnvelope = {
    schema_version: "2026-06-08.v1",
    id: makeId("evt"),
    run_id: input.runId,
    conversation_id: input.conversationId,
    task_id: input.taskId,
    seq: seqRow.seq,
    type: input.type,
    timestamp: nowIso(),
    producer: input.producer,
    trace: input.trace,
    payload: redactPayload(input.payload),
  };

  db.prepare(
    `INSERT INTO run_events
     (id, tenant_id, project_id, run_id, seq, event_type, producer_kind, producer_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    defaults.tenantId,
    defaults.projectId,
    event.run_id,
    event.seq,
    event.type,
    event.producer.kind,
    event.producer.id ?? null,
    JSON.stringify(event),
    event.timestamp,
  );

  return event;
}

export async function listRunEventsAfter(runId: string, seq: number) {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, run_id, seq, event_type, producer_kind, producer_id, payload_json, created_at
       FROM run_events
       WHERE run_id = ? AND seq > ?
       ORDER BY seq ASC`,
    )
    .all(runId, seq) as RunEventRow[];

  return rows.map(parseEventRow);
}

export async function listRunEventsForConversation(conversationId: string) {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT re.id, re.run_id, re.seq, re.event_type, re.producer_kind, re.producer_id, re.payload_json, re.created_at
       FROM run_events re
       JOIN runs r ON r.id = re.run_id
       WHERE r.conversation_id = ?
       ORDER BY r.created_at ASC, re.seq ASC`,
    )
    .all(conversationId) as RunEventRow[];

  return rows.map(parseEventRow);
}

export async function getEventSeqById(runId: string, eventId: string) {
  const db = await getDb();
  const row = db
    .prepare("SELECT seq FROM run_events WHERE run_id = ? AND id = ?")
    .get(runId, eventId) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

function parseEventRow(row: RunEventRow): RunEventEnvelope {
  return JSON.parse(row.payload_json) as RunEventEnvelope;
}

function redactPayload(payload: unknown): unknown {
  return JSON.parse(
    JSON.stringify(payload, (_key, value) => {
      if (typeof value === "string") {
        return value
          .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]")
          .replace(/e2b_[a-f0-9]{40}/gi, "[REDACTED_SECRET]")
          .replace(/tvly-[A-Za-z0-9_-]{8,}/g, "[REDACTED_SECRET]");
      }
      return value;
    }),
  ) as unknown;
}
