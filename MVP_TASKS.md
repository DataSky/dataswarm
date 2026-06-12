# DataSwarm MVP Task Plan

> Version: v0.1  
> Date: 2026-06-08  
> Scope: M0-M5 implementation tasks, dependencies, acceptance criteria, test requirements, and out-of-scope guardrails.  
> Current status note: this is a historical MVP task plan. Real E2B sandbox execution and real planner-owned Swarm are not complete as of 2026-06-10; see [DATASWARM_CANONICAL_PLAN.md](./DATASWARM_CANONICAL_PLAN.md).

## 1. MVP Definition

The MVP is complete when a user can:

1. Open a Next.js Web UI.
2. Create a conversation.
3. Send a message to the Orchestrator using DMXAPI.
4. Receive streamed assistant output through SSE.
5. Trigger at least one tool call.
6. Generate and preview Markdown/HTML artifacts.
7. See a complete run trace.
8. Launch at least one E2B sandbox agent.
9. Run a basic Swarm with multiple branches.
10. Receive evaluation summaries and failure summaries.

## 2. Milestone Overview

| Milestone | Name | Outcome |
|---|---|---|
| M0 | Engineering Skeleton | App, storage, schema, local UI shell |
| M1 | Single Agent Streaming | DMXAPI Orchestrator can stream responses |
| M2 | Tools, Skills, Artifacts | Tavily/tool calls, local skills, Markdown/HTML artifacts |
| M3 | Sandbox Agent | E2B sandbox can run a DeepSeek agent and return artifacts |
| M4 | Swarm | Multiple sandbox branches run and merge results |
| M5 | Evaluation and Self-Improvement Seed | Run/artifact/swarm eval and skill draft generation |

## 3. Global Engineering Rules

- Do not hardcode secrets.
- Do not store full secrets in SQLite, logs, events, traces, or artifacts.
- Persist run events before streaming them.
- Store large payloads in local files, not SQLite.
- Use `local://` URIs for files.
- Keep all database and SDK clients lazily initialized.
- Keep terminal/shell execution inside sandbox unless explicitly approved.
- Do not overwrite artifacts; create versions.
- Trace every run.
- Keep Swarm out of M0-M2 except for schema and event protocol readiness.

## 4. M0: Engineering Skeleton

### 4.1 Goal

Create the foundation: app shell, local storage, SQLite schema, seed data, base services, and empty UI surfaces.

### 4.2 Tasks

#### M0.1 Create Project Structure

Deliverables:

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

Acceptance:

- Directory structure matches [ARCHITECTURE.md](./ARCHITECTURE.md).
- Local development app can start.
- No runtime logic is hidden in random top-level files.

Tests:

- Smoke command starts the app.
- Static type check passes when implemented.

#### M0.2 Configure Next.js App

Deliverables:

- Next.js App Router.
- TypeScript.
- Tailwind CSS.
- Base layout with Sidebar, Conversation area, Composer placeholder, Artifact panel placeholder.

Acceptance:

- UI opens locally.
- Empty conversation state renders.
- No model/API call required.
- Layout is usable on desktop and mobile widths.

Tests:

- Playwright smoke: page loads.
- No console errors on initial load.

#### M0.3 Implement Local Storage Bootstrap

Deliverables:

- Create `data/` if absent.
- Create subdirectories:
  - `uploads`
  - `artifacts`
  - `traces`
  - `sandbox-bundles`
  - `emergency-events`

Acceptance:

- App can resolve `local://` URIs internally.
- Atomic write helper exists for artifact/payload files.
- Content hash helper exists.

Tests:

- Unit test local URI resolve.
- Unit test atomic write.
- Unit test content hash.

#### M0.4 Implement SQLite Migration System

Deliverables:

- `schema_migrations`.
- Ordered migrations.
- Initial schema from [SCHEMA.md](./SCHEMA.md).
- Migration runner.

Acceptance:

- Fresh database can be created.
- Re-running migrations is safe.
- Migration checksum is recorded.

Tests:

- Migration test on empty DB.
- Migration idempotency test.

#### M0.5 Seed Default Data

Deliverables:

- `ten_default`
- `usr_local`
- `prj_default`
- model profiles:
  - `dmx:gpt-5.5-1m`
  - `dmx:claude-opus-4-8`
  - `deepseek:deepseek-v4-pro`
  - `deepseek:deepseek-v4-flash`
- Tavily MCP registry entry.
- Built-in tool placeholders.

Acceptance:

- Seed runs once safely.
- Model selector can read seeded profiles.
- No secret values are inserted.

Tests:

- Seed test on empty DB.
- Seed idempotency test.

#### M0.6 Build Core Repositories

Deliverables:

- Conversation repository.
- Message repository.
- Task repository.
- Run repository.
- Run event repository.
- Trace span repository.
- Artifact repository.

Acceptance:

- Repositories hide SQL details.
- All create operations populate tenant/user/project fields.
- All JSON fields validate as JSON before write.

Tests:

- Unit tests for create/list/get.
- JSON field validation tests.

#### M0.7 Build Base API Routes

Deliverables:

- `POST /api/conversations`
- `GET /api/conversations`
- `GET /api/conversations/:id`

Acceptance:

- UI can create and list conversations.
- Conversation detail returns messages and artifact summary.

Tests:

- API integration tests.
- Playwright: create conversation.

### 4.3 M0 Exit Criteria

- App boots.
- SQLite initializes.
- Default data exists.
- Conversation can be created and displayed.
- No model provider required yet.

### 4.4 M0 Out of Scope

- Model calls.
- Tool calls.
- E2B.
- Swarm.
- Full auth.

## 5. M1: Single Agent Streaming

### 5.1 Goal

User sends a message; Orchestrator uses DMXAPI and streams assistant output through persisted SSE events.

### 5.2 Tasks

#### M1.1 Implement ModelProvider Interface

Deliverables:

- Provider abstraction.
- DMXAPI OpenAI-compatible provider.
- Error normalization.
- Streaming support.
- Usage metadata capture if provider returns it.

Acceptance:

- Provider can call `gpt-5.5-1m`.
- Provider can call `claude-opus-4-8`.
- Provider supports streaming deltas.
- Provider never logs API keys.

Tests:

- Mock provider unit tests.
- Optional live smoke tests gated by env vars.

#### M1.2 Implement Model Profile Service

Deliverables:

- List enabled profiles.
- Resolve profile by ID.
- Validate required env var names exist without revealing values.

Acceptance:

- UI model selector displays:
  - `gpt-5.5-1m`
  - `claude-opus-4-8`
  - `deepseek-v4-pro`
  - `deepseek-v4-flash`
- Orchestrator profiles are marked separately from sandbox profiles.

Tests:

- Profile resolution tests.
- Missing env var warning test.

#### M1.3 Implement Runtime Event Bus

Deliverables:

- Event builder.
- Redaction hook.
- Persist-before-stream pipeline.
- Sequence allocation per run.
- In-memory live subscribers for active SSE clients.

Acceptance:

- Event persisted to `run_events` before sent.
- Sequence is monotonic.
- Duplicate event IDs are not generated.

Tests:

- Sequence ordering test.
- Persist failure fallback test.

#### M1.4 Implement SSE Endpoint

Deliverables:

- `GET /api/runs/:id/events`
- `Last-Event-ID` support.
- `from_seq` support.
- Heartbeat.

Acceptance:

- Client receives live events.
- Client reconnects and replays missed events.
- Refreshing page recovers run state.

Tests:

- Integration test replay from seq.
- Integration test duplicate event handling.

#### M1.5 Implement Submit Message API

Deliverables:

- `POST /api/conversations/:id/messages`
- Create user message.
- Create task.
- Create run.
- Start Orchestrator run.
- Return `run_id` and `stream_url`.

Acceptance:

- User message persists.
- Run begins asynchronously.
- Response returns quickly.

Tests:

- API integration test.
- Run creation test.

#### M1.6 Implement Orchestrator AgentSession

Deliverables:

- AgentSession creation.
- Minimal instructions.
- DMXAPI model call.
- Stream assistant text as message parts.
- Persist final assistant message.

Acceptance:

- Assistant streams text into UI.
- Run completes.
- Run failure produces safe error event.

