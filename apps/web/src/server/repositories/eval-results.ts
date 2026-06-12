import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export type EvalResultRecord = {
  id: string;
  runId: string;
  artifactId: string | null;
  evalType: string;
  status: string;
  score: number | null;
  summary: string | null;
  checks: unknown[];
  traceSpanId: string | null;
  createdAt: string;
};

type EvalResultRow = {
  id: string;
  run_id: string;
  artifact_id: string | null;
  eval_type: string;
  status: string;
  score: number | null;
  summary: string | null;
  checks_json: string | null;
  trace_span_id: string | null;
  created_at: string;
};

export async function createEvalResult(input: {
  runId: string;
  artifactId?: string | null;
  evalType: string;
  status: "completed" | "failed";
  score?: number | null;
  summary?: string | null;
  checks?: unknown[];
  traceSpanId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("eval");

  db.prepare(
    `INSERT INTO eval_results
     (id, tenant_id, project_id, run_id, artifact_id, eval_type, status, score, summary, checks_json, trace_span_id, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    input.artifactId ?? null,
    input.evalType,
    input.status,
    input.score ?? null,
    input.summary ?? null,
    JSON.stringify(input.checks ?? []),
    input.traceSpanId ?? null,
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );

  return { id };
}

export async function listEvalResults(runId: string): Promise<EvalResultRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, run_id, artifact_id, eval_type, status, score, summary, checks_json, trace_span_id, created_at
       FROM eval_results
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId) as EvalResultRow[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    artifactId: row.artifact_id,
    evalType: row.eval_type,
    status: row.status,
    score: row.score,
    summary: row.summary,
    checks: parseChecks(row.checks_json),
    traceSpanId: row.trace_span_id,
    createdAt: row.created_at,
  }));
}

export async function getEvalResult(runId: string, evalResultId: string): Promise<EvalResultRecord | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT id, run_id, artifact_id, eval_type, status, score, summary, checks_json, trace_span_id, created_at
       FROM eval_results
       WHERE run_id = ? AND id = ?
       LIMIT 1`,
    )
    .get(runId, evalResultId) as EvalResultRow | undefined;
  return row
    ? {
        id: row.id,
        runId: row.run_id,
        artifactId: row.artifact_id,
        evalType: row.eval_type,
        status: row.status,
        score: row.score,
        summary: row.summary,
        checks: parseChecks(row.checks_json),
        traceSpanId: row.trace_span_id,
        createdAt: row.created_at,
      }
    : null;
}

function parseChecks(value: string | null) {
  if (!value) {
    return [];
  }
  try {
    return JSON.parse(value) as unknown[];
  } catch {
    return [];
  }
}
