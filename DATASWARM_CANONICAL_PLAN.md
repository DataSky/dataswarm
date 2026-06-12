# DataSwarm Canonical Plan

> Last updated: 2026-06-11  
> Status: canonical implementation direction for Agentic Runtime V2 to Real Swarm  
> Read this before older MVP or research documents.

## 1. Current Truth

DataSwarm is now centered on a planner-led agentic loop:

```text
User message
-> Orchestrator planner model proposes one AgentAction
-> Runtime validates policy/schema/tool availability
-> Adapter executes the action
-> Observation is persisted
-> Planner replans or final answer is streamed
-> Evaluator checks trace/evidence consistency
```

Implemented and verified:

| Capability | Status | Notes |
|---|---|---|
| Next.js conversation UI | Real | SSE, runtime cards, artifact drawer, trace page |
| SQLite trace/event/message store | Real | Local-first MVP store |
| DMX orchestrator model profiles | Real | `dmx:gpt-5.5-1m`, `dmx:claude-opus-4-8` |
| Planner-first `AgentAction` loop | Real | bounded by `DATASWARM_AGENT_MAX_STEPS` |
| `web.search` capability adapter | Real or mock-gated | model-facing generic `web_search` tool with provider registry; Tavily is the default real provider and `mock.search` is the built-in deterministic validation provider |
| `tavily.search` provider adapter | Real or mock-gated | direct provider adapter retained for compatibility and diagnostics; not the planner strategy |
| `trace.query` adapter | Real | conversation/run/trace diagnostics |
| `artifact.create` adapter | Real | Markdown/HTML artifacts with content-hash de-dupe |
| `file.read` adapter | Real | workspace-local file reads only |
| `approval.request` adapter | Real | creates pending approval records; Run Trace/API support approve/reject decisions |
| Skills | Managed local registry with local install/update | model can select enabled skills and receives V2 manifests; UI/API can inspect, enable/disable, install, and update local skill packs; remote marketplace flow still pending |
| Swarm | Planner-owned mock with model-provided branch plans + sandbox-agent runtime + reducer/verifier/reviewer + Run Trace timeline | `spawn_agent` and `spawn_swarm` actions enter Orchestrator; planner-provided branch definitions are preferred over runtime fallback templates; branch heartbeat, internal action/observation events, failure, artifact recovery, model quality signals, independent `swarm.reduce`, merge, deterministic verification, optional `swarm.review`, and post-swarm finalize guardrails are bridged into parent run events and rendered in a dedicated Swarm Tree / Branch Timeline |
| Sandbox agent model | Real local smoke verified | `sandbox/agent/dataswarm_sandbox_agent.py` runs a lightweight action/observation loop and can call DeepSeek/OpenAI-compatible chat completions when explicitly configured |
| E2B sandbox | SDK + template contract + operator readiness diagnostics + live smoke verified | `@e2b/code-interpreter` targets the `dataswarm-agent-runtime` template, imports or injects the DataSwarm sandbox agent, and preserves timeout/cancel/retry/recovery protocol; `data/e2b/template-verification.json` records template build evidence and `data/e2b/live-smoke-receipt.json` records a passed real E2B sandbox run; system snapshot exposes status, missing env, local template verification receipt state, live smoke receipt state, next steps, and verification commands; orchestrator execution still requires runtime `E2B_API_KEY` plus `DATASWARM_E2B_TEMPLATE_VERIFIED=1`, `DATASWARM_E2B_TEMPLATE_BUILD_ID`, or a matching local receipt |
| Run cancellation | Real control-plane lifecycle | `POST /api/runs/:id/cancel` persists cancellation intent, fans out to sandbox sessions, emits run/sandbox cancel events, and terminates Orchestrator/Swarm as `cancelled` rather than `failed` |
| Self-improvement loop | Async internal runner + Run Trace operations | eval enqueues internal analysis; runner creates idempotent candidates from trace/eval evidence; Run Trace/API expose and operate them; shadow test, review patch bundle, and human decision lifecycle implemented; automatic source patch application intentionally pending |

## 2. Canonical Architecture Rules

1. Orchestrator is the only user-entry runtime.
2. The model chooses actions; engineering code validates and executes.
3. Tools are exposed through a capability catalog, not keyword routing.
4. `web.search` is the default model-facing `web_search` capability; Tavily is only the first provider behind a provider registry, not a privileged strategy.
5. Skills are model-selected policy/workflow packs, not hidden routers.
6. Artifacts are produced by `artifact.create`, not by assistant text dumps.
7. Every tool, skill, artifact, and future swarm branch must create Observations.
8. Final answers must be grounded in Observations for tool-backed claims.
9. UI cards render run events and trace state, not inferred assistant prose.
10. Mock execution must be explicit in trace/evidence metadata.