Tests:

- Mock model streaming test.
- Run state transition tests.

#### M1.7 Implement Minimal Trace

Deliverables:

- `agent.run` span.
- `model.call` span.
- Link span IDs to events.
- Payload redaction.

Acceptance:

- Every M1 run has at least two spans.
- Trace can be fetched by run.

Tests:

- Trace span creation test.
- Redaction test.

### 5.3 M1 Exit Criteria

- User can send message.
- Assistant streams response.
- SSE replay works.
- Trace includes run and model call.

### 5.4 M1 Out of Scope

- Tools.
- Skills.
- Artifacts.
- Sandboxes.

## 6. M2: Tools, Skills, Artifacts

### 6.1 Goal

Enable the Orchestrator to select skills, call tools, and generate/preview Markdown/HTML artifacts.

### 6.2 Tasks

#### M2.1 Implement ToolRegistry

Deliverables:

- Tool definition schema.
- Tool executor.
- Permission check.
- Timeout policy.
- Tool call persistence.
- Tool events.

Acceptance:

- Built-in demo tool can be called.
- Tool call card renders.
- Tool errors are structured.

Tests:

- Tool schema validation.
- Timeout test.
- Permission denied test.

#### M2.2 Implement Tavily MCP Tool

Deliverables:

- Tavily MCP config using `TAVILY_API_KEY`.
- Search tool wrapper.
- Extract tool wrapper if supported.
- Source result normalization.

Acceptance:

- Web research task can call Tavily.
- Sources are summarized and linked.
- Actual API key never appears in events/traces.

Tests:

- Mock MCP search.
- Optional live smoke gated by env var.
- Redaction test.

#### M2.3 Implement Skill Discovery

Deliverables:

- Scan local `skills/`.
- Parse `SKILL.md`.
- Parse optional `skill.json`.
- Persist installed skill records.

Acceptance:

- Built-in skills appear in UI.
- Disabled skills are not selected.
- Skill metadata can be read without loading every reference file.

Tests:

- Skill parser test.
- Invalid skill handling test.

#### M2.4 Implement Skill Resolution

Deliverables:

- Candidate scoring by task type, file type, user hints.
- Skill selected/loaded events.
- `skill_usages` persistence.

Acceptance:

- CSV upload triggers data-related skill candidate.
- Web research prompt triggers web research skill.

Tests:

- Skill matching tests.

#### M2.5 Implement Artifact Service

Deliverables:

- Create artifact.
- Create artifact version.
- Save Markdown.
- Save HTML.
- Generate local preview URI.
- List artifacts by conversation.
- Download/preview endpoints.

Acceptance:

- Markdown artifact saves to local store.
- HTML artifact previews in right panel.
- New version does not overwrite old version.

Tests:

- Artifact version test.
- Local URI resolution test.
- Preview endpoint test.

#### M2.6 Add Artifact UI

Deliverables:

- Artifact icon row at assistant message tail.
- Right-side artifact panel.
- Markdown preview.
- HTML preview.
- Artifact metadata display.

Acceptance:

- User can click artifact icon and preview content.
- Panel shows title, type, version, source run.

Tests:

- Playwright artifact open test.

#### M2.7 Integrate Tool Use into Orchestrator

Deliverables:

- Orchestrator can decide to call a tool.
- Tool result returned as structured observation.
- Assistant summarizes result.

Acceptance:

- Web research prompt produces Tavily call and source summary.
- Tool call appears in stream.
- Trace links model -> tool -> assistant summary.

Tests:

- Golden task: Web research.

### 6.3 M2 Exit Criteria

- Tavily tool works.
- Local skills are visible and selectable.
- Markdown/HTML artifacts can be generated and previewed.
- Trace includes tool, skill, artifact spans.

### 6.4 M2 Out of Scope

- E2B.
- Swarm.
- Full report-generation sandbox flow.

## 7. M3: Sandbox Agent

### 7.1 Goal

Run a DeepSeek-powered agent inside E2B, pass it a context bundle, stream events back, and recover Markdown/HTML artifacts.

### 7.2 Tasks

#### M3.1 Design Context Bundle Format

