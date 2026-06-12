# DataSwarm Run Event Protocol

> Version: v0.1  
> Date: 2026-06-11  
> Scope: runtime event envelope, SSE transport, replay rules, event types, payload contracts, UI mapping, and validation criteria.

## 0. Current Runtime Event Mainline

Agentic Runtime V2 currently emits this canonical chain:

```text
run.started
message.created
message.part.started
model.call.started
model.call.completed | model.call.failed
action.proposed
action.validated
skill.selected                    optional
tool.call.requested               optional
tool.call.started                 optional
tool.call.output                  optional
observation.created | observation.failed
tool.call.completed | tool.call.failed
artifact.created                  optional
artifact.preview.ready            optional
agent.replan.requested            optional
message.part.delta
message.part.completed
message.completed
eval.started
eval.completed
run.completed | run.failed
```

The UI should render tool, skill, model, artifact, and swarm cards from these events. Assistant text is not a reliable source of runtime state.

Swarm execution follows the same event/observation contract. Current productionized swarm is planner-owned mock execution through the sandbox-agent protocol, with real E2B execution gated by readiness checks and template verification.

## 1. Purpose

DataSwarm uses structured run events as the source of truth for live UI rendering, replay, debugging, and trace correlation.

Events are emitted by the DataSwarm Runtime, persisted into `run_events`, and streamed to clients over SSE. The UI must never infer run state by scraping logs or parsing arbitrary assistant text.

## 2. Design Principles

1. Every event has a stable `id`, monotonic `seq`, and `run_id`.
2. Events are persisted before being sent over SSE.
3. Clients can replay from `Last-Event-ID`.
4. Events are redacted by default.
5. Large payloads are stored by URI, not embedded in the event.
6. Event payloads are typed and versioned.
7. UI rendering is derived from events plus persisted conversation/artifact state.
8. Trace spans and events should cross-reference each other where possible.

## 3. Transport

### 3.1 SSE Endpoint

```text
GET /api/runs/:run_id/events
```

Headers:

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Client may send:

```text
Last-Event-ID: evt_...
```

Query parameters:

| Parameter | Required | Notes |
|---|---|---|
| `from_seq` | no | replay events after a sequence |
| `include_snapshot` | no | if true, server may send `run.snapshot` first |

### 3.2 SSE Frame Format

```text
id: evt_000001
event: run.started
data: {"id":"evt_000001","run_id":"run_123","seq":1,"type":"run.started",...}

```

Heartbeat:

```text
event: heartbeat
data: {"timestamp":"2026-06-08T10:00:00.000Z"}

```

Heartbeat is not persisted unless needed for debugging.

## 4. Event Envelope

All persisted run events use this envelope:

```json
{
  "schema_version": "2026-06-08.v1",
  "id": "evt_000001",
  "run_id": "run_123",
  "conversation_id": "conv_123",
  "task_id": "task_123",
  "seq": 1,
  "type": "run.started",
  "timestamp": "2026-06-08T10:00:00.000Z",
  "producer": {
    "kind": "orchestrator",
    "id": "agent_123",
    "name": "Orchestrator"
  },
  "trace": {
    "trace_id": "trace_123",
    "span_id": "span_123",
    "parent_span_id": null
  },
  "payload": {}
}
```

Envelope fields:

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Event schema version |
| `id` | yes | Event ID |
| `run_id` | yes | Run ID |
| `conversation_id` | yes | Conversation ID |
| `task_id` | no | Task ID if known |
| `seq` | yes | Monotonic per run |
| `type` | yes | Event type |
| `timestamp` | yes | UTC ISO timestamp |
| `producer` | yes | Runtime component that emitted event |
| `trace` | no | Trace correlation |
| `payload` | yes | Type-specific payload |

Producer kinds:

- `system`
- `user`
- `orchestrator`
- `sandbox_agent`
- `swarm`
- `tool`
- `skill`
- `model`
- `artifact`
- `trace`
- `evaluator`

## 5. Ordering and Replay

### 5.1 Sequence Rules

- `seq` starts at 1 for each run.
- `seq` increases by 1.
- `(run_id, seq)` is unique.
- Event `id` should be stable and map to one row in `run_events`.

### 5.2 Persist-before-stream Rule

The server must:

1. Build event envelope.
2. Redact payload.
3. Persist event row.
4. Flush event to SSE clients.

If step 3 fails:

- Write emergency JSONL event if possible.
- Emit a non-persisted operational warning only if safe.
- Mark run observability as degraded.

### 5.3 Replay

When client reconnects:

1. Client sends `Last-Event-ID` or `from_seq`.
2. Server loads all events after that point.
3. Server streams historical events in order.
4. Server then attaches to live event stream.

If `Last-Event-ID` is unknown:

- Server should send `run.snapshot`.
- Then send events from latest known stable point if possible.

## 6. Event Type Catalog

### 6.1 Run Events

- `run.created`
- `run.started`
- `run.snapshot`
- `run.progress`
- `run.waiting_approval`
- `run.cancel.requested`
- `run.cancelling`
- `run.cancelled`
- `run.completed`
- `run.failed`

### 6.2 Message Events

- `message.created`
- `message.part.started`
- `message.part.delta`
- `message.part.completed`
- `message.completed`
- `message.failed`

### 6.3 Plan Events

- `plan.started`
- `plan.updated`
- `plan.completed`
- `plan.failed`

### 6.4 Model Events

- `model.call.started`
- `model.call.delta`
- `model.call.completed`
- `model.call.failed`

### 6.5 Tool Events

- `tool.call.requested`
- `tool.call.started`
- `tool.call.output`
- `tool.call.completed`
- `tool.call.failed`
- `tool.call.blocked`

### 6.6 Skill Events

- `skill.selected`
- `skill.loaded`
- `skill.executed`
- `skill.failed`
- `skill.skipped`

### 6.7 Approval Events

- `approval.requested`
- `approval.resolved`
- `approval.expired`

### 6.8 Context Events

- `context.bundle.started`
- `context.bundle.completed`
- `context.compaction.started`
- `context.compaction.completed`
- `context.failed`

### 6.9 Swarm Events

- `swarm.plan`
- `swarm.branch.started`
- `swarm.branch.completed`
- `swarm.branch.failed`
- `swarm.reduce`
- `swarm.merge`
- `swarm.verify`
- `swarm.review`
- `swarm.cancelled`

### 6.10 Sandbox Events

- `sandbox.create.started`
- `sandbox.create.completed`
- `sandbox.create.failed`
- `sandbox.cancel.requested`
- `sandbox.agent.started`
- `sandbox.agent.context_loaded`
- `sandbox.agent.heartbeat`
- `sandbox.agent.action_proposed`
- `sandbox.agent.action_completed`
- `sandbox.agent.observation_created`
- `sandbox.agent.model_skipped`
- `sandbox.agent.model_call_started`
- `sandbox.agent.model_call_completed`
- `sandbox.agent.model_call_failed`
- `sandbox.agent.artifact_prepared`
- `sandbox.agent.artifact_recovery_manifest`
- `sandbox.agent.completed`
- `sandbox.agent.failed`
- `sandbox.log`
- `sandbox.artifact.uploaded`
- `sandbox.closing`
- `sandbox.closed`
- `sandbox.failed`

### 6.11 Artifact Events

- `artifact.create.started`
- `artifact.created`
- `artifact.version.created`
- `artifact.preview.started`
- `artifact.preview.ready`
- `artifact.failed`

### 6.12 Trace Events

- `trace.span.started`
- `trace.span.completed`
- `trace.span.failed`
- `trace.export.failed`

### 6.13 Evaluation Events

- `eval.started`
- `eval.check.completed`
- `eval.completed`
- `eval.failed`

### 6.14 Self-Improvement Events

- `self_improvement.analysis.queued`
- `self_improvement.analysis.started`
- `self_improvement.candidates.queued`
- `self_improvement.analysis.completed`
- `self_improvement.analysis.failed`
- `self_improvement.candidate.shadow_tested`
- `self_improvement.candidate.patch_bundle_prepared`
- `self_improvement.candidate.decision_recorded`

### 6.15 Error Events

- `error.runtime`
- `error.policy`
- `error.storage`
- `error.network`
- `error.provider`

## 7. Payload Contracts

### 7.1 `run.created`

```json
{
  "status": "queued",
  "mode": "agent",
  "model_profile": "dmx:gpt-5.5-1m",
  "budget": {
    "max_tokens": 200000,
    "max_seconds": 600,
    "max_tool_calls": 30,
    "max_sandboxes": 0
  }
}
```

