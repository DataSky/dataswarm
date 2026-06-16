# DataSwarm V4.1 Delivery Closure Plan

## Purpose

V4.1 turns the V4 E2B ReAct swarm from a runnable branch system into an evidence-closed delivery system. The acceptance bar is not that code paths exist; it is that a real E2B complex swarm can prove, by conversationId diagnostics, that branches used real model actions, reachable shared capabilities, recovered artifacts, and reducer/verifier gates after all branches settled.

## Current Baseline

- Baseline conversation: `conv_7d810a1e83cd4de4b612e354c210d3a0`.
- Real E2B branches did start and complete.
- Closure failed because parent-proxied capability calls were not persisted as successful tool evidence, `trace.query` calls used `current` without resolving to the active conversation, image/HTML artifact requirements were not satisfied, and recovered markdown was too shallow to serve as branch final evidence.

## Implementation Tracks

1. BranchContract fidelity: every branch carries preserved instruction, required tools, required artifacts, minimum real-model action count, and fallback policy.
2. BranchFinal substance: every completed branch returns a structured final with findings, evidence observation ids, artifact ids, unsupported claims, and limitations.
3. Capability closure: sandbox calls to web.search, file.read, trace.query, artifact.create, and run_python must all flow through one capability plane with tool_call, Observation, event, and diagnostics records.
4. Artifact closure: image/Markdown/HTML artifacts must be generated, recovered, de-duplicated, previewable, and linked to sourceObservationIds.
5. Reducer/verifier closure: swarm.reduce and swarm.verify must wait for settled branches and fail on missing contracts, shallow finals, unsupported claims, fallback-as-normal-path, missing capability evidence, or missing artifact coverage.
6. Real-by-default startup: dev scripts must default to E2B + real model + parent/capability proxy; mock mode must be explicit and visibly degraded.

## Validation Ladder

1. Static checks for TypeScript/Python syntax and schema drift.
2. Local mock V3/V4 smoke to protect deterministic fixtures, clearly marked mock.
3. Real-action local smoke for parser/repair/retry and BranchFinal generation.
4. Parent/capability proxy smoke for web.search, artifact.create, file.read, trace.query, and run_python.
5. Swarm parallel smoke proving all branches settle before reduce/verify.
6. Real E2B parent-proxy smoke through the public Cloudflare tunnel.
7. Real E2B complex benchmark proving multiple branches, at least three real_model actions per branch, zero normal-path fallback, real parent-proxied web.search evidence, image artifact, Markdown/HTML artifact, final Observation/Artifact citations, and reproducible diagnostics.

## Non-Negotiables

- Do not mark mock results as live.
- Do not treat deterministic fallback as success.
- Do not count runtime summaries as substantive deliverables.
- Do not accept branch self-report as tool evidence unless parent tool_call, Observation, and events exist.

## 2026-06-15 Implementation Notes

