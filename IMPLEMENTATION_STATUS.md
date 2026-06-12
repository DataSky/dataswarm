# DataSwarm Implementation Status

> Last updated: 2026-06-12  
> Active goal: stabilize Agentic Runtime V2 and complete the gated path from planner-owned mock Swarm to real E2B sandbox execution.

## Current Canonical Status

Authoritative plan: [DATASWARM_CANONICAL_PLAN.md](./DATASWARM_CANONICAL_PLAN.md)

Current runtime truth:

| Capability | Status | Evidence |
|---|---|---|
| Planner-owned `AgentAction` loop | Real | `runOrchestrator` calls planner, validates actions, persists actions and observations |
| Generic tool catalog | Real | `ToolCapability` exposes provider, adapter status, auth, risk, schemas, freshness |
| `web.search` | Real/mock-gated | model-facing generic `web_search` adapter with provider registry; Tavily is the default real provider, `mock.search` is the built-in deterministic validation provider, and observations record logical/provider metadata |
| `tavily.search` | Real/mock-gated | provider/direct adapter retained for compatibility and diagnostics; mock only when `DATASWARM_MOCK_TOOLS=1` or key missing |
| `trace.query` | Real | implemented diagnostics adapter |
| Conversation diagnostics runtime consistency | Real | diagnostics summary now checks event-derived runtime activity state against terminal run state and trace span status, including a settlement rule for `swarm.plan` when later swarm stages exist |
| `artifact.create` | Real | implemented adapter for Markdown/HTML artifact creation and content-hash de-dupe |
| `file.read` | Real | implemented workspace-local file read adapter |
| `approval.request` | Real | creates pending approval records; Run Trace/API support approve/reject decisions |
| Skills | Managed local registry with local install/update | planner can select enabled skills and receives V2 manifests; Skills UI/API can inspect, enable/disable, install, and update local skill packs; remote marketplace flow pending |
| Swarm | Planner-owned mock with model-provided branch plans + sandbox-agent runtime + independent reducer/verifier/reviewer + Run Trace timeline | `spawn_agent` and `spawn_swarm` enter Orchestrator; planner-provided branch definitions are preferred and recorded as `plan_source=model_branches`; branch heartbeat, internal action/observation events, failure, artifact recovery, model quality signals, `swarm.reduce`, merge, richer independent `swarm.verify` checks, optional `swarm.review`, and post-swarm finalize guardrails are bridged into parent run events and rendered in a dedicated Swarm Tree / Branch Timeline |
| Sandbox agent model | Real local smoke verified | DataSwarm sandbox agent runs a lightweight action/observation loop and can call configured DeepSeek/OpenAI-compatible chat completions |
| E2B | SDK + template contract + operator readiness diagnostics + live smoke verified | `@e2b/code-interpreter` path targets `dataswarm-agent-runtime`, imports or injects the DataSwarm sandbox agent, and preserves timeout/cancel/retry/recovery protocol; template build evidence is recorded in `data/e2b/template-verification.json`; a real external sandbox smoke is recorded in `data/e2b/live-smoke-receipt.json`; system snapshot exposes secret-safe status, missing env names, next steps, verification commands, explicit template verification receipt state, and live smoke receipt state; live orchestrator execution still requires runtime `E2B_API_KEY` plus `DATASWARM_E2B_TEMPLATE_VERIFIED=1`, `DATASWARM_E2B_TEMPLATE_BUILD_ID`, or a matching local receipt |
| Run cancellation | Real control-plane lifecycle | cancel API persists run cancellation metadata, fans out to non-terminal sandbox sessions, publishes run/sandbox cancellation events, and records terminal `cancelled` state separately from failures |
| Self-improvement | Async internal runner + Run Trace operations | eval enqueues internal analysis; runner creates idempotent candidates from trace/eval evidence; Run Trace/API expose replayable analysis, shadow test, review patch bundle, and human decision lifecycle actions; `mark_applied` requires an operator-submitted verification receipt covering every required command; automatic source patching intentionally pending |

