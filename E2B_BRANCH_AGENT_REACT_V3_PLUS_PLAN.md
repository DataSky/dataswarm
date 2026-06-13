# E2B Branch Agent ReAct V3+ Execution Plan

> Date: 2026-06-14
> Status: V4 Capability Plane checkpoint implemented on 2026-06-14; preserved live complex re-verification passed 25/25
> Scope: upgrade the existing `dataswarm.sandbox-agent.v3` path from a verified bounded-loop sandbox agent into a stricter, evidence-bound E2B Branch Agent runtime.

## 0. Progress Snapshot

Implemented in the first V3+ pass:

- Added a V3-native sandbox action validator.
- Added V3 action handling for `reflect`, `revise_query`, `verify_evidence`, and `request_more_context`.
- Extended `final_answer` handling with `usedObservationIds`, `artifactIds`, `limitations`, and `verifiedBeforeFinal` payload fields.
- Added quality signals for `realModelActionRatio`, `fallbackReasons`, `fallbackPolicyStatus`, `degradedExecution`, `reflectionCount`, `evidenceVerificationCount`, and `contextRequestCount`.
- Updated the local V3 smoke so it executes reflection and evidence verification before final answer.
- Added a local complex benchmark covering research query revision, scientific plotting, Markdown/HTML artifact creation, and scoped context requests.
- Registered the V3+ static, local, real-action, and complex benchmark checks as focused Phase 4 canonical gates.
- Hardened real-model action parsing for Markdown fences, prose-wrapped JSON, nested action envelopes, OpenAI-compatible `tool_calls`, JSON-string arguments, and trailing commas so healthy live runs avoid deterministic fallback.
- Added Swarm branch-plan coverage repair for explicit user deliverables such as requested plots/images or Markdown/HTML reports. This preserves agentic execution by assigning missing branch responsibility in the branch instruction rather than directly invoking tools from engineering code.
- Verified a live E2B-to-parent tool proxy run through a custom HTTPS tunnel command, including three real E2B branches, parent-proxied `web.search`, zero deterministic fallback, and recovered image artifact metadata.
- Expanded `npm run smoke:sandbox-tool-proxy` to verify parent-proxy persistence for `web.search`, `artifact.create`, `file.read`, and `trace.query`, and to assert `tool_call` + `sandbox.proxy.*` observation + `sandbox.tool_proxy.call.*` event linkage for each tool.
- Advanced the V4 upgrade path by converting explicit user branch labels (`分支 A/B/C`, `Branch A/B/C`) into branch-specific instructions, even when the planner copies the full user prompt into every branch instruction. This prevents complex benchmark branch roles from collapsing into generic research/analysis/validation work while preserving model-led action choice inside each branch.
- Removed front-end per-turn manual artifact selection as a required context path. Orchestrator now collects artifact context automatically from prior artifact references and restores artifact-derived context automatically for subsequent turns, so selection is preserved by run state rather than user-side manual toggles.
- Harmonized orchestrator runtime wording and context logic so artifact context is treated as automatic context evidence (no “selected artifact” contract in planning/system prompts), and sandbox provider mode resolution now uses a single source of truth to prevent accidental mock path divergence.
- Hardened the live E2B complex benchmark diagnostics: failure output now summarizes branch completion, reduce, and proxy payloads without dumping large sandbox artifact/base64 content, and `DATASWARM_E2B_ORCHESTRATOR_V3_KEEP_ROWS_ON_FAILURE=1` preserves smoke conversation/run rows for trace/database diagnosis after a failed live run.
- Extended `swarm.verify` to consume branch V3 quality signals and recovered artifact summaries. It now surfaces hidden deterministic fallback as a failed verification condition, degraded fallback as a warning, weak real-model action coverage as a warning, and missing requested image/report artifact types as failures.
- Hardened sandbox action normalization for live model variants: `web_search` / `search_web` normalize to `call_tool` + `web.search`; `action_input`, `parameters`, `sources`, `sourceIds`, and `evidence` fields are lifted into canonical action input fields; artifact-only evidence verification is accepted when a branch is validating a generated artifact.
- Passed the live E2B complex benchmark with three real E2B branches, parent-proxied `web.search` and `artifact.create`, recovered image and Markdown report artifacts, `fallbackActionCount=0`, and post-settlement `swarm.reduce` / `swarm.verify`.