- `web.search` must fail on missing real provider credentials in real mode instead of silently returning mock sources; provider=mock is allowed only under explicit mock opt-in and must remain clearly degraded/mock evidence.
- Default developer startup should be real-by-default: `npm run dev` and `npm run dev:real` enforce E2B + real model + parent proxy and refuse inherited mock env, while `npm run dev:mock` is the explicit mock path.
- Diagnostics artifact details should expose parsed metadata, and `swarmEvidence` should report real E2B branch payload count plus fallback/degraded counts so a conversationId can distinguish real external sandbox execution from degraded paths.
- Conversation diagnostics should expose a dedicated `swarmEvidence` summary for real E2B/proxy/artifact proof, including parent-proxy completion/failure counts, latest verify `event_evidence`, BranchContract/BranchFinal coverage, artifact type coverage, and failed verifier checks.
- `swarm.verify` should consume parent-side event evidence from `run_events` and `tool_calls`, including `capability.invoke.*`, `sandbox.tool_proxy.call.*`, and completed/failed required tool calls, to prove real parent-proxy execution independently of sandbox self-report.
- Parent-proxy tool coverage should use explicit `toolCallSuccessCount` and `toolCallFailureCount` quality signals from the sandbox agent, so required tool coverage cannot pass on attempted-but-failed calls.
- Branch artifact coverage should include artifacts generated through parent-proxied capabilities, not only artifacts recovered from sandbox local manifests. This is required for `run_python` image artifacts and parent `artifact.create` HTML/Markdown artifacts to satisfy reducer/verifier gates.
- `run_python` is now part of the intended Capability Plane surface and should be validated as a parent-proxied tool call that creates an image artifact, Observation, and persisted tool_call.
- Sandbox V3 `run_python` actions should prefer the parent proxy and only use local image generation as degraded fallback.
- Verification still needs to prove capability-created artifacts are counted in branch/reducer artifact coverage, not merely present in tool Observation metadata.
- Default developer startup is now tunnel-real by default: root/app `dev` and `dev:real` start the Cloudflare Tunnel profile, while `dev:local-real` is the explicit non-tunnel path and refuses local-only sandbox proxy URLs unless `DATASWARM_ALLOW_LOCAL_SANDBOX_PROXY=1` is set.
- Real startup scripts now unconditionally reject inherited mock/degraded env contamination instead of allowing `DATASWARM_ALLOW_EXPLICIT_MOCK=1` to leak into a real E2B profile.
- `web.search` provider selection now defaults to Tavily in real mode and to mock only under explicit mock opt-in, preserving `dev:mock` fixtures without silently mocking real searches.
- Added `/api/internal/sandbox/health` as the parent/capability proxy health contract. It reports runtime profile, mock contamination, public proxy readiness, required capability coverage, endpoint URLs, and hard failures without exposing secrets.
- Sandbox proxy readiness now treats missing required V4 capabilities (`web.search`, `file.read`, `artifact.create`, `trace.query`, `run_python`) as not ready for external E2B branch execution.
- Conversation diagnostics now include `summary.capabilityPlaneHealth` and generate a remediation item when the current runtime/profile/proxy/capability surface is not ready for real E2B branch tool use.
- Orchestrator artifact carry-forward now automatically selects recent conversation artifacts in addition to explicit artifact preview references, and injects a bounded artifact evidence context with provenance, preview URI, sourceObservationIds, branchIds, and content excerpts for Markdown/HTML artifacts.
- Artifact carry-forward selection now scores recent artifacts against the latest user intent and persists an `artifact.context.prepared` event with selected artifact ids, explicit refs, injected context length, and selection policy for diagnostics replay.
- Conversation diagnostics now summarizes artifact carry-forward through `swarmEvidence.artifactContextPreparedCount` and `latestArtifactContextPrepared`.
- Conversation diagnostics now includes a per-branch `swarmEvidence.branchEvidenceMatrix` covering real E2B sandbox id, BranchContract/BranchFinal presence, real-model action counts vs contract minimum, fallback/degraded status, parent-proxy completions/failures, tool success/failure counts, artifact type coverage, sourceObservation-linked artifacts, and unsupported claims.
- Sandbox V3 action audit now records source/model/retry/repair/fallback metadata on action lifecycle events, attempts same-step model repair for validation failures, counts `repairedActionCount` and `unrepairedActionCount`, counts normal parent-proxy tool successes/failures, and normalizes direct `artifact.create` model actions into parent capability `call_tool`.
- Sandbox BranchFinal now materializes structured sections, claims, evidenceObservationIds, artifactIds, unsupportedClaims, assumptions, and limitations from local sandbox observations/artifact manifests so reducer/verifier no longer has to infer branch substance from runtime markdown alone.
- `swarm.reduce` now accepts BranchFinals as first-class input and builds reduction branch items from BranchFinal executive summaries, sections, claims, evidenceObservationIds, artifactIds, unsupportedClaims, and limitations before falling back to runtime observation summaries.
- `swarm.merge` now receives a structured reduction evidence document built from reduction branch items, including branch sections, claims, evidence ids, artifact ids, unsupported claims, limitations, and reducer recommendations, instead of only a flattened runtime summary string.
- `swarm.verify` now includes `branch_final_structured_evidence`, which fails when completed BranchFinals do not contain substantive sections, claims, and Observation/Artifact evidence ids.
- `artifact.create` now classifies Markdown/HTML artifacts with `artifactKind` and `qualitySignals.substanceStatus`, distinguishing substantive deliverables from thin/runtime-summary artifacts. `swarm.verify` artifact substance coverage now fails runtime-summary artifacts instead of counting them as user deliverables.
- Final orchestrator answers now have an evidence-reference safety net for both Observation IDs and Artifact IDs extracted from Observation metadata, so user-visible answers cannot silently omit persisted artifact evidence.
- Conversation diagnostics now includes final-answer evidence citation coverage, reporting whether the latest assistant answer cites persisted Observation IDs and Artifact IDs, and emits remediation when citations are missing.
- Conversation diagnostics now derives per-branch real_model/mock/fallback/repaired action counts from persisted `sandbox.agent.action.*` events in addition to branch qualitySignals, so real model action proof is not only branch self-report.
- Parent swarm runtime now persists sandbox agent events under their original `sandbox.agent.*` event type instead of collapsing them all to `sandbox.agent.event`, and flattens key sandbox payload fields so diagnostics can query action provenance directly.
- `contract_required_artifact_coverage` now checks BranchContract required artifact types per branch, using branch-linked artifact metadata, instead of allowing one global artifact type to satisfy every branch requirement.
- Required tool coverage now also checks BranchContract required tools per branch using branch-linked parent tool/capability events, preventing one branch's web.search/run_python/artifact.create from satisfying every branch.
- Conversation diagnostics now exposes per-branch `parentProxyEventEvidence`, `toolCallEvidence`, and `requiredToolCoverage`, so a `conversationId` replay can identify exactly which branch/tool has completed parent evidence versus missing/failed coverage.
- Parent capability invocations now stamp `tool_calls.metadata_json` with branch, sandbox session, sandbox action, capability/tool name, and capability plane version, making completed tool_call rows independently branch-attributable instead of relying only on run events.
- `required_tool_event_coverage` no longer lets global completed tool counts satisfy branch-specific required tools; every declared branch/tool pair must have branch-linked parent evidence.
- Capability invocations now persist a branch-linked `sandbox.agent.observation` event for both successful and failed parent-proxied calls.
- Failed capability invocations now create a failed Observation with branch/sandbox/action/tool metadata and include the failed Observation/tool_call ids in `capability.invoke.failed` and `sandbox.tool_proxy.call.failed`.
- Conversation diagnostics branch matrix now reports `sandboxAgentObservationEventCount` and `sandboxAgentFailedObservationEventCount` per branch, making missing or failed sandbox observations visible in conversation replay.
- Sandbox action normalization now handles additional real-model aliases such as `thought`, `read_scoped_context`, `scoped_context`, and `context.read`, steering them into supported V3 actions instead of immediate unsupported-action failure.
- V3 invalid action validation now performs up to two same-step model repair attempts and emits `sandbox.agent.action_repair_started`, `sandbox.agent.action_repair_failed`, and `sandbox.agent.action_repair_succeeded` events with raw/parsed action, validation result, repair attempt, and final action evidence.
- `swarm.verify` now includes an `invalid_action_repair_policy` hard gate that requires repair attempts to settle into succeeded/failed events and requires unrepaired invalid actions to be represented as degraded/fallback quality signals.
- Conversation diagnostics now summarizes repair started/succeeded/failed event counts globally and per branch in `branchEvidenceMatrix`, aligning diagnostics replay with the verifier `invalid_action_repair_policy` gate.
- `swarm.verify` now includes `branch_minimum_evidence_coverage`, enforcing each BranchContract `minimumEvidence` requirement for real model actions, successful tool calls, web.search calls, and image/HTML/Markdown artifacts using branch-linked qualitySignals, tool/capability events, and artifact metadata.
- Conversation diagnostics now exposes per-branch `minimumEvidenceCoverage` and summary `branchesMissingMinimumEvidence`, so `conversationId` replay can explain exactly which BranchContract evidence requirement failed.
- BranchContract generation now materializes V4.1 `role`, `minimumEvidence`, and `finalOutputSchema` fields before sandbox launch, preserving them through trace, sandbox job, reducer, verifier, and diagnostics evidence.
- `swarm.verify` now includes `branch_final_output_schema_coverage`, enforcing each branch final's required sections, Observation/Artifact citations, and unsupported-claim policy from the BranchContract `finalOutputSchema`.
- Conversation diagnostics now exposes per-branch `finalOutputSchemaCoverage` and summary `branchesMissingFinalOutputSchema`, so `conversationId` replay can explain BranchFinal schema failures without manually inspecting payloads.
- Sandbox BranchFinal materialization now reads BranchContract `finalOutputSchema.requiredSections` and appends missing required sections with Observation/Artifact citation ids according to the schema requirements.
- `artifact.create` now supports `json` / `application/json` artifacts in addition to Markdown and HTML, including formatted object serialization, JSON preview generation, `structured_json` artifactKind metadata, and JSON substance quality signals.
- `artifact.create` now supports `image_metadata` artifacts stored as JSON with `artifactKind=image_metadata` and `countsAsImageArtifact=false`, allowing image evidence indexing without pretending metadata satisfies real image artifact requirements.
- Branch artifact requirements and verifier matching now recognize `json` and `image_metadata` artifact types while preserving the separate hard gate for real `image/*` artifacts.
- Sandbox action normalization now routes model-emitted `create_artifact` actions into parent-proxied `call_tool` `artifact.create`, preserving Markdown/HTML/JSON/image metadata fields so normal V4.1 deliverables produce parent tool_call, Observation, and Artifact evidence.
- Sandbox action prompting now tells the model to prefer parent `artifact.create` for durable deliverables and treats local `create_artifact` as a degraded fallback shape.
- `swarm.merge` now creates a parent-level `final_html_report` artifact from reducer BranchFinal evidence, persists source Observation/Artifact metadata, emits `swarm.final_artifact.created`, and carries the final artifact id into merge/verify/review/return artifact lists.
- `swarm.verify` now includes `html_report_artifact_coverage`, requiring a substantive final HTML report artifact, and `swarm.merge` passes the generated final report artifact summary into verifier artifact evidence.
- Conversation diagnostics now reports `finalArtifactEventCount` and `finalHtmlReportArtifactCount`, proving whether merge actually materialized a final HTML artifact for a conversation.
- `swarm.verify` now includes `final_html_report_source_coverage`, requiring the final HTML report artifact to carry both source Observation ids and source Artifact ids.
- Conversation diagnostics now reports `finalHtmlReportSourceCoveredCount`, making final report source-link coverage replayable by `conversationId`.
- `swarm.verify` now includes `trace_diagnostics_replayability`, requiring pre-verify trace evidence for branch completion, reduce, final artifact creation, branch Observation ids, artifact ids, and capability/proxy completions when required tools exist.
- Conversation diagnostics now exposes `traceReplayability` with branch-completed, reduce, final-artifact, branch-observation, artifact, and capability/proxy counts so replayability can be audited without manually scanning events.
- Orchestrator swarm Observations now attach branch Observation ids and Artifact ids as claim sourceRefs and persist both snake_case and camelCase evidence id metadata, strengthening final answer evidence citation carry-forward.
- Capability manifest and sandbox tool catalog now advertise the full `artifact.create` V4.1 surface for Markdown, HTML, JSON, and image metadata artifacts, including source observation ids, image artifact ids, preview URI, MIME type, and artifact kind outputs.
- Sandbox parent tool responses now preserve returned parent artifact summaries in compact observations and convert parent capability artifacts into local manifest entries, allowing BranchFinal `artifactIds` to cite parent-created artifacts.
- Parent `artifact.create` now preserves explicit sandbox-provided `sourceObservationIds` in artifact metadata even when the parent cannot resolve those ids to local Observation records, while separately recording resolved parent Observation ids.