### 7.2 `run.started`

```json
{
  "status": "running",
  "started_at": "2026-06-08T10:00:00.000Z"
}
```

### 7.3 `run.snapshot`

Used for reconnect recovery.

```json
{
  "run": {
    "id": "run_123",
    "status": "running",
    "mode": "swarm",
    "started_at": "2026-06-08T10:00:00.000Z"
  },
  "latest_seq": 42,
  "messages": [
    {
      "id": "msg_123",
      "role": "assistant",
      "status": "streaming"
    }
  ],
  "agents": [
    {
      "id": "agent_123",
      "role": "orchestrator",
      "status": "running"
    }
  ],
  "artifacts": []
}
```

### 7.4 `message.created`

```json
{
  "message_id": "msg_123",
  "role": "assistant",
  "status": "streaming",
  "agent_session_id": "agent_123"
}
```

### 7.5 `message.part.started`

```json
{
  "message_id": "msg_123",
  "part_id": "part_1",
  "part_type": "text"
}
```

Part types:

- `text`
- `thinking_summary`
- `plan`
- `tool_call`
- `tool_result`
- `skill_usage`
- `swarm_status`
- `sandbox_log`
- `artifact_preview`
- `approval_request`
- `error`
- `summary`

### 7.6 `message.part.delta`

```json
{
  "message_id": "msg_123",
  "part_id": "part_1",
  "delta": {
    "text": "正在分析数据..."
  }
}
```

Rules:

- Deltas are append-only for text-like parts.
- Non-text parts should prefer `message.part.completed`.
- Deltas must be redacted.

### 7.7 `message.part.completed`

```json
{
  "message_id": "msg_123",
  "part_id": "part_1",
  "part": {
    "type": "text",
    "text": "分析完成。"
  }
}
```

### 7.8 `plan.updated`

```json
{
  "plan_id": "plan_123",
  "items": [
    {
      "id": "p1",
      "title": "读取数据",
      "status": "completed"
    },
    {
      "id": "p2",
      "title": "生成报告",
      "status": "running"
    }
  ]
}
```