Verification passed on 2026-06-11:

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
node scripts/swarm-image-artifact-e2e-smoke.mjs
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
node scripts/canonical-goal-audit.mjs --require-live-e2b
npm --prefix apps/web run build
node scripts/e2b-sandbox-smoke.mjs
```

Latest V2 tool-catalog calibration:

- `web.search` is now the default model-facing `web_search` adapter in the seeded tool catalog and mock planner.
- `web.search` now routes through a provider registry. Tavily remains the default real provider, while `mock.search` is a distinct built-in provider used for deterministic non-Tavily validation.
- The seeded `web.search` schema exposes a model-visible optional `provider` enum (`tavily`, `mock`), and startup sync updates existing local SQLite rows with the current schema/metadata.
- `tool.call.*` events and tool Observations record both the logical tool (`web.search`) and selected provider tool (`tavily.search` or `mock.search`).
- Evaluator and conversation diagnostics now evaluate web evidence by `web_search` capability/tool family instead of requiring a Tavily-specific tool name.
- `node scripts/tool-event-contract-e2e-smoke.mjs` verified the production API path with 12/12 checks: model action -> `web.search` tool event -> completed Observation -> provider metadata -> evaluator check -> diagnostics API summary with `hasWebSearchTool=true` and `hasTavily=false`.
- `node scripts/web-search-provider-smoke.mjs` verified the static provider registry contract with 10/10 checks.
- `node scripts/web-search-provider-e2e-smoke.mjs` verified the production API path with `DATASWARM_WEB_SEARCH_PROVIDER=mock`: model action -> `web.search` -> `mock.search` provider payload -> completed Observation -> terminal tool events with logical/provider metadata.
- `trace.query` now returns a richer model-facing summary that includes sandbox preflight counts and self-improvement applied receipt coverage, so diagnostic tool Observations can be used directly by the planner instead of requiring raw JSON inspection.
- Conversation diagnostics now include `summary.runtimeConsistency`, which reconstructs model/tool/artifact/swarm runtime activities from `run_events`, flags terminal runs with stale running activities or trace spans, and treats `swarm.plan` as settled when later `swarm.reduce` / `swarm.merge` / `swarm.verify` / `swarm.review` events exist.
- Run Trace now includes a dedicated `diagnostics` view that renders conversation health, runtime consistency, product/SSE/log evidence, Observation summaries, and structured remediation items from the canonical diagnostics repository.
- Mock planner routing now treats explicit sandbox visualization requests such as "使用沙箱绘制...图片" as sandbox/swarm work, matching the real planner policy and preventing local validation from silently taking the no-tool final-answer path.
- `scripts/canonical-verification-runner.mjs` is the grouped phase runner for Phase 1-5 gates. It writes a secret-safe receipt to `data/verification/canonical-verification-latest.json`, records E2B readiness booleans without secret values, and reports live E2B gates as `gated_skip` unless real credentials/template receipt make the external sandbox path provable. Canonical verification receipts now flow into conversation diagnostics / `trace.query`, so self-improvement and operator diagnosis can see Phase 1-5 gate status instead of reading local JSON files manually.
- `scripts/canonical-goal-audit.mjs` is the combined goal completion audit. Default mode verifies local receipt/document consistency while allowing explicit live E2B gating; `--require-live-e2b` now passes only because `data/verification/canonical-phase4-live-required-latest.json` records both a passed real external E2B sandbox smoke and a passed Orchestrator -> planner-owned `spawn_swarm` -> real E2B branch E2E gate.
- `node scripts/agentic-loop-v2-smoke.mjs` now includes 81 checks, including generic `web.search` provider registry, DB provider schema seed, provider-wrapper invariants, event protocol E2E coverage, phase-grouped canonical verification runner coverage, canonical receipt diagnostics coverage, canonical goal completion audit coverage, trace.query diagnostic summary coverage, planner-provided Swarm branch definitions, independent Swarm reducer/verifier/reviewer coverage, the controlled E2B template receipt gate, the Run Trace system readiness view, and the self-improvement queue health summary/API contract.

Smoke result:

```text
Agentic Loop V2 smoke passed: 81/81 checks passed, including terminal tool events carrying `observation_id` and `evidence_level`, mock planner trigger scoping to the latest user message, generic `web.search` provider registry and provider schema seed, event protocol E2E coverage, phase-grouped canonical verification runner coverage, canonical receipt diagnostics and goal completion audit coverage, `SCHEMA.md` current V2 storage contracts, `EVENT_PROTOCOL.md` current planner-owned swarm event names, planner-provided Swarm branch definitions, independent Swarm reducer/verifier/reviewer coverage, `ARCHITECTURE.md` current planner-owned runtime / gated E2B boundary, controlled E2B template receipt generation, structured remediation coverage, diagnostics-remediation candidate generation, Run Trace system readiness coverage, self-improvement queue health summary/API coverage, and deterministic `swarm.verify` coverage.
Canonical verification runner dry run passed: 43 gates listed across Phase 1-5, with a receipt written to `data/verification/canonical-verification-latest.json`. Focused Phase 4 execution wrote `data/verification/canonical-phase4-e2b-latest.json` and passed 4/4 gates: E2B readiness, live receipt contract, real live sandbox smoke, and Orchestrator E2B E2E smoke. The strict completion command `node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b --receipt data/verification/canonical-phase4-live-required-latest.json` passed 2/2 and `node scripts/canonical-goal-audit.mjs --require-live-e2b` reported `completion_status=complete`.
Canonical verification diagnostics smoke passed: 9/9 checks passed, including diagnostics API canonical receipt summary across 49 receipt gates, Phase 4 aggregate status, live E2B gated status, canonical diagnosis text, and a `canonical-verification-gates` remediation item with the strict live E2B verification command.
Canonical goal audit smoke passed: 4/4 checks passed, including default incomplete-live-E2B-gated audit, strict live-required audit failure while gated, strict audit success with synthetic live receipt, and secret-leak rejection for receipt evidence.
Web search provider smoke passed: 10/10 checks passed, including provider registry, model/env provider selection, logical/provider metadata persistence, direct Tavily compatibility, mock provider evidence, DB provider schema sync, and documentation status.
Web search provider e2e smoke passed: 12/12 checks passed against a self-started production server with `DATASWARM_WEB_SEARCH_PROVIDER=mock`, including model-proposed `web.search`, persisted mock provider Observation, mock payload source evidence, terminal `tool.call.completed`, and `tool.call.output` provider metadata.
Tool event contract e2e smoke passed: 12/12 checks passed against a self-started production server, including model-proposed `call_tool`, persisted tool Observation, `tool.call.output` evidence level, terminal `tool.call.completed` observation/evidence linkage, evaluator contract check, diagnostics API generic web_search recognition, and post-smoke cleanup.
Event protocol e2e smoke passed: 23/23 checks passed against a self-started production server, including persisted-before-flush wiring, gapless run-local `seq`, `from_seq` replay, `Last-Event-ID` replay, duplicate event IDs prevention, client-side seq-gap replay wiring, secret redaction for E2B/Tavily/OpenAI-shaped tokens, structured tool/artifact/swarm/approval UI surfaces, terminal event ordering, and post-smoke cleanup.
Skills V2 smoke passed: 18/18 checks passed, including enabled-only planner context, all-skill registry API, enable/disable API, install/update API, manifest-backed UI details, planner-selected skill Observation coverage, and SQLite manifest sync.
Skills install API smoke passed: 13/13 checks passed against a self-started production server, including local skill pack file writes, SQLite sync, registry visibility, disable/enable update path, and default quality-check fill.
Skills observation e2e smoke passed: 13/13 checks passed against a self-started production server, including model-proposed `use_skill`, durable `source_type=skill` Observation, selection reason, manifest context, alternatives metadata, `skill.selected`, `observation.created`, and replan linkage.
Sandbox agent smoke passed: 26/26 checks passed, including heartbeat, internal action/observation lifecycle, terminal runtime quality signals, markdown runtime summary, failure structuring, and artifact recovery manifest.
Sandbox agent model smoke passed: 12/12 checks passed when DeepSeek env is loaded from `apps/web/.env.local`, including real model call, action/observation lifecycle, runtime counts, and recovery readiness.
E2B template smoke passed: 9/9 checks passed, including Dockerfile packaging, default template alias, documented build command, local entrypoint readiness, and live smoke lifecycle coverage.
E2B template receipt smoke passed: 10/10 checks passed, including controlled receipt generation, default rejection without template build evidence, explicit local-contract-only mode, template contract smoke execution before receipt write, and Dockerfile/entrypoint/sandbox-agent hash evidence.
E2B readiness smoke passed: 26/26 checks passed, including system snapshot readiness, template/timeout env alignment, explicit env or local template verification receipt gating, live smoke receipt visibility, mismatched local receipt rejection, operator next steps, missing env reporting, verification command disclosure, and secret-safe output.
E2B live receipt smoke passed: 7/7 checks passed, including live smoke receipt field coverage, source-hash evidence, secret-safe receipt metadata, configurable receipt path, SDK resolution from the web workspace, missing-key skip behavior, and no receipt write on skipped live execution.
Run Trace system readiness smoke passed: 10/10 checks passed, including Run Trace system view wiring, E2B readiness gates, template/live smoke receipt evidence, operator verification commands, and reuse of the secret-safe system snapshot readiness source.
E2B preflight e2e smoke passed: 21/21 checks passed, including `DATASWARM_SANDBOX_PROVIDER=e2b` without `E2B_API_KEY`, missing template verification receipt reporting, structured `sandbox_preflight_failed` session metadata, matching `swarm.branch.failed` missing-env diagnostics, failed branch Observations, branch/merge observation links, 8-check deterministic `swarm.verify` failed-branch evidence, and post-smoke cleanup.
E2B template verification e2e smoke passed: 22/22 checks passed, including API-key-present/template-unverified readiness, no secret leak, preflight stop before external sandbox creation, structured branch diagnostics, failed branch Observations, branch/merge observation links, 8-check deterministic `swarm.verify` failed-branch evidence, and post-smoke cleanup.

E2B template verification receipt update:

- The `dataswarm-agent-runtime` template was rebuilt with the current E2B CLI command `npx --yes @e2b/cli template create dataswarm-agent-runtime -p sandbox -d e2b/e2b.Dockerfile -c 'sudo /root/.jupyter/start-up.sh' --ready-cmd 'python -c "import urllib.request; urllib.request.urlopen(\"http://localhost:49999/health\", timeout=5).read()" && python /home/user/dataswarm/entrypoint.py --ready'`.
- Template build evidence is recorded in `data/e2b/template-verification.json` with build id `c137a073-f397-4540-813e-44361948537f`; the command starts the inherited Code Interpreter service and waits for port `49999` health before accepting the DataSwarm readiness payload.
- `scripts/e2b-sandbox-smoke.mjs` completed a real external E2B sandbox run and wrote `data/e2b/live-smoke-receipt.json`; the receipt records `heartbeatCount=4`, `actionProposedCount=4`, `actionCompletedCount=4`, `observationCreatedCount=4`, and `artifactRecoveryManifest=true` without serializing provider secrets.
- `getE2bSandboxReadiness()` now accepts a matching local JSON receipt through `DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT` or the default `data/e2b/template-verification.json`.
- `scripts/e2b-template-receipt.mjs` is the preferred local receipt writer: it runs `node scripts/e2b-template-smoke.mjs` first, records template/agent file hashes, requires `--template-build-id` or `DATASWARM_E2B_TEMPLATE_BUILD_ID` by default, and only writes local-contract-only evidence when explicitly asked.
- `scripts/e2b-sandbox-smoke.mjs` parses E2B `runCode()` stdout/stderr/text chunks line-by-line, so live verification checks real sandbox agent events instead of relying on a brittle joined output string; `scripts/e2b-live-receipt-smoke.mjs` verifies that contract without creating a sandbox and confirms skipped runs do not write misleading receipts.
- Receipt validation requires matching selected template, `ready`/`verified` status, and durable evidence (`templateBuildId` or `verifiedAt`); a receipt for one template does not unlock another template.
- System snapshot now exposes `templateVerificationReceiptPath`, `templateVerifiedAt`, `liveSmokeReceiptPath`, `liveSmokeVerifiedAt`, and live smoke sandbox evidence without leaking `E2B_API_KEY`.
- Conversation diagnostics now summarize E2B live smoke receipt coverage from sandbox session metadata, failed branch observations, and branch failure events, so `trace.query`/diagnostics can distinguish "configured" from "live-smoke verified".
- Positive receipt readiness is covered by `node scripts/e2b-readiness-smoke.mjs`; missing receipt / key-only preflight blocking remains covered by `node scripts/e2b-template-verification-e2e-smoke.mjs`.
Sandbox retry policy smoke passed: 8/8 checks passed.
Run cancel lifecycle smoke passed: 8/8 checks passed, including cancel protocol coverage, Orchestrator cancelled terminal state, Swarm branch-boundary stop, and UI SSE handling.
Run cancel API smoke passed: 8/8 checks passed against a self-started production server, including persisted run metadata, sandbox fan-out metadata, and durable cancel events.
Swarm action plan smoke passed: 10/10 checks passed, including AgentAction branch schema, planner branch prompt/normalization/validation, mock planner branch emission, Orchestrator action passthrough, executor `plan_source`, stable branch IDs, event branch instructions, and status documentation.
Swarm reducer smoke passed: 10/10 checks passed, including independent reducer module extraction, shared contradiction/source-mismatch scanner semantics with verifier, durable `swarm.reduce` span/event emission before merge, reducer-influenced merge/final observations, Run Trace reducer rendering, conversation stream reducer cards, event protocol coverage, and status documentation.
Swarm verifier smoke passed: 10/10 checks passed, including independent verifier module extraction, preserved check IDs, plan-source traceability, branch instruction coverage, duplicate-summary detection, contradiction/source-mismatch signal scanning, deterministic status summarization, event protocol coverage, and status documentation.
Swarm review smoke passed: 10/10 checks passed, including independent optional reviewer module, disabled/mock/model modes, model-provider JSON review support, durable `swarm.review` span/event emission after verify, Orchestrator provider/profile wiring, conversation cards, Run Trace Review panel, protocol/schema coverage, and status documentation.
Sandbox retry e2e smoke passed: 19/19 checks passed against a self-started mock production server, including exactly one `swarm.plan`, `plan_source=model_branches`, model-provided branch instructions, exactly three branch sandbox sessions, one durable branch Observation per branch, `swarm.reduce` branch evidence, branch/reduce/merge/verify/review event observation links, 8 deterministic `swarm.verify` checks, mock `swarm.review` output, retry metadata, and post-smoke cleanup.
Swarm image artifact e2e smoke passed: 13/13 checks passed against a self-started mock production server, including sandbox visualization planner selection, recovered image artifacts, image-mode `artifact.created` / `artifact.preview.ready` events, assistant message artifact preview parts, branch Observation `image_artifact_ids`, requested-image verifier coverage, conversation artifacts API visibility, preview endpoint image bytes, and post-smoke cleanup.
Swarm trace UI smoke passed: 9/9 checks passed, including Run Trace swarm view, persisted event grouping, branch timeline rendering, reduce/merge separation, and dedicated Verify/Review panels for `swarm.verify` and `swarm.review`.
Approval lifecycle smoke passed: 6/6 checks passed.
Self-improvement async smoke passed: 12/12 checks passed, including replayable `run_async_analysis`, idempotent candidate generation per eval check, E2B/template-specific verification plans that include the template receipt gate, and internal worker events.
Self-improvement diagnostics smoke passed: 12/12 checks passed, including self-started production API execution for `run_diagnostics_analysis`, conversion of diagnostics remediation into de-duplicated review-gated candidates, E2B preflight/live-smoke verification plans, canonical verification remediation candidate generation, and durable diagnostics-analysis events.
Self-improvement lifecycle smoke passed: 13/13 checks passed, including self-started production API execution, patch bundle generation under `local://self-improvement/...`, rejection of `mark_applied` without a verification receipt, and command-level verification receipt recording.
Self-improvement UI smoke passed: 12/12 checks passed, including Run Trace action rendering, diagnostics remediation analysis action, canonical API calls, lifecycle action visibility, Mark Applied receipt prompting, applied verification receipt coverage summary, required command coverage summary, and durable event coverage.
Self-improvement summary smoke passed: 10/10 checks passed, including repository-level queue summary, API summary response, Run Trace queue health metrics, next operator actions, lifecycle/risk distributions, and applied receipt gap detection.
Self-improvement summary API smoke passed: 10/10 checks passed, including synthetic queued/shadow/prepared/approved/applied/rejected/deferred candidates, API summary counters, queue health, lifecycle distribution, required command coverage, next operator actions, and post-smoke cleanup.
Trace diagnostics improvements smoke passed: 13/13 checks passed, including conversation diagnostics API visibility for queued/applied self-improvement candidates, required verification commands, applied command-level verification receipt coverage, and structured self-improvement remediation items.
Trace diagnostics sandbox smoke passed: 13/13 checks passed, including conversation diagnostics API visibility for E2B sandbox sessions, failed branch Observations, observation summary counts, `sandbox_preflight_failed`, missing env names, sandbox verification commands, E2B live smoke receipt coverage, and structured sandbox remediation items.
Trace diagnostics runtime consistency smoke passed, including diagnostics API visibility for stale runtime activity after terminal run, stale running trace span detection, `swarm.plan` settlement by later swarm stage, diagnosis text, and `runtime-event-consistency` remediation.
Trace diagnostics UI smoke passed, including Run Trace diagnostics tab coverage, runtime consistency metrics, product/evidence signal rendering, structured remediation rendering, and canonical verification gate registration.
```

Build result:

```text
npm --prefix apps/web run build
```

Build passes. Turbopack still emits one warning for the intentional dynamic local-file capability used by `file.read`.

E2B smoke result:

```text
E2B orchestrator e2e smoke passed: 18/18 check(s) passed.
Canonical verification summary:
- phase4: 2/2 passed, 0 failed, 0 gated
```

The live E2B path is now verified with temporary runtime credentials and no persisted key. `/api/system/snapshot` reports exact E2B readiness status, missing environment names, template verification receipt state, next steps, and verification commands. If the orchestrator is switched to `DATASWARM_SANDBOX_PROVIDER=e2b` before credentials and template verification are configured, each branch records `sandbox_preflight_failed` with secret-safe readiness metadata, a failed branch Observation, and branch/merge observation links instead of silently using mock execution. The latest strict live receipt proves both `node scripts/e2b-sandbox-smoke.mjs` and `node scripts/e2b-orchestrator-e2e-smoke.mjs`: the Orchestrator accepted a conversation message, the planner selected `spawn_swarm`, three real E2B branch sessions completed, 66 sandbox agent events bridged into the parent run, three real branch Observations were persisted, and reduce/merge/verify events completed with branch evidence.

Browser verification:

```text
GET http://localhost:3226/runs/run_ui_verify_...?view=improvements -> 200
Temporary self-improvement candidate rendered Applied Receipts, Verification Commands, Command Results, and applied_receipt:present markers; temporary rows were cleaned up after verification.
GET http://localhost:3000/api/system/snapshot -> 200
GET /runs/run_43dfed4ca0da40179e79f95a3c407f18?view=improvements -> 200
Trace Improvements tab and Self-Improvement Candidates panel rendered with no browser console errors.
GET /api/runs/run_43dfed4ca0da40179e79f95a3c407f18/improvements -> 200, improvements: []
GET /api/runs/:id/approvals -> 200
POST /api/runs/:id/approvals/:approvalId approve -> approved
POST /api/runs/:id/improvements/:candidateId shadow_test -> shadow_tested
POST /api/runs/:id/improvements/:candidateId prepare_patch_bundle -> patch_prepared
POST /api/runs/:id/improvements/:candidateId approve -> approved
POST /api/runs/:id/improvements/:candidateId mark_applied -> applied
```

## Historical Status Log

The sections below are retained as implementation history. When they conflict with the canonical status above, the canonical status wins.

## Current Milestone

M0-M5 were implemented and verified as the initial MVP baseline. The active direction has shifted from MVP engineering-routed runtime to Agentic Runtime V2.

## Active Architecture Direction

The early MVP runtime could execute tools, persist Trace, stream events, and render tool cards, but it was not truly agentic. That gap drove the Agentic Runtime V2 migration.

New target architecture:

- Design doc: [AGENTIC_RUNTIME_V2_DESIGN.md](./AGENTIC_RUNTIME_V2_DESIGN.md)
- Core shift: model proposes `AgentAction`; runtime validates/executes; outputs become `Observation`; final answers are evidence-bound.
- Tool abstraction: planner reasons over a generic `ToolCapability` catalog; concrete tools are replaceable adapters.
- Tavily status: first implemented `web_search` smoke adapter only, not the runtime strategy or a privileged decision path.
- Temporary guardrails in the current runtime are allowed only to prevent misleading behavior during migration. They are not the target agentic design.

Original V2 migration milestone:

1. Add `AgentAction` and `Observation` types.
2. Add `agent_actions` and `observations` storage.
3. Add planner-first model call.
4. Load a generic tool capability catalog into planner context, including provider, adapter status, auth status, freshness, risk, input/output schemas, and evidence kind.
5. Execute any tool only when model proposes a validated `call_tool` action.
6. Use Tavily only as the first web-search smoke tool, not as the runtime abstraction.
7. Require final answers to cite observation IDs for tool-backed claims.
8. Add non-Tavily proof adapters such as `trace.query` and `artifact.create` before treating v2 as product-ready.

## Agentic Runtime v2 Phase A+B Implementation

Status: implemented and smoke-verified on 2026-06-09.

Implemented:

- Added generic `AgentAction`, `Observation`, and `ToolCapability` TypeScript protocols.
- Added `agent_actions` and `observations` SQLite tables through migration `0002_agentic_runtime_v2`.
- Added repositories for persisted agent actions and observations.
- Added generic `ToolCapability` catalog loading with capability kind, provider, adapter status, auth status, freshness, risk, schema, and evidence kind.
- Added planner-first model call before execution.
- Added parser normalization for common model structured-output variants:
  - `{ action: { ... } }`
  - direct `{ type: ... }`
  - `{ action: "call_tool", tool_name: ... }`
  - `{ tool_call: ... }`
  - direct answer fields such as `answer`, `response`, `reply`, `message`, `text`, `final_answer`.
- Runtime now persists `action.proposed` and `action.validated` before execution.
- Runtime executes a tool only when the validated model action is `call_tool`.
- Tool execution now goes through a generic adapter registry; `tavily.search` is the first implemented adapter.
- Tool results are normalized into persisted Observations.
- Tool events now carry `action_id`, `capability_kind`, and `observation_id`.
- Final answers cite Observation IDs when tool observations exist.
- Evaluator v2 now checks:
  - planner action existence
  - action validation
  - tool events linked to action IDs
  - executed tool actions creating observations
  - final answer evidence references
  - tool-claim consistency against observations

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

Both passed.

Smoke 1: search/tool path

```text
Conversation: conv_66180e8abf9d4690b00c8f55257fe3e5
Run:          run_07f665a6bb21430f9d46dc311b0fddbb
Status:       completed
Action:       call_tool / tavily.search / executed
Observation:  obs_20cdcc8d707c4ad9b3588581ef33ec24
Tool mode:    real
Evaluator:    100% (12/12 checks passed)
```

Observed event chain:

```text
action.proposed
action.validated
tool.call.requested
tool.call.started
tool.call.output
observation.created
tool.call.completed
model.call.started
model.call.completed
eval.completed
message.completed
run.completed
```

Smoke 2: no-tool final answer path

```text
Run:            run_1059b84b802e4e32ba0051f5f1a276ef
Status:         completed
Action:         final_answer / executed
Tool calls:     0
Observations:   0
Evaluator:      100% (12/12 checks passed)
```

Known remaining post-Phase-B work at that time:

- `trace.query`, `artifact.create`, and `file.read` are now implemented.
- Legacy Markdown/HTML report generation has been moved behind `artifact.create`.
- Extend UI cards to explicitly render `action.proposed` and `observation.created` as first-class generic cards if not already visible through runtime cards.

## Completed in M0

- Created workspace skeleton:
  - `apps/web`
  - `packages/shared`
  - `packages/storage`
  - `packages/trace`
  - `packages/runtime`
  - `packages/models`
  - `packages/tools`
  - `packages/skills`
  - `packages/swarm`
  - `sandbox/agent`
  - `skills/`
  - `data/`
- Created Next.js App Router application with TypeScript and Tailwind CSS.
- Added root npm scripts for web app commands.
- Added local storage helpers:
  - `local://` URI creation and resolution.
  - data directory bootstrap.
  - atomic text writes.
  - SHA-256 content hashing.
