# DataSwarm Schema and Storage Design

> Version: v0.1  
> Date: 2026-06-11  
> Scope: SQLite MVP schema, local storage layout, status enums, indexes, migration strategy, and future Postgres/OSS/S3 considerations.

## 0. Current V2 Storage Additions

Agentic Runtime V2 adds these active tables and metadata contracts on top of the original MVP schema:

| Area | Current contract |
|---|---|
| Agent actions | `agent_actions` persists model-proposed `AgentAction` JSON and lifecycle status |
| Observations | `observations` persists normalized evidence from tools, skills, artifacts, agents, users, and system blockers |
| Tools | `tools.metadata_json` and `schema_json` feed the `ToolCapability` catalog |
| Tool calls | `tool_calls` store adapter input/output summaries and payload URIs |
| Artifacts | `artifacts.metadata_json` now includes `artifactKind`, `contentHash`, `previewMode`, and source observation metadata |
| Trace | `trace_spans` remains the durable execution tree and is cross-linked from run events |

Implemented tool rows should currently include model-facing `web.search`, provider/direct `tavily.search`, `trace.query`, `artifact.create`, `file.read`, and `approval.request`. `web.search` is the default `web_search` capability exposed to the planner; its seeded input schema exposes an optional `provider` enum (`tavily`, `mock`), and its Observation metadata records `logical_tool_name`, `provider_tool_name`, and `provider` so diagnostics can distinguish planner choice from provider execution.

Swarm is currently planner-owned mock execution through the shared sandbox-agent protocol. Real E2B execution has an SDK path, a pinned `dataswarm-agent-runtime` template contract, readiness diagnostics, explicit template-verification gating, and a passed live sandbox smoke receipt; live orchestrator execution remains gated in each runtime on credentials and template receipt.

## 1. Design Principles

1. SQLite is the MVP database, but table names, field names, and relationship design should be migration-friendly for Postgres.
2. Local filesystem is the MVP artifact/payload store, but all persisted references should use URI-style `storage_uri` values.
3. Multi-tenant and multi-user fields are reserved from day one.
4. SQLite stores metadata, summaries, state, and pointers. Large payloads live in files.
5. Artifacts are immutable by version. Updating an artifact creates a new version.
6. Trace gaps are considered defects. Every run must have trace spans.
7. Do not store full secrets in any table or payload file.

## 2. Naming Conventions

- Primary keys: `id`, string ID with stable prefix, for example `run_...`, `msg_...`.
- Foreign keys: `<entity>_id`, for example `conversation_id`.
- Timestamps: ISO-8601 UTC text in SQLite, future `timestamptz` in Postgres.
- JSON fields: suffix `_json`.
- URIs: suffix `_uri`.
- Summaries: suffix `_summary`.
- Raw large payloads: stored in files, referenced by `payload_uri`.

## 3. ID Prefixes

| Entity | Prefix |
|---|---|
| Tenant | `ten_` |
| User | `usr_` |
| Project | `prj_` |
| Conversation | `conv_` |
| Message | `msg_` |
| Task | `task_` |
| Run | `run_` |
| Run step | `step_` |
| Run event | `evt_` |
| Agent session | `agent_` |
| Sandbox session | `sbx_` |
| Artifact | `art_` |
| Artifact version | `artv_` |
| Skill | `skill_` |
| Tool | `tool_` |
| Tool call | `tc_` |
| Trace span | `span_` |
| Approval | `appr_` |
| Context bundle | `ctx_` |
| Evaluation result | `eval_` |

## 4. Common Columns

Most domain tables should include:

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text | yes | Prefixed stable ID |
| `tenant_id` | text | yes | Use default tenant in MVP |
| `project_id` | text | nullable | Null only for global config tables |
| `user_id` | text | nullable | Acting user or owner |
| `created_at` | text | yes | UTC ISO timestamp |
| `updated_at` | text | yes | UTC ISO timestamp |
| `metadata_json` | text | no | JSON object |

MVP default IDs:

- `tenant_id`: `ten_default`
- `user_id`: `usr_local`
- `project_id`: `prj_default`

## 5. Core Tables

### 5.1 `tenants`

Purpose: reserve multi-tenant structure.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `ten_...` |
| `name` | text | yes | Display name |
| `plan` | text | yes | `local`, `team`, `enterprise` |
| `status` | text | yes | `active`, `disabled` |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

`action_json` for `spawn_agent` / `spawn_swarm` may include a `branches` array. Each branch definition contains `title`, `instruction`, optional `id`, and optional `modelProfile`; the swarm executor records the resulting `planSource` in the persisted swarm Observation metadata and `plan_source` in swarm events.

Indexes:

- `idx_tenants_status(status)`

### 5.2 `users`

Purpose: reserve user attribution and future auth.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `usr_...` |
| `tenant_id` | text | yes | FK-ish to tenants |
| `display_name` | text | yes | |
| `email` | text | no | nullable for local mode |
| `role` | text | yes | `owner`, `admin`, `member`, `viewer` |
| `status` | text | yes | `active`, `disabled` |
| `settings_json` | text | no | JSON |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_users_tenant_id(tenant_id)`
- `idx_users_email(email)`

### 5.3 `projects`

Purpose: group conversations, files, skills, and settings.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `prj_...` |
| `tenant_id` | text | yes | |
| `owner_user_id` | text | yes | |
| `name` | text | yes | |
| `description` | text | no | |
| `local_root` | text | no | optional local path |
| `status` | text | yes | `active`, `archived` |
| `settings_json` | text | no | default model, budget, enabled skills |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_projects_tenant_id(tenant_id)`
- `idx_projects_owner_user_id(owner_user_id)`
- `idx_projects_status(status)`

### 5.4 `conversations`

Purpose: user-visible chat/work sessions.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `conv_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `user_id` | text | yes | creator |
| `title` | text | yes | generated or user-set |
| `status` | text | yes | `active`, `archived`, `deleted` |
| `default_model` | text | no | model profile ID |
| `context_summary` | text | no | compacted conversation context |
| `last_run_id` | text | no | latest run |
| `last_message_at` | text | no | UTC |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_conversations_project_id(project_id)`
- `idx_conversations_user_id(user_id)`
- `idx_conversations_status(status)`
- `idx_conversations_last_message_at(last_message_at)`

### 5.5 `messages`

Purpose: structured conversation messages.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `msg_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `conversation_id` | text | yes | |
| `run_id` | text | no | null for user message before run creation if needed |
| `role` | text | yes | `user`, `assistant`, `system`, `tool` |
| `parts_json` | text | yes | structured message parts |
| `status` | text | yes | `created`, `streaming`, `completed`, `failed`, `redacted` |
| `created_by_agent_session_id` | text | no | assistant/tool messages |
| `token_count` | integer | no | estimate |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_messages_conversation_created(conversation_id, created_at)`
- `idx_messages_run_id(run_id)`
- `idx_messages_role(role)`

`parts_json` examples:

```json
[
  {
    "type": "text",
    "text": "请分析这个 CSV 并生成报告。"
  },
  {
    "type": "attachment_ref",
    "upload_id": "upl_123",
    "filename": "sample.csv"
  }
]
```

Assistant message parts:

```json
[
  {
    "type": "thinking_summary",
    "summary": "我会先做数据画像，再生成报告。"
  },
  {
    "type": "tool_call",
    "tool_call_id": "tc_123"
  },
  {
    "type": "artifact_preview",
    "artifact_id": "art_123"
  }
]
```

### 5.6 `uploads`

