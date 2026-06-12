import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";
import type { Observation, ObservationClaim } from "../runtime/agentic-types";

type ObservationRow = {
  id: string;
  run_id: string;
  action_id: string | null;
  source_type: Observation["sourceType"];
  source_name: string;
  status: Observation["status"];
  summary: string;
  payload_uri: string | null;
  evidence_level: Observation["evidenceLevel"];
  claims_json: string | null;
  metadata_json: string | null;
  created_at: string;
};

export async function createObservation(input: {
  runId: string;
  actionId?: string;
  sourceType: Observation["sourceType"];
  sourceName: string;
  status: Observation["status"];
  summary: string;
  payloadUri?: string;
  evidenceLevel: Observation["evidenceLevel"];
  claims?: ObservationClaim[];
  metadata?: Record<string, unknown>;
}): Promise<Observation> {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("obs");

  db.prepare(
    `INSERT INTO observations
     (id, tenant_id, project_id, run_id, action_id, source_type, source_name, status, summary, payload_uri, evidence_level, claims_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    input.actionId ?? null,
    input.sourceType,
    input.sourceName,
    input.status,
    input.summary,
    input.payloadUri ?? null,
    input.evidenceLevel,
    JSON.stringify(input.claims ?? []),
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );

  return {
    id,
    runId: input.runId,
    actionId: input.actionId,
    sourceType: input.sourceType,
    sourceName: input.sourceName,
    status: input.status,
    summary: input.summary,
    payloadUri: input.payloadUri,
    evidenceLevel: input.evidenceLevel,
    claims: input.claims ?? [],
    metadata: input.metadata,
    createdAt: now,
  };
}

export async function listObservations(runId: string): Promise<Observation[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, run_id, action_id, source_type, source_name, status, summary, payload_uri, evidence_level, claims_json, metadata_json, created_at
       FROM observations
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId) as ObservationRow[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    actionId: row.action_id ?? undefined,
    sourceType: row.source_type,
    sourceName: row.source_name,
    status: row.status,
    summary: row.summary,
    payloadUri: row.payload_uri ?? undefined,
    evidenceLevel: row.evidence_level,
    claims: parseClaims(row.claims_json),
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  }));
}

function parseClaims(value: string | null): ObservationClaim[] {
  if (!value) {
    return [];
  }
  try {
    return JSON.parse(value) as ObservationClaim[];
  } catch {
    return [];
  }
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