- Added SQLite initialization using lazy server-side initialization.
- Added migration runner and `0001_init` schema via code-backed migration.
- Added seed data:
  - `ten_default`
  - `usr_local`
  - `prj_default`
  - `dmx:gpt-5.5-1m`
  - `dmx:claude-opus-4-8`
  - `deepseek:deepseek-v4-pro`
  - `deepseek:deepseek-v4-flash`
  - Tavily MCP registry entry.
  - Built-in tool placeholders.
  - Built-in skill placeholders.
- Added repositories:
  - conversations
  - model profiles
  - system snapshot
- Added APIs:
  - `GET /api/conversations`
  - `POST /api/conversations`
  - `GET /api/conversations/:id`
  - `GET /api/system/snapshot`
- Replaced default homepage with DataSwarm workspace shell:
  - Sidebar.
  - Conversation surface.
  - Composer placeholder.
  - Artifact panel placeholder.
  - Seed/model/system counts.
- Verified browser render of the local app.

## Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

API smoke checks passed:

```text
GET  /api/system/snapshot
POST /api/conversations
GET  /api/conversations
GET  /api/conversations/:id
GET  /
```

SQLite evidence:

- `schema_migrations` contains `0001_init`.
- `conversations` contains the M0 smoke conversation.
- `model_profiles` contains all four confirmed model profiles.
- `skills` contains three enabled placeholder skills.

Browser smoke:

- Page title: `DataSwarm`.
- UI text includes DataSwarm, Artifacts, M0 smoke conversation, and seed counts.
- Browser console error log was empty during smoke check.

## Known Non-M0 Scope

These M0 exclusions have now moved as follows:

- User message submission to Orchestrator: implemented in M1.
- DMXAPI-compatible model provider: implemented in M1 with mock mode for local validation and real OpenAI-compatible path for configured environments.
- SSE run event stream: implemented in M1.
- Trace span creation during runs: implemented in M1.
- Tool execution: implemented in M2 with a Tavily-capable registry and safe local mock mode.
- Artifact generation/versioning: implemented in M2 for Markdown and HTML artifacts.
- E2B sandbox execution: provider boundary is implemented in M3; real E2B execution is deferred until dependency and template pinning.
- Swarm execution: implemented in M3 with local mock sandbox runtime and full event/trace persistence.
- Evaluation and self-improvement report generation: implemented in M5.
- Skill draft generation remains a future extension beyond this MVP pass.

## Completed in M1

- Added `ModelProvider` abstraction.
- Added DMXAPI/OpenAI-compatible streaming provider.
- Added safe local mock provider controlled by `DATASWARM_MOCK_MODEL=1`.
- Added runtime event bus with persist-before-stream behavior.
- Added `run_events` publishing and in-memory live subscribers.
- Added SSE endpoint:
  - `GET /api/runs/:id/events`
  - supports `from_seq`
  - supports `Last-Event-ID`
  - emits heartbeats
- Added run trace endpoint:
  - `GET /api/runs/:id/trace`
- Added message submission endpoint:
  - `POST /api/conversations/:id/messages`
- Added run/task creation path.
- Added Orchestrator `AgentSession` creation and run loop.
- Added assistant message streaming through `message.part.delta`.
- Added persisted assistant message completion.
- Added minimal Trace spans:
  - `agent.run`
  - `model.call`
- Added UI composer for sending messages.
- Added EventSource-based client streaming.
- Added `.env.example` with placeholder environment variables only.

## M1 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Golden task:

```text
请用三句话解释 DataSwarm 是什么。
```

Verified run:

```text
run_1ed3a84904eb4ae3b024dec1b689f965
```

SQLite evidence:

- `runs.status = completed`.
- `run_events` contains 18 ordered events for the run.
- `trace_spans` contains 2 completed spans for the run.
- `messages` contains completed user and assistant messages.

Observed event sequence:

```text
run.created
message.created
run.started
message.created
message.part.started
model.call.started
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.completed
model.call.completed
message.completed
run.completed
```

Trace evidence:

- `agent.run` completed.
- `model.call` completed.
- Both spans share a trace ID.
- `model.call` is parented under `agent.run`.

SSE replay evidence:

```text
GET /api/runs/run_1ed3a84904eb4ae3b024dec1b689f965/events?from_seq=17
```

returned only `seq=18` / `run.completed`, proving sequence-based replay.

Browser note:

- The page rendered successfully and browser console errors were empty during M0 smoke.
- During M1 interactive browser automation, the in-app browser automation environment failed on text entry with a virtual clipboard error. API, database, SSE, and trace verification passed; UI code path is implemented and will be rechecked with a stable browser input method in the next frontend verification pass.

## Completed in M2

- Added local skill discovery and synchronization from `skills/*/SKILL.md`.
- Added `GET /api/skills`.
- Added sidebar skill listing in the workspace UI.
- Added ToolRegistry with a Tavily search wrapper.
- Added safe mock tool mode controlled by `DATASWARM_MOCK_TOOLS=1`.
- Added tool call persistence in `tool_calls`.
- Added tool call payload persistence to `local://traces/...`.
- Added Artifact Service for immutable Markdown and HTML artifact versions.
- Added artifact content hashing.
- Added standardized artifact preview generation.
- Added artifact APIs:
  - `GET /api/conversations/:id/artifacts`
  - `GET /api/artifacts/:id/preview`
  - `GET /api/artifacts/:id/download`
- Added conversation artifact listing in the right-side workspace panel.
- Extended Orchestrator with:
  - skill resolution
  - `skill.selected` events
  - `tool.call.requested`
  - `tool.call.started`
  - `tool.call.output`
  - `tool.call.completed`
  - `artifact.create.started`
  - `artifact.created`
  - `artifact.preview.ready`
  - assistant `artifact_preview` message parts
- Extended Trace with:
  - `skill.resolve`
  - `tool.call`
  - `artifact.create`
- Replaced unsafe regex-based mock model chunking with fixed-size slicing so streamed text does not drop URL prefixes across chunks.

## M2 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Golden task 1:

```text
搜索 Tavily MCP 的官方文档，并总结它适合作为 DataSwarm 默认联网工具的原因。
```

Verified run:

```text
run_7f58492df1984c67b2e1b5e0a469c4d2
```

Observed M2 tool events:

```text
skill.selected
tool.call.requested
tool.call.started
tool.call.output
tool.call.completed
run.completed
```

