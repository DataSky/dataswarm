# DataSwarm Stage Review and Forward Plan

> Date: 2026-06-12  
> Stage checkpoint base: `71f02e7 docs: add root README`  
> Scope: align the original multi-agent swarm vision, the current Agentic Runtime V2 implementation, and the next execution path.

## 1. Executive Review

DataSwarm has moved well beyond the early Manus-like UI prototype. The current repository contains a working local-first Agentic Runtime V2 stack:

- Next.js workspace and API routes.
- SQLite persistence for conversations, runs, events, traces, observations, artifacts, evaluations, approvals, settings, skills, and self-improvement candidates.
- Planner-owned `AgentAction` loop with tool, skill, artifact, approval, trace, and swarm actions.
- Tool catalog abstraction with generic `web.search` and provider-specific Tavily/mock adapters.
- Skills V2 manifests and local skill management.
- Swarm execution path with branch events, sandbox agent protocol, reducer, verifier, reviewer, and artifact recovery.
- E2B readiness gates, template receipts, live smoke receipt support, and a sandbox branch agent.
- Trace/diagnostics/self-improvement foundations.
- Root Git checkpoint and GitHub remote: [DataSky/dataswarm](https://github.com/DataSky/dataswarm).

The project is not yet the full original "real multi-agent swarm platform". It is best described as:

```text
Agentic Runtime V2 foundation + local/e2b-gated sandbox branch execution
+ trace/eval/self-improvement infrastructure
+ product UI still in consolidation
```

The next phase should emphasize operational truth, reproducible verification, product coherence, and real swarm hardening. The most important shift is to separate three types of claims:

1. **Repository-proven**: source code and checked-in docs prove the capability shape.
2. **Local-runtime-proven**: ignored `data/` receipts and local credentials prove the capability on this machine.
3. **Deferred/gated**: architecture exists, but production-grade behavior is not yet proven.

This distinction is essential because many existing status documents accurately reflect local progress but overstate what a fresh clone can independently verify.

## 2. Evidence Used

Current-state evidence inspected:

- Git status and remote state:
  - local `main` tracks `origin/main`
  - latest remote commit at review start: `71f02e7`
- Static verification:
  - `npm run typecheck` passed
  - `npm run lint` passed
- Canonical verification:
  - `node scripts/canonical-goal-audit.mjs` passed locally with ignored receipt files under `data/`
  - `node scripts/canonical-verification-runner.mjs --dry-run` listed 42 gates
  - `node scripts/sandbox-agent-smoke.mjs` passed 26/26 checks
- Key documents:
  - `DATASWARM_CANONICAL_PLAN.md`
  - `AGENTIC_RUNTIME_V2_DESIGN.md`
  - `IMPLEMENTATION_STATUS.md`
  - `ARCHITECTURE.md`
  - `EVENT_PROTOCOL.md`
  - `SCHEMA.md`
  - original Chinese research and execution-design docs
- Key runtime modules:
  - `apps/web/src/server/runtime/orchestrator.ts`
  - `apps/web/src/server/runtime/planner.ts`
  - `apps/web/src/server/runtime/swarm.ts`
  - `apps/web/src/server/runtime/sandbox-provider.ts`
  - `apps/web/src/server/tools/registry.ts`
  - `apps/web/src/server/repositories/*`
  - `sandbox/agent/dataswarm_sandbox_agent.py`
- Product surfaces:
  - conversation workspace
  - run trace page
  - settings page
  - skills/projects/conversation management APIs
  - artifact preview/download APIs

## 3. Original Vision vs Current Reality

### 3.1 Original Vision

The original design aimed for a complete 0-to-1 multi-agent swarm system:

- A main Orchestrator as the single user entry.
- Agentic model reasoning with skills and tool calling.
- Swarm behavior for complex tasks.
- E2B sandbox branches running agent instances.
- Data production, analysis, insight, scientific computing, causal inference, visualization, and report generation.
- Manus-like Web UI with conversations, projects, skills, artifacts, and trace visibility.
- User-extensible skills.
- Tavily or equivalent web access as a default capability.
- Comprehensive trace collection for self-improvement.
- Long-term storage evolution from SQLite to Postgres/OLAP, local artifacts to OSS/S3, and single-user local mode to multi-user/multi-tenant mode.

### 3.2 Current Reality

The current implementation satisfies the architectural direction but not the full product depth:

| Area | Current State | Review |
|---|---|---|
| Orchestrator | Real single entry path | Aligned with vision. |
| Agentic loop | Real V2 action/observation loop | Strong foundation; needs more adversarial runtime tests. |
| Tool catalog | Real catalog with web/search/trace/file/artifact/approval | Correct abstraction; still early provider ecosystem. |
| Skills | Local V2 manifests and management | Good baseline; needs stronger quality scoring and marketplace/install UX. |
| Swarm | Planner-owned branch protocol with reducer/verifier/reviewer | Strong bridge; not yet full autonomous distributed agent swarm. |
| E2B | Gated real provider, readiness, receipts | Good boundary; production reliability still pending. |
| Artifacts | Markdown/HTML/image preview, de-dupe | Functional but needs schema/catalog-driven rendering and richer report generation. |
| Trace | Deep event/diagnostic foundation | Strongest differentiator; should become first-class product and skill surface. |
| UI | Usable workspace, trace, artifacts, settings | Needs consolidation, polish, and stronger state consistency. |
| Self-improvement | Async candidates and review gates | Correct safety model; source patch automation intentionally deferred. |
| Storage | SQLite/local artifacts | Correct for current phase; migration path should be explicit but not implemented yet. |

## 4. Key Findings

### Finding 1: Documentation Is Rich But Over-Optimistic

`IMPLEMENTATION_STATUS.md` records many successful local runs, including live E2B claims. Those claims depend on ignored `data/` receipts and local secrets. That is valid local evidence but not repository-verifiable evidence.

Required correction:

- Keep local receipt evidence explicit.
- Add a repository-level phase review document, this file, that separates source-proven and local-runtime-proven states.
- Make future status updates summarize current truth instead of appending long historical logs as if they are all globally reproducible.

### Finding 2: The Core Runtime Direction Is Correct

The project has already moved past the earlier engineering-routed tool problem. The current target is correctly centered on:

```text
model action -> validation -> adapter -> observation -> replan/final
```

This should remain the canonical runtime. No future feature should reintroduce hidden keyword routing as the primary decision maker.

### Finding 3: Trace Is The Product's Strategic Backbone

Trace is not just debugging. It is the foundation for:

- session diagnosis
- failed-run attribution
- tool/skill quality scoring
- self-improvement candidate generation
- replay/evaluation
- future user-facing run intelligence

Trace should become a product area with its own tools, skills, UI pages, and verification gates.

### Finding 4: Artifact Quality Is A Core Product Gap

Artifacts currently work technically, including HTML/image preview and content hash de-dupe. But the original vision requires high-quality analysis/report outputs.

Missing pieces:

- artifact schema/catalog beyond raw `markdown/html/image`
- source observation lineage per artifact section
- report template registry
- structured visualization outputs
- artifact quality checks
- clear separation of inline answer vs durable deliverable

### Finding 5: Swarm Is A Protocol Foundation, Not Yet A Full Swarm Product

The branch protocol, reducer, verifier, reviewer, and E2B boundary are valuable. However, the real swarm vision also needs:

- branch-level tool policies
- branch-specific memory/context budgets
- branch cancellation/retry UX
- branch result comparison and conflict exploration
- agent tree/timeline UX as a normal product surface
- reducer/verifier quality scoring beyond deterministic checks

### Finding 6: UI Has Grown By Accretion

The UI now includes conversations, runtime cards, artifacts, trace, improvements, settings, skills, projects, and management actions. It works, but product boundaries need simplification:

- conversation workspace should stay focused on the task stream
- trace should own runtime internals
- artifacts should own durable outputs
- settings should own system readiness and dangerous maintenance operations
- skills/projects need real product flows, not just navigation labels

### Finding 7: Verification Exists, But Needs Tiering

The project has many smoke scripts. They are useful, but developers need a smaller staged contract:

- **Tier A: commit gate**: fast static and unit smoke.
- **Tier B: local product gate**: self-started API/UI smoke with mock providers.
- **Tier C: external integration gate**: E2B/live provider smoke.
- **Tier D: completion audit**: full canonical goal audit.

Without tiers, verification becomes either too expensive to run often or too easy to skip.

## 5. New Planning Model

The project should move through seven checkpointed tracks.

### Track 0: Governance and Checkpoint Discipline

Goal: every meaningful phase has a git checkpoint and a reproducible validation statement.

Deliverables:

- root README and stage review documents
- root npm scripts for common verification commands
- checkpoint naming convention
- source-controlled phase status matrix
- ignored runtime receipts clearly documented

Validation:

```bash
git status --short --branch
npm run typecheck
npm run lint
npm run verify:dry
npm run verify:audit
```

### Track 1: Runtime Truth and Evidence Contracts

Goal: final answers, runtime cards, trace pages, and diagnostics derive from the same event/observation truth.

Deliverables:

- stricter evidence guard for final answers
- action/observation/run-event cross-link checks
- stale/running event repair checks
- conversation-level diagnostics summary in UI
- trace-query skill promoted as first-class built-in capability

Validation:

```bash
npm run smoke:agentic-v2
npm run smoke:tool-contract
npm run smoke:trace-diagnostics
```

### Track 2: Artifact V2

Goal: artifacts become structured, high-quality durable outputs rather than side effects.

Deliverables:

- artifact schema: `artifactKind`, `contentHash`, `previewMode`, `sourceObservationIds`, `qualitySignals`
- artifact catalog and renderer registry
- unified preview/source/open-in-new-window pattern
- report-generation templates for research summary, management brief, analysis report, and visualization notebook
- artifact duplication audit

Validation:

```bash
npm run smoke:artifact
npm run smoke:sandbox-agent
npm run build
```

### Track 3: Skills and Projects Productization

Goal: skills and projects become real management surfaces tied to runtime behavior.

Deliverables:

- skill detail pages or panels
- enable/disable/install/update flows with validation
- skill contribution metrics from observations
- project-scoped conversations and artifacts
- project settings and defaults

Validation:

```bash
npm run smoke:skills
npm run smoke:skills-e2e
```

### Track 4: Swarm V2 Productization

Goal: make branch execution inspectable, interruptible, and quality-scored.

Deliverables:

- branch tree/timeline product view
- branch policy metadata
- branch artifact grouping
- branch-level failure and retry UI
- reducer/verifier quality explanations
- conflict and source coverage reporting

Validation:

```bash
npm run smoke:swarm
npm run smoke:swarm-trace
```

### Track 5: Real Sandbox/E2B Hardening

Goal: move from gated real E2B evidence to reliable operator-ready sandbox execution.

Deliverables:

- template version registry
- sandbox health and heartbeat dashboard
- sandbox artifact recovery audit
- timeout/cancel/retry metrics
- real sandbox branch test with image/report artifacts
- no fallback-to-mock ambiguity

Validation:

```bash
npm run verify:e2b
npm run verify:e2b:strict
```

### Track 6: Self-Improvement as Review-Gated Workflow

Goal: turn trace failures into safe, reviewable improvements.

Deliverables:

- failure classification taxonomy
- candidate prioritization
- prompt/skill/tool/UI candidate templates
- shadow-test harness
- human approval flow
- applied receipt verification

Validation:

```bash
npm run smoke:self-improvement
npm run verify:audit
```

## 6. Immediate Execution Plan

The next implementation checkpoints should be:

### Checkpoint A: Repository Governance and Verification Scripts

Status: in progress.

Tasks:

- Add this stage review document.
- Add root npm aliases for common verification tiers.
- Link this document from README.
- Commit and push.

### Checkpoint B: Documentation Truth Reset

Tasks:

- Update `IMPLEMENTATION_STATUS.md` top section to distinguish:
  - repository-proven
  - local-runtime-proven
  - gated/deferred
- Add a short "receipt evidence is local and gitignored" warning to canonical docs.
- Keep long historical logs below a clear archive marker.

### Checkpoint C: Verification Tiering

Tasks:

- Add canonical script aliases:
  - `verify:commit`
  - `verify:local`
  - `verify:e2b`
  - `verify:audit`
- Ensure each tier writes or references a receipt.
- Add a short verification section to README and stage review.

### Checkpoint D: Artifact V2 First Slice

Tasks:

- Add an artifact quality checker smoke script.
- Verify image/report artifact presence when requested.
- Add artifact lineage display in artifact drawer.
- Improve artifact duplicate diagnostics.

### Checkpoint E: Trace Diagnosis First-Class Surface

Tasks:

- Add conversation diagnosis summary card or page entry.
- Promote `trace-diagnostics` skill in UI.
- Add "diagnose this conversation" action from conversation header or trace page.

## 7. Current Risk Register

| Risk | Severity | Evidence | Mitigation |
|---|---:|---|---|
| Docs overstate fresh-clone reality | High | Local receipts are ignored but status claims cite them | Split repository vs local-runtime evidence. |
| UI state drift during SSE/routing | High | Prior repeated user reports | Keep event source as truth, add replay/resync checks. |
| Artifact quality below product expectation | High | Reports/HTML often simple or duplicated | Artifact V2 schema/catalog/templates. |
| Swarm still partly protocol/demo-like | Medium | Branch protocol exists; full autonomy still evolving | Productize branch policies, quality scoring, and branch UI. |
| E2B evidence depends on local secrets/receipts | Medium | Valid but not portable | Keep gated integration tier and secret-safe receipts. |
| Verification suite is large and hard to choose | Medium | 42 canonical gates | Add tiered npm aliases and docs. |
| Self-improvement can become noisy | Medium | Candidate generation exists | Keep review gates and improve taxonomy. |

## 8. Definition of Done For The Current Goal

This active goal should not be marked complete until all of the following are true:

- Git checkpoint exists and is pushed.
- Stage review and forward plan exist in the repository.
- README points to the current stage review.
- Verification aliases exist for routine checks.
- At least one concrete implementation improvement beyond documentation is committed.
- `typecheck`, `lint`, `verify:dry`, `verify:audit`, and at least one runtime smoke pass after the changes.
- The final response clearly reports:
  - checkpoint commit
  - pushed remote
  - verification results
  - remaining roadmap items

## 9. Current Conclusion

DataSwarm is in a strong but delicate phase. The architecture is now pointed in the right direction: model-owned actions, structured observations, event-driven UI, sandboxed swarm branches, and trace-driven self-improvement. The highest-value next work is not adding more isolated features; it is tightening truth contracts, verification tiers, artifact quality, and product boundaries so the system can grow from a capable prototype into the real swarm platform originally envisioned.