Deliverables:

- `task_contract`
- conversation summary.
- selected message snippets.
- upload/artifact refs.
- skill refs.
- tool policy.
- output contract.

Acceptance:

- Bundle can be serialized to JSON.
- Bundle has content hash.
- Bundle stored under `local://sandbox-bundles/...`.

Tests:

- Bundle builder test.
- Redaction test.

#### M3.2 Implement Sandbox Controller

Deliverables:

- E2B sandbox create.
- Upload context bundle.
- Inject allowed env vars.
- Start sandbox agent.
- Stream sandbox events.
- Close sandbox.

Acceptance:

- Sandbox can be created with template.
- Sandbox closes on run cancellation.
- Sandbox status persists.

Tests:

- Mock E2B controller test.
- Optional live smoke gated by env var.

#### M3.3 Build Sandbox Agent Runtime

Deliverables:

- Reads task contract.
- Uses DeepSeek model profile.
- Emits events.
- Writes trace spans.
- Saves artifacts.
- Exits with status.

Acceptance:

- Sandbox agent can produce `analysis_report.md`.
- Sandbox agent can produce `analysis_report.html`.
- Events are forwarded to parent run.

Tests:

- Local sandbox agent unit tests.
- Mock model test.

#### M3.4 Implement Artifact Recovery

Deliverables:

- Collect artifacts from sandbox.
- Save to local artifact store.
- Create artifact versions.
- Emit artifact events.

Acceptance:

- Markdown/HTML reports generated in sandbox are visible in UI.
- Artifact source trace links to sandbox agent.

Tests:

- Artifact recovery test with fake sandbox output.

#### M3.5 Implement Cancellation Fan-out

Deliverables:

- Cancel run.
- Stop AgentSession.
- Close sandbox.
- Emit terminal events.

Acceptance:

- User can stop sandbox run.
- No orphan sandbox remains after cancellation.

Tests:

- Cancellation test with mock sandbox.

### 7.3 M3 Exit Criteria

- A single E2B sandbox agent can run.
- DeepSeek sandbox model path works.
- Sandbox-generated Markdown/HTML artifacts return to UI.
- Cancellation closes sandbox.

### 7.4 M3 Out of Scope

- Multiple parallel sandboxes.
- Reducer/verifier.
- Self-improvement.

## 8. M4: Swarm

### 8.1 Goal

Enable Orchestrator to split a complex task into multiple sandbox branches, run them in parallel, reduce results, verify outputs, and present branch progress.

### 8.2 Tasks

#### M4.1 Implement Swarm Decision Policy

Deliverables:

- Rule-based trigger:
  - mode is `swarm`
  - user explicitly asks
  - task complexity threshold met
  - report/data analysis requiring branches
- Budget guardrails.

Acceptance:

- Simple chat does not trigger swarm.
- Explicit Swarm mode triggers swarm if budget allows.

Tests:

- Policy tests.

#### M4.2 Implement Task Splitter

Deliverables:

- Map-Reduce splitter.
- Builder-Reviewer-Fixer splitter.
- Branch task contracts.

Acceptance:

- A data report task can split into profiling, analysis, report branches.
- Each branch has expected outputs and tool policy.

Tests:

- Splitter tests.

#### M4.3 Run Parallel Sandbox Branches

Deliverables:

- Create N context bundles.
- Create N E2B sandboxes.
- Start N sandbox agents.
- Stream branch progress.

Acceptance:

- At least 3 branches can run concurrently.
- Branch failures are isolated.
- Parent run can cancel all branches.

Tests:

- Mock parallel branch test.
- Optional live E2B test.

#### M4.4 Build Swarm UI

Deliverables:

- Swarm tree.
- Branch status.
- Branch model/sandbox metadata.
- Branch output summaries.
- Branch errors.

Acceptance:

- User can see each branch state.
- Completed branch shows artifacts.
- Failed branch shows safe error summary.

Tests:

- Playwright swarm state rendering.

#### M4.5 Implement Reducer

Deliverables:

- Reads branch summaries and artifacts.
- Produces merged answer.
- Produces final report outline or final artifact.
- Records evidence mapping.

Acceptance:

- Final answer references branch outputs.
- Failed branches are included in risk notes.

Tests:

- Reducer mock test.

#### M4.6 Implement Verifier

Deliverables:

- Checks merged result.
- Checks artifact presence.
- Checks source trace coverage.
- Emits verifier result.

Acceptance:

- Verifier can pass, warn, or fail.
- Warnings appear in final UI.

Tests:

- Verifier tests.

### 8.3 M4 Exit Criteria

- Swarm runs at least 3 branches.
- UI shows branch progress.
- Reducer creates final result.
- Verifier produces quality summary.
- Trace spans cover swarm.run, swarm.branch, reduce, verify.

### 8.4 M4 Out of Scope

- Complex debate/race strategies.
- Automatic long-term optimization.
- Cloud-scale queue orchestration.

## 9. M5: Evaluation and Self-Improvement Seed

### 9.1 Goal

Create evaluation summaries and begin the self-improvement loop without automatic production mutation.

### 9.2 Tasks

#### M5.1 Implement Run Evaluator

Deliverables:

- Checks task completion.
- Checks promised artifact generation.
- Checks unhandled errors.
- Checks budget overrun.
- Checks trace completeness.

Acceptance:

- Every completed/failed run gets `eval_results` row.
- UI can show eval summary.

Tests:

- Eval tests for passed/failed/warning.

#### M5.2 Implement Artifact Evaluator

Deliverables:

- Markdown/HTML report checks.
- Source trace checks.
- Link/image/chart presence checks.

Acceptance:

- Markdown and HTML artifacts are evaluated.
- Missing required report sections generate warnings.

Tests:

- Artifact fixture tests.

#### M5.3 Implement Swarm Evaluator

Deliverables:

- Branch terminal-state check.
- Reducer evidence check.
- Verifier result check.
- Branch failure risk summary.

Acceptance:

- Swarm run has eval summary.
- Failed branches are not hidden.

Tests:

- Swarm eval fixture tests.

#### M5.4 Implement Failure Classifier

Deliverables:

- Classify provider/tool/sandbox/storage/runtime/policy failures.
- Generate failure summary.
- Link failure to spans/events.

Acceptance:

- Failed run explains likely failure category.
- Failure summary includes next recommended action.

Tests:

- Failure classification tests.

#### M5.5 Implement Skill Draft Generator

Deliverables:

- Read successful run trace.
- Extract reusable workflow.
- Generate `SKILL.md` draft.
- Generate `skill.json` draft.
- Mark skill as `draft`.

Acceptance:

- Successful report-generation run can produce skill draft.
- Draft is disabled until approved.

Tests:

- Skill draft generation test.

### 9.3 M5 Exit Criteria

- Every run gets evaluation result.
- Failures get categorized.
- Successful runs can generate disabled skill drafts.
- No automatic production self-modification occurs.

### 9.4 M5 Out of Scope

- Automatic online prompt mutation.
- Automatic skill enablement.
- Fine-tuning.
- Full historical replay engine.

## 10. Golden Tasks

### 10.1 GT1: Simple Chat

Input:

```text
请用三句话解释 DataSwarm 是什么。
```

Expected:

- No tool call.
- Streamed assistant response.
- `agent.run` and `model.call` spans.
- `run.completed`.

### 10.2 GT2: Web Research

Input:

```text
搜索 Tavily MCP 的官方文档，并总结它适合作为 DataSwarm 默认联网工具的原因。
```

Expected:

- Tavily tool call.
- Source summary.
- Tool card.
- Trace link.

### 10.3 GT3: CSV Profiling

Input:

```text
请分析我上传的 CSV，输出字段、缺失值、异常值和初步洞察。
```

Expected:

- Upload reference.
- Data profiling skill.
- Artifact: `data_profile.json` or Markdown summary.
- No Swarm unless explicitly requested.

### 10.4 GT4: Markdown/HTML Report

Input:

```text
基于这个数据集生成一份分析报告，要求 Markdown 和 HTML 两种格式。
```

Expected:

- Markdown artifact.
- HTML artifact.
- Right panel preview.
- Artifact evaluation.

### 10.5 GT5: Sandbox Report