Trace evidence:

- `agent.run` completed.
- `skill.resolve` completed.
- `tool.call` completed.
- `model.call` completed.

Tool call evidence:

- `tool_calls.status = completed`.
- Tool output summary: `Tavily search returned 3 source(s).`
- Tool payload stored through a local trace URI, not inline secrets.

Golden task 2:

```text
基于 DataSwarm 当前设计生成一份分析报告，要求 Markdown 和 HTML 两种格式。
```

Verified run:

```text
run_b1f0446614454140ab4cd2c3d6dae4d8
```

Artifact evidence:

```text
art_cd207e3aecfb43fb8159728c305985a9
art_d07b24e394b84917b85ec8bd07a5451d
```

SQLite evidence:

- `artifacts` contains 2 M2 artifacts.
- `artifact_versions` contains 2 immutable v1 versions.
- `tool_calls` contains 1 completed tool call from the Tavily golden task.
- M2 golden runs include `skill.selected`, tool events, artifact events, model events, and `run.completed`.

Preview/download evidence:

```text
GET /api/artifacts/art_d07b24e394b84917b85ec8bd07a5451d/preview -> 200
GET /api/artifacts/art_cd207e3aecfb43fb8159728c305985a9/download -> 200
```

The HTML preview includes:

```text
DataSwarm Analysis Report
Reproducibility
```

Post-fix stream chunk evidence:

```text
run_12a73070bc2e4b04ae944169c18b99e3
```

The new assistant message preserved all mock source URIs as complete `local://...` values.

Security scan:

```text
rg -n "<old-opus-model>|sk-[A-Za-z0-9]{12,}|e2b_[A-Za-z0-9]|tvly-[A-Za-z0-9]" . --glob '!LLM推理服务相关信息.md' --glob '!data/**' --glob '!apps/web/node_modules/**' --glob '!apps/web/.next/**' --glob '!apps/web/package-lock.json'
```

returned no matches, confirming implementation files did not introduce the old model name or obvious key-shaped secrets.

## Completed in M3

- Added parent-child AgentSession support.
- Added sandbox session repository over the existing `sandbox_sessions` schema.
- Added context bundle repository over the existing `context_bundles` schema.
- Added `SandboxProvider` abstraction.
- Added deterministic local mock sandbox provider.
- Added E2B provider boundary with secret-safe `E2B_API_KEY` configuration.
- Added `DATASWARM_SANDBOX_PROVIDER=mock` local default.
- Added swarm runtime with:
  - deterministic branch planning
  - research branch
  - analysis branch
  - validation branch
  - branch AgentSession creation
  - branch context bundle creation
  - branch sandbox session creation
  - branch artifact creation
  - merge event generation
- Added Orchestrator swarm trigger for complex, parallel, sandbox, and swarm requests.
- Added M3 event types:
  - `swarm.plan`
  - `swarm.branch.started`
  - `swarm.branch.completed`
  - `swarm.merge`
- Added M3 Trace span kinds:
  - `swarm.plan`
  - `swarm.branch`
  - `swarm.merge`
- Added branch artifacts as immutable Markdown artifacts with previews.

## M3 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Golden task:

```text
这是一个复杂任务：请使用蜂群模式并行启动多个沙箱分支，分别完成研究、分析和验证，然后合并为 DataSwarm M3 runtime 的执行判断。
```

Verified run:

```text
run_ab1b8641fb084c29aa4e24ef21853027
```

Observed M3 event counts:

```text
swarm.plan|1
swarm.branch.started|3
swarm.branch.completed|3
swarm.merge|1
artifact.created|3
artifact.preview.ready|3
run.completed|1
```

Observed M3 event sequence:

```text
4|swarm.plan
5|swarm.branch.started
8|swarm.branch.completed
9|swarm.branch.started
12|swarm.branch.completed
13|swarm.branch.started
16|swarm.branch.completed
17|swarm.merge
```

Trace evidence:

- `agent.run` completed.
- `swarm.plan` completed.
- `swarm.branch` completed 3 times.
- `swarm.merge` completed.
- `model.call` completed.

Sandbox evidence:

- `sandbox_sessions` contains 3 completed mock sessions for the run.
- `context_bundles` contains 3 redacted branch context bundles for the run.
- Branch agents use sandbox model profiles:
  - `deepseek:deepseek-v4-pro`
  - `deepseek:deepseek-v4-flash`
  - `deepseek:deepseek-v4-pro`

Branch artifact evidence:

```text
art_9bc9a0547da343cfa15fd41d1364a574
art_4c886eb33bbe43b0a4acb14d0af99741
art_cb77a9149bfb4358a7c0119bcac6de45
```

Preview/download evidence:

```text
GET /api/artifacts/art_9bc9a0547da343cfa15fd41d1364a574/preview -> 200
GET /api/artifacts/art_cb77a9149bfb4358a7c0119bcac6de45/download -> 200
```

The final assistant response included the `Swarm merge` observation with all three branch artifact IDs.

Security scan:

```text
rg -n "<old-opus-model>|sk-[A-Za-z0-9]{12,}|e2b_[A-Za-z0-9]|tvly-[A-Za-z0-9]" . --glob '!LLM推理服务相关信息.md' --glob '!data/**' --glob '!apps/web/node_modules/**' --glob '!apps/web/.next/**' --glob '!apps/web/package-lock.json'
```

returned no matches after M3.

## Completed in M4

- Added latest-run lookup for conversations.
- Passed persisted run events and trace spans into the conversation workspace on page refresh.
- Converted SQLite trace rows into plain objects for safe Server Component to Client Component serialization.
- Added Run Activity rendering for persisted and live SSE events.
- Added Trace summary chips for span kinds.
- Filtered high-volume text delta events out of the activity panel while keeping streaming text in messages.
- Rendered assistant `artifact_preview` message parts as artifact links.
- Added sandbox model profile chips in the conversation header.
- Added an attachment control placeholder in the composer.
- Added inline artifact preview panels in the right-side artifact list.
- Kept the existing preview/download APIs as the artifact rendering backend.

## M4 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Refresh replay smoke:

```text
GET /?conversationId=conv_afd488131f154b5a990ece407ba85c77
```

Observed page markers:

```text
Run Activity
swarm.plan
swarm.branch.started
swarm.branch.completed
swarm.merge
artifact ·
Inline preview
DeepSeek V4 Pro
Attach
swarm.branch:3
```

Negative page markers:

```text
__next_error__
Only plain objects
```

were absent after the trace-row serialization fix.

Trace API smoke:

```text
GET /api/runs/run_ab1b8641fb084c29aa4e24ef21853027/trace
```

returned:

```json
{
  "agent.run": 1,
  "swarm.plan": 1,
  "swarm.branch": 3,
  "swarm.merge": 1,
  "model.call": 1
}
```

Security scan returned no matches after M4.

## Completed in M5

- Added `eval_results` repository.
- Added `GET /api/runs/:id/evals`.
- Added deterministic run-health evaluator.
- Added self-improvement recommendation report generation.
- Added M5 event types:
  - `eval.started`
  - `eval.completed`
- Added M5 Trace span kind:
  - `eval.run`
- Added self-improvement report artifacts as immutable Markdown artifacts with previews.
- Added evaluation artifact IDs to final assistant message artifact parts.
- Added eval events to Run Activity UI.
- Fixed accidental swarm trigger caused by matching `swarm` inside the `DataSwarm` brand name.

## M5 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Final golden task:

```text
请进行一次普通 DataSwarm M5 健康检查，回复一句话即可。
```

Verified run:

```text
run_dfdadcca8fce4795ab2755de0ecb648b
```

Observed M5 event counts:

```text
artifact.created|1
artifact.preview.ready|1
eval.completed|1
eval.started|1
message.completed|1
model.call.completed|1
model.call.started|1
run.completed|1
run.created|1
run.started|1
```

Observed lifecycle sequence:

```text
14|model.call.completed
15|eval.started
18|eval.completed
20|message.completed
21|run.completed
```

Trace evidence:

- `agent.run` completed.
- `model.call` completed.
- `eval.run` completed.

Eval API evidence:

```text
GET /api/runs/run_dfdadcca8fce4795ab2755de0ecb648b/evals
```

returned:

```json
[
  {
    "id": "eval_496c8d037f944787806e2baa1a32b5fb",
    "score": 1,
    "artifactId": "art_b50cb8f82bef467eb7ec69c2a588eece",
    "summary": "Run health score 100% (5/5 checks passed)."
  }
]
```

Self-improvement artifact:

```text
art_b50cb8f82bef467eb7ec69c2a588eece
```

Preview evidence:

```text
GET /api/artifacts/art_b50cb8f82bef467eb7ec69c2a588eece/preview -> 200
```

The preview includes:

```text
DataSwarm Self-Improvement Report
Run health score 100% (5/5 checks passed).
Recommendations
Data Sources
```

