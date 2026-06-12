import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ensureDataDirs, getSqlitePath, sha256 } from "./paths";
import { initialSchemaSql } from "./schema";
import { nowIso } from "./ids";

const migrationVersion = "0001_init";
const defaultTenantId = "ten_default";
const defaultUserId = "usr_local";
const defaultProjectId = "prj_default";

let database: DatabaseSync | null = null;
let initialized = false;

type CountRow = { count: number };

export async function getDb() {
  if (!database) {
    await ensureDataDirs();
    database = new DatabaseSync(getSqlitePath());
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA synchronous = NORMAL;");
  }

  if (!initialized) {
    runMigrations(database);
    seedDefaults(database);
    initialized = true;
  }

  return database;
}

function runMigrations(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);

  const checksum = sha256(initialSchemaSql);
  const existing = db
    .prepare("SELECT version, checksum FROM schema_migrations WHERE version = ?")
    .get(migrationVersion) as { version: string; checksum: string } | undefined;

  if (existing) {
    if (existing.checksum !== checksum) {
      throw new Error(`Migration checksum mismatch for ${migrationVersion}`);
    }
  } else {
    db.exec("BEGIN;");
    try {
      db.exec(initialSchemaSql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)",
      ).run(migrationVersion, nowIso(), checksum);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  runMigrationIfMissing(db, "0002_agentic_runtime_v2", agenticRuntimeV2MigrationSql);
  runMigrationIfMissing(db, "0003_self_improvement_candidates", selfImprovementCandidatesMigrationSql);
}

function runMigrationIfMissing(db: DatabaseSync, version: string, sql: string) {
  const checksum = sha256(sql);
  const existing = db
    .prepare("SELECT version, checksum FROM schema_migrations WHERE version = ?")
    .get(version) as { version: string; checksum: string } | undefined;

  if (existing) {
    if (existing.checksum !== checksum) {
      throw new Error(`Migration checksum mismatch for ${version}`);
    }
    return;
  }

  db.exec("BEGIN;");
  try {
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)",
    ).run(version, nowIso(), checksum);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

const agenticRuntimeV2MigrationSql = `
CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT,
  agent_session_id TEXT,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  action_json TEXT NOT NULL,
  model_profile TEXT,
  trace_span_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_run_id ON agent_actions(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions(status);
CREATE INDEX IF NOT EXISTS idx_agent_actions_type ON agent_actions(action_type);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  action_id TEXT,
  source_type TEXT NOT NULL,
  source_name TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_uri TEXT,
  evidence_level TEXT NOT NULL,
  claims_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_run_id ON observations(run_id);
CREATE INDEX IF NOT EXISTS idx_observations_action_id ON observations(action_id);
CREATE INDEX IF NOT EXISTS idx_observations_source ON observations(source_type, source_name);
CREATE INDEX IF NOT EXISTS idx_observations_status ON observations(status);
`;

const selfImprovementCandidatesMigrationSql = `
CREATE TABLE IF NOT EXISTS self_improvement_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  eval_result_id TEXT,
  candidate_type TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT,
  proposal_json TEXT,
  verification_plan_json TEXT,
  trace_span_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_improvement_candidates_run_id ON self_improvement_candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_self_improvement_candidates_conversation_id ON self_improvement_candidates(conversation_id);
CREATE INDEX IF NOT EXISTS idx_self_improvement_candidates_status ON self_improvement_candidates(status);
CREATE INDEX IF NOT EXISTS idx_self_improvement_candidates_type ON self_improvement_candidates(candidate_type);
`;

