import { getDb, defaults } from "../storage/db";
import { nowIso } from "../storage/ids";

export type ProjectRecord = {
  id: string;
  name: string;
  description: string | null;
  localRoot: string | null;
  status: string;
  defaultModel: string | null;
  createdAt: string;
  updatedAt: string;
  conversationCount: number;
  artifactCount: number;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  local_root: string | null;
  status: string;
  settings_json: string | null;
  created_at: string;
  updated_at: string;
  conversation_count?: number;
  artifact_count?: number;
};

export async function listProjects(): Promise<ProjectRecord[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.local_root, p.status, p.settings_json, p.created_at, p.updated_at,
              COUNT(DISTINCT c.id) AS conversation_count,
              COUNT(DISTINCT a.id) AS artifact_count
       FROM projects p
       LEFT JOIN conversations c ON c.project_id = p.id AND c.status != 'deleted'
       LEFT JOIN artifacts a ON a.project_id = p.id
       WHERE p.tenant_id = ? AND p.status != 'deleted'
       GROUP BY p.id
       ORDER BY p.updated_at DESC`,
    )
    .all(defaults.tenantId) as ProjectRow[];

  return rows.map(mapProject);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.local_root, p.status, p.settings_json, p.created_at, p.updated_at,
              COUNT(DISTINCT c.id) AS conversation_count,
              COUNT(DISTINCT a.id) AS artifact_count
       FROM projects p
       LEFT JOIN conversations c ON c.project_id = p.id AND c.status != 'deleted'
       LEFT JOIN artifacts a ON a.project_id = p.id
       WHERE p.id = ? AND p.tenant_id = ? AND p.status != 'deleted'
       GROUP BY p.id`,
    )
    .get(id, defaults.tenantId) as ProjectRow | undefined;

  return row ? mapProject(row) : null;
}

export async function updateProject(
  id: string,
  input: {
    name?: string;
    description?: string;
    localRoot?: string;
    defaultModel?: string;
  },
) {
  const project = await getProject(id);
  if (!project) {
    return null;
  }

  const db = await getDb();
  const settings = {
    default_model: project.defaultModel,
    ...(await getProjectSettings(id)),
  };
  if (input.defaultModel !== undefined) {
    settings.default_model = input.defaultModel.trim() || null;
  }

  db.prepare(
    `UPDATE projects
     SET name = ?, description = ?, local_root = ?, settings_json = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status != 'deleted'`,
  ).run(
    input.name?.trim() || project.name,
    input.description === undefined ? project.description : input.description.trim() || null,
    input.localRoot === undefined ? project.localRoot : input.localRoot.trim() || null,
    JSON.stringify(settings),
    nowIso(),
    id,
    defaults.tenantId,
  );

  return getProject(id);
}

async function getProjectSettings(id: string): Promise<Record<string, string | null>> {
  const db = await getDb();
  const row = db
    .prepare("SELECT settings_json FROM projects WHERE id = ? AND tenant_id = ?")
    .get(id, defaults.tenantId) as { settings_json: string | null } | undefined;
  if (!row?.settings_json) {
    return {};
  }
  try {
    return JSON.parse(row.settings_json) as Record<string, string | null>;
  } catch {
    return {};
  }
}

function mapProject(row: ProjectRow): ProjectRecord {
  let defaultModel: string | null = null;
  if (row.settings_json) {
    try {
      const settings = JSON.parse(row.settings_json) as { default_model?: string };
      defaultModel = settings.default_model ?? null;
    } catch {
      defaultModel = null;
    }
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    localRoot: row.local_root,
    status: row.status,
    defaultModel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conversationCount: row.conversation_count ?? 0,
    artifactCount: row.artifact_count ?? 0,
  };
}