UI replay evidence:

The refreshed conversation page includes:

```text
eval.started
eval.completed
DataSwarm Self-Improvement Report
Run Activity
eval.run
```

Negative UI markers:

```text
__next_error__
Only plain objects
```

were absent.

Security scan returned no matches after M5.

## Next Milestone

Post-MVP hardening.

Primary next tasks:

1. Pin and implement real E2B sandbox execution templates.
2. Replace mock model/tool paths with configured provider calls in a staging environment.
3. Add real upload persistence and attachment context ingestion.
4. Add richer artifact drawer behavior and live artifact list refresh.
5. Add skill creation/install workflows.
6. Add Postgres migration path and multi-tenant enforcement checks.

## Post-MVP UI Productization Pass

Completed after the M0-M5 MVP because the first UI was only an engineering smoke surface.

- Rebuilt the workspace shell into a product-oriented two-column layout:
  - dark left navigation
  - central conversation workspace
  - client-side artifact panel
  - embedded run activity rail
- Added `lucide-react` for real iconography in navigation, buttons, timeline rows, composer, and artifact actions.
- Replaced the old server-rendered artifact iframe list with a selectable artifact preview panel.
- Added live artifact refresh on `artifact.created`, `artifact.preview.ready`, and `run.completed` events.
- Converted run events into typed timeline rows with visual states for:
  - run lifecycle
  - model calls
  - tool calls
  - swarm branches
  - artifact creation
  - evaluation
- Added a denser, more coherent visual system:
  - dark navigation surface
  - neutral workspace background
  - distinct teal, blue, green, amber, and red status colors
  - consistent 8px radii
  - icon-only buttons where appropriate
- Updated local mock model output so it no longer reads as `mock demo` or `M1` engineering verification text.
- Added frontend cleanup for historical mock boilerplate in old persisted messages.
- Verified the productized UI through:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Interaction smoke:

```text
run_c98574457fd64bca86aa75413dbdfbe1
```

The run completed with model, eval, artifact, message, and run events, and produced:

```text
art_9ae42431378241a982489f49c3c39bf8
```

UI replay smoke showed:

```text
Conversations
Installed Skills
Run Activity
Artifacts
DataSwarm Self-Improvement Report
eval.started
eval.completed
Trace, events, artifacts, and evaluation records
```

Negative UI markers were absent:

```text
__next_error__
Only plain objects
Unhandled Runtime Error
```

Security scan returned no matches after the UI productization pass.

## Conversation Flow And Trace Separation Pass

Completed after reviewing the productized UI interaction issues.

- Re-centered the main workspace around the conversation stream:
  - the middle column is now the only scroll container for messages
  - SSE `message.part.delta` continues to append streamed assistant text
  - the stream auto-scrolls to the latest message while a run is active
  - Trace/run activity cards were removed from message cards
- Kept the left navigation fixed:
  - `h-screen`
  - `overflow-hidden` app shell
  - conversation list scrolls only inside the sidebar list area
- Converted Artifacts into a right-side drawer:
  - closed by default
  - opened by the header Artifacts button or an artifact chip in the message stream
  - fixed to the right side instead of participating in page scroll
  - does not render the artifact preview iframe while closed
- Added a dedicated run Trace page:
  - route: `/runs/[id]`
  - tabs: `overview`, `sessions`, `trace`, `spans`, `events`, `evals`
  - search parameter: `q`
  - supports session/trace/span/event/eval level inspection without cluttering the chat flow
- Added read repositories for Trace page support:
  - `listAgentSessions(runId)`
  - `listSandboxSessions(runId)`
- Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

HTTP smoke:

```text
home_has_iframe=no
home_has_run_activity=no
home_has_translate_closed=yes
sessions=200 trace=200 spans=200 events=200 evals=200
```

## Conversation Submit And SSE Replay Fix

Completed after reviewing the message submission flow from composer to API, run event stream, and canonical message refresh.

- Fixed composer interaction:
  - Enter now submits the instruction
  - Shift+Enter keeps multiline input behavior
  - the composer is now a real form with submit handling
  - the optimistic local user message is reconciled to the server `message_id`
- Fixed front-end message synchronization:
  - `message.completed` now triggers a canonical `/api/conversations/[id]` refresh
  - `run.completed` and `run.failed` also refresh canonical conversation state
  - final assistant message parts, including `artifact_preview`, now appear in the conversation flow after the run is persisted
- Hardened SSE replay:
  - `/api/runs/[id]/events` now subscribes before sending historical events
  - sent event ids are de-duped so events created during the historical fetch window are not lost or duplicated
- Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

End-to-end API/SSE smoke:

```json
{
  "message.part.delta": 7,
  "message.completed": 1,
  "run.completed": 1,
  "finalAssistantParts": ["text", "artifact_preview"]
}
```

## Interaction Observability And Composer Layout Pass

Completed after the conversation interaction review exposed that agent-facing debugging could not see the front-end/back-end data exchange clearly enough.

- Added structured server logs with `[DataSwarm:server]` prefix:
  - `api.messages.post.*`
  - `api.events.*`
  - `event_bus.*`
  - `api.conversation.get.*`
  - `api.artifacts.list.*`
- Server logs include request ids, conversation ids, run ids, task ids, message ids, event type/seq, subscriber counts, and safe text length/preview.
- Added client-side console logs with `[DataSwarm:UI]` prefix:
  - message submit start/accepted/error
  - SSE connect/open/error
  - message/event/artifact/run lifecycle events
  - canonical conversation/artifact refresh start/ok/failure
- Composer behavior and layout:
  - Enter submits by default
  - Shift+Enter inserts a newline
  - model selector and attachment button moved to the bottom of the input box
  - model selector appears before attachment
  - send button remains on the bottom-right of the composer
- Trace navigation:
  - Trace opens in a new browser tab/window
  - Trace URL carries `conversationId`
  - `/runs/[id]` preserves `conversationId` across Trace sub-tabs and back navigation
- Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

End-to-end API/SSE smoke:

```json
{
  "message.part.delta": 6,
  "message.completed": 1,
  "run.completed": 1,
  "finalAssistantParts": ["text", "artifact_preview"]
}
```

## Real DMX Provider Activation Fix

Completed after the UI still showed the mock template response:

```text
DataSwarm Orchestrator completed the request with claude-opus-4-8.
```

Root cause:

- `apps/web/package.json` forced `DATASWARM_MOCK_MODEL=1` in the default `dev` script.
- The front-end message flow was working, but the server process was intentionally using `MockModelProvider`.
- Existing browser sessions connected to the old dev process continued to return mock model text until the server was restarted.

Fix:

- Changed `npm --prefix apps/web run dev` to use the real OpenAI-compatible provider by default.
- Added `npm --prefix apps/web run dev:mock` for explicit local mock runs.
- Created local, gitignored `apps/web/.env.local` with provider configuration from the local reference document.
- Added provider-level logs:
  - `model.provider.mock.enabled`
  - `model.provider.real.enabled`
  - `model.provider.request.start`
  - `model.provider.delta`
  - `model.provider.usage`
  - `model.provider.request.failed`
- Restarted the dev server on port 3000 with `.env.local` loaded.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Real provider smoke:

```json
{
  "modelProfile": "dmx:claude-opus-4-8",
  "providerMode": "real",
  "message.part.delta": 3,
  "run.completed": 1,
  "finalTextPreview": "我是 DataSwarm Orchestrator，负责协调数据工具、技能与产物，为你提供简洁可靠的数据分析与处理服务。"
}
```

## Internal Evaluation Artifact Visibility Fix

Completed after the `DataSwarm Self-Improvement Report` appeared in every conversation as a visible artifact.

Root cause:

- The run evaluator synchronously created a markdown artifact titled `DataSwarm Self-Improvement Report`.
- The orchestrator appended the evaluator artifact id to the assistant message `artifact_preview` parts.
- The Artifacts drawer listed all conversation artifacts, so internal evaluator reports appeared beside user-facing outputs.

Fix:

- `evaluateRunAndRecommend` now records internal run health in:
  - `eval_results`
  - `eval.started` / `eval.completed` events
  - trace span attributes
- It no longer creates a user-facing markdown artifact.
- The orchestrator no longer appends evaluator output to the assistant message artifacts.
- `listArtifacts(conversationId)` filters historical `DataSwarm Self-Improvement Report` artifacts from the default user-facing artifact list.
- Message artifact chips are filtered against the visible artifact list, so historical internal evaluator artifacts no longer appear in the conversation flow.

Design note:

- Self-improvement remains an internal evaluation signal.
- Future autonomous improvement should run asynchronously from `eval_results`, run events, and trace spans, not as a visible artifact in the chat response.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Real provider smoke:

```json
{
  "eventTypesAbsent": ["artifact.created", "artifact.preview.ready"],
  "eventTypesPresent": ["eval.started", "eval.completed"],
  "finalAssistantParts": ["text"],
  "visibleArtifactTitles": []
}
```

