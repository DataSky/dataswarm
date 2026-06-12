import { getDb, defaults } from "../storage/db";
import { nowIso } from "../storage/ids";

export type ApprovalRecord = {
  id: string;
  runId: string;
  agentSessionId: string | null;
  toolCallId: string | null;
  status: "pending" | "approved" | "rejected" | "expired";
  riskLevel: string;
  requestSummary: string;
  requestPayloadUri: string | null;
  decisionByUserId: string | null;
  decisionComment: string | null;
  expiresAt: string | null;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ApprovalRow = {
  id: string;
  run_id: string;
  agent_session_id: string | null;
  tool_call_id: string | null;
  status: ApprovalRecord["status"];
  risk_level: string;
  request_summary: string;
  request_payload_uri: string | null;
  decision_by_user_id: string | null;
  decision_comment: string | null;
  expires_at: string | null;
  resolved_at: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export async function listApprovals(runId: string): Promise<ApprovalRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, run_id, agent_session_id, tool_call_id, status, risk_level, request_summary, request_payload_uri,
              decision_by_user_id, decision_comment, expires_at, resolved_at, metadata_json, created_at, updated_at
       FROM approvals
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId) as ApprovalRow[];
  return rows.map(mapApprovalRow);
}

export async function getApproval(runId: string, approvalId: string) {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT id, run_id, agent_session_id, tool_call_id, status, risk_level, request_summary, request_payload_uri,
              decision_by_user_id, decision_comment, expires_at, resolved_at, metadata_json, created_at, updated_at
       FROM approvals
       WHERE run_id = ? AND id = ?`,
    )
    .get(runId, approvalId) as ApprovalRow | undefined;
  return row ? mapApprovalRow(row) : null;
}

export async function decideApproval(input: {
  runId: string;
  approvalId: string;
  decision: "approve" | "reject";
  comment?: string;
}) {
  const approval = await getApproval(input.runId, input.approvalId);
  if (!approval) {
    throw new Error(`Approval not found: ${input.approvalId}`);
  }
  if (approval.status !== "pending") {
    throw new Error(`Approval is already resolved with status ${approval.status}`);
  }

  const status = input.decision === "approve" ? "approved" : "rejected";
  const now = nowIso();
  const metadata = {
    ...approval.metadata,
    decisions: [
      ...arrayValue(approval.metadata.decisions),
      {
        decision: input.decision,
        status,
        comment: input.comment ?? "",
        decidedAt: now,
        actor: defaults.userId,
      },
    ],
  };
  const db = await getDb();
  db.prepare(
    `UPDATE approvals
     SET status = ?,
         decision_by_user_id = ?,
         decision_comment = ?,
         resolved_at = ?,
         metadata_json = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(status, defaults.userId, input.comment ?? "", now, JSON.stringify(metadata), now, input.approvalId);

  return { approval: { ...approval, status, decisionByUserId: defaults.userId, decisionComment: input.comment ?? "", resolvedAt: now, metadata, updatedAt: now } };
}

function mapApprovalRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    agentSessionId: row.agent_session_id,
    toolCallId: row.tool_call_id,
    status: row.status,
    riskLevel: row.risk_level,
    requestSummary: row.request_summary,
    requestPayloadUri: row.request_payload_uri,
    decisionByUserId: row.decision_by_user_id,
    decisionComment: row.decision_comment,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
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

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
