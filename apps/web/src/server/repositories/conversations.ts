import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export type ConversationSummary = {
  id: string;
  title: string;
  status: string;
  defaultModel: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  artifactCount: number;
};

export type MessageRecord = {
  id: string;
  runId: string | null;
  role: string;
  parts: unknown[];
  status: string;
  createdAt: string;
};

type ConversationRow = {
  id: string;
  title: string;
  status: string;
  default_model: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  artifact_count?: number;
};

type MessageRow = {
  id: string;
  run_id: string | null;
  role: string;
  parts_json: string;
  status: string;
  created_at: string;
};

export async function listConversations(): Promise<ConversationSummary[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.status, c.default_model, c.last_message_at, c.created_at, c.updated_at,
              COUNT(DISTINCT m.id) AS message_count,
              COUNT(DISTINCT a.id) AS artifact_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       LEFT JOIN artifacts a ON a.conversation_id = c.id
       WHERE c.tenant_id = ? AND c.project_id = ? AND c.status != 'deleted'
       GROUP BY c.id
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    )
    .all(defaults.tenantId, defaults.projectId) as ConversationRow[];

  return rows.map(mapConversation);
}

export async function getConversation(id: string) {
  const db = await getDb();
  const conversation = db
    .prepare(
      `SELECT id, title, status, default_model, last_message_at, created_at, updated_at
       FROM conversations
       WHERE id = ? AND tenant_id = ? AND project_id = ? AND status != 'deleted'`,
    )
    .get(id, defaults.tenantId, defaults.projectId) as ConversationRow | undefined;

  if (!conversation) {
    return null;
  }

  const messages = db
    .prepare(
      `SELECT id, run_id, role, parts_json, status, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(id) as MessageRow[];

  return {
    ...mapConversation(conversation),
    messages: messages.map(mapMessage),
  };
}

export async function createConversation(input: {
  title?: string;
  defaultModel?: string;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("conv");
  const title = input.title?.trim() || "Untitled DataSwarm Run";
  const defaultModel = input.defaultModel || "dmx:gpt-5.5-1m";

  db.prepare(
    `INSERT INTO conversations
     (id, tenant_id, project_id, user_id, title, status, default_model, context_summary, last_run_id, last_message_at, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    defaults.userId,
    title,
    "active",
    defaultModel,
    null,
    null,
    now,
    "{}",
    now,
    now,
  );

  return getConversation(id);
}

export async function renameConversation(id: string, title: string) {
  const db = await getDb();
  const nextTitle = title.trim();
  if (!nextTitle) {
    return null;
  }

  db.prepare(
    `UPDATE conversations
     SET title = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND project_id = ? AND status != 'deleted'`,
  ).run(nextTitle, nowIso(), id, defaults.tenantId, defaults.projectId);

  return getConversation(id);
}

export async function deleteConversation(id: string) {
  const db = await getDb();
  const result = db
    .prepare(
      `UPDATE conversations
       SET status = 'deleted', updated_at = ?
       WHERE id = ? AND tenant_id = ? AND project_id = ? AND status != 'deleted'`,
    )
    .run(nowIso(), id, defaults.tenantId, defaults.projectId);

  return result.changes > 0;
}

function mapConversation(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    defaultModel: row.default_model,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count ?? 0,
    artifactCount: row.artifact_count ?? 0,
  };
}

function mapMessage(row: MessageRow): MessageRecord {
  let parts: unknown[] = [];
  try {
    parts = JSON.parse(row.parts_json) as unknown[];
  } catch {
    parts = [{ type: "error", message: "Message parts could not be parsed." }];
  }

  return {
    id: row.id,
    runId: row.run_id,
    role: row.role,
    parts,
    status: row.status,
    createdAt: row.created_at,
  };
}