## 3. Document Authority

| Document | Role |
|---|---|
| `DATASWARM_CANONICAL_PLAN.md` | Current source of truth |
| `AGENTIC_RUNTIME_V2_DESIGN.md` | Main runtime design; update alongside code |
| `AGENTIC_LOOP_V2_EXECUTION_PLAN.md` | Near-term execution checklist |
| `IMPLEMENTATION_STATUS.md` | Current status snapshot plus historical log |
| `ARCHITECTURE.md` | High-level architecture; must reference V2 runtime as current mainline |
| `SCHEMA.md` | Data model contract; must include V2 action/observation/tool metadata |
| `EVENT_PROTOCOL.md` | UI/event/trace contract; must align with real event names |
| `MVP_TASKS.md` | Historical MVP plan, not current completion truth |
| `DataSwarm多Agent蜂群体系调研与设计.md` | Original research and vision baseline |
| `DataSwarm技术设计执行路径与验证方案.md` | Original execution-path baseline |

## 4. Near-Term Implementation Path

### Phase 1: Runtime V2 Productization

- Keep all tool execution behind model-selected `AgentAction`.
- Treat `create_artifact` as a first-class model action backed by `artifact.create`.
- Keep `file.read`, `trace.query`, `artifact.create`, and `approval.request` in the generic tool adapter registry.
- Keep approval decisions explicit: `approval.request` may block execution, and users resolve it through run approval APIs/Trace diagnostics.
- Ensure all tool events carry `action_id`, `tool_call_id`, `observation_id`, capability kind, and evidence level.
- Use content hash metadata to prevent duplicate artifacts in the same conversation.
- Keep final answers from claiming execution unless completed Observations exist.

### Phase 2: Skills V2

- Maintain per-skill manifest fields: purpose, activation guidance, required tools, input contract, output contract, quality checks, risk level.
- Let the planner inspect skill manifests and choose `use_skill` only when it changes task policy.
- Persist skill selection reason, selected alternatives, and contribution to final answer.
- Keep disabled skills visible in the registry but hidden from planner context.
- Support local enable/disable/install/update management through Skills UI and API before adding remote marketplace flows.

### Phase 3: Swarm V2

- Keep `spawn_agent` and `spawn_swarm` executable in the same loop.
- Replace remaining static swarm assumptions with planner-owned action execution and planner-provided branch definitions; runtime role/fallback templates are allowed only as explicit `plan_source=model_roles` or `plan_source=runtime_fallback` compatibility paths.
- Each branch agent must have a context bundle, model profile, tool policy, sandbox policy, trace span, and Observation.
- After a completed swarm Observation exists for the current objective, the planner must finalize or create artifacts instead of spawning duplicate branch cycles unless the user explicitly asks to rerun/retry/add branches.
- Keep `swarm.reduce` followed by `swarm.merge`, deterministic `swarm.verify`, and optional `swarm.review` before final answer; `swarm.reduce` now runs as an independent evented reducer stage that compresses branch Observations into structured evidence items, scans contradiction/source-mismatch signals, and emits reducer recommendations. `swarm.verify` runs through a richer independent verifier stage that checks branch observations, artifact coverage, failed-branch isolation, plan-source traceability, branch instruction coverage, duplicate summaries, and contradiction/source-mismatch signals. `swarm.review` is disabled by default and can run in `mock` or `model` mode as a critique layer above deterministic reducer/verifier output without adding new facts.
- Render Swarm Tree / Branch Timeline in Run Trace from persisted `run_events` so branch progress is inspectable without reading raw event JSON.

### Phase 4: Real E2B