Implemented in the V4 Capability Plane checkpoint:

- Added a shared parent capability runtime and `/api/internal/capabilities/invoke`.
- Kept `/api/internal/sandbox/tool-proxy` as a compatibility route backed by the same runtime.
- Downstream sandbox Observations now include `capability_plane_version=dataswarm.capability-plane.v4`.
- Capability calls emit `capability.invoke.started/completed/failed` and compatibility `sandbox.tool_proxy.call.*` events.
- Sandbox jobs now include `capabilityPlane` manifest/invoke URL, and the sandbox agent prefers `capabilityPlane.invokeUrl`.
- E2B readiness now blocks real orchestrator execution when the callback URL is local-only or missing.
- `apps/web` default `dev` no longer hardcodes `host.docker.internal`.

Verified:

```text
python3 -m py_compile sandbox/agent/dataswarm_sandbox_agent.py
node --check scripts/sandbox-agent-v3-smoke.mjs
npm run smoke:sandbox-v3-plus-static
npm run smoke:sandbox-v3-plus-local
npm run smoke:sandbox-v3
npm run smoke:sandbox-v2
npm run smoke:sandbox-v3-real-action
npm run smoke:sandbox-v3-plus-real-action
npm run smoke:sandbox-v3-plus-complex
node scripts/swarm-action-plan-smoke.mjs
npm run smoke:swarm-verifier
npm run smoke:swarm-parallel
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND='ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=5 -R 80:localhost:${DATASWARM_LOCAL_PORT} serveo.net' DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS=30000 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs
node scripts/canonical-verification-runner.mjs --phase phase4 --only sandbox-v3-plus-static,sandbox-v3-plus-local,sandbox-v3-plus-real-action,sandbox-v3-plus-complex-benchmark --receipt data/verification/canonical-phase4-sandbox-v3-plus-latest.json
```

Still pending:

- Follow-up hardening for the non-blocking Turbopack NFT dynamic tracing warning.
- Optional live internet provider quality gates beyond the parent-proxy contract; the latest complex benchmark used the configured parent `mock.search` provider to prove E2B-to-parent tool-call persistence deterministically.
- Non-blocking: optional live internet provider quality gates beyond the parent-proxy contract.

Latest V4 Capability Plane live proof:

```text
DATASWARM_E2B_ORCHESTRATOR_V3_KEEP_ROWS=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND='ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=5 -R0:localhost:${DATASWARM_LOCAL_PORT} a.pinggy.io' DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS=60000 DATASWARM_E2B_ORCHESTRATOR_V3_E2E_RUN_TIMEOUT_MS=420000 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs
```

Result: 25/25 passed with preserved conversation `conv_dfacf3e78ffa4069bf026410ab8b4018`, run `run_45753d885cff4261899a8e9f07a5b34b`. Evidence includes 3 completed real E2B branches, V4 capability plane quality signals on every branch, 7 completed `tool_calls`, 7 `capability.invoke` completed events, 7 compatibility parent proxy completed events, recovered image artifact, Markdown artifacts, and passed `swarm.reduce` / `swarm.verify`.

## 1. Current Evidence Baseline

The current V3 implementation is not a pure mock path. The following evidence is already present in the repository:

| Capability | Current evidence | Interpretation |
|---|---|---|
| Sandbox ReAct loop | `sandbox/agent/dataswarm_sandbox_agent.py` has `run_v3()` with per-step action proposal, validation, execution, observation creation, artifact manifest, and loop completion events. | Real V3 loop skeleton exists. |
| Model-sourced branch actions | `propose_v3_action()` supports `sandboxModel.mode=real` and records `actionSource=real_model`. | The sandbox model can choose stepwise actions. |
| Fallback visibility | V3 quality signals include `realModelActionCount`, `mockModelActionCount`, `fallbackActionCount`, `modelDrivenReactLoop`, and `parentToolProxyMode`. | Trace can distinguish real model autonomy from fallback/test paths. |
| E2B V3 live proof | `npm run smoke:e2b-v3-real-action` and the live receipt prove real E2B + sandbox-agent v3 + stepwise real-model actions with zero deterministic fallback for the covered scenario. | Real external sandbox execution has been proven for the single-branch gate. |
| Orchestrator-level V3 proof | `npm run smoke:e2b-orchestrator-v3-real-action` verifies parent Orchestrator -> `spawn_swarm` -> real E2B branch sessions -> bridged sandbox events -> branch Observations -> `swarm.reduce` / `swarm.verify`. | The parent can observe and verify V3 branch behavior end to end. |
| Parent tool proxy contract | `npm run smoke:sandbox-tool-proxy` verifies signed token validation, parent tool execution, `tool_calls`, `sandbox.proxy.*` Observations, and proxy events. A live E2B parent-proxy smoke has also passed through a custom HTTPS tunnel command. | The parent-side security and multi-tool persistence contract is real, including `web.search` + `artifact.create` + `file.read` + `trace.query`, and E2B can call back into it when a public URL is supplied. |
| Swarm parallel execution | `executeSwarmBranchesConcurrently()` uses bounded workers and `Promise.allSettled`; `swarm.reduce` occurs after branch settlement. | Swarm is no longer serial in the executor. |
| Branch plan deliverable coverage | `alignSwarmPlanWithObjective()` patches missing branch responsibility for explicit image/plot and report deliverables, and specializes explicit `分支 A/B/C` requirements into matching branch instructions even when those requirements were copied into every model branch. | The runtime preserves user-requested artifact obligations and branch role assignments without directly triggering tools. |
| Swarm V4 verification signals | `swarm.verify` receives branch quality signals and recovered artifact summaries. | Fallback, weak real-model action coverage, and missing requested artifact types are now first-class verification signals rather than hidden metadata. |
| Live complex E2B benchmark | Preserved run `run_38dc09406f9a407a9785d458d464abb8` passed 25/25 checks with parent proxy enabled and a Pinggy HTTPS tunnel. | Real multi-branch E2B execution can complete the complex research/plot/report/reduce/verify gate and can be diagnosed by conversation id. |

## 2. Non-Negotiable Remaining Gaps

Core functional acceptance gates are now met; remaining hardening is non-blocking:

1. **Operator-network dependency for live parent proxy.**
   Real E2B parent-proxy runs still need a reachable public callback URL (`DATASWARM_PUBLIC_BASE_URL`, `DATASWARM_SANDBOX_TOOL_PROXY_URL`, URL file, or tunnel).

2. **Non-blocking build warning.**
   Turbopack still reports a non-blocking NFT warning on the `next.config.ts -> sandbox-tool-proxy` import chain.

3. **Optional real web-quality coverage.**
   Current complex benchmark demonstrates parent-proxy contract via `mock.search`; optional future gates can replace this with live internet provider assertions.

## 3. V3+ Target Definition

V3+ is complete only when a branch can satisfy this contract:

```text
branch objective
-> read scoped context
-> choose a skill policy if useful
-> decide the next action with the sandbox model
-> call parent-proxied tools or run local sandbox code
-> create observations
-> reflect on whether evidence is enough
-> revise search/code/artifact plan when evidence is weak
-> verify evidence before finalizing
-> return a final branch answer with observation/artifact references
-> parent reduce/verify can prove the chain
```

## 4. Protocol Changes

### 4.1 Add V3-Native Action Types

Extend `SandboxAgentAction`:

| Action | Purpose | Required fields |
|---|---|---|
| `reflect` | Assess whether current observations are enough and choose the next gap. | `summary`, `evidenceStatus`, `next` |
| `revise_query` | Rewrite poor or exhausted search queries before another `call_tool`. | `toolName`, `previousQuery`, `newQuery`, `reason` |
| `verify_evidence` | Validate branch claims against observations/artifacts before final answer. | `claims`, `observationIds`, `artifactIds`, `status` |
| `request_more_context` | Ask parent for missing scoped context instead of hallucinating. | `neededContext`, `reason` |
| `final_answer` | Finish with explicit evidence links and limitations. | `answer`, `usedObservationIds`, `artifactIds`, `limitations` |

Keep current actions:

- `think`
- `use_skill`
- `read_context`
- `call_tool`
- `run_python`
- `create_artifact`

### 4.2 Replace V2 Validator

Introduce `validate_v3_action()` with checks for:

- Supported V3 action types.
- Tool allowlist.
- Tool budget.
- Runtime budget.
- `final_answer.usedObservationIds` is present unless no evidence was required.
- `verify_evidence` occurs before `final_answer` for research, report, code, and artifact-producing branches.
- `revise_query` only follows a search/tool observation or explicit low-quality evidence reflection.
- `request_more_context` cannot ask for secrets or unrestricted parent filesystem access.

### 4.3 Fallback Policy

Classify fallback as:

| Fallback reason | Allowed? | Status impact |
|---|---:|---|
| Model temporarily unavailable | Yes | `degraded` |
| JSON parse failed after repair/retry | Yes | `degraded` |
| Budget exhausted | Yes | `partial` |
| Normal planning convenience | No | `failed_verification` |

Quality signals should include:

- `realModelActionRatio`
- `fallbackReasons`
- `degradedExecution`
- `fallbackPolicyStatus`

## 5. Parent Tool Proxy Completion

V3+ must prove a live E2B sandbox can call the parent tool proxy.

Required runtime configuration:

```text
DATASWARM_SANDBOX_PROVIDER=e2b
DATASWARM_SANDBOX_AGENT_PROTOCOL=dataswarm.sandbox-agent.v3
DATASWARM_SANDBOX_AGENT_MODEL=real
DATASWARM_SANDBOX_TOOL_PROXY=parent
DATASWARM_PUBLIC_BASE_URL=<public-url-reachable-from-e2b>
# or
DATASWARM_SANDBOX_TOOL_PROXY_URL=<public-url-reachable-from-e2b>/api/internal/sandbox/tool-proxy
# dev-only smoke fallback:
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_AUTOTUNNEL=localtunnel
# or any command that prints an HTTPS tunnel URL:
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND="<your tunnel command>"
```

The production runtime can also read a proxy URL dynamically from
`DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE` or
`DATASWARM_PUBLIC_BASE_URL_FILE`. The parent-proxy smoke uses this for
server-first tunnel providers: it starts the Next.js server, opens the tunnel,
writes the public proxy URL to `data/e2b/parent-proxy-url.txt`, and only then
submits the swarm request so branch jobs receive the live callback URL.

Expected proof:

- `swarm.branch.started.payload.sandbox_tool_proxy.mode = parent`
- `swarm.branch.started.payload.sandbox_tool_proxy.url_configured = true`
- E2B emits `sandbox.agent.tool.requested`
- Parent persists `sandbox.tool_proxy.call.started`
- Parent persists completed `tool_calls`
- Parent creates `source_name=sandbox.proxy.web.search` Observation
- E2B receives proxy response and emits `sandbox.agent.tool.completed`
- Branch Observation metadata references parent observation/tool call.

## 6. Evidence-Bound Branch Final

Every branch final should be structured:

```json
{
  "answer": "branch conclusion",
  "usedObservationIds": ["sbo_v3_02_tool", "obs_parent_..."],
  "artifactIds": ["art_..."],
  "limitations": ["public tool proxy returned only 3 sources"],
  "verification": {
    "status": "passed",
    "unsupportedClaims": [],
    "sourceCoverage": 0.9,
    "artifactCoverage": 1.0
  }
}
```

Parent reduce should consume this structure instead of treating branch markdown as the only source of truth.

## 7. Verification Gates

### 7.1 Static Gate

Checks:

- `validate_v3_action()` exists.
- `validate_v2_action()` is not the V3 primary validator.
- V3 action schema includes `reflect`, `revise_query`, `verify_evidence`, `request_more_context`.
- Fallback policy emits `degradedExecution` when fallback occurs.
- Event protocol documents new action and verification payloads.

### 7.2 Local Sandbox V3+ Gate

Mock-action model, no external E2B:

- At least 6 action steps.
- Includes `read_context`, `call_tool`, `reflect`, `verify_evidence`, `final_answer`.
- `fallbackActionCount = 0`.
- Final answer includes `usedObservationIds`.
- Artifact manifest references local sandbox observation IDs.

