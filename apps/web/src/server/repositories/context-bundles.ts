import path from "node:path";
import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";
import { atomicWriteText, localUri, resolveLocalUri, sha256 } from "../storage/paths";

export async function createContextBundle(input: {
  runId: string;
  agentSessionId: string;
  branchId: string;
  content: string;
  sourceRefs?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("ctx");
  const storageUri = localUri(
    "sandbox-bundles",
    defaults.projectId,
    input.runId,
    input.branchId,
    "context.json",
  );
  const filePath = resolveLocalUri(storageUri);

  await atomicWriteText(filePath, input.content);

  db.prepare(
    `INSERT INTO context_bundles
     (id, tenant_id, project_id, run_id, agent_session_id, storage_uri, content_hash, token_estimate, source_refs_json, redaction_status, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    input.agentSessionId,
    storageUri,
    sha256(input.content),
    Math.ceil(input.content.length / 4),
    JSON.stringify(input.sourceRefs ?? []),
    "redacted",
    JSON.stringify({ filename: path.basename(filePath), ...(input.metadata ?? {}) }),
    now,
    now,
  );

  return { id, storageUri };
}