## Markdown, Real Tavily, And Conversation Diagnostics Pass

Completed after reviewing `conv_4aaa59d01a61441eb54bdf3c9772cb1c` and the web-search behavior.

Findings:

- The conversation did select `web-research`.
- It did call `tavily.search`.
- The wrong answer came from `DATASWARM_MOCK_TOOLS=1`, which made Tavily return local mock sources instead of internet results.
- The model correctly refused to treat mock local docs as real news.

Fixes:

- Added safe Markdown rendering for assistant text:
  - headings
  - unordered and ordered lists
  - fenced code blocks
  - bold / italic
  - inline code
  - HTTP/mailto links
- Removed `DATASWARM_MOCK_TOOLS=1` from the default `dev` script.
- Kept mock tools available only through `dev:mock`.
- Added `TAVILY_API_KEY` to local, gitignored `apps/web/.env.local`.
- Confirmed Tavily REST auth against official docs: `Authorization: Bearer [TAVILY_API_KEY]`.
- Added current date context to the orchestrator system prompt and web-search query, using `Asia/Shanghai`.
- Added Tavily execution logs:
  - `tool.tavily.search.start`
  - `tool.tavily.rest.request`
  - `tool.tavily.rest.ok`
  - `tool.tavily.search.completed`
  - `tool.tavily.search.failed`
- Added conversation diagnostics API:
  - `/api/diagnostics/conversations/[id]`
  - summarizes messages, runs, events, skills, tool calls, trace spans, evals, artifacts, and likely mock-search usage
  - reads persisted tool output payloads to distinguish mock/local search from real Tavily output

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Diagnostic smoke for `conv_4aaa59d01a61441eb54bdf3c9772cb1c`:

```json
{
  "hasWebResearch": true,
  "hasTavily": true,
  "likelyUsedMockSearch": true,
  "failures": []
}
```

Real Tavily smoke after restart:

```json
{
  "skill.selected": 1,
  "tool.call.completed": 1,
  "message.part.delta": 37,
  "likelyUsedMockSearch": false
}
```

Page smoke:

```text
page_error=no
markdown_text_present=yes
```

## Multi-Turn Context And Follow-Up Web Research Fix

Completed after the second-turn prompt `继续问，最近一周有什么进展吗` lost prior context and answered as if no previous conversation existed.

Root cause:

- `runOrchestrator` loaded persisted messages but only sent the latest user message to the model.
- Skill routing used only the latest user message, so follow-up phrases could not reliably inherit the previous web-research topic.
- Tavily was briefly given the full recent conversation as the search query, which made real Tavily reject long/complex follow-up queries with HTTP 400.

Fixes:

- Added conversation-history extraction from persisted message parts.
- Added bounded model history:
  - latest 12 user/assistant messages
  - 16k character budget
- Model calls now send:
  - system prompt
  - recent user/assistant history
  - latest user message
  - tool observations attached only to the latest user turn
- The system prompt now explicitly instructs the orchestrator to resolve follow-ups such as `继续`, `上面`, and `最近一周` from prior messages.
- Skill routing now uses a structured routing context:
  - latest user message
  - recent conversation context
- `web-research` can inherit prior web intent only when the latest message is a follow-up.
- `report-generation` now requires an explicit latest-message report intent, avoiding accidental selection from prior Markdown/source text.
- Tavily follow-up queries are compressed into short search phrases, for example:
  - `AI agent past 7 days news developments as of 2026年06月09日星期二`
- Tool trace spans are now marked `failed` when Tavily execution fails, so trace/span diagnostics do not leave failed tools stuck in `started`.
- Added orchestrator logs:
  - `orchestrator.context.loaded`
  - `orchestrator.skills.selected`
  - `orchestrator.model.context_prepared`
- `model.call.started` now records:
  - `model_message_count`
  - `history_message_count`
  - `observation_count`

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

API multi-turn smoke:

```json
{
  "conversationId": "conv_68c0f49439e3406ab99ff4a0ca087644",
  "firstRun": "run_564cd2c69b034db381cb935bc030bd90",
  "secondRun": "run_4c4661e764504b5b8118a70f58dd8501",
  "secondStatus": "completed",
  "secondSkills": ["web-research"],
  "secondToolStatus": ["completed"],
  "secondHasToolCompleted": true,
  "modelMessageCount": 4,
  "historyMessageCount": 2,
  "observationCount": 1,
  "badNoContextComplaint": false
}
```

Browser UI multi-turn smoke:

```json
{
  "enterSubmitWorked": true,
  "assistantAfterSecond": 5,
  "hasNoContextComplaint": false,
  "hasPastWeekAnswer": true,
  "uiObservedStreamingDeltas": true,
  "lastMessageStatus": "completed"
}
```

## Light UI, Prompt Budget, Skills Routing, And Unified Logs Pass

Completed after reviewing the workspace UI, weak multi-turn behavior, visible-but-unclear skills, and fragmented logs/trace diagnostics.

Fixes:

- Reworked the workspace visual theme to a light interface:
  - light sidebar
  - softer workspace background
  - lighter user messages
  - less black/white contrast
- Replaced the static sidebar with a client-side workspace sidebar:
  - `Conversations`
  - `Skills`
  - `Projects`
- `Installed Skills` is collapsed by default.
- The `Skills` panel now exposes the local skill registry and explains that skill selection is recorded as traceable events/spans.
- The `Projects` panel now shows the default project and a staged project roadmap.
- Expanded the orchestrator system prompt into a DataSwarm execution contract:
  - preserve prior conversation as working memory
  - resolve follow-up references
  - summarize actual previous questions when asked
  - use tool/skill/artifact observations as evidence
  - avoid invented sources
- Added explicit model output budget:
  - `DATASWARM_ORCHESTRATOR_MAX_TOKENS`
  - default: `8192`
  - sent as OpenAI-compatible `max_tokens`
- Added selected skills into model observations so the assistant can explain capability usage when relevant.
- Tightened skill routing:
  - routing context now uses latest user text plus recent user messages only
  - assistant output is no longer used for skill matching
  - `latest_user` labels no longer cause accidental web-research matches
  - ordinary memory follow-ups no longer trigger Tavily or data-profiling
- Added persistent unified logs:
  - `app_logs` local table, created without changing the initial migration checksum
  - server logs persist `info/warn/error`
  - UI lifecycle logs persist through `POST /api/logs`
  - high-volume token delta UI logs remain console-only
- Conversation diagnostics now include unified logs.
- Run Trace page now includes a `logs` tab.
- Top-level `agent.run` spans now include:
  - selected skills
  - model history count
  - observation count
  - artifact IDs

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

API smoke for memory follow-up:

```json
{
  "secondStatus": "completed",
  "secondSkills": [],
  "secondTools": [],
  "historyMessageCount": 2,
  "observationCount": 0,
  "maxOutputTokens": 8192,
  "logCount": 35
}
```

Browser smoke:

```json
{
  "sidebarBackground": "rgb(251, 252, 254)",
  "installedCollapsed": true,
  "skillsPanelVisible": true,
  "projectsPanelVisible": true,
  "traceLogsVisible": true,
  "consoleErrors": []
}
```

## Streaming, Tool Cards, Markdown Tables, And Follow-Up Prompts Pass

Completed after reviewing the conversation stream UX where model output appeared as a single block, tool calls were only visible indirectly after final output, Markdown tables rendered as plain text, and assistant answers ended with confirmation-style prompts.

Fixes:

- Server-side model deltas are now split into smaller UI chunks before publishing `message.part.delta`.
- Added a small pacing delay for large upstream chunks so the browser receives visibly progressive text updates.
- Conversation flow now renders runtime activity cards between the user message and assistant answer:
  - selected skills
  - Tavily tool lifecycle
  - model call lifecycle
  - artifact creation lifecycle
- Runtime activity cards work both live through SSE and after refresh from the latest run events.
- Markdown rendering now supports:
  - tables
  - horizontal rules
  - existing headings/lists/code/links/bold/italic/inline-code
- Added deterministic recommended follow-up prompt buttons under assistant responses.
- Clicking a recommended prompt sends it as a new user instruction and starts a new run.
- Strengthened the orchestrator prompt to avoid ending with confirmation requests.
- Added display-layer cleanup for older confirmation-style endings such as `请告诉我...`.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

API smoke:

```json
{
  "conversationId": "conv_ff512c92945545c8b6cff0f2740e1735",
  "runId": "run_2d13f77406df4f688fa0ec5600d9a804",
  "status": "completed",
  "deltaCount": 76,
  "toolTypes": [
    "tool.call.requested",
    "tool.call.started",
    "tool.call.output",
    "tool.call.completed"
  ],
  "modelTypes": [
    "model.call.started",
    "model.call.completed"
  ]
}
```