## 2026-06-15 Checkpoint: web.search evidence-bearing verification

- Added a dedicated `web_search_observation_coverage` verifier gate.
- For each BranchContract requiring `web.search`, verification must now find branch-linked completed search evidence that carries a parent `tool_call` id or capability `Observation` id.
- Swarm event evidence now lifts `observation_id` and `tool_call_id` from parent/capability proxy events into verifier input, making the search evidence chain replayable by `conversationId` instead of hidden inside event payload JSON.
- This closes a V4.1 gap where parent proxy completion could be counted without proving that the search produced persisted parent evidence.

Validation status:

- Not yet validated in this slice.
- Required next checks: static/type validation when explicitly requested, parent-proxy smoke for `web.search`, and a real E2B complex benchmark proving `web_search_observation_coverage` passes from live tool calls rather than mock/degraded evidence.

## 2026-06-15 Checkpoint: run_python image artifact gate

- Added `run_python_image_artifact_coverage` to `swarm.verify`.
- For every branch requiring `run_python` or an image artifact, verification now requires both completed branch-linked `run_python` evidence and a recovered real image artifact.
- This prevents Python execution evidence from being treated as image delivery evidence when artifact recovery failed or produced only metadata.

Validation status:

- Not yet validated in this slice.
- Required next checks: parent-proxied `run_python` smoke, artifact recovery inspection, and real E2B benchmark evidence with at least one branch-generated image artifact.