function seedDefaults(db: DatabaseSync) {
  const now = nowIso();

  insertIfMissing(db, "tenants", defaultTenantId, () => {
    db.prepare(
      `INSERT INTO tenants
       (id, name, plan, status, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(defaultTenantId, "Local DataSwarm", "local", "active", "{}", now, now);
  });

  insertIfMissing(db, "users", defaultUserId, () => {
    db.prepare(
      `INSERT INTO users
       (id, tenant_id, display_name, email, role, status, settings_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      defaultUserId,
      defaultTenantId,
      "Local User",
      null,
      "owner",
      "active",
      "{}",
      "{}",
      now,
      now,
    );
  });

  insertIfMissing(db, "projects", defaultProjectId, () => {
    db.prepare(
      `INSERT INTO projects
       (id, tenant_id, owner_user_id, name, description, local_root, status, settings_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      defaultProjectId,
      defaultTenantId,
      defaultUserId,
      "Default Project",
      "Local-first DataSwarm MVP workspace",
      path.resolve(
        /* turbopackIgnore: true */ process.cwd(),
        process.env.DATASWARM_WORKSPACE_ROOT ?? ".",
      ),
      "active",
      JSON.stringify({ default_model: "dmx:gpt-5.5-1m" }),
      "{}",
      now,
      now,
    );
  });

  const profiles = [
    {
      id: "dmx:gpt-5.5-1m",
      provider: "dmx",
      model: "gpt-5.5-1m",
      display: "GPT 5.5 1M",
      role: "orchestrator",
      baseUrlEnv: "DMX_BASE_URL",
      apiKeyEnv: "DMX_API_KEY",
      contextWindow: 1_000_000,
    },
    {
      id: "dmx:claude-opus-4-8",
      provider: "dmx",
      model: "claude-opus-4-8",
      display: "Claude Opus 4.8",
      role: "orchestrator",
      baseUrlEnv: "DMX_BASE_URL",
      apiKeyEnv: "DMX_API_KEY",
      contextWindow: 1_000_000,
    },
    {
      id: "deepseek:deepseek-v4-pro",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      display: "DeepSeek V4 Pro",
      role: "sandbox",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      contextWindow: null,
    },
    {
      id: "deepseek:deepseek-v4-flash",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      display: "DeepSeek V4 Flash",
      role: "sandbox",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      contextWindow: null,
    },
  ];

  for (const profile of profiles) {
    insertIfMissing(db, "model_profiles", profile.id, () => {
      db.prepare(
        `INSERT INTO model_profiles
         (id, provider, model, display_name, role, protocol, base_url_env, api_key_env, context_window, enabled, settings_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        profile.id,
        profile.provider,
        profile.model,
        profile.display,
        profile.role,
        "openai_chat_completions",
        profile.baseUrlEnv,
        profile.apiKeyEnv,
        profile.contextWindow,
        1,
        "{}",
        "{}",
        now,
        now,
      );
    });
  }

  insertIfMissing(db, "mcp_servers", "mcp_tavily", () => {
    db.prepare(
      `INSERT INTO mcp_servers
       (id, tenant_id, project_id, label, transport, server_url_template, command_json, auth_json, enabled, tool_snapshot_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "mcp_tavily",
      defaultTenantId,
      null,
      "tavily",
      "http",
      "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}",
      null,
      JSON.stringify({ apiKeyEnv: "TAVILY_API_KEY" }),
      1,
      JSON.stringify(["tavily-search", "tavily-extract"]),
      "{}",
      now,
      now,
    );
  });

  const tools = [
    ["tool_artifact_create", "artifact.create", "builtin", "low"],
    ["tool_file_read", "file.read", "builtin", "low"],
    ["tool_trace_query", "trace.query", "builtin", "low"],
    ["tool_approval_request", "approval.request", "builtin", "medium"],
    ["tool_web_search", "web.search", "builtin", "low"],
    ["tool_tavily_search", "tavily.search", "mcp", "low"],
  ] as const;

  for (const [id, name, kind, risk] of tools) {
    insertIfMissing(db, "tools", id, () => {
      db.prepare(
        `INSERT INTO tools
         (id, tenant_id, project_id, name, kind, schema_json, risk_level, permission_policy_json, enabled, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        defaultTenantId,
        null,
        name,
        kind,
        JSON.stringify(defaultToolSchema(name)),
        risk,
        "{}",
        1,
        JSON.stringify(defaultToolMetadata(name)),
        now,
        now,
      );
    });
    db.prepare(
      `UPDATE tools
       SET schema_json = ?, metadata_json = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(JSON.stringify(defaultToolSchema(name)), JSON.stringify(defaultToolMetadata(name)), now, id, defaultTenantId);
  }

  const skills = [
    ["skill_web_research", "web-research", "skills/web-research"],
    ["skill_data_profiling", "data-profiling", "skills/data-profiling"],
    ["skill_report_generation", "report-generation", "skills/report-generation"],
  ] as const;

  for (const [id, name, skillPath] of skills) {
    insertIfMissing(db, "skills", id, () => {
      db.prepare(
        `INSERT INTO skills
         (id, tenant_id, project_id, name, version, source, path, description, tags_json, required_tools_json, permissions_json, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        defaultTenantId,
        null,
        name,
        "0.1.0",
        "local",
        skillPath,
        `${name} MVP placeholder skill`,
        JSON.stringify([name]),
        "[]",
        "{}",
        "enabled",
        "{}",
        now,
        now,
      );
    });
  }
}