Plan item statuses:

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`

### 7.9 `model.call.started`

```json
{
  "model_call_id": "mc_123",
  "provider": "dmx",
  "model": "gpt-5.5-1m",
  "model_profile": "dmx:gpt-5.5-1m",
  "purpose": "orchestrator_plan",
  "input_summary": "User requests CSV analysis and HTML report."
}
```

### 7.10 `model.call.delta`

```json
{
  "model_call_id": "mc_123",
  "delta_type": "text",
  "text": "我将先检查数据结构..."
}
```

### 7.11 `model.call.completed`

```json
{
  "model_call_id": "mc_123",
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 600,
    "cost_estimate": null
  },
  "latency_ms": 1800,
  "output_summary": "Model produced a 3-step plan."
}
```

### 7.12 `model.call.failed`

```json
{
  "model_call_id": "mc_123",
  "error": {
    "code": "provider_timeout",
    "message": "Provider request timed out.",
    "retryable": true
  }
}
```

### 7.13 `tool.call.requested`

```json
{
  "action_id": "act_123",
  "tool_call_id": "tc_123",
  "tool_name": "web.search",
  "capability_kind": "web_search",
  "risk_level": "low",
  "requires_approval": false,
  "input_summary": "Search web for current documentation."
}
```

### 7.14 `tool.call.started`

```json
{
  "action_id": "act_123",
  "tool_call_id": "tc_123",
  "tool_name": "web.search",
  "capability_kind": "web_search"
}
```

### 7.15 `tool.call.output`

For model-facing tools such as `web.search`, `tool_name` and `logical_tool_name` identify the planner-selected capability while `provider_tool_name` and `provider` identify the concrete provider selected by runtime input/env/catalog policy. The example below uses Tavily; deterministic provider-registry smoke tests also verify `mock.search`.

```json
{
  "action_id": "act_123",
  "tool_call_id": "tc_123",
  "tool_name": "web.search",
  "capability_kind": "web_search",
  "logical_tool_name": "web.search",
  "provider_tool_name": "tavily.search",
  "provider": "tavily",
  "output_summary": "Found 5 relevant sources.",
  "output_preview": [
    {
      "title": "Tavily MCP Documentation",
      "url": "https://docs.tavily.com/documentation/mcp"
    }
  ],
  "payload_uri": "local://traces/prj_default/run_123/tc_123.json",
  "execution_mode": "real",
  "evidence_level": "real"
}
```

### 7.16 `tool.call.completed`

```json
{
  "action_id": "act_123",
  "tool_call_id": "tc_123",
  "tool_name": "web.search",
  "capability_kind": "web_search",
  "logical_tool_name": "web.search",
  "provider_tool_name": "tavily.search",
  "provider": "tavily",
  "observation_id": "obs_123",
  "status": "completed",
  "output_summary": "Search completed.",
  "execution_mode": "real",
  "evidence_level": "real",
  "payload_uri": "local://traces/prj_default/run_123/tc_123.json"
}
```

### 7.17 `tool.call.failed`

```json
{
  "action_id": "act_123",
  "tool_call_id": "tc_123",
  "tool_name": "web.search",
  "capability_kind": "web_search",
  "observation_id": "obs_123",
  "status": "failed",
  "evidence_level": "inferred",
  "error": {
    "code": "tool_timeout",
    "message": "Tool timed out.",
    "retryable": true
  }
}
```

### 7.18 `approval.requested`

```json
{
  "approval_id": "appr_123",
  "risk_level": "high",
  "request_summary": "Agent wants to execute a destructive file operation.",
  "target": {
    "kind": "tool_call",
    "id": "tc_123"
  },
  "options": [
    "approve",
    "reject"
  ],
  "expires_at": "2026-06-08T10:10:00.000Z"
}
```

### 7.19 `approval.resolved`

```json
{
  "approval_id": "appr_123",
  "decision": "approved",
  "resolved_by_user_id": "usr_local",
  "comment": "Proceed."
}
```

### 7.20 `skill.selected`

```json
{
  "skill_usage_id": "sku_123",
  "skill_id": "skill_data_profiling",
  "skill_name": "data-profiling",
  "version": "0.1.0",
  "reason": "Uploaded file is a CSV and the task asks for analysis."
}
```

### 7.21 `context.bundle.completed`

```json
{
  "context_bundle_id": "ctx_123",
  "storage_uri": "local://sandbox-bundles/prj_default/run_123/ctx_123.json",
  "token_estimate": 4800,
  "source_refs": {
    "messages": 4,
    "uploads": 1,
    "artifacts": 0,
    "skills": 2
  },
  "redaction_status": "redacted"
}
```

### 7.22 `swarm.plan`

```json
{
  "strategy": "parallel_branch_then_merge",
  "reason": "Planner selected spawn_swarm for independent research, analysis, and validation branches.",
  "plan_source": "model_branches",
  "requested_branch_count": 3,
  "branches": [
    {
      "branch_id": "branch_research",
      "title": "Research Branch",
      "instruction": "Gather task-specific facts, source evidence, and open questions for the current objective.",
      "model_profile": "deepseek:deepseek-v4-pro"
    }
  ]
}
```

`plan_source` values:

- `model_branches`: planner action included explicit branch definitions.
- `model_single_agent`: planner selected `spawn_agent`; runtime normalized it into one branch.
- `model_roles`: planner action included only branch roles/count; runtime expanded them.
- `runtime_fallback`: no executable branch plan was supplied, so compatibility fallback was used and should be visible in diagnostics.

### 7.23 `swarm.branch.started`

```json
{
  "branch_id": "branch_research",
  "agent_session_id": "agent_branch_research",
  "span_id": "span_branch_research",
  "parent_span_id": "span_swarm_plan"
}
```

### 7.24 `sandbox.agent.event`

Parent-run wrapper around a branch-local sandbox-agent protocol event.

```json
{
  "branch_id": "branch_research",
  "agent_session_id": "agent_branch_research",
  "sandbox_session_id": "sbx_123",
  "execution_mode": "mock",
  "external_sandbox_id": "mock-branch_research",
  "agent_event_type": "sandbox.agent.heartbeat",
  "level": "info",
  "message": "Sandbox heartbeat.",
  "timestamp": "2026-06-11T10:00:00.000Z",
  "event_payload": {
    "stage": "artifact_prepared"
  },
  "protocol_version": "dataswarm.sandbox-agent.v1"
}
```

### 7.25 `swarm.branch.completed`

```json
{
  "branch_id": "branch_research",
  "agent_session_id": "agent_branch_research",
  "sandbox_session_id": "sbx_123",
  "status": "completed",
  "execution_mode": "mock",
  "external_sandbox_id": "mock-branch_research",
  "attempt": 1,
  "max_attempts": 2,
  "output_summary": "Research Branch completed branch branch_research.",
  "agent_event_count": 23,
  "quality_signals": {
    "runtimeVersion": "dataswarm.sandbox-runtime.v1",
    "actionCount": 8,
    "observationCount": 4,
    "artifactRecoveryReady": true
  },
  "sandbox_artifacts": [
    {
      "kind": "markdown",
      "title": "Research Branch Result",
      "sha256": "..."
    }
  ],
  "artifact_id": "art_123",
  "observation_id": "obs_branch_research",
  "started_at": "2026-06-11T10:00:00.000Z",
  "ended_at": "2026-06-11T10:00:05.000Z"
}
```

### 7.26 `swarm.branch.failed`

```json
{
  "branch_id": "branch_research",
  "sandbox_session_id": "sbx_123",
  "status": "failed",
  "error_code": "sandbox_preflight_failed",
  "error": "E2B live sandbox execution is gated until required environment is configured.",
  "attempt_failures": [
    {
      "attempt": 0,
      "missing_env": [
        "E2B_API_KEY",
        "DATASWARM_E2B_TEMPLATE_VERIFIED=1 or DATASWARM_E2B_TEMPLATE_BUILD_ID or local template verification receipt"
      ],
      "verification_commands": [
        "node scripts/e2b-readiness-smoke.mjs"
      ]
    }
  ],
  "observation_id": "obs_failed_branch"
}
```

### 7.27 `swarm.reduce`

```json
{
  "status": "completed",
  "strategy": "parallel_branch_then_merge",
  "plan_source": "model_branches",
  "reducer_mode": "deterministic_runtime",
  "assisted_by": [
    "swarm-verifier.detectContradictionSignals"
  ],
  "branch_count": 3,
  "completed_branch_count": 3,
  "failed_branch_count": 0,
  "artifact_ids": [
    "art_123"
  ],
  "branch_observation_ids": [
    "obs_branch_research"
  ],
  "branch_items": [
    {
      "branchId": "branch_research",
      "title": "Research Branch",
      "status": "completed",
      "observationId": "obs_branch_research",
      "artifactId": "art_123",
      "summary": "Research Branch: identified evidence inputs."
    }
  ],
  "conflict_signals": [],
  "recommendations": [
    "Proceed to merge and verification using the reduced branch evidence."
  ],
  "summary": "Reducer synthesized 3/3 branches completed; 3 artifact(s), 3 branch observation(s); no explicit contradiction/source-mismatch signals."
}
```

`swarm.reduce` is the independent reduction stage over branch Observations. It does not invent new facts; it compresses branch evidence into structured items, scans for contradiction/source-mismatch signals using the same semantics as `swarm.verify`, and produces merge recommendations before `swarm.merge`.

### 7.28 `swarm.merge`

```json
{
  "status": "completed",
  "strategy": "parallel_branch_then_merge",
  "plan_source": "model_branches",
  "branch_count": 3,
  "completed_branch_count": 3,
  "failed_branch_count": 0,
  "reduction_status": "completed",
  "reducer_mode": "deterministic_runtime",
  "reduction_summary": "Reducer synthesized 3/3 branches completed; 3 artifact(s), 3 branch observation(s); no explicit contradiction/source-mismatch signals.",
  "artifact_ids": [
    "art_123"
  ],
  "branch_observation_ids": [
    "obs_branch_research"
  ],
  "summary": "Swarm completed 3/3 branches."
}
```

### 7.29 `swarm.verify`

```json
{
  "status": "passed",
  "strategy": "parallel_branch_then_merge",
  "plan_source": "model_branches",
  "branch_count": 3,
  "completed_branch_count": 3,
  "failed_branch_count": 0,
  "artifact_ids": [
    "art_123"
  ],
  "branch_observation_ids": [
    "obs_branch_research"
  ],
  "checks": [
    {
      "id": "branch_observations_present",
      "status": "passed",
      "detail": "3/3 branch observations were persisted."
    },
    {
      "id": "failed_branch_isolation",
      "status": "passed",
      "detail": "No branch failures observed."
    },
    {
      "id": "plan_source_traceable",
      "status": "passed",
      "detail": "Swarm plan source is traceable as model_branches."
    },
    {
      "id": "branch_instructions_present",
      "status": "passed",
      "detail": "3/3 branches include executable instructions."
    },
    {
      "id": "branch_summary_uniqueness",
      "status": "passed",
      "detail": "3 branch summary item(s) are distinct after normalization."
    }
  ],
  "summary": "All 8 verification checks passed."
}
```

`swarm.verify` is deterministic runtime verification over persisted branch evidence. It must not invent factual conclusions; it checks branch Observation coverage, artifact coverage, failed-branch isolation, plan-source traceability, branch instruction coverage, duplicate branch summaries, merge evidence, and explicit conflict / contradiction / unsupported-claim / source-mismatch signals before the parent Orchestrator replans for the final answer.

### 7.30 `swarm.review`

```json
{
  "status": "completed",
  "review_mode": "model",
  "model_profile": "claude-opus-4-8",
  "confidence": 0.72,
  "strategy": "parallel_branch_then_merge",
  "plan_source": "model_branches",
  "branch_count": 3,
  "completed_branch_count": 3,
  "failed_branch_count": 0,
  "artifact_ids": [
    "art_123"
  ],
  "branch_observation_ids": [
    "obs_branch_research"
  ],
  "finding_count": 0,
  "findings": [],
  "recommendations": [
    "Use the deterministic reducer/verifier output as the final synthesis evidence base."
  ],
  "required_follow_up": false,
  "summary": "Model-assisted swarm review completed without adding new facts."
}
```

`swarm.review` is an optional layer above deterministic `swarm.reduce` and `swarm.verify`. It may be `disabled`, `mock`, or `model` via `DATASWARM_SWARM_REVIEW_MODE`; disabled runs must emit `status=skipped` so trace diagnostics can distinguish a deliberately skipped review from a missing implementation. The reviewer must not introduce new facts and must only critique reducer/verifier evidence.

### 7.31 `sandbox.create.started`

```json
{
  "sandbox_session_id": "sbx_123",
  "provider": "e2b",
  "template": "dataswarm-python-data-v0"
}
```

### 7.32 `sandbox.create.completed`

```json
{
  "sandbox_session_id": "sbx_123",
  "provider": "e2b",
  "external_sandbox_id": "external_id_redacted",
  "status": "running"
}
```

### 7.33 `sandbox.log`

```json
{
  "sandbox_session_id": "sbx_123",
  "stream": "stdout",
  "level": "info",
  "text": "Generated analysis_report.md"
}
```

Rules:

- Logs must be redacted.
- Long logs should be stored by `payload_uri`.

### 7.34 `artifact.created`

```json
{
  "artifact_id": "art_123",
  "artifact_version_id": "artv_123",
  "type": "markdown",
  "mime_type": "text/markdown",
  "title": "Analysis Report",
  "storage_uri": "local://artifacts/prj_default/art_123/v1/artifact.md",
  "source_trace_id": "trace_123"
}
```

### 7.35 `artifact.preview.ready`

```json
{
  "artifact_id": "art_123",
  "artifact_version_id": "artv_123",
  "preview_uri": "local://artifacts/prj_default/art_123/v1/preview.html",
  "preview_type": "html"
}
```

### 7.36 `trace.span.started`

```json
{
  "trace_id": "trace_123",
  "span_id": "span_123",
  "parent_span_id": null,
  "span_kind": "agent.run",
  "name": "Orchestrator run"
}
```

### 7.37 `trace.span.completed`

```json
{
  "trace_id": "trace_123",
  "span_id": "span_123",
  "span_kind": "agent.run",
  "latency_ms": 5000,
  "status": "completed"
}
```

### 7.38 `eval.completed`

```json
{
  "eval_result_id": "eval_123",
  "eval_type": "run",
  "status": "passed",
  "score": 0.92,
  "summary": "Run completed with report artifacts and trace coverage.",
  "checks": [
    {
      "name": "artifact_generated",
      "status": "passed"
    },
    {
      "name": "trace_complete",
      "status": "passed"
    }
  ]
}
```

### 7.39 `self_improvement.analysis.completed`

```json
{
  "visibility": "internal",
  "status": "completed",
  "eval_result_id": "eval_123",
  "candidate_count": 2,
  "candidate_ids": ["sic_123", "sic_456"]
}
```

### 7.40 `self_improvement.candidate.patch_bundle_prepared`

```json
{
  "candidate_id": "sic_123",
  "candidate_type": "runtime_policy_patch",
  "action": "prepare_patch_bundle",
  "status": "patch_prepared",
  "severity": "medium",
  "patch_bundle": {
    "storageUri": "local://self-improvement/prj_default/run_123/sic_123.patch-bundle.md",
    "format": "markdown",
    "autoApply": false
  }
}
```

### 7.41 `error.runtime`

```json
{
  "error": {
    "code": "runtime_invariant_failed",
    "message": "Run entered invalid state transition.",
    "retryable": false
  },
  "related": {
    "run_id": "run_123",
    "agent_session_id": "agent_123"
  }
}
```

## 8. UI Mapping

| Event family | UI surface |
|---|---|
| `run.*` | run status bar, composer disabled/enabled, stop/continue state |
| `message.*` | conversation stream |
| `plan.*` | plan card |
| `model.*` | hidden by default; optional trace/debug drawer |
| `tool.*` | collapsible tool call cards |
| `skill.*` | skill usage chips/cards |
| `approval.*` | approval card with actions |
| `context.*` | context progress indicator |
| `swarm.*` | swarm tree / branch progress |
| `sandbox.*` | branch logs and debug details |
| `artifact.*` | artifact icons and right-side panel |
| `trace.*` | trace panel |
| `eval.*` | final quality summary |
| `self_improvement.*` | internal improvements tab, not normal chat flow |
| `error.*` | inline error card or run error banner |

## 9. Client State Reconstruction

The client reconstructs state by applying events in order.

Minimal client state:

```json
{
  "run": {},
  "messages": {},
  "plans": {},
  "tools": {},
  "skills": {},
  "approvals": {},
  "swarm": {},
  "sandboxes": {},
  "artifacts": {},
  "evals": {}
}
```

Rules:

- Apply only events with `seq` greater than current latest seq.
- Ignore duplicate event IDs.
- If sequence gap is detected, reconnect with `from_seq`.
- If replay cannot fill the gap, request `run.snapshot`.

## 10. Redaction Rules

Never include:

- Full API keys.
- Cookies.
- Access tokens.
- Raw private credentials.
- Full uploaded file content unless explicitly allowed.
- Unbounded model prompt or tool output.

Use:

- `input_summary`
- `output_summary`
- `payload_uri`
- `redaction_status`

Redaction status values:

- `not_required`
- `redacted`
- `partial`
- `failed`

If redaction fails:

- Do not stream the sensitive payload.
- Emit a safe error event.
- Mark corresponding trace span as `redaction_status: failed`.

## 11. Error Codes

Provider:

- `provider_timeout`
- `provider_rate_limit`
- `provider_invalid_response`
- `provider_auth_failed`
- `provider_unavailable`

Tool:

- `tool_schema_invalid`
- `tool_permission_denied`
- `tool_timeout`
- `tool_execution_failed`
- `tool_output_invalid`

Sandbox:

- `sandbox_create_failed`
- `sandbox_start_failed`
- `sandbox_cancelled`
- `sandbox_heartbeat_lost`
- `sandbox_artifact_recovery_failed`
- `sandbox_close_failed`

Storage:

- `storage_write_failed`
- `storage_read_failed`
- `sqlite_busy`
- `artifact_write_failed`
- `payload_write_failed`

Runtime:

- `runtime_invariant_failed`
- `invalid_state_transition`
- `budget_exceeded`
- `run_cancelled`
- `context_too_large`

Policy:

- `approval_required`
- `approval_rejected`
- `permission_denied`
- `secret_redaction_failed`

## 12. State Transition Event Requirements

### 12.1 Run

- `run.started` must follow `run.created`.
- `run.completed`, `run.failed`, `run.cancelled` are terminal.
- `run.waiting_approval` must correspond to an `approval.requested`.
- `run.cancel.requested` should be emitted before `run.cancelled` when the user/API requests cancellation.
- `run.cancelled` must be emitted after cancellation fan-out completes or times out.

### 12.2 Tool Call

- `tool.call.started` must follow `tool.call.requested`.
- Terminal events:
  - `tool.call.completed`
  - `tool.call.failed`
  - `tool.call.blocked`

### 12.3 Sandbox

- `sandbox.create.completed` must follow `sandbox.create.started`.
- `sandbox.agent.started` should be followed by at least one `sandbox.agent.heartbeat`.
- `sandbox.agent.artifact_recovery_manifest` should be emitted before a successful branch result when artifacts are prepared.
- `sandbox.cancel.requested` should set the sandbox session to `cancelling` unless the session is already terminal.
- `sandbox.closed` should follow `sandbox.closing` unless sandbox failed before closing.
- Heartbeats are optional persisted events but recommended for long-running sandboxes.

### 12.4 Artifact

- `artifact.created` must identify artifact and version.
- `artifact.preview.ready` is optional but expected for Markdown/HTML report artifacts.
- `artifact.failed` should include safe error summary.

## 13. Golden Event Sequences

### 13.1 Simple Chat

Expected sequence:

1. `run.created`
2. `run.started`
3. `trace.span.started`
4. `message.created`
5. `model.call.started`
6. `message.part.started`
7. `message.part.delta` repeated
8. `message.part.completed`
9. `model.call.completed`
10. `message.completed`
11. `trace.span.completed`
12. `eval.completed`
13. `run.completed`

### 13.2 Tool Call

Expected sequence includes:

1. Simple chat prefix.
2. `tool.call.requested`
3. `tool.call.started`
4. `tool.call.output`
5. `tool.call.completed`
6. Assistant summary message parts.
7. `run.completed`

### 13.3 Report Artifact

Expected sequence includes:

1. Tool or sandbox execution.
2. `artifact.create.started`
3. `artifact.created` for Markdown.
4. `artifact.created` for HTML.
5. `artifact.preview.started`
6. `artifact.preview.ready`
7. `eval.completed`
8. `run.completed`

### 13.4 Swarm

Expected sequence:

1. `run.created`
2. `run.started`
3. `action.proposed` with `action_type=spawn_swarm` or `spawn_agent`
4. `action.validated`
5. `swarm.plan`
6. `context.bundle.completed` repeated per branch.
7. `swarm.branch.started` repeated.
8. `sandbox.agent.event` repeated per branch, with `agent_event_type` such as `sandbox.agent.heartbeat`, `sandbox.agent.action_completed`, or `sandbox.agent.artifact_recovery_manifest`.
9. `artifact.created` and `artifact.preview.ready` for recovered branch artifacts when available.
10. `observation.created` for each branch Observation.
11. `swarm.branch.completed` or `swarm.branch.failed` per branch, each linking `observation_id`.
12. `swarm.reduce` with `branch_items`, `branch_observation_ids`, conflict signals, and reducer recommendations.
13. `swarm.merge` with `branch_observation_ids` and `reduction_summary`.
14. `swarm.verify` with `branch_observation_ids` and deterministic checks.
15. `swarm.review` with review mode, findings, recommendations, and explicit skipped/completed/failed status.
16. `observation.created` for the merged swarm Observation.
17. `agent.replan.requested`
18. `message.completed`
18. `eval.completed`
19. `run.completed` or `run.cancelled` / `run.failed`

## 14. Validation Checklist

Current contract gate: `node scripts/event-protocol-e2e-smoke.mjs`, plus the targeted tool/artifact/swarm/approval smoke gates listed in `DATASWARM_CANONICAL_PLAN.md`.

The event protocol is implemented correctly when:

- [x] Events are persisted before SSE flush.
- [x] `seq` is monotonic per run.
- [x] Client can reconnect with `Last-Event-ID`.
- [x] Client can recover from page refresh.
- [x] Duplicate events do not corrupt UI state.
- [x] Missing seq triggers replay or snapshot.
- [x] Tool calls render as structured cards.
- [x] Artifacts render as icons and side panel entries.
- [x] Swarm branches render in a tree.
- [x] Approval events block and resume run correctly.
- [x] Redaction prevents secrets from entering event payloads.
- [x] Terminal run events cannot be followed by additional active-state events.