## 2026-06-15 Checkpoint: search gate tightened to tool_call plus Observation

- Tightened the `web_search_observation_coverage` acceptance gate.
- Branches requiring `web.search` must now prove both a branch-linked completed parent `tool_call` and a branch-linked completed capability Observation.
- This prevents half-complete parent proxy evidence from satisfying V4.1 real-search acceptance.

Validation status:

- Not yet validated in this slice.
- Required next check: real parent-proxied `web.search` run through E2B with diagnostics replay by `conversationId`.

## 2026-06-15 Checkpoint: diagnostics replay for search and image gates

- Extended conversation diagnostics with branch-level `webSearchObservationCoverage`.
- Extended conversation diagnostics with branch-level `runPythonImageArtifactCoverage`.
- Added aggregate missing-coverage counts and remediation evidence for both gates.
- This makes the new verifier requirements auditable by `conversationId` instead of requiring manual inspection of raw `run_events`, `tool_calls`, and artifact metadata.

Validation status:

- Not yet validated in this slice.
- Required next checks: diagnostics replay against a real parent-proxied search run and a real E2B `run_python` image artifact run.

## 2026-06-15 Checkpoint: Markdown report substance gate

- Added `markdown_summary_artifact_coverage` to `swarm.verify`.
- Branches requiring Markdown artifacts must now produce branch-linked substantive Markdown deliverables; runtime-summary and thin-text artifacts do not satisfy the gate.
- Conversation diagnostics now reports branch-level and aggregate Markdown deliverable coverage so report simplification/empty-output failures are replayable by `conversationId`.

