# DataSwarm

DataSwarm is an experimental multi-agent swarm runtime for research, data production, analysis, visualization, report generation, trace diagnosis, and eventually self-improving agent workflows.

The project started from a "Manus-like workspace + AI coding/runtime" vision and is now being consolidated around **Agentic Runtime V2**: a planner-led Orchestrator, structured actions, validated tool adapters, durable observations, artifacts, trace data, and swarm branches that can run locally or in E2B-compatible sandboxes.

## Current Stage

DataSwarm is not yet the final full swarm platform. It is a working V2 foundation with a growing verification suite.

| Area | Status | Notes |
|---|---|---|
| Web workspace | Real | Next.js UI, conversation stream, runtime cards, artifact drawer, trace pages, settings |
| Runtime loop | Real | `AgentAction -> validate -> adapter -> Observation -> final answer` |
| Model access | Real | DMX/OpenAI-compatible orchestrator profiles, including `claude-opus-4-8` and `gpt-5.5-1m` |
| Tool catalog | Real | Generic tool capabilities with provider/auth/risk/schema metadata |
| Web search | Real/mock-gated | `web.search` is the model-facing capability; Tavily is one provider behind it |
| Trace diagnostics | Real | `trace.query`, conversation diagnostics, runtime consistency checks |
| Artifacts | Real/expanding | Markdown, HTML, image preview, content-hash de-dupe |
| Skills | Partial/managed | Local skill registry, enable/disable/install/update, model-visible manifests |
| Swarm | Planner-owned mock/local + gated E2B | `spawn_swarm`, branch traces, reducer/verifier/reviewer, sandbox artifact recovery |
| E2B | Gated real path | SDK/template/readiness/live-smoke contracts exist; real execution requires local credentials and template verification |
| Self-improvement | Partial async loop | Candidate generation and trace operations exist; automatic source patching is intentionally deferred |

## Architecture At A Glance

```text
User message
  -> Orchestrator planner model
  -> structured AgentAction
  -> runtime validation and policy checks
  -> tool / skill / artifact / swarm adapter
  -> durable Observation + RunEvent + Trace span
  -> replanning, reflection, final answer, or artifact output
```

Core rules:

- The Orchestrator is the only user-facing entry point.
- The model chooses actions; engineering code validates, executes, and records.
- Tools are catalog capabilities, not hard-coded Tavily branches.
- Skills are model-readable strategy/workflow packages, not hidden routers.
- Artifacts are created through adapter contracts and de-duped by content hash.
- Run events are the UI and trace truth source.
- Swarm branches are structured actions/observations, not static side paths.
- Mock execution must be explicit in trace/evidence metadata.

## Repository Layout

```text
.
├── apps/web/                         # Next.js workspace and API routes
├── packages/                         # Future shared package boundaries
├── sandbox/agent/                    # DataSwarm sandbox branch agent
├── sandbox/e2b/                      # E2B template contract and entrypoint
├── scripts/                          # Verification, smoke, audit, and E2B scripts
├── skills/                           # Built-in DataSwarm skills
├── ARCHITECTURE.md                   # Current architecture snapshot
├── EVENT_PROTOCOL.md                 # Run event and trace protocol
├── SCHEMA.md                         # SQLite/schema reference
├── AGENTIC_RUNTIME_V2_DESIGN.md      # Canonical runtime design
├── AGENTIC_LOOP_V2_EXECUTION_PLAN.md # Agentic loop execution plan
├── DATASWARM_CANONICAL_PLAN.md       # Roadmap and verification gates
├── IMPLEMENTATION_STATUS.md          # Current implementation status
└── STAGE_REVIEW_2026_06_12.md        # Stage review and reset notes
```

## Quick Start

Install dependencies:

```bash
npm --prefix apps/web install
```

Create local environment config:

```bash
cp .env.example apps/web/.env.local
```

For local development without provider keys, keep the mock settings:

```bash
DATASWARM_MOCK_MODEL=1
DATASWARM_SANDBOX_PROVIDER=mock
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Production-style local run:

```bash
npm run build
npm --prefix apps/web run start -- -p 3000
```

## Environment

Use `apps/web/.env.local` for local secrets. Do not commit provider keys.

Important variables:

```bash
DATASWARM_DATA_DIR=../../data
DATASWARM_WORKSPACE_ROOT=../..

DATASWARM_MOCK_MODEL=1
DATASWARM_MOCK_TOOLS=1

DMX_BASE_URL=https://www.dmxapi.cn/v1
DMX_API_KEY=

DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=

DATASWARM_SANDBOX_PROVIDER=mock
DATASWARM_WEB_SEARCH_PROVIDER=tavily
TAVILY_API_KEY=

E2B_API_KEY=
DATASWARM_E2B_TEMPLATE=dataswarm-agent-runtime
DATASWARM_E2B_TEMPLATE_VERIFIED=
DATASWARM_E2B_TEMPLATE_BUILD_ID=
```

Ignored local state and secrets include `.env.local`, `.env.*`, `data/`, `apps/web/.next/`, `apps/web/node_modules/`, and `LLM推理服务相关信息.md`.

## Common Commands

```bash
npm run dev                 # Start Next.js dev server
npm run build               # Build production bundle
npm run check               # Typecheck + lint
npm run verify:commit       # Fast commit gate
npm run verify:dry          # Canonical gate dry run
npm run verify:audit        # Canonical goal audit
npm run smoke:agentic-v2    # Runtime V2 static/product smoke
npm run smoke:swarm-image   # Swarm image artifact E2E smoke
npm run smoke:trace-diagnostics
```

E2B gates are explicit because they require local credentials and template evidence:

```bash
npm run verify:e2b
npm run verify:e2b:strict
```

## Documentation Map

Read these in order when reviewing the project:

1. [STAGE_REVIEW_2026_06_12.md](./STAGE_REVIEW_2026_06_12.md)
2. [DATASWARM_CANONICAL_PLAN.md](./DATASWARM_CANONICAL_PLAN.md)
3. [AGENTIC_RUNTIME_V2_DESIGN.md](./AGENTIC_RUNTIME_V2_DESIGN.md)
4. [AGENTIC_LOOP_V2_EXECUTION_PLAN.md](./AGENTIC_LOOP_V2_EXECUTION_PLAN.md)
5. [ARCHITECTURE.md](./ARCHITECTURE.md)
6. [EVENT_PROTOCOL.md](./EVENT_PROTOCOL.md)
7. [SCHEMA.md](./SCHEMA.md)
8. [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)

Original vision and research baseline:

- [DataSwarm多Agent蜂群体系调研与设计.md](./DataSwarm多Agent蜂群体系调研与设计.md)
- [DataSwarm技术设计执行路径与验证方案.md](./DataSwarm技术设计执行路径与验证方案.md)

## Roadmap

Near-term implementation is tracked in [DATASWARM_CANONICAL_PLAN.md](./DATASWARM_CANONICAL_PLAN.md):

1. Stabilize Runtime V2 product behavior and event consistency.
2. Make Skills V2 fully model-readable, inspectable, and verifiable.
3. Generalize tools and observations beyond any single provider.
4. Promote Swarm V2 from local/mock branch protocol to stronger branch autonomy.
5. Harden the E2B sandbox path with template lifecycle, heartbeat, cancel, retry, and artifact recovery.
6. Build trace-driven self-improvement as an async review-gated workflow.

## Git And Checkpoints

Use small, reviewable commits for each implementation slice. Keep runtime data and provider secrets out of Git.

The initial public checkpoint was:

```text
35726a1 chore: initialize DataSwarm project checkpoint
```

The repository remote is expected to be:

```text
https://github.com/DataSky/dataswarm
```
