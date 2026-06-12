# DataSwarm Web Workspace

This package contains the DataSwarm Next.js workspace: conversation UI, API routes, SSE streaming, trace pages, settings, artifact previews, and runtime adapters.

For the project-level architecture and roadmap, start with the root [README.md](../../README.md).

## Development

Install dependencies from the repository root:

```bash
npm --prefix apps/web install
```

Create local environment config:

```bash
cp ../../.env.example .env.local
```

For mock/local development, keep:

```bash
DATASWARM_MOCK_MODEL=1
DATASWARM_MOCK_TOOLS=1
DATASWARM_SANDBOX_PROVIDER=mock
DATASWARM_DATA_DIR=../../data
DATASWARM_WORKSPACE_ROOT=../..
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Package Commands

From this directory:

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
```

From the repository root, prefer the workspace aliases:

```bash
npm run dev
npm run build
npm run check
npm run verify:commit
```

## Key Areas

```text
src/app/                  # App Router pages and API routes
src/components/           # Conversation, trace, artifact, settings UI
src/server/runtime/       # Orchestrator, planner, swarm, sandbox runtime
src/server/tools/         # Tool catalog and adapters
src/server/repositories/  # SQLite persistence repositories
src/server/storage/       # Database bootstrap and schema handling
```

## Local State

The web app stores local SQLite data and artifacts through `DATASWARM_DATA_DIR`, which defaults to `../../data` for repository-root execution. Runtime data, `.env.local`, `.next`, and dependencies are intentionally ignored by Git.