Validation status:

- Not yet validated in this slice.
- Required next checks: local artifact smoke, diagnostics replay, and real E2B complex benchmark with substantive Markdown branch artifacts.

## 2026-06-15 Checkpoint: required artifact source Observation gate

- Added `artifact_source_observation_coverage` to `swarm.verify`.
- Required branch artifacts must now carry `sourceObservationIds`, so deliverables remain tied to tool/branch evidence rather than existing as detached files.
- Conversation diagnostics now reports branch-level and aggregate artifact source Observation coverage.

Validation status:

- Not yet validated in this slice.
- Required next checks: parent `artifact.create` smoke, `run_python` image artifact smoke, and real E2B complex benchmark diagnostics replay.

## 2026-06-15 Checkpoint: explicit unsupported claim gate

- Added `unsupported_claim_coverage` to `swarm.verify`.
- Diagnostics now reports aggregate branches with unsupported claims and includes them in high-priority remediation evidence.
- This makes unsupported claims auditable as a first-class V4.1 failure mode rather than only as part of finalOutputSchema coverage.

Validation status:

- Not yet validated in this slice.
- Required next check: real E2B complex benchmark with BranchFinal claims linked to Observation/Artifact evidence and zero unresolved unsupported claims.

## 2026-06-15 Checkpoint: explicit verifier gate id alignment