function defaultToolMetadata(name: string) {
  if (name === "web.search") {
    return {
      displayName: "Web Search",
      description: "Generic web_search capability routed to the best available provider adapter.",
      provider: "dataswarm",
      defaultProvider: "tavily",
      providerCandidates: ["tavily", "mock"],
      upstreamProvider: "tavily",
      providerToolName: "tavily.search",
      capabilityKind: "web_search",
      adapterStatus: "implemented",
      evidenceKind: "external_source",
      freshness: "near_realtime",
      costHint: "low",
    };
  }
  if (name === "tavily.search") {
    return {
      displayName: "Tavily Search",
      description: "Direct Tavily web_search provider adapter.",
      provider: "tavily",
      capabilityKind: "web_search",
      adapterStatus: "implemented",
      evidenceKind: "external_source",
      freshness: "near_realtime",
      costHint: "low",
    };
  }
  return {};
}

function defaultToolSchema(name: string) {
  if (name === "web.search" || name === "tavily.search") {
    const providerProperty =
      name === "web.search"
        ? {
            provider: {
              type: "string",
              enum: ["tavily", "mock"],
              description: "Optional web_search provider override. Omit to use DATASWARM_WEB_SEARCH_PROVIDER or Tavily.",
            },
          }
        : {};
    return {
      input: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Search query written for the selected provider.",
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Maximum number of sources to return.",
          },
          search_depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description: "Provider search depth when supported.",
          },
          topic: {
            type: "string",
            enum: ["general", "news"],
            description: "Provider topic hint when supported.",
          },
          include_answer: {
            type: "boolean",
            description: "Whether the provider should include a synthesized answer when supported.",
          },
          include_raw_content: {
            type: "boolean",
            description: "Whether the provider should include raw page content when supported.",
          },
          include_domains: {
            type: "array",
            items: { type: "string" },
            description: "Domain allow-list for the search provider.",
          },
          exclude_domains: {
            type: "array",
            items: { type: "string" },
            description: "Domain block-list for the search provider.",
          },
          ...providerProperty,
        },
      },
      output: {
        type: "object",
        properties: {
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                content: { type: "string" },
              },
            },
          },
          logicalToolName: { type: "string" },
          providerToolName: { type: "string" },
          provider: { type: "string" },
        },
      },
    };
  }
  return { input: { type: "object" }, output: { type: "object" } };
}

function insertIfMissing(db: DatabaseSync, table: string, id: string, insert: () => void) {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE id = ?`).get(id) as
    | CountRow
    | undefined;
  if (!row || row.count === 0) {
    insert();
  }
}

export const defaults = {
  tenantId: defaultTenantId,
  userId: defaultUserId,
  projectId: defaultProjectId,
};