Purpose: user-uploaded files.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `upl_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `user_id` | text | yes | uploader |
| `conversation_id` | text | no | |
| `filename` | text | yes | original name |
| `mime_type` | text | no | |
| `size_bytes` | integer | yes | |
| `content_hash` | text | yes | sha256 |
| `storage_uri` | text | yes | `local://uploads/...` |
| `status` | text | yes | `ready`, `failed`, `deleted` |
| `metadata_json` | text | no | file profile, inferred schema |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_uploads_conversation_id(conversation_id)`
- `idx_uploads_content_hash(content_hash)`

## 6. Task and Run Tables

### 6.1 `tasks`

Purpose: durable representation of a user objective or generated sub-objective.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `task_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `conversation_id` | text | yes | |
| `parent_task_id` | text | no | subtask |
| `title` | text | yes | |
| `objective` | text | yes | |
| `task_type` | text | yes | see enum |
| `status` | text | yes | see enum |
| `priority` | integer | yes | default 0 |
| `risk_level` | text | yes | `low`, `medium`, `high`, `critical` |
| `input_refs_json` | text | no | upload/artifact/source refs |
| `acceptance_criteria_json` | text | no | expected outputs |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Task types:

- `chat`
- `web_research`
- `data_profile`
- `data_analysis`
- `visualization`
- `causal_inference`
- `report_generation`
- `scientific_computing`
- `code_task`
- `review`
- `swarm`

Task statuses:

- `created`
- `planned`
- `running`
- `blocked`
- `completed`
- `failed`
- `cancelled`

Indexes:

- `idx_tasks_conversation_id(conversation_id)`
- `idx_tasks_parent_task_id(parent_task_id)`
- `idx_tasks_status(status)`
- `idx_tasks_task_type(task_type)`

### 6.2 `runs`

Purpose: one execution attempt for a task.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `run_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `conversation_id` | text | yes | |
| `task_id` | text | yes | |
| `mode` | text | yes | `chat`, `agent`, `swarm`, `review`, `replay` |
| `status` | text | yes | see enum |
| `model_profile` | text | no | selected top-level profile |
| `attempt` | integer | yes | starts at 1 |
| `started_at` | text | no | UTC |
| `ended_at` | text | no | UTC |
| `budget_json` | text | no | tokens, dollars, time, tools |
| `result_summary` | text | no | final user-facing summary |
| `error_json` | text | no | normalized error |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Run statuses:

- `queued`
- `running`
- `waiting_approval`
- `cancelling`
- `cancelled`
- `completed`
- `failed`

Indexes:

- `idx_runs_task_id(task_id)`
- `idx_runs_conversation_id(conversation_id)`
- `idx_runs_status(status)`
- `idx_runs_created_at(created_at)`

### 6.3 `run_steps`

Purpose: human-readable and trace-linked execution steps.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `step_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `parent_step_id` | text | no | |
| `step_type` | text | yes | `plan`, `model`, `tool`, `skill`, `sandbox`, `artifact`, `review`, `eval` |
| `status` | text | yes | `queued`, `running`, `completed`, `failed`, `cancelled` |
| `title` | text | yes | |
| `input_summary` | text | no | |
| `output_summary` | text | no | |
| `started_at` | text | no | UTC |
| `ended_at` | text | no | UTC |
| `trace_span_id` | text | no | |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_run_steps_run_id(run_id)`
- `idx_run_steps_parent_step_id(parent_step_id)`
- `idx_run_steps_trace_span_id(trace_span_id)`

### 6.4 `run_events`

Purpose: ordered event log for SSE replay and UI state reconstruction.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `evt_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `seq` | integer | yes | monotonic per run |
| `event_type` | text | yes | see EVENT_PROTOCOL |
| `producer_kind` | text | yes | `system`, `user`, `orchestrator`, `agent`, `sandbox_agent`, `tool`, `skill`, `model`, `artifact`, `trace`, `evaluator`, `swarm` |
| `producer_id` | text | no | agent/tool/sandbox ID |
| `payload_json` | text | yes | redacted event payload |
| `created_at` | text | yes | UTC |

Constraints:

- Unique `(run_id, seq)`.

Indexes:

- `idx_run_events_run_seq(run_id, seq)`
- `idx_run_events_type(event_type)`
- `idx_run_events_created_at(created_at)`

### 6.5 `agent_actions`