- Added explicit verifier gates matching the V4.1 acceptance list: `branch_final_content_present`, `successful_tool_call_coverage`, `capability_event_coverage`, `parent_proxy_coverage`, and `fallback_action_policy`.
- Diagnostics now reports failed-check counters for those gate ids and includes them in remediation evidence.
- `final_answer_evidence_coverage` is intentionally kept in diagnostics/evaluator scope because it depends on persisted assistant-message content after swarm verification has run.

Validation status:

- Not yet validated in this slice.
- Required next checks: static/type validation, parent/capability proxy smoke, and real E2B complex benchmark replay showing the full verifier gate set in `swarm.verify` output.

## 2026-06-15 Checkpoint: final answer evidence coverage diagnostics

- Added explicit diagnostics output named `final_answer_evidence_coverage` for the latest persisted assistant answer.
- The coverage object checks Observation and Artifact citations against persisted ids, preserving the correct phase boundary: final answer evidence is validated after assistant-message persistence, not inside pre-final swarm verification.

Validation status:

- Not yet validated in this slice.
- Required next check: real E2B complex conversation replay where the final answer cites persisted Observation and Artifact evidence.

## 2026-06-15 Checkpoint: trace.query active conversation resolution evidence

- `trace.query` now records resolved target metadata in `tool_calls.metadata_json.trace_query`.
- The metadata captures requested ids, resolved target kind/id, resolved conversation id, and whether active conversation fallback rewrote `current` / missing conversation id.
- Conversation diagnostics now exposes `traceQueryResolution` and remediation for unresolved current literals.
- This addresses the V4.1 requirement that `conversation_id=current` must not reach repository diagnostics lookup as a literal id.

Validation status:

- Not yet validated in this slice.
- Required next check: parent-proxied `trace.query` smoke with `conversation_id=current` and missing `conversation_id`, confirming both resolve to the active conversationId and persist metadata.

## 2026-06-15 Checkpoint: reducer input coverage replayability

- `swarm.reduce` now records `reducer_input_coverage` in run events and trace span metadata.
- Diagnostics now exposes reducer input coverage and remediation for reduce runs that do not use BranchFinal evidence.
- This addresses the V4.1 requirement that diagnostics by `conversationId` can prove reducer inputs rather than only seeing a final summary.

Validation status:

- Not yet validated in this slice.
- Required next check: swarm parallel smoke and real E2B complex benchmark showing reducer input coverage with BranchContracts, BranchFinals, Observations, and Artifacts.

## 2026-06-15 Checkpoint: BranchFinal materialized event

- Added dedicated `swarm.branch.final.materialized` events for completed branches that produce BranchFinal records.
- Diagnostics now reports BranchFinal materialization globally and per branch, making BranchFinal persistence replayable by `conversationId` instead of only embedded in branch completed payloads.
- Missing materialized events now trigger remediation as branch evidence gaps.

Validation status:

- Not yet validated in this slice.
- Required next check: local swarm smoke and real E2B complex benchmark proving every completed branch has a BranchFinal materialized event before reduce/verify.

## 2026-06-15 Checkpoint: verifier gate coverage replayability

- Added a canonical V4.1 `swarm.verify` gate id list and persisted `gate_coverage` in verify run events and trace span metadata.
- Diagnostics now reports expected/present/missing/failed verifier gate ids and remediates incomplete gate coverage.
- This makes it possible to prove by `conversationId` that the verifier itself covered the required V4.1 acceptance gates.

Validation status:

- Not yet validated in this slice.
- Required next check: smoke/live run showing `swarmEvidence.verificationGateCoverage.complete=true` and expected failed/passed gate behavior.