### 7.3 Real Model Sandbox Gate

OpenAI-compatible local or real model endpoint:

- `realModelActionCount >= 4`.
- `realModelActionRatio >= 0.8`.
- `fallbackActionCount = 0`.
- Model chooses at least one nontrivial action after reading observations.

### 7.4 Live E2B Parent Proxy Gate

Real E2B + public parent URL:

- At least one branch calls `web.search` through the parent proxy.
- Parent persists proxy events, `tool_calls`, and `sandbox.proxy.*` Observation.
- Sandbox receives the proxy response and continues the loop.
- Receipt records public proxy URL redacted, sandbox id, tool call id, observation id, and branch id.

### 7.5 Complex Task Benchmark Gate

Run at least four benchmark tasks:

| Task | Required evidence |
|---|---|
| Web research | Multiple queries or query revision, parent-proxied web observations, source coverage. |
| Scientific plot | `run_python`, image artifact, artifact preview recovery. |
| Report generation | Markdown + HTML artifacts with observation provenance. |
| Multi-branch swarm | 3+ branches, independent traces, all-settled-before-reduce, deterministic verify. |

The live E2B complex benchmark is registered as canonical Phase 4 gate
`e2b-branch-complex-benchmark` and runs:

```text
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 \
DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1 \
node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs
```

It requires a parent proxy URL reachable from E2B. When live, it asserts that:

- three real E2B branch sessions complete with `dataswarm.sandbox-agent.v3`;
- parent-proxied `web.search` calls reach the parent runtime;
- at least one branch records `reflect` and `verify_evidence`;
- query revision occurs, or the branch performs multiple parent-proxy searches;
- image artifact recovery works for the scientific plotting branch;
- Markdown/HTML or multiple durable report artifacts are recovered;
- `swarm.reduce` and `swarm.verify` run after branch settlement.

Latest preserved live result: passed on 2026-06-13 with conversation
`conv_20f646bee6f341a0ac2cc8824b860980` and run
`run_38dc09406f9a407a9785d458d464abb8` using a Pinggy tunnel command.
The run proved branch-specific A/B/C assignment, three real E2B sandbox sessions,
stepwise `real_model` actions with zero deterministic fallback, parent-proxied
`web.search` and `artifact.create`, one recovered image artifact, recovered
Markdown report artifacts, and passing post-settlement `swarm.verify`.

## 8. Canonical Verification Additions

Add new Phase 4 gates:

```text
sandbox-v3-plus-static
sandbox-v3-plus-local
sandbox-v3-plus-real-action
sandbox-v3-plus-complex-benchmark
e2b-orchestrator-v3-parent-proxy
e2b-branch-complex-benchmark
```

Strict completion should require:

```text
node scripts/canonical-verification-runner.mjs \
  --phase phase4 \
  --only e2b-orchestrator-v3-parent-proxy,e2b-branch-complex-benchmark \
  --require-live-e2b
```

## 9. Implementation Order

1. Add V3 action schema and validator.
2. Add `reflect`, `revise_query`, `verify_evidence`, and `request_more_context` execution handlers.
3. Add final-answer evidence contract.
4. Add fallback degradation policy and quality signals.
5. Add local V3+ smoke.
6. Add real-model V3+ smoke.
7. Complete live E2B parent proxy callback gate.
8. Add and pass the live complex benchmark gate.
9. Update Run Trace and conversation diagnostics to surface V3+ quality signals.
10. Update canonical verification receipts and status docs.

## 10. Completion Definition

The E2B Branch Agent ReAct V3+ objective is complete only when current evidence proves:

- Real E2B branches can run `dataswarm.sandbox-agent.v3`.
- Branch steps are primarily selected by the sandbox model.
- Deterministic fallback is absent in healthy runs and marked degraded when used.
- Live E2B can call the parent tool proxy over a reachable URL.
- Branch finals cite observations and artifacts.
- Parent reduce/verify can inspect branch evidence rather than trusting prose.
- Complex benchmark tasks pass with current live evidence.
- Trace diagnostics can answer whether a given conversation used real E2B, real model actions, parent-proxied tools, and recovered artifacts.