Purpose: persist every model-proposed `AgentAction` and its lifecycle.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `act_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `step_id` | text | no | reserved |
| `agent_session_id` | text | no | proposing agent |
| `action_type` | text | yes | `call_tool`, `use_skill`, `create_artifact`, `ask_user`, `spawn_agent`, `spawn_swarm`, `final_answer` |
| `status` | text | yes | `proposed`, `validated`, `executed`, `blocked`, `failed` |
| `action_json` | text | yes | normalized action payload |
| `model_profile` | text | no | planner model profile |
| `trace_span_id` | text | no | model/agent span |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_agent_actions_run_id(run_id)`
- `idx_agent_actions_status(status)`
- `idx_agent_actions_type(action_type)`

### 6.6 `observations`

Purpose: normalized evidence units created by tools, skills, artifacts, agents, users, and system blockers.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `obs_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `action_id` | text | no | source `agent_actions.id` when applicable |
| `source_type` | text | yes | `tool`, `skill`, `artifact`, `agent`, `user`, `system` |
| `source_name` | text | yes | tool/skill/branch/artifact/system name |
| `status` | text | yes | `completed`, `failed`, `blocked`, `pending` |
| `summary` | text | yes | concise evidence summary |
| `payload_uri` | text | no | large payload pointer |
| `evidence_level` | text | yes | `real`, `mock`, `inferred`, `user_provided` |
| `claims_json` | text | no | structured claim list |
| `metadata_json` | text | no | tool call IDs, sources, artifact IDs, branch metadata, quality signals |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_observations_run_id(run_id)`
- `idx_observations_action_id(action_id)`
- `idx_observations_source(source_type, source_name)`
- `idx_observations_status(status)`

## 7. Agent and Sandbox Tables

### 7.1 `agent_sessions`

Purpose: runtime identity for orchestrator, specialists, reviewers, sandbox agents.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `agent_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `parent_agent_session_id` | text | no | |
| `agent_role` | text | yes | `orchestrator`, `specialist`, `sandbox`, `reducer`, `verifier`, `reviewer` |
| `agent_name` | text | yes | display name |
| `model_profile` | text | yes | |
| `status` | text | yes | see enum |
| `instructions_hash` | text | no | hash of instruction set |
| `context_bundle_id` | text | no | |
| `tool_policy_json` | text | no | |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Agent statuses:

- `created`
- `context_loaded`
- `running`
- `waiting_approval`
- `tool_calling`
- `completed`
- `failed`
- `cancelled`

Indexes:

- `idx_agent_sessions_run_id(run_id)`
- `idx_agent_sessions_parent(parent_agent_session_id)`
- `idx_agent_sessions_role(agent_role)`
- `idx_agent_sessions_status(status)`

### 7.2 `context_bundles`

Purpose: minimal context passed to an agent or sandbox.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `ctx_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `agent_session_id` | text | no | |
| `storage_uri` | text | yes | `local://sandbox-bundles/...` |
| `content_hash` | text | yes | sha256 |
| `token_estimate` | integer | no | |
| `source_refs_json` | text | no | messages/uploads/artifacts/traces |
| `redaction_status` | text | yes | `not_required`, `redacted`, `partial`, `failed` |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_context_bundles_run_id(run_id)`
- `idx_context_bundles_agent(agent_session_id)`
- `idx_context_bundles_hash(content_hash)`

### 7.3 `sandbox_sessions`

Purpose: represent local mock and E2B sandbox lifecycle.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `sbx_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `agent_session_id` | text | yes | |
| `provider` | text | yes | `mock`, `e2b` |
| `external_sandbox_id` | text | no | E2B ID |
| `status` | text | yes | see enum |
| `template` | text | no | template name/version |
| `started_at` | text | no | UTC |
| `ended_at` | text | no | UTC |
| `last_heartbeat_at` | text | no | UTC |
| `resource_limits_json` | text | no | CPU/mem/time |
| `env_policy_json` | text | no | allowed env vars |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Sandbox statuses:

- `created`
- `running`
- `completed`
- `cancelling`
- `cancelled`
- `failed`

Important metadata keys:

- `provider_mode`: `mock` or `e2b`.
- `e2b_preflight`: secret-safe readiness snapshot when provider is `e2b`.
- `agent_protocol`: currently `dataswarm.sandbox-agent.v1`.
- `timeout_ms`: effective branch timeout.
- `heartbeat_count`: number of `sandbox.agent.heartbeat` events observed by the parent runtime.
- `last_heartbeat_stage`: last heartbeat stage from the sandbox agent.
- `artifact_recovery`: latest `sandbox.agent.artifact_recovery_manifest` payload.
- `quality_signals`: sandbox agent quality signal object.
- `sandbox_runtime`: branch-local action/observation runtime summary.
- `attempt`, `max_attempts`, `attempt_failures`, `retry_policy`: bounded retry metadata.
- `cancel_requested`: boolean cancellation flag used by provider preflight checks.
- `error_code` / `error`: safe failure summary.
- `missing_env`, `verification_commands`: preflight failure remediation metadata.

Indexes:

- `idx_sandbox_sessions_run_id(run_id)`
- `idx_sandbox_sessions_agent(agent_session_id)`
- `idx_sandbox_sessions_status(status)`
- `idx_sandbox_sessions_external(external_sandbox_id)`

## 8. Artifact Tables

### 8.1 `artifacts`

Purpose: user-visible generated outputs.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `art_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `conversation_id` | text | yes | |
| `run_id` | text | yes | |
| `producer_agent_session_id` | text | no | |
| `type` | text | yes | see enum |
| `mime_type` | text | no | |
| `title` | text | yes | |
| `status` | text | yes | see enum |
| `current_version_id` | text | no | |
| `storage_uri` | text | no | current version URI convenience |
| `preview_uri` | text | no | |
| `source_trace_id` | text | no | |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Artifact types:

- `markdown`
- `html`
- `image`
- `chart`
- `csv`
- `json`
- `notebook`
- `log`
- `trace_summary`
- `source_bundle`

Artifact statuses:

- `creating`
- `ready`
- `preview_ready`
- `failed`
- `archived`

Indexes:

- `idx_artifacts_conversation_id(conversation_id)`
- `idx_artifacts_run_id(run_id)`
- `idx_artifacts_type(type)`
- `idx_artifacts_status(status)`

### 8.2 `artifact_versions`

Purpose: immutable artifact revisions.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `artv_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `artifact_id` | text | yes | |
| `version` | integer | yes | starts at 1 |
| `storage_uri` | text | yes | |
| `preview_uri` | text | no | |
| `mime_type` | text | no | |
| `size_bytes` | integer | no | |
| `content_hash` | text | yes | sha256 |
| `created_by_agent_session_id` | text | no | |
| `change_summary` | text | no | |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Constraints:

- Unique `(artifact_id, version)`.

Indexes:

- `idx_artifact_versions_artifact_id(artifact_id)`
- `idx_artifact_versions_hash(content_hash)`

## 9. Skill and Tool Tables

### 9.1 `skills`

Purpose: installed skill registry.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `skill_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | no | null for global skill |
| `name` | text | yes | |
| `version` | text | yes | semantic or local version |
| `source` | text | yes | `local`, `git`, `registry`, `generated` |
| `path` | text | yes | local path |
| `description` | text | no | |
| `tags_json` | text | no | |
| `required_tools_json` | text | no | |
| `permissions_json` | text | no | |
| `status` | text | yes | `enabled`, `disabled`, `draft`, `failed` |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_skills_name(name)`
- `idx_skills_status(status)`
- `idx_skills_project_id(project_id)`

### 9.2 `skill_usages`

Purpose: trace skill use in runs.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `sku_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `skill_id` | text | yes | |
| `run_id` | text | yes | |
| `agent_session_id` | text | no | |
| `status` | text | yes | `selected`, `loaded`, `executed`, `failed`, `skipped` |
| `input_summary` | text | no | |
| `output_summary` | text | no | |
| `trace_span_id` | text | no | |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_skill_usages_run_id(run_id)`
- `idx_skill_usages_skill_id(skill_id)`

