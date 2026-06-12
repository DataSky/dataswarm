import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";
import { atomicWriteText, localUri, resolveLocalUri, sha256 } from "../storage/paths";

export type ArtifactRecord = {
  id: string;
  runId: string;
  type: string;
  mimeType: string | null;
  title: string;
  status: string;
  currentVersionId: string | null;
  version: number | null;
  sizeBytes: number | null;
  contentHash: string | null;
  storageUri: string | null;
  previewUri: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ArtifactRow = {
  id: string;
  run_id: string;
  type: string;
  mime_type: string | null;
  title: string;
  status: string;
  current_version_id: string | null;
  version: number | null;
  size_bytes: number | null;
  content_hash: string | null;
  storage_uri: string | null;
  preview_uri: string | null;
  metadata_json: string | null;
  created_at: string;
};

export async function createTextArtifact(input: {
  conversationId: string;
  runId: string;
  producerAgentSessionId?: string;
  type: "markdown" | "html";
  title: string;
  content: string;
  sourceTraceId?: string;
  metadata?: Record<string, unknown>;
}) {
  const db = await getDb();
  const now = nowIso();
  const contentHash = sha256(input.content);
  const existing = db
    .prepare(
      `SELECT a.id, a.current_version_id, a.type, a.mime_type, a.title, a.storage_uri, a.preview_uri
       FROM artifacts a
       JOIN artifact_versions av ON av.id = a.current_version_id
       WHERE a.conversation_id = ?
         AND a.type = ?
         AND av.content_hash = ?
       ORDER BY a.created_at DESC
       LIMIT 1`,
    )
    .get(input.conversationId, input.type, contentHash) as
    | {
        id: string;
        current_version_id: string;
        type: "markdown" | "html";
        mime_type: string;
        title: string;
        storage_uri: string;
        preview_uri: string;
      }
    | undefined;

  if (existing) {
    return {
      id: existing.id,
      versionId: existing.current_version_id,
      type: existing.type,
      mimeType: existing.mime_type,
      title: existing.title,
      storageUri: existing.storage_uri,
      previewUri: existing.preview_uri,
      deduped: true,
    };
  }

  const artifactId = makeId("art");
  const versionId = makeId("artv");
  const extension = input.type === "markdown" ? "md" : "html";
  const mimeType = input.type === "markdown" ? "text/markdown" : "text/html";
  const artifactUri = localUri(
    "artifacts",
    defaults.projectId,
    artifactId,
    "v1",
    `artifact.${extension}`,
  );
  const previewUri = localUri("artifacts", defaults.projectId, artifactId, "v1", "preview.html");
  const artifactPath = resolveLocalUri(artifactUri);
  const previewPath = resolveLocalUri(previewUri);
  const previewContent =
    input.type === "html"
      ? input.content
      : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
          input.title,
        )}</title></head><body><pre>${escapeHtml(input.content)}</pre></body></html>`;

  await atomicWriteText(artifactPath, input.content);
  await atomicWriteText(previewPath, previewContent);

  db.exec("BEGIN;");
  try {
    db.prepare(
      `INSERT INTO artifacts
       (id, tenant_id, project_id, conversation_id, run_id, producer_agent_session_id, type, mime_type, title, status, current_version_id, storage_uri, preview_uri, source_trace_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifactId,
      defaults.tenantId,
      defaults.projectId,
      input.conversationId,
      input.runId,
      input.producerAgentSessionId ?? null,
      input.type,
      mimeType,
      input.title,
      "preview_ready",
      versionId,
      artifactUri,
      previewUri,
      input.sourceTraceId ?? null,
      JSON.stringify({
        artifactKind: input.type === "html" ? "html_document" : "markdown_document",
        contentHash,
        previewMode: "html",
        ...(input.metadata ?? {}),
      }),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO artifact_versions
       (id, tenant_id, project_id, artifact_id, version, storage_uri, preview_uri, mime_type, size_bytes, content_hash, created_by_agent_session_id, change_summary, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      versionId,
      defaults.tenantId,
      defaults.projectId,
      artifactId,
      1,
      artifactUri,
      previewUri,
      mimeType,
      Buffer.byteLength(input.content, "utf8"),
      contentHash,
      input.producerAgentSessionId ?? null,
      "Initial artifact version",
      JSON.stringify({ filename: path.basename(artifactPath), ...(input.metadata ?? {}) }),
      now,
      now,
    );
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  return {
    id: artifactId,
    versionId,
    type: input.type,
    mimeType,
    title: input.title,
    storageUri: artifactUri,
    previewUri,
    deduped: false,
  };
}

