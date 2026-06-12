import { getDb } from "../storage/db";
import { nowIso } from "../storage/ids";

export type ModelProfile = {
  id: string;
  provider: string;
  model: string;
  displayName: string;
  role: string;
  protocol?: string;
  baseUrlEnv?: string;
  apiKeyEnv?: string;
  contextWindow?: number | null;
  enabled: boolean;
};

type ModelProfileRow = {
  id: string;
  provider: string;
  model: string;
  display_name: string;
  role: string;
  protocol?: string;
  base_url_env?: string;
  api_key_env?: string;
  context_window?: number | null;
  enabled: number;
};

export async function listModelProfiles(): Promise<ModelProfile[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, provider, model, display_name, role, enabled
       FROM model_profiles
       WHERE enabled = 1
       ORDER BY CASE role WHEN 'orchestrator' THEN 0 WHEN 'sandbox' THEN 1 ELSE 2 END, display_name ASC`,
    )
    .all() as ModelProfileRow[];

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    model: row.model,
    displayName: row.display_name,
    role: row.role,
    enabled: row.enabled === 1,
  }));
}

export async function listAllModelProfiles(): Promise<ModelProfile[]> {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, provider, model, display_name, role, protocol, base_url_env, api_key_env, context_window, enabled
       FROM model_profiles
       ORDER BY CASE role WHEN 'orchestrator' THEN 0 WHEN 'sandbox' THEN 1 ELSE 2 END, display_name ASC`,
    )
    .all() as ModelProfileRow[];

  return rows.map(mapModelProfile);
}

export async function getModelProfile(id: string): Promise<ModelProfile | null> {
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT id, provider, model, display_name, role, protocol, base_url_env, api_key_env, context_window, enabled
       FROM model_profiles
       WHERE id = ?`,
    )
    .get(id) as ModelProfileRow | undefined;

  if (!row) {
    return null;
  }

  return mapModelProfile(row);
}

export async function updateModelProfile(
  id: string,
  input: {
    displayName?: string;
    role?: string;
    enabled?: boolean;
  },
): Promise<ModelProfile | null> {
  const current = await getModelProfile(id);
  if (!current) {
    return null;
  }

  const db = await getDb();
  db.prepare(
    `UPDATE model_profiles
     SET display_name = ?, role = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.displayName?.trim() || current.displayName,
    input.role?.trim() || current.role,
    input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0,
    nowIso(),
    id,
  );

  return getModelProfile(id);
}

function mapModelProfile(row: ModelProfileRow): ModelProfile {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    displayName: row.display_name,
    role: row.role,
    protocol: row.protocol,
    baseUrlEnv: row.base_url_env,
    apiKeyEnv: row.api_key_env,
    contextWindow: row.context_window,
    enabled: row.enabled === 1,
  };
}