### 9.3 `tools`

Purpose: tool registry.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `tool_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | no | null for global |
| `name` | text | yes | unique per scope |
| `kind` | text | yes | `builtin`, `mcp`, `sandbox`, `external` |
| `schema_json` | text | yes | input/output schema |
| `risk_level` | text | yes | `low`, `medium`, `high`, `critical` |
| `permission_policy_json` | text | no | |
| `enabled` | integer | yes | 0/1 |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_tools_name(name)`
- `idx_tools_kind(kind)`
- `idx_tools_enabled(enabled)`

### 9.4 `tool_calls`

Purpose: durable tool invocation records.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `tc_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `agent_session_id` | text | no | |
| `tool_id` | text | yes | |
| `trace_span_id` | text | no | |
| `status` | text | yes | `requested`, `running`, `completed`, `failed`, `cancelled`, `blocked` |
| `input_summary` | text | no | redacted summary |
| `output_summary` | text | no | redacted summary |
| `input_payload_uri` | text | no | optional |
| `output_payload_uri` | text | no | optional |
| `started_at` | text | no | UTC |
| `ended_at` | text | no | UTC |
| `error_json` | text | no | normalized error |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_tool_calls_run_id(run_id)`
- `idx_tool_calls_agent(agent_session_id)`
- `idx_tool_calls_tool(tool_id)`
- `idx_tool_calls_status(status)`

## 10. Trace and Evaluation Tables

### 10.1 `trace_spans`

Purpose: structured observability backbone.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `span_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `trace_id` | text | yes | root trace ID |
| `parent_span_id` | text | no | |
| `run_id` | text | yes | |
| `agent_session_id` | text | no | |
| `span_kind` | text | yes | see enum |
| `name` | text | yes | |
| `status` | text | yes | `started`, `completed`, `failed`, `cancelled` |
| `started_at` | text | yes | UTC |
| `ended_at` | text | no | UTC |
| `attributes_json` | text | no | OTel/OpenInference-style attrs |
| `payload_uri` | text | no | large raw payload |
| `redaction_status` | text | yes | `not_required`, `redacted`, `partial`, `failed` |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Span kinds:

- `agent.run`
- `agent.plan`
- `model.call`
- `tool.call`
- `skill.resolve`
- `skill.execute`
- `context.bundle.create`
- `context.compact`
- `swarm.plan`
- `swarm.branch`
- `swarm.merge`
- `swarm.verify`
- `swarm.reduce`
- `swarm.review`
- `sandbox.create`
- `sandbox.agent.run`
- `artifact.create`
- `artifact.preview`
- `approval.wait`
- `eval.run`

Indexes:

- `idx_trace_spans_trace_id(trace_id)`
- `idx_trace_spans_run_id(run_id)`
- `idx_trace_spans_parent(parent_span_id)`
- `idx_trace_spans_kind(span_kind)`
- `idx_trace_spans_status(status)`

### 10.2 `approvals`

Purpose: human-in-the-loop decisions.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `appr_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `agent_session_id` | text | no | |
| `tool_call_id` | text | no | |
| `status` | text | yes | `requested`, `approved`, `rejected`, `expired`, `cancelled` |
| `risk_level` | text | yes | |
| `request_summary` | text | yes | |
| `request_payload_uri` | text | no | optional large payload |
| `decision_by_user_id` | text | no | |
| `decision_comment` | text | no | |
| `expires_at` | text | no | UTC |
| `resolved_at` | text | no | UTC |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_approvals_run_id(run_id)`
- `idx_approvals_status(status)`

### 10.3 `eval_results`

Purpose: run/artifact/swarm quality evaluation.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `eval_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `artifact_id` | text | no | |
| `eval_type` | text | yes | `run_health`, `run`, `artifact`, `swarm`, `tool`, `trace` |
| `status` | text | yes | `completed`, `failed`, `warning`, `skipped` |
| `score` | real | no | 0-1 optional |
| `summary` | text | no | |
| `checks_json` | text | no | individual checks |
| `trace_span_id` | text | no | |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_eval_results_run_id(run_id)`
- `idx_eval_results_artifact_id(artifact_id)`
- `idx_eval_results_type(eval_type)`
- `idx_eval_results_status(status)`

### 10.4 `self_improvement_candidates`

Purpose: async, trace/eval-derived improvement queue for prompt, skill, tool, UI, sandbox, and verification changes.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `sic_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | yes | |
| `run_id` | text | yes | |
| `conversation_id` | text | yes | |
| `eval_result_id` | text | no | source eval |
| `candidate_type` | text | yes | `prompt_patch`, `skill_patch`, `tool_adapter_patch`, `ui_bug`, `sandbox_template`, `verification_gap` |
| `status` | text | yes | `queued`, `shadow_tested`, `patch_prepared`, `approved`, `rejected`, `deferred`, `applied` |
| `severity` | text | yes | `low`, `medium`, `high`, `critical` |
| `title` | text | yes | |
| `rationale` | text | yes | |
| `evidence_json` | text | no | trace/eval/log evidence |
| `proposal_json` | text | no | proposed remediation and review bundle URI |
| `verification_plan_json` | text | no | required smoke commands and expected checks |
| `trace_span_id` | text | no | self-improvement analysis span |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Indexes:

- `idx_self_improvement_candidates_run_id(run_id)`
- `idx_self_improvement_candidates_conversation_id(conversation_id)`
- `idx_self_improvement_candidates_status(status)`
- `idx_self_improvement_candidates_type(candidate_type)`

## 11. Settings Tables

### 11.1 `model_profiles`

Purpose: configurable model catalog.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | for example `dmx:gpt-5.5-1m` |
| `provider` | text | yes | `dmx`, `deepseek` |
| `model` | text | yes | provider model ID |
| `display_name` | text | yes | UI label |
| `role` | text | yes | `orchestrator`, `sandbox`, `reviewer`, `general` |
| `protocol` | text | yes | `openai_chat_completions`, `responses` |
| `base_url_env` | text | yes | |
| `api_key_env` | text | yes | |
| `context_window` | integer | no | |
| `enabled` | integer | yes | 0/1 |
| `settings_json` | text | no | temperature, limits, etc |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Seed profiles:

- `dmx:gpt-5.5-1m`
- `dmx:claude-opus-4-8`
- `deepseek:deepseek-v4-pro`
- `deepseek:deepseek-v4-flash`

### 11.2 `mcp_servers`

Purpose: MCP server registry.

| Column | Type | Required | Notes |
|---|---|---|---|
| `id` | text primary key | yes | `mcp_...` |
| `tenant_id` | text | yes | |
| `project_id` | text | no | |
| `label` | text | yes | `tavily` |
| `transport` | text | yes | `http`, `stdio`, `sse` |
| `server_url_template` | text | no | use env placeholders |
| `command_json` | text | no | stdio command |
| `auth_json` | text | no | env var names only |
| `enabled` | integer | yes | 0/1 |
| `tool_snapshot_json` | text | no | discovered tools |
| `metadata_json` | text | no | JSON |
| `created_at` | text | yes | UTC |
| `updated_at` | text | yes | UTC |

Web-search registry rule:

- Store `web.search` as the model-facing `web_search` capability.
- Store `tavily.search` as the current provider/direct adapter for compatibility and diagnostics.
- Store URL template with `${TAVILY_API_KEY}` placeholder.
- Do not store the actual key.

## 12. Local Storage Layout

Root:

```text
data/
  dataswarm.sqlite
  uploads/
  artifacts/
  traces/
  sandbox-bundles/
  emergency-events/
```

Uploads:

```text
data/uploads/
  <project_id>/
    <upload_id>/
      original.<ext>
      metadata.json
```

Artifacts:

```text
data/artifacts/
  <project_id>/
    <artifact_id>/
      v1/
        artifact.md
        preview.html
        metadata.json
      v2/
        artifact.md
        preview.html
        metadata.json
```

Trace payloads:

```text
data/traces/
  <project_id>/
    <run_id>/
      <span_id>.json
      <tool_call_id>.json
```

Sandbox bundles:

```text
data/sandbox-bundles/
  <project_id>/
    <run_id>/
      <context_bundle_id>.json
      files/
```

Emergency event log:

```text
data/emergency-events/
  <date>.jsonl
```

Use this only if SQLite write fails while a run is active.

## 13. URI Strategy

MVP local URIs:

- `local://uploads/<project_id>/<upload_id>/original.csv`
- `local://artifacts/<project_id>/<artifact_id>/v1/artifact.md`
- `local://traces/<project_id>/<run_id>/<span_id>.json`
- `local://sandbox-bundles/<project_id>/<run_id>/<context_bundle_id>.json`

Future cloud URIs:

- `oss://<bucket>/<key>`
- `s3://<bucket>/<key>`

Never store absolute local paths in user-facing metadata. Resolve `local://` internally.

## 14. SQLite Pragmas

Recommended MVP settings:

- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA synchronous = NORMAL`

Notes:

- WAL improves concurrent read/write behavior.
- SQLite still has write concurrency limits; keep writes short.
- Long-running model/sandbox tasks should not hold database transactions.

## 15. Migration Strategy

### 15.1 Migration Files

Use ordered migration files:

```text
migrations/
  0001_init.sql
  0002_add_trace_tables.sql
  0003_add_swarm_tables.sql
```

Track migrations:

**schema_migrations**

| Column | Type | Required |
|---|---|---|
| `version` | text primary key | yes |
| `applied_at` | text | yes |
| `checksum` | text | yes |

### 15.2 SQLite to Postgres Readiness

Avoid SQLite-specific shortcuts that make migration hard:

- Use text IDs instead of integer autoincrement.
- Store booleans as integer 0/1 in SQLite, map to boolean in Postgres later.
- Use ISO timestamp text in SQLite, map to timestamptz later.
- Keep JSON fields valid JSON strings, map to jsonb later.
- Avoid relying on SQLite loose typing.

### 15.3 Postgres Target Changes

Future Postgres adjustments:

- JSON fields become `jsonb`.
- Timestamp fields become `timestamptz`.
- Add real foreign keys where operationally safe.
- Add partial indexes for active runs, active conversations, failed spans.
- Add row-level security if multi-tenant SaaS becomes real.

## 16. Data Retention

MVP suggested defaults:

- Conversations/messages: keep indefinitely unless user deletes.
- Artifacts: keep indefinitely unless archived/deleted.
- Trace summaries: keep indefinitely.
- Large trace payloads: configurable, default 30-90 days.
- Sandbox bundles: default 7-30 days unless linked to artifact.
- Emergency events: default 30 days after successful recovery.

Deletion rules:

- Soft delete user-facing objects first.
- Hard-delete local files only after metadata is updated.
- Preserve audit traces for destructive actions unless user explicitly purges local data.

## 17. Seed Data

MVP should create:

- Default tenant: `ten_default`
- Default user: `usr_local`
- Default project: `prj_default`
- Model profiles:
  - `dmx:gpt-5.5-1m`
  - `dmx:claude-opus-4-8`
  - `deepseek:deepseek-v4-pro`
  - `deepseek:deepseek-v4-flash`
- Tavily MCP server definition.
- Built-in tool definitions.
- Built-in skills from `skills/`.

## 18. Validation Checklist

Schema is acceptable when:

- [ ] All tables can be created in SQLite.
- [ ] Default seed data can be inserted.
- [ ] A conversation can be created and listed.
- [ ] A user message can create a task and run.
- [ ] Run events can be appended and replayed by `run_id, seq`.
- [ ] Trace spans can be linked to run, tool call, artifact.
- [ ] Artifact versions cannot overwrite previous versions.
- [ ] Large payloads can be stored via URI without bloating SQLite.
- [ ] Secret redaction fields exist where raw payload may be involved.
- [ ] Tenant/user/project fields exist in user, run, artifact, trace tables.