- Use `@e2b/code-interpreter` for the first real sandbox execution path.
- Run the same `sandbox/agent/dataswarm_sandbox_agent.py` protocol in local mock and E2B paths.
- Allow sandbox agents to use DeepSeek/OpenAI-compatible models only when `DATASWARM_SANDBOX_AGENT_MODEL=real` is set.
- Bridge sandbox runtime logs and model quality signals (`runtimeVersion`, `actionCount`, `observationCount`, `modelMode`, `modelStatus`, `modelUsed`) into parent run events and artifacts.
- Verify live sandbox access with `node scripts/e2b-sandbox-smoke.mjs` after setting `E2B_API_KEY`; successful runs write a secret-safe live smoke receipt to `data/e2b/live-smoke-receipt.json` by default.
- Verify secret-safe readiness without creating a sandbox with `node scripts/e2b-readiness-smoke.mjs`.
- Verify the live smoke receipt contract without creating a sandbox with `node scripts/e2b-live-receipt-smoke.mjs`.
- Generate local template receipts through `node scripts/e2b-template-receipt.mjs --template-build-id <id>` after the template contract smoke passes; use `--allow-local-contract-only` only when deliberately recording local contract evidence without a remote build id.
- Expose operator-facing readiness in `/api/system/snapshot`: status, missing env names, readiness reasons, next steps, verification commands, template verification receipt state, and live smoke receipt state without leaking secrets.
- Expose the same live smoke receipt state through conversation diagnostics / `trace.query`, including receipt path, verified/unverified coverage, verification commands, sandbox preflight failure context, and structured remediation items.
- Require an explicit template verification receipt (`DATASWARM_E2B_TEMPLATE_VERIFIED=1`, `DATASWARM_E2B_TEMPLATE_BUILD_ID`, or a matching local receipt at `data/e2b/template-verification.json` / `DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT`) before `readyForOrchestrator` becomes true; an API key alone is not enough to enable real branch execution.
- When `DATASWARM_SANDBOX_PROVIDER=e2b` is selected but live execution is not ready, persist a structured `sandbox_preflight_failed` diagnosis in `sandbox_sessions`, failed branch Observations, and `swarm.branch.failed` events rather than falling back to mock execution or emitting a vague runtime error.
- Keep the dedicated `dataswarm-agent-runtime` E2B template contract under `sandbox/e2b`, with `entrypoint.py --ready`, an explicit Code Interpreter start command, a port `49999` health check, and a documented template create command.
- Start sandbox DataSwarm agent instances with DeepSeek V4 Pro/Flash.
- Bridge sandbox logs, spans, observations, and artifacts back to the parent run.
- Support heartbeat, cancel, timeout, bounded retry policy, and artifact recovery.
- Keep user/API cancellation as control-plane behavior: cancellation is not a model action, but it must write `run.cancel.requested`, `sandbox.cancel.requested`, and terminal `run.cancelled` events into the same trace/event stream.

### Phase 5: Self-Improvement

- Keep self-improvement asynchronous and out of the normal conversation stream.
- Convert trace/eval/log issues into queued improvement candidates.
- Convert selected diagnostics remediation items into review-gated improvement candidates through `run_diagnostics_analysis`, while skipping `self_improvement` remediation items to avoid recursive candidate growth.
- Use `self_improvement.analysis.*` events for queued/started/completed/failed worker state.
- Keep async analysis replayable through Run Improvements API and idempotent per eval check.
- Review queued candidates from Run Trace `improvements`, keeping ordinary chat free of fixed self-improvement artifacts.
- Operate candidate lifecycle from Run Trace `improvements`: shadow test, prepare review bundle, approve/reject/defer, and mark externally applied changes.
- Include Observation summaries, self-improvement candidate summaries, applied verification receipt coverage, failed sandbox branch evidence, and required verification commands in `trace.query` / conversation diagnostics.
- Require shadow tests, a generated review patch bundle, and human approval before marking prompt/skill/tool changes as applied.
- Store review bundles under `local://self-improvement/...` so candidates have durable evidence, proposal, and verification context before approval.
- Keep application conservative: `mark_applied` records an approved external/manual application only when the operator submits a verification receipt with passed results for every required command; it does not silently patch source code.

## 5. Verification Gates

Required before considering Runtime V2 healthy:

```text
node scripts/canonical-verification-runner.mjs --dry-run
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
node scripts/agentic-loop-v2-smoke.mjs
node scripts/web-search-provider-smoke.mjs
node scripts/web-search-provider-e2e-smoke.mjs
node scripts/tool-event-contract-e2e-smoke.mjs
node scripts/event-protocol-e2e-smoke.mjs
node scripts/skills-v2-smoke.mjs
node scripts/skills-install-api-smoke.mjs
node scripts/skills-observation-e2e-smoke.mjs
node scripts/sandbox-agent-smoke.mjs
node scripts/sandbox-agent-model-smoke.mjs
node scripts/e2b-template-smoke.mjs
node scripts/e2b-template-receipt-smoke.mjs
node scripts/e2b-readiness-smoke.mjs
node scripts/e2b-live-receipt-smoke.mjs
node scripts/run-trace-system-readiness-smoke.mjs
node scripts/e2b-preflight-e2e-smoke.mjs
node scripts/e2b-template-verification-e2e-smoke.mjs
node scripts/sandbox-retry-policy-smoke.mjs
node scripts/run-cancel-lifecycle-smoke.mjs
node scripts/run-cancel-api-smoke.mjs
node scripts/swarm-action-plan-smoke.mjs
node scripts/swarm-reducer-smoke.mjs
node scripts/swarm-verifier-smoke.mjs
node scripts/swarm-review-smoke.mjs
node scripts/sandbox-retry-e2e-smoke.mjs
node scripts/swarm-trace-ui-smoke.mjs
node scripts/approval-lifecycle-smoke.mjs
node scripts/self-improvement-async-smoke.mjs
node scripts/self-improvement-diagnostics-smoke.mjs
node scripts/self-improvement-lifecycle-smoke.mjs
node scripts/self-improvement-ui-smoke.mjs
node scripts/self-improvement-summary-smoke.mjs
node scripts/self-improvement-summary-api-smoke.mjs
node scripts/trace-diagnostics-improvements-smoke.mjs
node scripts/trace-diagnostics-sandbox-smoke.mjs
node scripts/trace-diagnostics-runtime-consistency-smoke.mjs
node scripts/trace-diagnostics-ui-smoke.mjs
node scripts/canonical-verification-diagnostics-smoke.mjs
node scripts/canonical-goal-audit-smoke.mjs
node scripts/canonical-goal-audit.mjs
npm --prefix apps/web run build
node scripts/e2b-sandbox-smoke.mjs
node scripts/e2b-orchestrator-e2e-smoke.mjs
```

`scripts/canonical-verification-runner.mjs` is the grouped phase runner. Use `--phase phase4 --only e2b-readiness,e2b-live-receipt,e2b-live-sandbox,e2b-orchestrator-e2e` for focused E2B readiness and live E2E checks, and use `--require-live-e2b` only when completing the Real Swarm goal with real external sandbox evidence. Without live credentials/template receipt, live external gates must be reported as `gated_skip`, not a mock pass.

`scripts/canonical-goal-audit.mjs` is the completion audit. Run it in default mode to prove the current local receipts and documents are internally consistent; run it with `--require-live-e2b` before marking the combined Real Swarm goal complete. In strict mode it must exit non-zero until the strict live receipt proves both the single live E2B sandbox smoke and the Orchestrator -> `spawn_swarm` -> real E2B branch E2E smoke passed.

Additional product smoke scenarios:

1. Simple chat returns final answer with no tool call.
2. Web research uses an implemented `web_search` capability such as `web.search` and creates Observations that record the logical tool and provider tool separately.
2a. Tool terminal events carry `action_id`, `tool_call_id`, capability kind, `observation_id`, and `evidence_level`, verified by an API/DB e2e smoke.
3. Multi-turn follow-up either reuses relevant Observations or calls tools again.
4. Report request creates artifact through `artifact.create`.
5. Trace diagnosis uses `trace.query`.
6. Skills UI/API can install or update a local skill pack and synchronize it into SQLite without manual DB edits.
7. Missing credentials, missing built templates, or deferred sandbox execution are explicit in trace metadata.
8. Artifact drawer shows de-duped Markdown/HTML artifacts.
9. Sandbox branch execution emits heartbeat, internal action/observation, artifact recovery manifest events, one durable parent-level branch Observation per branch, `swarm.reduce` reduced branch evidence, merge summaries, `swarm.verify` checks, and explicit `swarm.review` skipped/mock/model state; failed/cancelled branches appear in reduction, merge, verification, and review results.
10. Sandbox retry policy is bounded, retryable-error scoped, and records attempt metadata.
11. Planner-owned mock Swarm creates exactly one branch cycle for a single swarm instruction, then finalizes from the swarm Observation.
12. Run cancellation marks active runs and non-terminal sandbox sessions as cancelling, stops future swarm branches, and records terminal `run.cancelled` instead of `run.failed`.
13. `ARCHITECTURE.md`, `SCHEMA.md`, and `EVENT_PROTOCOL.md` stay aligned with current V2 runtime/storage/event contracts and are checked by the main agentic smoke gate.
