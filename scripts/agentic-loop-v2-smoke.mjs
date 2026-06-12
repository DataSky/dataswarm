import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const targetConversationId =
  process.argv[2] ?? process.env.DATASWARM_SMOKE_CONVERSATION_ID ?? "conv_b0d87605c4d04288982736d134d5f441";
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const results = [];

function expect(name, passed, detail) {
  results.push({ name, passed, detail });
}

function readProjectFile(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function resolveLocalUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("local://")) {
    return "";
  }
  const [kind, ...segments] = uri.slice("local://".length).split("/");
  return path.join(dataDir, kind, ...segments);
}

function readLocalPayload(uri) {
  const filePath = resolveLocalUri(uri);
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  return parseJson(readFileSync(filePath, "utf8"));
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function assertStaticRuntimeInvariants() {
  const orchestrator = readProjectFile("apps/web/src/server/runtime/orchestrator.ts");
  const planner = readProjectFile("apps/web/src/server/runtime/planner.ts");
  const registry = readProjectFile("apps/web/src/server/tools/registry.ts");
  const agenticTypes = readProjectFile("apps/web/src/server/runtime/agentic-types.ts");
  const approvals = readProjectFile("apps/web/src/server/repositories/approvals.ts");
  const approvalsApi = readProjectFile("apps/web/src/app/api/runs/[id]/approvals/route.ts");
  const approvalActionApi = readProjectFile("apps/web/src/app/api/runs/[id]/approvals/[approvalId]/route.ts");
  const evaluator = readProjectFile("apps/web/src/server/runtime/evaluator.ts");
  const schemaDb = readProjectFile("apps/web/src/server/storage/db.ts");
  const diagnostics = readProjectFile("apps/web/src/server/repositories/diagnostics.ts");
  const skills = readProjectFile("apps/web/src/server/repositories/skills.ts");
  const selfImprovement = readProjectFile("apps/web/src/server/repositories/self-improvement.ts");
  const selfImprovementRunner = readProjectFile("apps/web/src/server/runtime/self-improvement-runner.ts");
  const traceDiagnosticsImprovementsSmoke = readProjectFile("scripts/trace-diagnostics-improvements-smoke.mjs");
  const traceDiagnosticsSandboxSmoke = readProjectFile("scripts/trace-diagnostics-sandbox-smoke.mjs");
  const canonicalVerificationDiagnosticsSmoke = readProjectFile("scripts/canonical-verification-diagnostics-smoke.mjs");
  const selfImprovementDiagnosticsSmoke = readProjectFile("scripts/self-improvement-diagnostics-smoke.mjs");
  const selfImprovementUiSmoke = readProjectFile("scripts/self-improvement-ui-smoke.mjs");
  const selfImprovementSummarySmoke = readProjectFile("scripts/self-improvement-summary-smoke.mjs");
  const selfImprovementSummaryApiSmoke = readProjectFile("scripts/self-improvement-summary-api-smoke.mjs");
  const eventProtocolE2eSmoke = readProjectFile("scripts/event-protocol-e2e-smoke.mjs");
  const canonicalVerificationRunner = readProjectFile("scripts/canonical-verification-runner.mjs");
  const runTraceSystemReadinessSmoke = readProjectFile("scripts/run-trace-system-readiness-smoke.mjs");
  const skillsObservationE2eSmoke = readProjectFile("scripts/skills-observation-e2e-smoke.mjs");
  const swarmTraceUiSmoke = readProjectFile("scripts/swarm-trace-ui-smoke.mjs");
  const swarmActionPlanSmoke = readProjectFile("scripts/swarm-action-plan-smoke.mjs");
  const swarmReducer = readProjectFile("apps/web/src/server/runtime/swarm-reducer.ts");
  const swarmReducerSmoke = readProjectFile("scripts/swarm-reducer-smoke.mjs");
  const swarmVerifier = readProjectFile("apps/web/src/server/runtime/swarm-verifier.ts");
  const swarmVerifierSmoke = readProjectFile("scripts/swarm-verifier-smoke.mjs");
  const swarmReviewer = readProjectFile("apps/web/src/server/runtime/swarm-reviewer.ts");
  const swarmReviewSmoke = readProjectFile("scripts/swarm-review-smoke.mjs");
  const runTracePage = readProjectFile("apps/web/src/app/runs/[id]/page.tsx");
  const improvementActions = readProjectFile("apps/web/src/app/runs/[id]/improvement-actions.tsx");
  const improvementsApi = readProjectFile("apps/web/src/app/api/runs/[id]/improvements/route.ts");
  const improvementActionApi = readProjectFile("apps/web/src/app/api/runs/[id]/improvements/[candidateId]/route.ts");
  const sandboxProvider = readProjectFile("apps/web/src/server/runtime/sandbox-provider.ts");
  const swarm = readProjectFile("apps/web/src/server/runtime/swarm.ts");
  const runCancelRoute = readProjectFile("apps/web/src/app/api/runs/[id]/cancel/route.ts");
  const runCancelSmoke = readProjectFile("scripts/run-cancel-lifecycle-smoke.mjs");
  const runCancelApiSmoke = readProjectFile("scripts/run-cancel-api-smoke.mjs");
  const modelProvider = readProjectFile("apps/web/src/server/models/provider.ts");
  const sandboxAgent = readProjectFile("sandbox/agent/dataswarm_sandbox_agent.py");
  const e2bSmoke = readProjectFile("scripts/e2b-sandbox-smoke.mjs");
  const e2bReadinessSmoke = readProjectFile("scripts/e2b-readiness-smoke.mjs");
  const e2bTemplateSmoke = readProjectFile("scripts/e2b-template-smoke.mjs");
  const e2bTemplateReceiptSmoke = readProjectFile("scripts/e2b-template-receipt-smoke.mjs");
  const e2bLiveReceiptSmoke = readProjectFile("scripts/e2b-live-receipt-smoke.mjs");
  const e2bPreflightE2eSmoke = readProjectFile("scripts/e2b-preflight-e2e-smoke.mjs");
  const e2bTemplateVerificationE2eSmoke = readProjectFile("scripts/e2b-template-verification-e2e-smoke.mjs");
  const e2bDockerfile = readProjectFile("sandbox/e2b/e2b.Dockerfile");
  const e2bEntrypoint = readProjectFile("sandbox/e2b/entrypoint.py");
  const systemSnapshot = readProjectFile("apps/web/src/server/repositories/system.ts");
  const sandboxModelSmoke = readProjectFile("scripts/sandbox-agent-model-smoke.mjs");
  const packageJson = JSON.parse(readProjectFile("apps/web/package.json"));
  const conversationWorkspace = readProjectFile("apps/web/src/app/ui/conversation-workspace.tsx");
  const architectureDoc = readProjectFile("ARCHITECTURE.md");
  const schemaDoc = readProjectFile("SCHEMA.md");
  const eventProtocol = readProjectFile("EVENT_PROTOCOL.md");

  expect(
    "runtime has bounded multi-step loop",
    /DATASWARM_AGENT_MAX_STEPS/.test(orchestrator) && /for \(let stepIndex = 1/.test(orchestrator),
    "orchestrator should bound plan-tool-observe iterations",
  );
  expect(
    "runtime emits replan events",
    /agent\.replan\.requested/.test(orchestrator) &&
      /shouldReplanAfterObservation/.test(orchestrator) &&
      /extractRequiredSiteDomains/.test(orchestrator),
    "empty, weak, or constraint-mismatched observations should produce a durable replan signal",
  );
  expect(
    "planner receives available and active skills",
    /availableSkills/.test(planner) && /activeSkills/.test(planner) && /trace-diagnostics/.test(planner),
    "planner should see the skill catalog and model-activated skills without engineering preselection",
  );
  expect(
    "planner-selected skills produce observations",
    /const skillObservation = await recordSelectedSkill/.test(orchestrator) &&
      /sourceType: "skill"/.test(orchestrator) &&
      /selected_alternatives/.test(orchestrator) &&
      /contribution_contract/.test(orchestrator) &&
      /publishObservationEvent/.test(orchestrator) &&
      /Skills observation e2e smoke passed/.test(skillsObservationE2eSmoke) &&
      /skills-observation-e2e-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Skills observation e2e smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "use_skill must create durable skill observations so skills participate in the same action/observation/trace contract as tools and swarm",
  );
  expect(
    "planner enforces strict action schema",
    /Field names are strict/.test(planner) && /"type":"use_skill","skillName"/.test(planner),
    "planner prompt should reduce malformed use_skill and call_tool actions",
  );
  expect(
    "planner parser accepts nested skill aliases",
    /extractSkillName/.test(planner) && /targetSkill/.test(planner) && /value\.skill/.test(planner),
    "planner parser should normalize common model variants for use_skill",
  );
  expect(
    "runtime does not use regex skill preselection",
    !/resolveSkillsForText/.test(orchestrator) && !/resolveSkillsForText/.test(readProjectFile("apps/web/src/server/repositories/skills.ts")),
    "skills should be activated by planner use_skill actions, not preselected by repository regex routing",
  );
  expect(
    "mock planner scopes deterministic triggers to latest user message",
    /extractLatestPlannerUserMessage/.test(modelProvider) &&
      /const latestTask = extractLatestPlannerUserMessage\(content\)/.test(modelProvider) &&
      /shouldUseSkill[\s\S]*?test\(latestTask\)/.test(modelProvider) &&
      /shouldSearch[\s\S]*?test\(latestTask\)/.test(modelProvider) &&
      /shouldSwarm[\s\S]*?test\(latestTask\)/.test(modelProvider) &&
      /\\bswarm\\b/.test(modelProvider),
    "mock-mode verification should not choose tools or skills because their names appear in planner catalog context",
  );
  expect(
    "runtime records planner failures",
    orchestrator.includes("model.call.failed") && orchestrator.includes('completeTraceSpan(plannerSpan.id, "failed"'),
    "planner parse/validation failures should leave durable trace evidence",
  );
  expect(
    "terminal tool events carry observation evidence",
    /type: "tool\.call\.completed"[\s\S]*?observation_id: observation\.id[\s\S]*?evidence_level: observation\.evidenceLevel/.test(orchestrator) &&
      /type: "tool\.call\.failed"[\s\S]*?observation_id: observation\.id[\s\S]*?evidence_level: observation\.evidenceLevel/.test(orchestrator) &&
      /terminal_tool_events_have_observation_evidence/.test(evaluator) &&
      /terminal tool events include observation_id and evidence_level/.test(evaluator),
    "completed/failed tool events should expose action_id, tool_call_id, capability, observation_id, and evidence_level for trace diagnosis",
  );
  expect(
    "schema document reflects current V2 storage contracts",
      /### 6\.5 `agent_actions`/.test(schemaDoc) &&
      /### 6\.6 `observations`/.test(schemaDoc) &&
      /### 10\.4 `self_improvement_candidates`/.test(schemaDoc) &&
      /Real E2B execution has an SDK path/.test(schemaDoc) &&
      !/real E2B sandbox execution is deferred until sandbox templates and event bridging are pinned/.test(schemaDoc),
    "SCHEMA.md should describe actual AgentAction, Observation, self-improvement, and gated E2B contracts rather than stale deferred architecture",
  );
  expect(
    "event protocol uses current swarm event names",
    /`swarm\.plan`/.test(eventProtocol) &&
      /`swarm\.branch\.started`/.test(eventProtocol) &&
      /`swarm\.branch\.completed`/.test(eventProtocol) &&
      /`swarm\.branch\.failed`/.test(eventProtocol) &&
      /`swarm\.reduce`/.test(eventProtocol) &&
      /`swarm\.merge`/.test(eventProtocol) &&
      /`swarm\.verify`/.test(eventProtocol) &&
      /`sandbox\.agent\.event`/.test(eventProtocol) &&
      /branch_observation_ids/.test(eventProtocol) &&
      !/`swarm\.started`/.test(eventProtocol) &&
      !/`swarm\.agent\.completed`/.test(eventProtocol),
    "EVENT_PROTOCOL.md should match persisted planner-owned swarm events instead of old target names",
  );
  expect(
    "event protocol replay redaction and terminal ordering have an e2e gate",
      /Event protocol e2e smoke passed/.test(eventProtocolE2eSmoke) &&
      /Last-Event-ID/.test(eventProtocolE2eSmoke) &&
      /from_seq/.test(eventProtocolE2eSmoke) &&
      /events\.seq_gap/.test(conversationWorkspace) &&
      /client detects missing seq and reconnects from latest applied seq/.test(eventProtocolE2eSmoke) &&
      /REDACTED_SECRET/.test(eventProtocolE2eSmoke) &&
      /Terminal run event is not followed by active runtime events/i.test(eventProtocolE2eSmoke) &&
      /event-protocol-e2e-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Event protocol e2e smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "event replay, seq monotonicity, redaction, and terminal ordering should be verified by a production API smoke",
  );
  expect(
    "canonical phase runner groups all verification gates",
    /phaseGate\("phase1", "agentic-loop-v2"/.test(canonicalVerificationRunner) &&
      /phaseGate\("phase2", "skills-v2"/.test(canonicalVerificationRunner) &&
      /phaseGate\("phase3", "swarm-action-plan"/.test(canonicalVerificationRunner) &&
      /phaseGate\("phase4", "e2b-live-sandbox"/.test(canonicalVerificationRunner) &&
      /phaseGate\("phase5", "self-improvement-async"/.test(canonicalVerificationRunner) &&
      /phaseGate\("phase5", "canonical-verification-diagnostics"/.test(canonicalVerificationRunner) &&
      /phaseGate\("phase5", "canonical-goal-audit-smoke"/.test(canonicalVerificationRunner) &&
      /liveExternalGate: true/.test(canonicalVerificationRunner) &&
      /gated_skip/.test(canonicalVerificationRunner) &&
      /requireLiveE2b/.test(canonicalVerificationRunner) &&
      /safeEnvironmentSnapshot/.test(canonicalVerificationRunner) &&
      /canonical-verification-latest\.json/.test(canonicalVerificationRunner) &&
      /canonical-verification-runner\.mjs --dry-run/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /canonical-goal-audit\.mjs/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Canonical verification runner dry run passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "Phase 1-5 gates should have a grouped runner that records local pass/fail and live E2B gated state without leaking secrets",
  );
  expect(
    "canonical verification receipts are exposed through diagnostics",
    /readCanonicalVerificationSummary/.test(diagnostics) &&
      /canonicalVerification/.test(diagnostics) &&
      /canonical-verification-gates/.test(diagnostics) &&
      /liveE2bGated/.test(diagnostics) &&
      /Canonical verification:/.test(registry) &&
      /canonical-verification-diagnostics-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Canonical verification diagnostics smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")) &&
      /diagnostic exposes canonical verification receipt summary/.test(canonicalVerificationDiagnosticsSmoke),
    "Conversation diagnostics and trace.query should summarize canonical Phase 1-5 gate receipts and the live E2B gated state",
  );
  expect(
    "architecture document reflects current planner-owned runtime boundary",
    /planner-selected `AgentAction` values/.test(architectureDoc) &&
      /persist `Observation` records/.test(architectureDoc) &&
      /Real E2B execution has an SDK path/.test(architectureDoc) &&
      /live E2B branches remain gated/i.test(architectureDoc) &&
      /`swarm\.plan`/.test(architectureDoc) &&
      /swarm\.branch\.completed \/ failed/.test(architectureDoc) &&
      /`swarm\.reduce`/.test(architectureDoc) &&
      /swarm\.merge with branch_observation_ids/.test(architectureDoc) &&
      /`swarm\.verify`/.test(architectureDoc) &&
      !/Real E2B execution remains deferred until sandbox templates and event bridging are pinned/.test(architectureDoc) &&
      !/`swarm\.started`/.test(architectureDoc) &&
      !/`swarm\.agent\.completed`/.test(architectureDoc),
    "ARCHITECTURE.md should describe the current model-selected AgentAction boundary, Observation contract, gated E2B path, and persisted swarm event names",
  );
  expect(
    "generic web_search adapter uses a provider registry",
    /"web\.search"/.test(registry) &&
      /executeWebSearchAction/.test(registry) &&
      /const webSearchProviders: Record<WebSearchProviderName, WebSearchProvider>/.test(registry) &&
      /executeSearchViaProvider/.test(registry) &&
      /DATASWARM_WEB_SEARCH_PROVIDER/.test(registry) &&
      /toolName: input\.action\.toolName/.test(registry) &&
      /providerToolName: "tavily\.search"/.test(registry) &&
      /providerToolName: "mock\.search"/.test(registry) &&
      /toolName: "web\.search"/.test(modelProvider),
    "web.search should be the model-facing web_search adapter while Tavily and mock are provider implementations",
  );
  expect(
    "web.search catalog exposes provider candidates",
    /providerCandidates: \["tavily", "mock"\]/.test(schemaDb) &&
      /function defaultToolSchema/.test(schemaDb) &&
      /enum: \["tavily", "mock"\]/.test(schemaDb),
    "web.search tool schema should expose model-visible provider choices and sync existing local DB rows",
  );
  expect(
    "web_search adapter accepts search options",
    /max_results/.test(registry) &&
      /search_depth/.test(registry) &&
      /include_domains/.test(registry) &&
      /include_raw_content/.test(registry),
    "web_search tools should pass model-selected parameters through to the provider API payload",
  );
  expect(
    "trace.query adapter is implemented",
    /"trace\.query"/.test(registry) &&
      /executeTraceQueryAction/.test(registry) &&
      /formatTraceQuerySummary/.test(registry) &&
      /applied receipt coverage/.test(registry),
    "trace.query must be a first-class local tool adapter",
  );
  expect(
    "artifact.create adapter is implemented",
    /"artifact\.create"/.test(registry) &&
      /executeArtifactCreateAction/.test(registry) &&
      /createTextArtifact/.test(registry) &&
      /artifactActionToToolAction/.test(orchestrator),
    "create_artifact actions should flow through the artifact.create adapter and durable artifact events",
  );
  expect(
    "file.read and approval.request adapters are implemented",
    /"file\.read"/.test(registry) &&
      /executeFileReadAction/.test(registry) &&
      /"approval\.request"/.test(registry) &&
      /executeApprovalRequestAction/.test(registry),
    "local file inspection and approval requests should be model-selectable tools, not roadmap-only catalog rows",
  );
  expect(
    "approval lifecycle is inspectable and decidable",
    /listApprovals/.test(approvals) &&
      /decideApproval/.test(approvals) &&
      /Approval is already resolved/.test(approvals) &&
      /listApprovals/.test(approvalsApi) &&
      /approval\.decision\.recorded/.test(approvalActionApi) &&
      /"approvals"/.test(runTracePage) &&
      /function Approvals/.test(runTracePage),
    "approval.request should create durable pending approvals that can be listed, approved/rejected, and inspected from Run Trace",
  );
  expect(
    "artifact repository dedupes immutable versions by content hash",
    /contentHash/.test(readProjectFile("apps/web/src/server/repositories/artifacts.ts")) &&
      /JOIN artifact_versions/.test(readProjectFile("apps/web/src/server/repositories/artifacts.ts")) &&
      /deduped/.test(readProjectFile("apps/web/src/server/repositories/artifacts.ts")),
    "repeated markdown/html output should reuse identical artifacts instead of duplicating the drawer",
  );
  expect(
    "spawn_agent and spawn_swarm enter the orchestrator loop",
      /executeSwarm/.test(orchestrator) &&
      /action\.type === "spawn_agent" \|\| action\.type === "spawn_swarm"/.test(orchestrator) &&
      /action,/.test(orchestrator) &&
      /plan_source: swarmResult\.plan\.planSource/.test(orchestrator) &&
      /"swarm\.e2b"/.test(orchestrator) &&
      /"swarm\.mock"/.test(orchestrator) &&
      /"type":"spawn_swarm"/.test(planner) &&
      /"type":"spawn_agent"/.test(planner),
    "swarm execution should be triggered by explicit model AgentActions and produce observations, not a keyword side path",
  );
  expect(
    "swarm uses planner-provided branch definitions before runtime fallback",
    /SwarmActionBranchDefinition/.test(agenticTypes) &&
      /normalizeSwarmBranches/.test(planner) &&
      /validateSwarmBranches/.test(planner) &&
      /branches: \[/.test(modelProvider) &&
      /buildSwarmPlan\(objective: string, action\?: SpawnAgentAction \| SpawnSwarmAction\)/.test(swarm) &&
      /planSource: "model_branches"/.test(swarm) &&
      /planSource: "runtime_fallback"/.test(swarm) &&
      /Swarm action plan smoke passed/.test(swarmActionPlanSmoke) &&
      /Swarm action plan smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "planner-provided branch plans should be visible in types, prompts, mock e2e, executor plan source, and status docs",
  );
  expect(
    "mock planner can select spawn_swarm for deterministic local verification",
    /shouldSwarm/.test(modelProvider) && /type: "spawn_swarm"/.test(modelProvider),
    "mock-mode tests should exercise planner-owned swarm instead of bypassing it",
  );
  expect(
    "planner prevents duplicate swarm spawning after observations",
    /completed swarm\/mock\/e2b agent observation/.test(planner) &&
      /do not choose spawn_swarm or spawn_agent again/.test(planner) &&
      /hasSwarmObservation/.test(modelProvider) &&
      /buildMockSwarmFinalAnswer/.test(modelProvider),
    "after one swarm observation, the planner should finalize or create artifacts instead of repeatedly spawning branches",
  );
  expect(
    "E2B provider has a real SDK execution path",
    /@e2b\/code-interpreter/.test(sandboxProvider) &&
      /Sandbox\.create/.test(sandboxProvider) &&
      /runCode/.test(sandboxProvider) &&
      /executionMode: "real"/.test(sandboxProvider) &&
      /dataswarm-agent-runtime/.test(sandboxProvider) &&
      packageJson.dependencies?.["@e2b/code-interpreter"],
    "DATASWARM_SANDBOX_PROVIDER=e2b should use the E2B SDK, target the DataSwarm template, and fail loudly on missing credentials instead of pretending to be mock",
  );
  expect(
    "sandbox branch agent protocol exists",
    /dataswarm\.sandbox-agent\.v1/.test(sandboxAgent) &&
      /sandbox\.agent\.started/.test(sandboxAgent) &&
      /sandbox\.agent\.heartbeat/.test(sandboxAgent) &&
      /sandbox\.agent\.artifact_prepared/.test(sandboxAgent) &&
      /sandbox\.agent\.artifact_recovery_manifest/.test(sandboxAgent) &&
      /emit_action/.test(sandboxAgent) &&
      /sandbox\.agent\.action_/.test(sandboxAgent) &&
      /"proposed"/.test(sandboxAgent) &&
      /"completed"/.test(sandboxAgent) &&
      /sandbox\.agent\.observation_created/.test(sandboxAgent) &&
      /dataswarm\.sandbox-runtime\.v1/.test(sandboxAgent) &&
      /sandbox\.agent\.model_call_started/.test(sandboxAgent) &&
      /sandbox\.agent\.model_skipped/.test(sandboxAgent) &&
      /qualitySignals/.test(sandboxAgent),
    "sandbox branches should use a stable agent protocol with heartbeat, action/observation lifecycle, recovery metadata, quality signals, and artifact metadata",
  );
  expect(
    "sandbox agent supports gated real model calls",
    /run_model_if_configured/.test(sandboxAgent) &&
      /sandbox\.agent\.model_call_completed/.test(sandboxAgent) &&
      /authScheme/.test(sandboxAgent) &&
      /extract_model_content/.test(sandboxAgent) &&
      /modelUsed/.test(sandboxAgent) &&
      /DEEPSEEK_API_KEY/.test(sandboxModelSmoke) &&
      /modelUsed === true/.test(sandboxModelSmoke),
    "sandbox agent should support DeepSeek/OpenAI-compatible model execution when explicitly configured",
  );
  expect(
    "mock and E2B providers use sandbox agent protocol",
    /executeLocalSandboxAgent/.test(sandboxProvider) &&
      /readSandboxAgentSource/.test(sandboxProvider) &&
      /DATASWARM_AGENT_JOB_JSON/.test(sandboxProvider) &&
      /DATASWARM_SANDBOX_AGENT_MODEL/.test(sandboxProvider) &&
      /DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS/.test(sandboxProvider) &&
      /parseSandboxAgentOutput/.test(sandboxProvider),
    "mock and E2B paths should share the DataSwarm sandbox agent protocol instead of separate fake outputs",
  );
  expect(
    "sandbox provider persists heartbeat timeout cancel and recovery signals",
    /updateSandboxSessionHeartbeat/.test(sandboxProvider) &&
      /isSandboxSessionCancelRequested/.test(sandboxProvider) &&
      /DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS/.test(sandboxProvider) &&
      /sandbox_timeout/.test(sandboxProvider) &&
      /sandbox_cancelled/.test(sandboxProvider) &&
      /collectArtifactRecovery/.test(sandboxProvider),
    "sandbox execution should have explicit heartbeat, timeout, cancellation, and artifact recovery mechanics",
  );
  expect(
    "sandbox provider has bounded retry policy",
    /DATASWARM_SANDBOX_BRANCH_MAX_RETRIES/.test(sandboxProvider) &&
      /sandbox\.agent\.retry_scheduled/.test(sandboxProvider) &&
      /attempt_failures/.test(sandboxProvider) &&
      /shouldRetrySandboxAttempt/.test(sandboxProvider) &&
      /isRetryableSandboxError/.test(sandboxProvider),
    "retry should be explicit, bounded, metadata-backed, and limited to retryable sandbox failures",
  );
  expect(
    "run cancellation lifecycle is implemented and verified",
    /run\.cancel\.requested/.test(runCancelRoute) &&
      /sandbox\.cancel\.requested/.test(runCancelRoute) &&
      /requestSandboxSessionsCancelForRun/.test(runCancelRoute) &&
      /run\.cancelled/.test(orchestrator) &&
      /swarm\.cancelled/.test(swarm) &&
      /run-cancel-lifecycle-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /run-cancel-api-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Run cancel lifecycle smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")) &&
      /Run cancel API smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")) &&
      /Run cancel lifecycle smoke passed/.test(runCancelSmoke) &&
      /Run cancel API smoke passed/.test(runCancelApiSmoke),
    "user/API cancellation should fan out to sandbox sessions, stop swarm branch launch, and be verified by dedicated static/API smoke gates",
  );
  expect(
    "swarm bridges sandbox agent events",
      /sandbox\.agent\.event/.test(swarm) &&
      /agent_event_type/.test(swarm) &&
      /quality_signals/.test(swarm) &&
      /sandbox_artifacts/.test(swarm) &&
      /sandbox_runtime/.test(swarm),
    "sandbox events, runtime logs, quality signals, and artifact metadata should be visible in parent run events",
  );
  expect(
    "swarm records failed or cancelled branches as observable partial results",
    /swarm\.branch\.failed/.test(swarm) &&
      /failed_branch_count/.test(swarm) &&
      /completed_branch_count/.test(swarm) &&
      /normalizeBranchError/.test(swarm),
    "branch failures should produce durable events and merge summaries instead of disappearing into a thrown error",
  );
  expect(
    "swarm branches create observations",
    /sourceType: "agent"/.test(swarm) &&
      /sourceName: `swarm\.branch\.\$\{branch\.id\}`/.test(swarm) &&
      /branchObservationIds/.test(swarm) &&
      /branch_observation_ids/.test(swarm) &&
      /branch completed events link observations/.test(readProjectFile("scripts/sandbox-retry-e2e-smoke.mjs")) &&
      /Sandbox retry e2e smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "each swarm branch should produce a durable agent Observation and link it from branch/merge events",
  );
  expect(
    "swarm exposes sandbox retry attempts in branch events",
    /attempt: result\.attempt/.test(swarm) && /max_attempts: result\.maxAttempts/.test(swarm),
    "completed branch events should expose retry attempt metadata for trace diagnostics",
  );
  expect(
    "swarm reduces branch evidence before merge",
    /export function buildSwarmReduction/.test(swarmReducer) &&
      /detectContradictionSignals/.test(swarmReducer) &&
      /type: "swarm\.reduce"/.test(swarm) &&
      /spanKind: "swarm\.reduce"/.test(swarm) &&
      /parentSpanId: reduceSpan\.id/.test(swarm) &&
      /reduction_summary: reduction\.summary/.test(swarm) &&
      /event\.type === "swarm\.reduce"/.test(runTracePage) &&
      /"swarm\.reduce"/.test(readProjectFile("apps/web/src/app/ui/conversation-workspace.tsx")) &&
      /Swarm reducer smoke passed/.test(swarmReducerSmoke),
    "swarm.reduce should be an independent evented reducer stage before merge and verify",
  );
  expect(
    "swarm verifies merged branch evidence before final synthesis",
    /from "\.\/swarm-verifier"/.test(swarm) &&
      /buildSwarmVerification/.test(swarm) &&
      /type: "swarm\.verify"/.test(swarm) &&
      /spanKind: "swarm\.verify"/.test(swarm) &&
      /branch_observation_ids: branchObservationIds/.test(swarm) &&
      /failed_branch_isolation/.test(swarmVerifier) &&
      /swarm verify carries branch observation ids and passed checks/.test(readProjectFile("scripts/sandbox-retry-e2e-smoke.mjs")) &&
      /failed swarm verify records failed branch evidence/.test(readProjectFile("scripts/e2b-preflight-e2e-smoke.mjs")),
    "swarm merge should be followed by a durable verifier event that checks branch observations, artifacts, failed branches, and conflict signals",
  );
  expect(
    "swarm verifier is reusable and checks richer evidence quality signals",
    /export function buildSwarmVerification/.test(swarmVerifier) &&
      /export function detectContradictionSignals/.test(swarmVerifier) &&
      /plan_source_traceable/.test(swarmVerifier) &&
      /branch_instructions_present/.test(swarmVerifier) &&
      /branch_summary_uniqueness/.test(swarmVerifier) &&
      /source_mismatch/.test(swarmVerifier) &&
      /from "\.\/swarm-verifier"/.test(swarm) &&
      /Swarm verifier smoke passed/.test(swarmVerifierSmoke) &&
      /Swarm verifier smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "swarm.verify should be an independent verifier stage with plan-source, instruction, duplicate-summary, and contradiction/source-mismatch checks",
  );
  expect(
    "swarm review is optional and evented above deterministic reducer/verifier",
    /export async function reviewSwarmResult/.test(swarmReviewer) &&
      /DATASWARM_SWARM_REVIEW_MODE/.test(swarmReviewer) &&
      /purpose: "swarm_model_review"/.test(swarmReviewer) &&
      /type: "swarm\.review"/.test(swarm) &&
      /spanKind: "swarm\.review"/.test(swarm) &&
      /parentSpanId: verifySpan\.id/.test(swarm) &&
      /event\.type === "swarm\.review"/.test(runTracePage) &&
      /"swarm\.review"/.test(readProjectFile("apps/web/src/app/ui/conversation-workspace.tsx")) &&
      /Swarm review smoke passed/.test(swarmReviewSmoke) &&
      /Swarm review smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "swarm.review should make optional model-assisted critique explicit without replacing deterministic contracts",
  );
  expect(
    "swarm has a dedicated Run Trace tree and branch timeline",
    /"swarm"/.test(runTracePage) &&
      /function SwarmTimeline/.test(runTracePage) &&
      /function buildSwarmTimeline/.test(runTracePage) &&
      /Panel title="Swarm Tree"/.test(runTracePage) &&
      /Panel title="Branch Timeline"/.test(runTracePage) &&
      /Panel title="Reduce \/ Merge"/.test(runTracePage) &&
      /Panel title="Review"/.test(runTracePage) &&
      /Swarm trace UI smoke passed/.test(swarmTraceUiSmoke) &&
      /swarm-trace-ui-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Swarm trace UI smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "Run Trace should render planner-owned swarm execution separately from raw events",
  );
  expect(
    "E2B live smoke is gated by credentials",
    /E2B_API_KEY/.test(e2bSmoke) &&
      /SKIP E2B live smoke/.test(e2bSmoke) &&
      /Sandbox\.create/.test(e2bSmoke) &&
      /sandbox\.kill/.test(e2bSmoke) &&
      /dataswarm_sandbox_agent\.py/.test(e2bSmoke) &&
      /dataswarm\.sandbox-agent\.v1/.test(e2bSmoke) &&
      /DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS/.test(e2bSmoke),
    "live E2B validation should be repeatable when configured and explicitly skipped when credentials are absent",
  );
  expect(
    "E2B template contract is pinned and locally verifiable",
    /FROM e2bdev\/code-interpreter/.test(e2bDockerfile) &&
      /COPY agent\/dataswarm_sandbox_agent\.py/.test(e2bDockerfile) &&
      /entrypoint\.py --ready/.test(e2bDockerfile) &&
      /DATASWARM_AGENT_JOB_JSON/.test(e2bEntrypoint) &&
      /dataswarm-agent-runtime/.test(e2bTemplateSmoke) &&
      /E2B template smoke passed/.test(e2bTemplateSmoke) &&
      /e2b-template-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /E2B template smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "Phase 4 should have a dedicated template entrypoint and a non-network verification gate before live E2B validation",
  );
  expect(
    "E2B template receipt generation is controlled and verifiable",
    /scripts\/e2b-template-receipt\.mjs/.test(e2bTemplateReceiptSmoke) &&
      /receipt generator rejects missing build id unless explicitly overridden/.test(e2bTemplateReceiptSmoke) &&
      /receipt records template file hashes/.test(e2bTemplateReceiptSmoke) &&
      /local contract only receipt is explicit/.test(e2bTemplateReceiptSmoke) &&
      /e2b-template-receipt-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /E2B template receipt smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")) &&
      /node scripts\/e2b-template-receipt-smoke\.mjs/.test(selfImprovement) &&
      /node scripts\/e2b-template-receipt-smoke\.mjs/.test(selfImprovementRunner) &&
      /node scripts\/e2b-live-receipt-smoke\.mjs/.test(selfImprovement) &&
      /node scripts\/e2b-live-receipt-smoke\.mjs/.test(selfImprovementRunner) &&
      /E2B live receipt smoke passed/.test(e2bLiveReceiptSmoke),
    "local template verification receipts should be generated through a checked operator path and included in self-improvement verification plans",
  );
  expect(
    "E2B readiness is diagnosable without creating a sandbox",
    /getE2bSandboxReadiness/.test(sandboxProvider) &&
      /DATASWARM_E2B_TEMPLATE/.test(sandboxProvider) &&
      /DATASWARM_E2B_TIMEOUT_MS/.test(sandboxProvider) &&
      /missingEnv/.test(sandboxProvider) &&
      /nextSteps/.test(sandboxProvider) &&
      /verificationCommands/.test(sandboxProvider) &&
      /readyForOrchestrator/.test(sandboxProvider) &&
      /templateVerified/.test(sandboxProvider) &&
      /DATASWARM_E2B_TEMPLATE_VERIFIED/.test(sandboxProvider) &&
      /DATASWARM_E2B_TEMPLATE_BUILD_ID/.test(sandboxProvider) &&
      /DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT/.test(sandboxProvider) &&
      /readE2bTemplateVerificationReceipt/.test(sandboxProvider) &&
      /templateVerificationReceiptPath/.test(sandboxProvider) &&
      /readE2bLiveSmokeReceipt/.test(sandboxProvider) &&
      /liveSmokeVerified/.test(sandboxProvider) &&
      /liveSmokeReceiptPath/.test(sandboxProvider) &&
      /getE2bSandboxReadiness/.test(systemSnapshot) &&
      /apiKeyConfigured/.test(e2bReadinessSmoke) &&
      /readiness includes operator action plan/.test(e2bReadinessSmoke) &&
      /readiness gates orchestrator on template verification/.test(e2bReadinessSmoke) &&
      /snapshot reports local template verification receipt/.test(e2bReadinessSmoke) &&
      /snapshot reports live smoke receipt/.test(e2bReadinessSmoke) &&
      /snapshot reports orchestrator readiness from local receipt/.test(e2bReadinessSmoke) &&
      /provider and live smoke share E2B template envs/.test(e2bReadinessSmoke) &&
      /provider and live smoke share timeout envs/.test(e2bReadinessSmoke) &&
      /snapshot includes E2B readiness object/.test(e2bReadinessSmoke),
    "system diagnostics should expose readiness, env alignment, and secret-safe live smoke prerequisites",
  );
  expect(
    "Run Trace exposes E2B readiness for operators",
    /"system"/.test(runTracePage) &&
      /function SystemReadiness/.test(runTracePage) &&
      /E2B Sandbox Readiness/.test(runTracePage) &&
      /Operator Next Steps/.test(runTracePage) &&
      /readyForOrchestrator/.test(runTracePage) &&
      /liveSmokeReceiptPath/.test(runTracePage) &&
      /templateBuildCommand/.test(runTracePage) &&
      /run-trace-system-readiness-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Run Trace system readiness smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")) &&
      /Run Trace system readiness smoke passed/.test(runTraceSystemReadinessSmoke),
    "Run Trace should make E2B readiness gates, receipt evidence, and operator commands visible from the trace surface",
  );
  expect(
    "E2B preflight failures persist structured branch diagnostics",
    /buildE2bPreflightEvidence/.test(sandboxProvider) &&
      /sandbox_preflight_failed/.test(sandboxProvider) &&
      /e2b_preflight/.test(sandboxProvider) &&
      /attempt_failures/.test(swarm) &&
      /E2B preflight e2e smoke passed/.test(e2bPreflightE2eSmoke) &&
      /swarm.branch.failed/.test(e2bPreflightE2eSmoke) &&
      /failed e2b branches create observations/.test(e2bPreflightE2eSmoke) &&
      /failed branch events link observations/.test(e2bPreflightE2eSmoke) &&
      /missing_env/.test(e2bPreflightE2eSmoke) &&
      /e2b-preflight-e2e-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /E2B preflight e2e smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "switching the orchestrator to e2b without credentials should produce inspectable preflight evidence, not a vague branch failure",
  );
  expect(
    "E2B template verification gate prevents key-only live execution",
    /E2B template verification e2e smoke passed/.test(e2bTemplateVerificationE2eSmoke) &&
      /fakeApiKey/.test(e2bTemplateVerificationE2eSmoke) &&
      /needs_template_verification/.test(e2bTemplateVerificationE2eSmoke) &&
      /external_sandbox_id === null/.test(e2bTemplateVerificationE2eSmoke) &&
      /template-gated e2b branches create failed observations/.test(e2bTemplateVerificationE2eSmoke) &&
      /template-gated branch failed events link observations/.test(e2bTemplateVerificationE2eSmoke) &&
      /e2b-template-verification-e2e-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /E2B template verification e2e smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "having an E2B_API_KEY without an explicit template verification receipt should stop at preflight before external sandbox creation",
  );
  expect(
    "self-improvement queues asynchronous internal analysis",
    /self_improvement_candidates/.test(schemaDb) &&
      /enqueueSelfImprovementAnalysis/.test(evaluator) &&
      /queueMicrotask/.test(selfImprovementRunner) &&
      /runSelfImprovementAnalysis/.test(selfImprovementRunner) &&
      /createSelfImprovementCandidate/.test(selfImprovementRunner) &&
      /self_improvement\.analysis\.queued/.test(selfImprovementRunner) &&
      /self_improvement\.candidates\.queued/.test(selfImprovementRunner) &&
      /visibility: "internal"/.test(selfImprovementRunner),
    "post-run self-improvement should enqueue async analysis and create internal candidates outside the normal chat path",
  );
  expect(
    "self-improvement async analysis is replayable and idempotent",
    /export async function POST/.test(improvementsApi) &&
      /run_async_analysis/.test(improvementsApi) &&
      /findSelfImprovementCandidateForEvalCheck/.test(selfImprovementRunner) &&
      /generated_by: "self_improvement\.analysis"/.test(selfImprovementRunner) &&
      /node scripts\/e2b-template-smoke\.mjs/.test(selfImprovementRunner) &&
      /node scripts\/e2b-template-receipt-smoke\.mjs/.test(selfImprovementRunner) &&
      /node scripts\/e2b-readiness-smoke\.mjs/.test(selfImprovementRunner) &&
      /node scripts\/e2b-live-receipt-smoke\.mjs/.test(selfImprovementRunner),
    "trace/eval based improvement analysis should be manually replayable, idempotent, and choose specific verification gates for E2B/template failures",
  );
  expect(
    "diagnostics remediation creates self-improvement candidates",
    /run_diagnostics_analysis/.test(improvementsApi) &&
      /runSelfImprovementDiagnosticsAnalysis/.test(improvementsApi) &&
      /diagnoseConversation/.test(selfImprovementRunner) &&
      /createImprovementCandidatesFromDiagnostics/.test(selfImprovementRunner) &&
      /findSelfImprovementCandidateForDiagnosticRemediation/.test(selfImprovement) &&
      /generated_by: "self_improvement\.diagnostics_analysis"/.test(selfImprovementRunner) &&
      /item\.category === "self_improvement"/.test(selfImprovementRunner) &&
      /Self-improvement diagnostics smoke passed/.test(selfImprovementDiagnosticsSmoke) &&
      /diagnostics analysis API is idempotent/.test(selfImprovementDiagnosticsSmoke) &&
      /canonical-verification-gates/.test(selfImprovementDiagnosticsSmoke) &&
      /canonical verification remediation uses strict live E2B gate/.test(selfImprovementDiagnosticsSmoke) &&
      /self-improvement-diagnostics-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")),
    "diagnostics remediation should be promotable into review-gated candidates without recursive self-improvement candidate growth",
  );
  expect(
    "self-improvement candidates are visible in trace diagnostics",
    /listSelfImprovementCandidates/.test(selfImprovement) &&
      /selfImprovementCandidates/.test(diagnostics) &&
      /buildSelfImprovementSummary/.test(diagnostics) &&
      /appliedWithVerificationReceiptCount/.test(diagnostics) &&
      /appliedReceiptRequiredCommandCoverage/.test(diagnostics) &&
      /Self-Improvement Candidates/.test(runTracePage) &&
      /Applied Receipts/.test(runTracePage) &&
      /Verification Commands/.test(runTracePage) &&
      /"improvements"/.test(runTracePage) &&
      /latestShadowTest/.test(runTracePage) &&
      /decisions/.test(runTracePage) &&
      /listSelfImprovementCandidates/.test(improvementsApi) &&
      /Trace diagnostics improvements smoke passed/.test(traceDiagnosticsImprovementsSmoke) &&
      /diagnostic summary exposes applied receipt coverage/.test(traceDiagnosticsImprovementsSmoke) &&
      /trace-diagnostics-improvements-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Trace diagnostics improvements smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "queued self-improvement candidates and verification commands should be inspectable from trace diagnostics, the run trace page, and run API, not hidden in normal chat output",
  );
  expect(
    "self-improvement lifecycle requires shadow test and human decision",
    /runSelfImprovementShadowTest/.test(selfImprovement) &&
      /prepareSelfImprovementPatchBundle/.test(selfImprovement) &&
      /decideSelfImprovementCandidate/.test(selfImprovement) &&
      /allowedVerificationCommands/.test(selfImprovement) &&
      /Candidate must have a prepared patch bundle before approval/.test(selfImprovement) &&
      /Candidate must be approved before mark_applied/.test(selfImprovement) &&
      /mark_applied requires verification_receipt/.test(selfImprovement) &&
      /verification_receipt\.commandResults is missing required command/.test(selfImprovement) &&
      /buildAppliedVerificationReceipt/.test(selfImprovement) &&
      /commandResults/.test(selfImprovement) &&
      /sourcePatchAppliedBySystem: false/.test(selfImprovement) &&
      /mark_applied records verification receipt/.test(readProjectFile("scripts/self-improvement-lifecycle-smoke.mjs")) &&
      /mark_applied without verification receipt is rejected/.test(readProjectFile("scripts/self-improvement-lifecycle-smoke.mjs")) &&
      /shadow_test/.test(improvementActionApi) &&
      /prepare_patch_bundle/.test(improvementActionApi) &&
      /self_improvement\.candidate\.shadow_tested/.test(improvementActionApi) &&
      /self_improvement\.candidate\.patch_bundle_prepared/.test(improvementActionApi) &&
      /self_improvement\.candidate\.decision_recorded/.test(improvementActionApi),
    "self-improvement should support queued -> shadow_tested -> patch_prepared -> approved/rejected/deferred/applied without auto-applying patches",
  );
  expect(
    "self-improvement lifecycle is operable from Run Trace UI",
    /ImprovementActions/.test(runTracePage) &&
      /actions\?: React\.ReactNode/.test(runTracePage) &&
      /"use client"/.test(improvementActions) &&
      /router\.refresh/.test(improvementActions) &&
      /shadow_test/.test(improvementActions) &&
      /prepare_patch_bundle/.test(improvementActions) &&
      /mark_applied/.test(improvementActions) &&
      /ImprovementDiagnosticsActions/.test(runTracePage) &&
      /run_diagnostics_analysis/.test(improvementActions) &&
      /self-improvement-ui-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Self-improvement UI smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")) &&
      /run trace exposes diagnostics analysis action/.test(selfImprovementUiSmoke) &&
      /Self-improvement UI smoke passed/.test(selfImprovementUiSmoke),
    "Run Trace should let operators shadow-test, prepare bundles, and record human decisions without leaving the trace surface",
  );
  expect(
    "self-improvement queue health is summarized for operators and automation",
    /summarizeSelfImprovementCandidates/.test(selfImprovement) &&
      /SelfImprovementQueueSummary/.test(selfImprovement) &&
      /queueHealth/.test(selfImprovement) &&
      /highSeverityOpen/.test(selfImprovement) &&
      /nextOperatorActions/.test(selfImprovement) &&
      /appliedMissingReceipt/.test(selfImprovement) &&
      /summary: summarizeSelfImprovementCandidates\(improvements\)/.test(improvementsApi) &&
      /Queue Health/.test(runTracePage) &&
      /Next Operator Actions/.test(runTracePage) &&
      /Queue Distribution/.test(runTracePage) &&
      /self-improvement-summary-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /self-improvement-summary-api-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Self-improvement summary smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")) &&
      /Self-improvement summary API smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")) &&
      /Self-improvement summary smoke passed/.test(selfImprovementSummarySmoke) &&
      /Self-improvement summary API smoke passed/.test(selfImprovementSummaryApiSmoke),
    "self-improvement should expose queue-level risk, lifecycle, receipt, and next-action summaries instead of only individual candidate cards",
  );
  expect(
    "evaluator checks weak evidence",
    /required_web_evidence/.test(evaluator) &&
      /empty_web_result_recovery/.test(evaluator) &&
      /required_site_domain_respected/.test(evaluator),
    "run health should fail when fresh web evidence is missing, unrecovered, or outside required domains",
  );
  expect(
    "diagnostics exposes quality issues",
    /qualityIssues/.test(diagnostics) &&
      /scored 100% despite an empty web-search observation/.test(diagnostics) &&
      /required site\/domain constraint/.test(diagnostics),
    "conversation diagnostics should call out false-positive evals and source constraint mismatches",
  );
  expect(
    "diagnostics exposes sandbox preflight issues",
      /buildSandboxSummary/.test(diagnostics) &&
      /buildObservationSummary/.test(diagnostics) &&
      /buildRemediationPlan/.test(diagnostics) &&
      /e2b-preflight/.test(diagnostics) &&
      /e2b-live-smoke-receipt/.test(diagnostics) &&
      /sandboxSessions/.test(diagnostics) &&
      /observations/.test(diagnostics) &&
      /sandbox_preflight_failed/.test(diagnostics) &&
      /missingEnv/.test(diagnostics) &&
      /verificationCommands/.test(diagnostics) &&
      /liveSmokeVerifiedCount/.test(diagnostics) &&
      /liveSmokeReceiptPaths/.test(diagnostics) &&
      /diagnostic summary includes observation evidence/.test(traceDiagnosticsSandboxSmoke) &&
      /diagnostic summary exposes sandbox remediation plan/.test(traceDiagnosticsSandboxSmoke) &&
      /e2b-live-receipt-smoke/.test(traceDiagnosticsSandboxSmoke) &&
      /live smoke receipt coverage/.test(traceDiagnosticsSandboxSmoke) &&
      /Trace diagnostics sandbox smoke passed/.test(traceDiagnosticsSandboxSmoke) &&
      /trace-diagnostics-sandbox-smoke/.test(readProjectFile("DATASWARM_CANONICAL_PLAN.md")) &&
      /Trace diagnostics sandbox smoke passed/.test(readProjectFile("IMPLEMENTATION_STATUS.md")),
    "conversation diagnostics should summarize E2B/sandbox session failures without requiring raw event inspection",
  );
  expect(
    "trace query summaries expose remediation counts",
    /remediation/.test(diagnostics) &&
      /Remediation:/.test(registry) &&
      /diagnostic summary exposes self-improvement remediation plan/.test(traceDiagnosticsImprovementsSmoke),
    "trace.query output should advertise structured remediation items for downstream self-improvement and operator triage",
  );
  expect(
    "trace diagnostics skill is selectable",
    /syncLocalSkills/.test(skills) &&
      /availableSkills/.test(planner) &&
      existsSync(path.join(root, "skills/trace-diagnostics/SKILL.md")),
    "DataSwarm should expose trace-diagnostics through the local skill catalog for planner use_skill actions",
  );
  expect(
    "skills expose v2 manifests to planner",
    /SkillManifest/.test(skills) &&
      /readSkillManifest/.test(skills) &&
      /required_tools/.test(planner) &&
      ["web-research", "report-generation", "data-profiling", "trace-diagnostics"].every((name) =>
        existsSync(path.join(root, "skills", name, "skill.json")),
      ),
    "Skills V2 should provide activation guidance, required tools, preferred capabilities, and quality checks to the planner",
  );
  expect(
    "suggested prompts expand searches by default",
    /buildSuggestionCandidates/.test(conversationWorkspace) &&
      /继续检索/.test(conversationWorkspace) &&
      /GitHub、社媒和技术博客/.test(conversationWorkspace),
    "recommended next questions should continue the user's research intent instead of defaulting to source audits",
  );
  expect(
    "source audit suggestions require explicit user intent",
    /isExplicitSourceAuditRequest/.test(conversationWorkspace) &&
      /shouldUseAssistantSuggestedPrompt/.test(conversationWorkspace) &&
      !/v2 一手来源版/.test(conversationWorkspace),
    "source/date/trust wording in an assistant answer should not force one-source audit prompts unless the user asked for it",
  );
}

function assertConversationRegressionEvidence() {
  expect("sqlite database exists", existsSync(dbPath), dbPath);
  if (!existsSync(dbPath)) {
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const conversation = db
    .prepare("SELECT id, title, status FROM conversations WHERE id = ?")
    .get(targetConversationId);
  expect("target conversation exists", Boolean(conversation), targetConversationId);
  if (!conversation) {
    db.close();
    return;
  }

  const runs = db
    .prepare("SELECT id, status, model_profile FROM runs WHERE conversation_id = ? ORDER BY created_at ASC")
    .all(targetConversationId);
  const runIds = runs.map((run) => run.id);
  expect("target conversation has runs", runIds.length > 0, `${runIds.length} run(s)`);

  const placeholders = runIds.map(() => "?").join(",");
  const toolCalls =
    runIds.length > 0
      ? db
          .prepare(
            `SELECT tc.id, tc.run_id, t.name AS tool_name, tc.status, tc.input_summary, tc.output_summary, tc.output_payload_uri
             FROM tool_calls tc
             JOIN tools t ON t.id = tc.tool_id
             WHERE tc.run_id IN (${placeholders})
             ORDER BY tc.created_at ASC`,
          )
          .all(...runIds)
      : [];
  const toolCallsWithPayload = toolCalls.map((call) => ({
    ...call,
    output_payload: readLocalPayload(call.output_payload_uri),
  }));
  const emptyWebToolCalls = toolCallsWithPayload.filter((call) => {
    const sources = Array.isArray(call.output_payload?.sources) ? call.output_payload.sources : [];
    return call.tool_name === "tavily.search" && call.status === "completed" && sources.length === 0;
  });
  expect(
    "historical target exposes empty web search failure",
    emptyWebToolCalls.length > 0,
    `${emptyWebToolCalls.length} empty tavily.search call(s)`,
  );

  const events =
    runIds.length > 0
      ? db
          .prepare(
            `SELECT run_id, event_type, payload_json
             FROM run_events
             WHERE run_id IN (${placeholders})
             ORDER BY run_id ASC, seq ASC`,
          )
          .all(...runIds)
      : [];
  const eventCountsByRun = countBy(
    events.filter((event) => event.event_type === "tool.call.completed"),
    (event) => event.run_id,
  );
  const replanRunIds = new Set(
    events.filter((event) => event.event_type === "agent.replan.requested").map((event) => event.run_id),
  );
  const unrecoveredEmptyRuns = emptyWebToolCalls.filter((call) => {
    const completedToolCount = eventCountsByRun.get(call.run_id) ?? 0;
    return completedToolCount <= 1 && !replanRunIds.has(call.run_id);
  });
  expect(
    "historical target shows missing empty-result recovery",
    unrecoveredEmptyRuns.length > 0,
    `${unrecoveredEmptyRuns.length} run(s) stopped without replan/fallback`,
  );

  const evals =
    runIds.length > 0
      ? db
          .prepare(`SELECT id, run_id, score, summary FROM eval_results WHERE run_id IN (${placeholders})`)
          .all(...runIds)
      : [];
  const falsePositiveEvals = evals.filter(
    (evalResult) =>
      Number(evalResult.score) >= 1 && emptyWebToolCalls.some((call) => call.run_id === evalResult.run_id),
  );
  expect(
    "historical target exposes false-positive health score",
    falsePositiveEvals.length > 0,
    `${falsePositiveEvals.length} perfect eval(s) attached to empty web evidence`,
  );

  const tools = db
    .prepare("SELECT name, enabled FROM tools WHERE name IN ('web.search', 'trace.query', 'tavily.search', 'artifact.create', 'file.read', 'approval.request')")
    .all();
  const genericWebSearchTool = tools.find((tool) => tool.name === "web.search");
  const traceTool = tools.find((tool) => tool.name === "trace.query");
  const tavilyTool = tools.find((tool) => tool.name === "tavily.search");
  const artifactTool = tools.find((tool) => tool.name === "artifact.create");
  const fileReadTool = tools.find((tool) => tool.name === "file.read");
  const approvalTool = tools.find((tool) => tool.name === "approval.request");
  expect(
    "web.search tool is enabled in DB after app seed",
    genericWebSearchTool?.enabled === 1,
    JSON.stringify(genericWebSearchTool ?? null),
  );
  expect("trace.query tool is enabled in DB", traceTool?.enabled === 1, JSON.stringify(traceTool ?? null));
  expect("tavily.search provider adapter remains enabled in DB", tavilyTool?.enabled === 1, JSON.stringify(tavilyTool ?? null));
  expect("artifact.create tool is enabled in DB", artifactTool?.enabled === 1, JSON.stringify(artifactTool ?? null));
  expect("file.read tool is enabled in DB", fileReadTool?.enabled === 1, JSON.stringify(fileReadTool ?? null));
  expect("approval.request tool is enabled in DB", approvalTool?.enabled === 1, JSON.stringify(approvalTool ?? null));

  const migrations = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all();
  const migrationVersions = new Set(migrations.map((migration) => migration.version));
  expect(
    "self-improvement migration is applied",
    migrationVersions.has("0003_self_improvement_candidates"),
    Array.from(migrationVersions).join(", "),
  );

  const selfImprovementTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'self_improvement_candidates'")
    .get();
  expect("self-improvement candidate table exists", Boolean(selfImprovementTable), JSON.stringify(selfImprovementTable ?? null));

  db.close();
}

async function assertDiagnosticsApiIfConfigured() {
  const baseUrl = process.env.DATASWARM_DIAGNOSTICS_URL;
  if (!baseUrl) {
    expect("diagnostics API smoke skipped", true, "set DATASWARM_DIAGNOSTICS_URL=http://localhost:3000 to enable");
    return;
  }

  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/api/diagnostics/conversations/${targetConversationId}`,
  );
  if (!response.ok) {
    expect("diagnostics API returns target conversation", false, `HTTP ${response.status}`);
    return;
  }
  const payload = await response.json();
  const issues = payload?.diagnostic?.summary?.qualityIssues;
  expect(
    "diagnostics API exposes quality issues",
    Array.isArray(issues) && issues.length >= 3,
    `${Array.isArray(issues) ? issues.length : 0} issue(s)`,
  );
}

assertStaticRuntimeInvariants();
assertConversationRegressionEvidence();
await assertDiagnosticsApiIfConfigured();

const failed = results.filter((result) => !result.passed);
for (const result of results) {
  const marker = result.passed ? "PASS" : "FAIL";
  console.log(`${marker} ${result.name}: ${result.detail}`);
}

if (failed.length > 0) {
  console.error(`\nAgentic Loop V2 smoke failed: ${failed.length}/${results.length} check(s) failed.`);
  process.exit(1);
}

console.log(`\nAgentic Loop V2 smoke passed: ${results.length}/${results.length} check(s) passed.`);