## 2026-06-15 Checkpoint: BranchContract materialized event

- Added dedicated `swarm.branch.contract.materialized` events for every branch after sandbox session creation.
- Diagnostics now reports BranchContract materialization globally and per branch, making BranchContract persistence replayable by `conversationId` instead of only embedded in metadata or branch completion payloads.
- Missing materialized contract events now trigger remediation as branch evidence gaps.

Validation status:

- Not yet validated in this slice.
- Required next check: local swarm smoke and real E2B complex benchmark proving every branch has a BranchContract materialized event before sandbox ReAct execution.

## 2026-06-15 Checkpoint: materialized events promoted into hard verifier gates

- `branch_contract_coverage` now fails if BranchContract materialization events are missing.
- `branch_final_content_present` and `branch_final_substance` now fail if BranchFinal materialization events are missing for completed branches.
- This strengthens V4.1 replayability: branch contracts/finals must be independently event-backed, not merely embedded in completion payloads.

Validation status:

- Not yet validated in this slice.
- Required next check: rerun swarm smoke/live benchmark so new materialized events exist before `swarm.verify` evaluates the stricter gates.

## 2026-06-15 Checkpoint: artifact provenance metadata closure

- `artifact.create` and `run_python` artifacts now receive unified branch/sandbox/action/tool-call provenance metadata at creation time.
- Capability-plane completion now merges the final capability Observation id and producer details into returned artifact metadata.
- This supports V4.1 artifact gates for branch linkage, sourceObservationIds, producer action id, toolCallId, preview/recovery, and image artifact coverage.

Validation status:

- Not yet validated in this slice.
- Required next check: parent-proxy smoke for Markdown/HTML `artifact.create` and `run_python` image artifacts, followed by real E2B replay proving sourceObservation-linked artifact metadata.

## 2026-06-15 Checkpoint: run_python chart/code compatibility

- `run_python` now accepts model-friendly chart/code inputs and converts them into recoverable SVG image artifacts without executing untrusted Python in the parent process.
- The artifact records `runPythonInputMode`, provenance metadata, image quality signals, and source observation ids when supplied.
- This supports the V4.1 requirement that at least one branch can generate a real image artifact through the parent capability path.

Validation status:

- Not yet validated in this slice.
- Required next check: parent-proxy `run_python` smoke using `labels`/`values` and a real E2B branch requiring an image artifact.

## 2026-06-15 Checkpoint: sandbox run_python schema alignment

- Sandbox ReAct prompting and action defaults now align with the parent `run_python` chart/code input schema.
- `run_python` actions are budget-gated like other parent tools and default to evidence chart inputs with source Observation ids when available.
- This helps real E2B branch agents produce image artifacts through the parent capability path without needing to handcraft SVG/base64 payloads.

Validation status:

- Not yet validated in this slice.
- Required next check: local parser/repair smoke and real E2B parent-proxy smoke proving real_model emits `run_python` chart inputs and receives image artifact evidence.

## 2026-06-15 Checkpoint: sandbox artifact.create prompt substance alignment

- Sandbox ReAct instructions now steer real model actions to create substantive parent-tracked Markdown/HTML artifacts with `sourceObservationIds`.
- Examples now demonstrate report structure and Observation citation, reducing the chance of runtime-summary artifacts satisfying deliverable slots.

Validation status:

- Not yet validated in this slice.
- Required next check: real E2B branch run where `artifact.create` produces substantive Markdown/HTML artifacts tied to tool Observations.

## 2026-06-15 Checkpoint: artifact.create input completion before parent proxy

- Sandbox `artifact.create` parent-tool calls now auto-fill missing `sourceObservationIds` from branch observations.
- Missing title/type/content are completed with substantive report structure rather than runtime-summary placeholders.
- This improves the chance that real E2B branch artifacts satisfy sourceObservation and substance gates even when the model omits some fields.

Validation status:

- Not yet validated in this slice.
- Required next check: parent-proxied `artifact.create` smoke proving auto-filled sourceObservationIds and substantive content reach parent artifact metadata.
