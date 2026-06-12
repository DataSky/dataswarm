import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export async function createUserMessage(input: { conversationId: string; text: string; runId?: string }) {
  return createMessage({
    conversationId: input.conversationId,
    runId: input.runId,
    role: "user",
    parts: [{ type: "text", text: input.text }],
    status: "completed",
  });
}

export async function createAssistantMessage(input: {
  conversationId: string;
  runId: string;
  agentSessionId: string;
}) {
  return createMessage({
    conversationId: input.conversationId,
    runId: input.runId,
    role: "assistant",
    parts: [],
    status: "streaming",
    agentSessionId: input.agentSessionId,
  });
}

export async function completeAssistantMessage(input: {
  messageId: string;
  parts: unknown[];
  status?: "completed" | "failed";
}) {
  const db = await getDb();
  const now = nowIso();
  db.prepare("UPDATE messages SET parts_json = ?, status = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(input.parts),
    input.status ?? "completed",
    now,
    input.messageId,
  );
}

async function createMessage(input: {
  conversationId: string;
  runId?: string;
  role: string;
  parts: unknown[];
  status: string;
  agentSessionId?: string;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("msg");

  db.prepare(
    `INSERT INTO messages
     (id, tenant_id, project_id, conversation_id, run_id, role, parts_json, status, created_by_agent_session_id, token_count, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.conversationId,
    input.runId ?? null,
    input.role,
    JSON.stringify(input.parts),
    input.status,
    input.agentSessionId ?? null,
    null,
    "{}",
    now,
    now,
  );

  db.prepare("UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?").run(
    now,
    now,
    input.conversationId,
  );

  return { id };
}
