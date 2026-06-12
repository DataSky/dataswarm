export const initialSchemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  settings_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  local_root TEXT,
  status TEXT NOT NULL,
  settings_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_projects_owner_user_id ON projects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  default_model TEXT,
  context_summary TEXT,
  last_run_id TEXT,
  last_message_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT,
  role TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by_agent_session_id TEXT,
  token_count INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_run_id ON messages(run_id);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  storage_uri TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_conversation_id ON uploads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_uploads_content_hash ON uploads(content_hash);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  risk_level TEXT NOT NULL,
  input_refs_json TEXT,
  acceptance_criteria_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation_id ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  model_profile TEXT,
  attempt INTEGER NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  budget_json TEXT,
  result_summary TEXT,
  error_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_conversation_id ON runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_step_id TEXT,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  started_at TEXT,
  ended_at TEXT,
  trace_span_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_run_steps_parent_step_id ON run_steps(parent_step_id);
CREATE INDEX IF NOT EXISTS idx_run_steps_trace_span_id ON run_steps(trace_span_id);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  producer_kind TEXT NOT NULL,
  producer_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(event_type);
CREATE INDEX IF NOT EXISTS idx_run_events_created_at ON run_events(created_at);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_agent_session_id TEXT,
  agent_role TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  model_profile TEXT NOT NULL,
  status TEXT NOT NULL,
  instructions_hash TEXT,
  context_bundle_id TEXT,
  tool_policy_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_run_id ON agent_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent ON agent_sessions(parent_agent_session_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_role ON agent_sessions(agent_role);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);

CREATE TABLE IF NOT EXISTS context_bundles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_session_id TEXT,
  storage_uri TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_estimate INTEGER,
  source_refs_json TEXT,
  redaction_status TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_bundles_run_id ON context_bundles(run_id);
CREATE INDEX IF NOT EXISTS idx_context_bundles_agent ON context_bundles(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_context_bundles_hash ON context_bundles(content_hash);

CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_sandbox_id TEXT,
  status TEXT NOT NULL,
  template TEXT,
  started_at TEXT,
  ended_at TEXT,
  last_heartbeat_at TEXT,
  resource_limits_json TEXT,
  env_policy_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_run_id ON sandbox_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_agent ON sandbox_sessions(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_status ON sandbox_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sandbox_sessions_external ON sandbox_sessions(external_sandbox_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  producer_agent_session_id TEXT,
  type TEXT NOT NULL,
  mime_type TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  current_version_id TEXT,
  storage_uri TEXT,
  preview_uri TEXT,
  source_trace_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_conversation_id ON artifacts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(status);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  storage_uri TEXT NOT NULL,
  preview_uri TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  content_hash TEXT NOT NULL,
  created_by_agent_session_id TEXT,
  change_summary TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(artifact_id, version)
);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact_id ON artifact_versions(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_hash ON artifact_versions(content_hash);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  tags_json TEXT,
  required_tools_json TEXT,
  permissions_json TEXT,
  status TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
CREATE INDEX IF NOT EXISTS idx_skills_project_id ON skills(project_id);

CREATE TABLE IF NOT EXISTS skill_usages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_session_id TEXT,
  status TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  trace_span_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_usages_run_id ON skill_usages(run_id);
CREATE INDEX IF NOT EXISTS idx_skill_usages_skill_id ON skill_usages(skill_id);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  permission_policy_json TEXT,
  enabled INTEGER NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name);
CREATE INDEX IF NOT EXISTS idx_tools_kind ON tools(kind);
CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_session_id TEXT,
  tool_id TEXT NOT NULL,
  trace_span_id TEXT,
  status TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  input_payload_uri TEXT,
  output_payload_uri TEXT,
  started_at TEXT,
  ended_at TEXT,
  error_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status);

CREATE TABLE IF NOT EXISTS trace_spans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  run_id TEXT NOT NULL,
  agent_session_id TEXT,
  span_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  attributes_json TEXT,
  payload_uri TEXT,
  redaction_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_spans_trace_id ON trace_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_run_id ON trace_spans(run_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_parent ON trace_spans(parent_span_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_kind ON trace_spans(span_kind);
CREATE INDEX IF NOT EXISTS idx_trace_spans_status ON trace_spans(status);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_session_id TEXT,
  tool_call_id TEXT,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  request_summary TEXT NOT NULL,
  request_payload_uri TEXT,
  decision_by_user_id TEXT,
  decision_comment TEXT,
  expires_at TEXT,
  resolved_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_run_id ON approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  artifact_id TEXT,
  eval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL,
  summary TEXT,
  checks_json TEXT,
  trace_span_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_results_run_id ON eval_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_artifact_id ON eval_results(artifact_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_type ON eval_results(eval_type);
CREATE INDEX IF NOT EXISTS idx_eval_results_status ON eval_results(status);

CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url_env TEXT NOT NULL,
  api_key_env TEXT NOT NULL,
  context_window INTEGER,
  enabled INTEGER NOT NULL,
  settings_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  label TEXT NOT NULL,
  transport TEXT NOT NULL,
  server_url_template TEXT,
  command_json TEXT,
  auth_json TEXT,
  enabled INTEGER NOT NULL,
  tool_snapshot_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