export async function createBinaryArtifact(input: {
  conversationId: string;
  runId: string;
  producerAgentSessionId?: string;
  type: "image";
  title: string;
  content: Buffer;
  mimeType: "image/png" | "image/svg+xml" | "image/jpeg";
  extension: "png" | "svg" | "jpg" | "jpeg";
  sourceTraceId?: string;
  metadata?: Record<string, unknown>;
}) {
  const db = await getDb();
  const now = nowIso();
  const contentHash = sha256(input.content);
  const existing = db
    .prepare(
      `SELECT a.id, a.current_version_id, a.type, a.mime_type, a.title, a.storage_uri, a.preview_uri
       FROM artifacts a
       JOIN artifact_versions av ON av.id = a.current_version_id
       WHERE a.conversation_id = ?
         AND a.type = ?
         AND av.content_hash = ?
       ORDER BY a.created_at DESC
       LIMIT 1`,
    )
    .get(input.conversationId, input.type, contentHash) as
    | {
        id: string;
        current_version_id: string;
        type: "image";
        mime_type: string;
        title: string;
        storage_uri: string;
        preview_uri: string;
      }
    | undefined;

  if (existing) {
    return {
      id: existing.id,
      versionId: existing.current_version_id,
      type: existing.type,
      mimeType: existing.mime_type,
      title: existing.title,
      storageUri: existing.storage_uri,
      previewUri: existing.preview_uri,
      deduped: true,
    };
  }

  const artifactId = makeId("art");
  const versionId = makeId("artv");
  const artifactUri = localUri("artifacts", defaults.projectId, artifactId, "v1", `artifact.${input.extension}`);
  const artifactPath = resolveLocalUri(artifactUri);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, input.content);

  db.exec("BEGIN;");
  try {
    db.prepare(
      `INSERT INTO artifacts
       (id, tenant_id, project_id, conversation_id, run_id, producer_agent_session_id, type, mime_type, title, status, current_version_id, storage_uri, preview_uri, source_trace_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifactId,
      defaults.tenantId,
      defaults.projectId,
      input.conversationId,
      input.runId,
      input.producerAgentSessionId ?? null,
      input.type,
      input.mimeType,
      input.title,
      "preview_ready",
      versionId,
      artifactUri,
      artifactUri,
      input.sourceTraceId ?? null,
      JSON.stringify({
        artifactKind: "image",
        contentHash,
        previewMode: "image",
        ...(input.metadata ?? {}),
      }),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO artifact_versions
       (id, tenant_id, project_id, artifact_id, version, storage_uri, preview_uri, mime_type, size_bytes, content_hash, created_by_agent_session_id, change_summary, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      versionId,
      defaults.tenantId,
      defaults.projectId,
      artifactId,
      1,
      artifactUri,
      artifactUri,
      input.mimeType,
      input.content.byteLength,
      contentHash,
      input.producerAgentSessionId ?? null,
      "Initial binary artifact version",
      JSON.stringify({ filename: path.basename(artifactPath), ...(input.metadata ?? {}) }),
      now,
      now,
    );
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  return {
    id: artifactId,
    versionId,
    type: input.type,
    mimeType: input.mimeType,
    title: input.title,
    storageUri: artifactUri,
    previewUri: artifactUri,
    deduped: false,
  };
}

export async function listArtifacts(conversationId: string): Promise<ArtifactRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT a.id, a.run_id, a.type, a.mime_type, a.title, a.status, a.current_version_id,
              av.version, av.size_bytes, av.content_hash,
              a.storage_uri, a.preview_uri, a.metadata_json, a.created_at
       FROM artifacts a
       LEFT JOIN artifact_versions av ON av.id = a.current_version_id
       WHERE a.conversation_id = ?
         AND a.title != 'DataSwarm Self-Improvement Report'
       ORDER BY a.created_at DESC`,
    )
    .all(conversationId) as ArtifactRow[];

  const latestByTypeAndContent = new Map<string, ArtifactRow>();
  for (const row of rows) {
    const key = `${row.type}:${row.content_hash ?? row.title}`;
    if (!latestByTypeAndContent.has(key)) {
      latestByTypeAndContent.set(key, row);
    }
  }

  return Array.from(latestByTypeAndContent.values()).map(mapArtifact);
}

export async function getArtifact(id: string): Promise<ArtifactRecord | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT a.id, a.run_id, a.type, a.mime_type, a.title, a.status, a.current_version_id,
              av.version, av.size_bytes, av.content_hash,
              a.storage_uri, a.preview_uri, a.metadata_json, a.created_at
       FROM artifacts a
       LEFT JOIN artifact_versions av ON av.id = a.current_version_id
       WHERE a.id = ?`,
    )
    .get(id) as ArtifactRow | undefined;

  return row ? mapArtifact(row) : null;
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    mimeType: row.mime_type,
    title: row.title,
    status: row.status,
    currentVersionId: row.current_version_id,
    version: row.version,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    storageUri: row.storage_uri,
    previewUri: row.preview_uri,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  };
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