Browser smoke:

```json
{
  "toolTavilyVisible": true,
  "modelNamedVisible": true,
  "skillCardCount": 2,
  "tableCount": 2,
  "recommendedVisible": true,
  "suggestedButtonCount": 3,
  "noRawTableSeparator": true,
  "confirmationTextCleaned": true,
  "consoleErrors": []
}
```

## Run-Scoped Runtime Cards, Dynamic Suggestions, And Log-Based Product Diagnosis Pass

Completed after reviewing multi-turn conversation regressions where runtime/tool cards were tied to the latest run only, historical cards could disappear or move to the wrong turn, follow-up prompts were too static, and logs were collected but not summarized into product behavior signals.

Fixes:

- Message records now expose `runId` to the web client.
- Home page now loads all run events for the selected conversation, not only the latest run.
- Conversation UI stores runtime activity as `runId -> activity[]`.
- Conversation flow now renders each turn as:
  - user message
  - same-run runtime activity cards
  - same-run assistant response
- Runtime cards share the assistant-side avatar and remain attached to their original historical turn after later turns start.
- Follow-up prompt generation is now topic-aware and uses the latest user/assistant content instead of fixed Hermes-only defaults.
- Message, runtime card, table, code, and status text sizes were normalized to reduce visual jumps.
- UI logs now include `runtime.item.upsert`, `suggestions.rendered`, and run-scoped SSE connect/open/error signals.
- Conversation diagnostics now include `summary.productHealth`, derived from server logs, UI logs, run events, and tool calls.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

Browser smoke:

```json
{
  "conversationId": "conv_fbf4ea3031464247a9837283a6b7c9ba",
  "articleCount": 6,
  "turnPattern": [
    "user",
    "runtime+assistant",
    "user",
    "runtime+assistant",
    "user",
    "runtime+assistant"
  ],
  "suggestions": [
    "打开并检查 Hermes Agent 的 artifact 内容",
    "把 Hermes Agent 报告改成管理层摘要",
    "为 Hermes Agent 生成下一轮验证清单"
  ],
  "consoleErrors": []
}
```

Diagnostics smoke:

```json
{
  "messageCount": 6,
  "runCount": 3,
  "toolNames": [
    "tavily.search",
    "tavily.search",
    "tavily.search"
  ],
  "productHealth": {
    "hasSubmitAccepted": true,
    "hasServerMessageAccepted": true,
    "hasSseOpen": true,
    "hasMessageCompleted": true,
    "hasRuntimeItemRenderSignal": true,
    "hasSuggestionsRenderSignal": true,
    "toolRunCount": 3,
    "renderedToolRunCount": 3,
    "recordedToolCallCount": 3,
    "issues": []
  }
}
```

## Runtime Activity Expansion, Artifact Status Merge, And Smaller Dynamic Follow-Ups Pass

Completed after reviewing artifact cards that kept spinning after a completed run, runtime/tool cards that could not be inspected, and follow-up prompts that still fell back to tool names such as Tavily for short follow-up turns.

Fixes:

- Artifact lifecycle events now use the trace span as the stable runtime card id.
- `artifact.create.started`, `artifact.created`, and `artifact.preview.ready` now merge into one card, so completed artifacts no longer leave stale running cards behind.
- Runtime activity item merging now preserves existing preview/details when later lifecycle events omit those optional fields.
- Tool, skill, model, and artifact cards are collapsed by default.
- Clicking a runtime card expands a detail panel with structured fields and source previews where available.
- Follow-up prompt topic inference now uses recent conversation context, not only the latest short user command.
- Follow-up prompt topic inference filters non-topic tokens such as Tavily, HTML, Markdown, Artifact, and report component names.
- Follow-up buttons and label typography were reduced.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

Browser smoke:

```json
{
  "conversationId": "conv_5e8b6d8ca70a4dc599792f16d2bf5c80",
  "artifactRunningText": [],
  "artifactCompletedCount": 6,
  "visibleSourceLinksBeforeExpand": 0,
  "visibleSourceLinksAfterExpand": 5,
  "suggestions": [
    "预览并检查 英伟达 的 HTML artifact",
    "补齐 英伟达 报告的来源日期与可信度标注",
    "把 英伟达 报告压缩成管理层摘要"
  ],
  "hasTavilySuggestion": false,
  "consoleErrors": []
}
```

## Artifact Quality, Deduplication, Tool Provenance, And Hallucination Review Pass

Completed after reviewing repeated artifacts, weak HTML output, static follow-up prompts, fast-appearing tool cards, and possible fabricated/demo-like model output.

Findings:

- Runtime tool cards are not purely fake UI cards:
  - They are reconstructed from persisted `run_events`.
  - Tavily calls are also persisted in `tool_calls`.
  - Server logs record `tool.tavily.search.start/completed`.
- A reviewed NVIDIA run used real Tavily mode, not mock mode.
- A reviewed OpenAI Agent SDK run also used real Tavily mode, but the returned sources were mostly broad AI Agent industry sources rather than direct OpenAI Agent SDK release/changelog sources.
- The previous report artifact generation was too weak:
  - Markdown/HTML artifacts were generated before the model synthesis completed.
  - HTML artifact content used a static template and could miss the assistant's final reasoning.
  - The model could print raw HTML code in chat, causing artifact content to duplicate or embed escaped HTML blocks.
- Repeated artifact rows were caused by multiple report-generation runs creating the same generic titles.

Fixes:

- Artifacts API now deduplicates by `type + title`, showing the latest artifact for repeated titles while keeping historical rows in SQLite/Trace.
- Report artifacts are now generated after the model response completes.
- Markdown/HTML artifacts now use the model synthesis plus Tavily sources, not only the latest user prompt.
- HTML reports now use a richer report shell with objective, assistant synthesis, source cards, provenance notes, source count, and web-search indicator.
- Raw HTML/CSS blocks are removed from artifact synthesis because DataSwarm owns artifact rendering.
- System prompt now instructs the model not to print raw HTML/CSS code blocks when report-generation is selected.
- Service-side Markdown table conversion to HTML table was added for report artifacts.
- Report titles now prioritize explicit entities such as `OpenAI Agent SDK`, `NVIDIA`, `Hermes Agent`, etc.
- Tavily event payloads now include `execution_mode` and `payload_uri`; expanded tool cards can show real/mock mode and persisted payload evidence.
- Follow-up prompts now first extract concrete recommendations from the assistant's own "recommended/next steps" section before falling back to heuristic templates.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

API smoke:

```json
{
  "dedupedArtifactsForExistingConversation": [
    "DataSwarm Analysis Report HTML",
    "DataSwarm Analysis Report"
  ],
  "rawArtifactRowsStillPreservedInSQLite": true
}
```

Browser/API smoke:

```json
{
  "conversationId": "conv_4af472520ffa4aee822eb5d674a5d7a8",
  "artifactTitles": [
    "OpenAI Agent SDK 分析报告 HTML",
    "OpenAI Agent SDK 分析报告"
  ],
  "eventOrder": [
    "tool.call.requested",
    "tool.call.started",
    "tool.call.output",
    "tool.call.completed",
    "model.call.completed",
    "artifact.create.started",
    "artifact.created",
    "artifact.preview.ready"
  ],
  "tavilyMode": "real",
  "artifactRunning": false,
  "consoleErrors": []
}
```

## Recommended Next Questions Freshness Pass

Completed after reviewing a multi-turn conversation where `Recommended next questions` stayed on the first generic report prompts.

Root cause:

- The UI was refreshing conversation data, but the suggestion builder relied too much on generic fallback templates.
- The latest assistant response often expressed next steps as plain actionable paragraphs, not bullet lists, so they were not extracted.
- Source/date/credibility follow-up turns were routed into the generic `artifact/report/html` fallback, producing repeated prompts such as preview/check/compress.

Fixes:

- Recommendation generation is now latest-turn aware and matches the latest user message to the latest assistant run.
- Historical suggestions from older assistant messages are fingerprinted and suppressed before fallbacks are used.
- Source/date/credibility/first-party-source intents now generate dedicated follow-up prompts.
- Plain actionable lines in recommendation sections are now considered, not only bullets.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

Browser smoke on `conv_4af472520ffa4aee822eb5d674a5d7a8`:

```json
{
  "previousRepeatedPrompts": [
    "预览并检查 OpenAI Agent SDK 的 HTML artifact",
    "补齐 OpenAI Agent SDK 报告的来源日期与可信度标注",
    "把 OpenAI Agent SDK 报告压缩成管理层摘要"
  ],
  "currentLatestTurnPrompts": [
    "用站点限定查询核验 OpenAI Agent SDK 一手来源",
    "把 OpenAI Agent SDK 缺日期来源列入待核验清单",
    "将 OpenAI Agent SDK 报告拆成 v1 基线与 v2 一手来源版"
  ]
}
```
