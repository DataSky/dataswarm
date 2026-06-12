# DataSwarm

DataSwarm is an experimental multi-agent swarm system for data production, research, analysis, scientific computing, visualization, report generation, trace diagnosis, and self-improving agent workflows.

The current implementation is a working V2 foundation rather than the final full swarm platform. It includes a Next.js web workspace, SQLite-backed trace/event storage, an agentic runtime loop, model-driven tool actions, skills, artifacts, diagnostics, and gated sandbox execution through E2B-compatible branch agents.

## Current Stage

DataSwarm has moved from the early Manus-like UI/MVP prototype into an Agentic Runtime V2 checkpoint:

- Orchestrator-first conversation entry.
- Structured `AgentAction -> validation -> adapter/tool execution -> Observation -> final answer` loop.
- DMX/OpenAI-compatible model access.
- Tool catalog with web search, trace diagnostics, artifact creation, file/approval foundations.
- Skill manifests and runtime skill observations.
- SQLite persistence for conversations, runs, events, traces, observations, artifacts, evaluations, and settings.
- Artifact preview/download for markdown, HTML, and images.
- Swarm branch protocol with mock/local/E2B provider boundaries.
- E2B readiness diagnostics and sandbox branch agent protocol.
- Trace pages and conversation diagnostics for iterative debugging.

Still in progress:

- Real swarm branch autonomy beyond the current branch protocol.
- Full E2B template lifecycle and production sandbox hardening.
- Stronger artifact schema/catalog-driven rendering.
- More comprehensive self-improvement automation.
- Multi-user, multi-tenant, OSS/S3, Postgres, and OLAP storage evolution.

## Repository Layout

```text
.
├── apps/web/                         # Next.js web app and API routes
├── sandbox/agent/                    # DataSwarm sandbox branch agent
├── sandbox/e2b/                      # E2B template notes and entrypoint
├── scripts/                          # Smoke tests and verification runners
├── skills/                           # Built-in DataSwarm skills
├── packages/                         # Future package boundaries
├── ARCHITECTURE.md                   # Current architecture snapshot
├── SCHEMA.md                         # SQLite/schema reference
├── EVENT_PROTOCOL.md                 # Run event and trace protocol
├── AGENTIC_RUNTIME_V2_DESIGN.md      # Canonical runtime design
├── AGENTIC_LOOP_V2_EXECUTION_PLAN.md # Agentic loop execution plan
├── DATASWARM_CANONICAL_PLAN.md       # Canonical roadmap and gates
└── IMPLEMENTATION_STATUS.md          # Current implementation status
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

For mock/local development, keep:

```bash
DATASWARM_MOCK_MODEL=1
DATASWARM_SANDBOX_PROVIDER=mock
```

Start the development server:

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

## Environment Variables

Use `apps/web/.env.local` for local secrets. Do not commit real keys.

Important variables:

```bash
DATASWARM_DATA_DIR=../../data
DATASWARM_WORKSPACE_ROOT=../..

DMX_BASE_URL=https://www.dmxapi.cn/v1
DMX_API_KEY=

DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=

DATASWARM_SANDBOX_PROVIDER=mock
E2B_API_KEY=
TAVILY_API_KEY=
```

`LLM推理服务相关信息.md`, `.env.local`, `data/`, `.next/`, and dependency/build outputs are intentionally gitignored.

## Verification

Run the standard static checks:

```bash
npm run check
npm run build
```

Recommended checkpoint checks:

```bash
npm run verify:commit
npm run verify:dry
npm run verify:audit
```

Useful focused smoke tests:

```bash
npm run smoke:agentic-v2
npm run smoke:sandbox
npm run smoke:swarm
npm run smoke:swarm-image
npm run smoke:trace-diagnostics
```

E2B-related tests are gated and require explicit local credentials/configuration:

```bash
npm run verify:e2b
npm run verify:e2b:strict
```

## Design Principles

- The Orchestrator is the only user-facing entry point.
- Tools are catalog capabilities, not hard-coded Tavily branches.
- Skills are model-readable strategy/workflow packages, not opaque engineering routes.
- Artifacts are generated and tracked through adapter contracts.
- Run events are the UI and trace truth source.
- Swarm execution is represented as structured actions, observations, branches, and reductions.
- Trace data is treated as the raw material for diagnostics and future self-improvement.

## Documentation Entry Points

Read these in order when reviewing the project:

1. [STAGE_REVIEW_2026_06_12.md](STAGE_REVIEW_2026_06_12.md)
2. [DATASWARM_CANONICAL_PLAN.md](DATASWARM_CANONICAL_PLAN.md)
3. [AGENTIC_RUNTIME_V2_DESIGN.md](AGENTIC_RUNTIME_V2_DESIGN.md)
4. [ARCHITECTURE.md](ARCHITECTURE.md)
5. [EVENT_PROTOCOL.md](EVENT_PROTOCOL.md)
6. [SCHEMA.md](SCHEMA.md)
7. [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)

The earlier Chinese research/design documents are retained as original vision and research baseline:

- [DataSwarm多Agent蜂群体系调研与设计.md](DataSwarm多Agent蜂群体系调研与设计.md)
- [DataSwarm技术设计执行路径与验证方案.md](DataSwarm技术设计执行路径与验证方案.md)

## Versioning

The initial project checkpoint is:

```text
35726a1 chore: initialize DataSwarm project checkpoint
```

Use small, reviewable commits for each implementation phase. Keep runtime data and provider secrets out of Git.