Input:

```text
在沙箱中完成数据分析并生成 Markdown/HTML 报告。
```

Expected:

- E2B sandbox.
- DeepSeek sandbox model.
- Sandbox events.
- Artifact recovery.

### 10.6 GT6: Swarm Research

Input:

```text
使用 Swarm 模式，从数据质量、趋势洞察、可视化方案三个分支并行分析这个数据集，然后汇总成报告。
```

Expected:

- 3 branches.
- Swarm tree.
- Reducer.
- Verifier.
- Final report.

### 10.7 GT7: Tool Failure

Setup:

- Mock Tavily failure.

Expected:

- Tool failure card.
- Orchestrator fallback or safe explanation.
- Failure trace span.
- Eval warning/failure.

### 10.8 GT8: Approval

Input:

```text
删除这个项目里的旧报告文件。
```

Expected:

- Approval requested.
- Run waits.
- User rejects or approves.
- Decision traced.

## 11. Test Matrix

| Area | Unit | Integration | E2E | Live Smoke |
|---|---|---|---|---|
| SQLite migrations | yes | yes | no | no |
| Repositories | yes | yes | no | no |
| Event bus | yes | yes | yes | no |
| SSE replay | yes | yes | yes | no |
| DMXAPI provider | yes mock | yes mock | yes | gated |
| Tool registry | yes | yes | yes | no |
| Tavily MCP | yes mock | yes mock | yes | gated |
| Artifact service | yes | yes | yes | no |
| E2B controller | yes mock | yes mock | yes | gated |
| Sandbox agent | yes | yes | yes | gated |
| Swarm manager | yes | yes | yes | gated |
| Evaluation | yes | yes | no | no |

## 12. Definition of Done

For any task:

- Code or configuration is implemented.
- Tests are added or explicit reason is documented.
- Trace/event behavior is considered.
- Secret handling is considered.
- Failure behavior is considered.
- UI state for loading/error/empty is considered if user-facing.
- Documentation is updated if behavior changes.

For any milestone:

- All milestone exit criteria pass.
- Golden tasks relevant to that milestone pass.
- No deprecated Opus model alias appears anywhere.
- No real API key appears in committed/generated design docs or code.
- The app can be started locally.

## 13. Implementation Order Recommendation

Strict order:

1. M0.1 Project structure.
2. M0.2 Next.js shell.
3. M0.3 Local storage.
4. M0.4 SQLite migrations.
5. M0.5 Seed data.
6. M0.6 Repositories.
7. M0.7 Conversation APIs.
8. M1.3 Event bus.
9. M1.4 SSE endpoint.
10. M1.1 Model provider.
11. M1.2 Model profile service.
12. M1.5 Submit message API.
13. M1.6 Orchestrator AgentSession.
14. M1.7 Minimal trace.
15. M2.5 Artifact service.
16. M2.6 Artifact UI.
17. M2.1 Tool registry.
18. M2.2 Tavily MCP.
19. M2.3 Skill discovery.
20. M2.4 Skill resolution.
21. M2.7 Tool integration.
22. M3 sandbox work.
23. M4 swarm work.
24. M5 evaluation work.

Rationale:

- Event bus before model run loop makes streaming/replay clean.
- Artifact service before tool integration lets tools produce visible outputs early.
- Sandbox after local tool/artifact flow reduces moving parts.
- Swarm after single sandbox prevents parallel debugging chaos.

## 14. Open Implementation Choices

These choices can be made at coding time:

- Package manager: npm, pnpm, or bun.
- Monorepo tool: plain workspaces first, Turborepo later if needed.
- SQLite library: choose based on Next.js runtime compatibility.
- Migration library: lightweight custom runner or established SQLite migration tool.
- UI component baseline: custom Tailwind primitives or shadcn/ui.
- Whether to use Vercel AI SDK v6 immediately or start with direct OpenAI-compatible HTTP client.

Recommended conservative path:

- Start with direct OpenAI-compatible HTTP client for DMXAPI/DeepSeek.
- Add AI SDK only when the provider/tool-calling shape is confirmed and beneficial.
- Use plain workspaces before adding heavy monorepo orchestration.
