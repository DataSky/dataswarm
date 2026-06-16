# E2B Branch Agent ReAct V4 Capability Plane

> Date: 2026-06-16
> Status: V4 capability-plane checkpoint implemented; preserved live E2B complex benchmark passed

## Core Decision

DataSwarm V4 treats tools as a shared capability plane instead of a sandbox-only parent proxy detail. The orchestrator, main agent, and E2B sandbox agent should call the same capability contract and produce the same trace evidence:

- capability manifest
- signed branch-scoped invocation
- `tool_call`
- Observation
- artifact provenance
- `capability.invoke.*` event
- compatibility `sandbox.tool_proxy.call.*` event

This directly addresses the failure mode where an E2B sandbox tries to call `host.docker.internal`, fails DNS resolution, and still produces a degraded final report that looks complete.

## Implemented Checkpoint

- Added `apps/web/src/server/runtime/capabilities.ts` as the shared parent capability runtime.
- Added `POST /api/internal/capabilities/invoke`.
- Kept `POST /api/internal/sandbox/tool-proxy` as a compatibility route, backed by the same capability runtime.
- Registered V4 manifest entries for `web.search`, `file.read`, `artifact.create`, and `trace.query`.
- Added `capability_plane_version=dataswarm.capability-plane.v4` into sandbox proxy Observations.
- Emitted `capability.invoke.started/completed/failed` for every parent capability invocation.
- Preserved `sandbox.tool_proxy.call.started/completed/failed` so existing diagnostics and tests still work.
- Updated sandbox jobs to include `capabilityPlane` with `invokeUrl`, allowed capabilities, and manifest.
- Updated the sandbox agent to prefer `capabilityPlane.invokeUrl` and fall back to the legacy proxy URL.
- Changed default `apps/web` dev startup so it no longer hardcodes `host.docker.internal`.
- Added E2B readiness gating for public callback reachability. A real E2B orchestrator run now requires a public proxy/capability URL instead of accepting local-only URLs such as `localhost`, `127.0.0.1`, or `host.docker.internal`.

## 2026-06-16 Checkpoint: action schema alignment for V4 ReAct branch agents

- Updated sandbox action system prompt to align with V4.1 canonical action schema (`thought`, `web.search`, `file.read`, `trace.query`, `artifact.create`, `run_python`, `final`) and clarified that legacy aliases are compatibility only.
- Added explicit parser acceptance guidance for legacy-to-canonical action equivalences (e.g., `thought` -> `think`, `web.search` -> `call_tool` with `toolName=web.search`) to reduce invalid-action noise and improve repair-to-progress behavior.
- Improved repair prompt action vocabulary so repaired outputs return canonical action names expected by V4.1 validation.
- No live validation claim added in this slice; next step is verifying real-model repair/parse behavior under the smoke phase.

## Runtime Contract

Every successful sandbox capability invocation should prove:

- signed proxy token verified
- branch/run/sandbox claims matched
- capability is allowlisted
- `tool_call` persisted
- Observation persisted with branch/sandbox/action provenance
- `capability.invoke.completed` persisted
- `sandbox.tool_proxy.call.completed` persisted for compatibility
- returned response includes `toolCallId`, Observation, payload URI, and capability plane version

Every failed invocation should emit:

- `capability.invoke.failed`
- `sandbox.tool_proxy.call.failed` when called through the sandbox compatibility path
- structured error payload

## Validation Checkpoint

Passed on 2026-06-14:

```text
npm --prefix apps/web run typecheck
python3 -m py_compile sandbox/agent/dataswarm_sandbox_agent.py
node --check scripts/sandbox-tool-proxy-e2e-smoke.mjs
npm --prefix apps/web run lint
node scripts/sandbox-tool-proxy-e2e-smoke.mjs
npm run smoke:sandbox-v3-plus-static
npm run smoke:sandbox-v3-plus-local
npm run smoke:sandbox-v3-plus-real-action
npm run smoke:swarm-verifier
node scripts/e2b-readiness-smoke.mjs
DATASWARM_E2B_ORCHESTRATOR_V3_KEEP_ROWS=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND='ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=5 -R0:localhost:${DATASWARM_LOCAL_PORT} a.pinggy.io' DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS=60000 DATASWARM_E2B_ORCHESTRATOR_V3_E2E_RUN_TIMEOUT_MS=420000 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs
```

Important evidence:

- sandbox tool proxy e2e passed 40/40 checks.
- `web.search`, `artifact.create`, `file.read`, and `trace.query` persisted `tool_call` + Observation.
- Direct `/api/internal/capabilities/invoke` call was verified.
- `capability.invoke.*` event count reached the expected coverage.
- E2B readiness smoke passed 26/26 and now requires a public callback for orchestrator readiness.
- Preserved live E2B complex benchmark passed 25/25.

## Preserved Live Evidence

Conversation: `conv_dfacf3e78ffa4069bf026410ab8b4018`

Run: `run_45753d885cff4261899a8e9f07a5b34b`

Database evidence for the preserved run:

```text
3 completed E2B sandbox sessions
realModelActionCount: 10 / 6 / 10
fallbackActionCount: 0 / 0 / 0
toolCallCount: 2 / 2 / 3
capabilityPlaneVersion: dataswarm.capability-plane.v4 on every branch
capabilityInvokeConfigured: true on every branch
7 completed tool_calls
7 capability.invoke.started events
7 capability.invoke.completed events
7 sandbox.tool_proxy.call.started events
7 sandbox.tool_proxy.call.completed events
1 swarm.reduce event
1 swarm.verify event
4 Markdown artifacts
1 image artifact
```

This checkpoint proves a real E2B swarm, real model actions, capability-proxied parent tools, artifact recovery, post-settlement reduce/verify, and diagnostics reproducibility by `conversationId`.

## 2026-06-15 Checkpoint: trace.query resolution metadata for capability-plane diagnostics

- Parent `trace.query` tool calls now persist `trace_query` resolution metadata on `tool_calls.metadata_json`.
- Capability-plane diagnostics can now distinguish raw model aliases such as `conversation_id=current` from the resolved active `conversationId` used for repository lookup.
- Conversation diagnostics summarizes trace query resolution through `swarmEvidence.traceQueryResolution` and emits remediation if any literal current/active/this id remains unresolved.

Validation status:

- Not validated in this slice.
- This is implementation progress only; parent-proxy smoke and real E2B replay are still required for V4.1 acceptance.
