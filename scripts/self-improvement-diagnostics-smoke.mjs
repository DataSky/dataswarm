import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const port = Number(process.env.DATASWARM_SELF_IMPROVEMENT_DIAGNOSTICS_PORT ?? 3229);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const verificationDir = path.join(dataDir, "verification");
const receiptPaths = [
  path.join(verificationDir, "canonical-verification-latest.json"),
  path.join(verificationDir, "canonical-phase4-e2b-latest.json"),
  path.join(verificationDir, "canonical-phase4-live-required-latest.json"),
];
const results = [];
const cleanup = [];
const receiptBackups = new Map();
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

const db = new DatabaseSync(dbPath);

try {
  backupReceipts();
  writeSyntheticCanonicalReceipts();

  const suffix = Date.now();
  const conversationId = `conv_si_diag_${suffix}`;
  const runId = `run_si_diag_${suffix}`;
  const taskId = `task_si_diag_${suffix}`;
  const agentSessionId = `agent_si_diag_${suffix}`;
  const sandboxSessionId = `sandbox_si_diag_${suffix}`;
  const observationId = `obs_si_diag_${suffix}`;
  const eventId = `evt_si_diag_${suffix}`;
  const now = new Date().toISOString();
  const verificationCommands = [
    "node scripts/e2b-template-smoke.mjs",
    "node scripts/e2b-readiness-smoke.mjs",
    "node scripts/e2b-sandbox-smoke.mjs",
    "node scripts/e2b-live-receipt-smoke.mjs",
  ];
  const attemptFailure = {
    attempt: 0,
    code: "sandbox_preflight_failed",
    message: "E2B live sandbox execution is gated until required environment is configured.",
    retryable: false,
    readiness_status: "needs_credentials",
    missing_env: ["E2B_API_KEY"],
    verification_commands: verificationCommands,
    live_smoke_verified: false,
    live_smoke_receipt_path: "data/e2b/live-smoke-receipt.json",
    live_smoke_receipt_status: "missing",
  };

  db.prepare(
    `INSERT INTO conversations
     (id, tenant_id, project_id, user_id, title, status, default_model, context_summary, last_run_id, last_message_at, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', 'usr_default', '[smoke] self improvement diagnostics', 'active',
      'dmx:claude-opus-4-8', NULL, ?, ?, '{}', ?, ?)`,
  ).run(conversationId, runId, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId));

  db.prepare(
    `INSERT INTO tasks
     (id, tenant_id, project_id, conversation_id, parent_task_id, title, objective, task_type, status, priority, risk_level,
      input_refs_json, acceptance_criteria_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, '[smoke] self improvement diagnostics task',
      'convert diagnostics remediation into self-improvement candidates', 'diagnostics', 'completed', 0, 'low', '[]', '[]', '{}', ?, ?)`,
  ).run(taskId, conversationId, now, now);
  cleanup.push(() => db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId));

  db.prepare(
    `INSERT INTO runs
     (id, tenant_id, project_id, conversation_id, task_id, mode, status, model_profile, attempt, started_at, ended_at,
      budget_json, result_summary, error_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, 'agent', 'completed', 'dmx:claude-opus-4-8', 1, ?, ?,
      '{}', 'completed with sandbox preflight failure', NULL, '{}', ?, ?)`,
  ).run(runId, conversationId, taskId, now, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM runs WHERE id = ?").run(runId));

  db.prepare(
    `INSERT INTO agent_sessions
     (id, tenant_id, project_id, run_id, parent_agent_session_id, agent_role, agent_name, model_profile, status,
      instructions_hash, context_bundle_id, tool_policy_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, 'swarm_branch', 'Diagnostics Self Improvement Branch',
      'deepseek:deepseek-v4-pro', 'failed', NULL, NULL, '{}', '{}', ?, ?)`,
  ).run(agentSessionId, runId, now, now);
  cleanup.push(() => db.prepare("DELETE FROM agent_sessions WHERE id = ?").run(agentSessionId));

  db.prepare(
    `INSERT INTO sandbox_sessions
     (id, tenant_id, project_id, run_id, agent_session_id, provider, external_sandbox_id, status, template,
      started_at, ended_at, last_heartbeat_at, resource_limits_json, env_policy_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, 'e2b', NULL, 'failed', 'dataswarm-agent-runtime',
      ?, ?, ?, '{}', '{}', ?, ?, ?)`,
  ).run(
    sandboxSessionId,
    runId,
    agentSessionId,
    now,
    now,
    now,
    JSON.stringify({
      provider_mode: "e2b",
      error_code: "sandbox_preflight_failed",
      e2b_preflight: {
        status: "needs_credentials",
        provider_selected: true,
        api_key_configured: false,
        missing_env: ["E2B_API_KEY"],
        verification_commands: verificationCommands,
        live_smoke_verified: false,
        live_smoke_receipt_path: "data/e2b/live-smoke-receipt.json",
        live_smoke_receipt_status: "missing",
      },
      attempt_failures: [attemptFailure],
    }),
    now,
    now,
  );
  cleanup.push(() => db.prepare("DELETE FROM sandbox_sessions WHERE id = ?").run(sandboxSessionId));

  db.prepare(
    `INSERT INTO observations
     (id, tenant_id, project_id, run_id, action_id, source_type, source_name, status, summary,
      payload_uri, evidence_level, claims_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, 'agent', 'swarm.branch.branch_si_diag',
      'failed', 'Diagnostics branch failed by sandbox preflight.', NULL, 'real', '[]', ?, ?, ?)`,
  ).run(
    observationId,
    runId,
    JSON.stringify({
      branch_id: "branch_si_diag",
      sandbox_session_id: sandboxSessionId,
      error_code: "sandbox_preflight_failed",
      attempt_failures: [attemptFailure],
    }),
    now,
    now,
  );
  cleanup.push(() => db.prepare("DELETE FROM observations WHERE id = ?").run(observationId));

  db.prepare(
    `INSERT INTO run_events
     (id, tenant_id, project_id, run_id, seq, event_type, producer_kind, producer_id, payload_json, created_at)
     VALUES (?, 'ten_default', 'prj_default', ?, 1, 'swarm.branch.failed', 'agent', ?, ?, ?)`,
  ).run(
    eventId,
    runId,
    agentSessionId,
    JSON.stringify({
      type: "swarm.branch.failed",
      payload: {
        branch_id: "branch_si_diag",
        sandbox_session_id: sandboxSessionId,
        status: "failed",
        error_code: "sandbox_preflight_failed",
        attempt_failures: [attemptFailure],
        observation_id: observationId,
      },
    }),
    now,
  );
  cleanup.push(() => db.prepare("DELETE FROM run_events WHERE id = ?").run(eventId));
  cleanup.push(() => db.prepare("DELETE FROM self_improvement_candidates WHERE run_id = ?").run(runId));
  expect("synthetic diagnostics remediation run inserted", true, `${conversationId} ${runId}`);

  if (process.env.DATASWARM_SELF_IMPROVEMENT_DIAGNOSTICS_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }
  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(String(chunk)));
  server.stderr.on("data", (chunk) => output.push(String(chunk)));
  await waitForHealth(output);

  const first = await postJson(`/api/runs/${runId}/improvements`, { action: "run_diagnostics_analysis" });
  expect("diagnostics analysis API returns candidates", first?.analysis?.candidates?.length === 4, JSON.stringify(first));

  const second = await postJson(`/api/runs/${runId}/improvements`, { action: "run_diagnostics_analysis" });
  expect("diagnostics analysis API is idempotent", second?.analysis?.candidates?.length === 4, JSON.stringify(second));

  const candidateRows = db
    .prepare(
      `SELECT id, candidate_type, severity, evidence_json, proposal_json, verification_plan_json
       FROM self_improvement_candidates
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
      .all(runId);
  expect("four diagnostics remediation candidates persisted", candidateRows.length === 4, JSON.stringify(candidateRows));
  const candidates = candidateRows.map((row) => ({
    ...row,
    evidence: parseJson(row.evidence_json, {}),
    proposal: parseJson(row.proposal_json, {}),
    verificationPlan: parseJson(row.verification_plan_json, {}),
  }));
  expect(
    "candidates reference diagnostics remediation ids",
    ["product-interaction-logs", "e2b-preflight", "e2b-live-smoke-receipt", "canonical-verification-gates"].every((id) =>
      candidates.some((candidate) => candidate.evidence.source === "diagnostics.remediation" && candidate.evidence.remediation_id === id),
    ),
    JSON.stringify(candidates.map((candidate) => candidate.evidence)),
  );
  expect(
    "E2B preflight remediation uses e2e verification gates",
    candidates.some(
      (candidate) =>
        candidate.evidence.remediation_id === "e2b-preflight" &&
        candidate.candidate_type === "runtime_policy_patch" &&
        candidate.severity === "high" &&
        candidate.proposal.generated_by === "self_improvement.diagnostics_analysis" &&
        candidate.verificationPlan.required_commands.includes("node scripts/e2b-preflight-e2e-smoke.mjs") &&
        candidate.verificationPlan.required_commands.includes("node scripts/e2b-template-verification-e2e-smoke.mjs"),
    ),
    JSON.stringify(candidates),
  );
  expect(
    "live smoke receipt remediation uses live smoke gates",
    candidates.some(
      (candidate) =>
        candidate.evidence.remediation_id === "e2b-live-smoke-receipt" &&
        candidate.verificationPlan.required_commands.includes("node scripts/e2b-live-receipt-smoke.mjs") &&
        candidate.verificationPlan.required_commands.includes("node scripts/e2b-sandbox-smoke.mjs"),
    ),
    JSON.stringify(candidates),
  );
  expect(
    "canonical verification remediation uses strict live E2B gate",
    candidates.some(
      (candidate) =>
        candidate.evidence.remediation_id === "canonical-verification-gates" &&
        candidate.evidence.remediation_category === "verification" &&
        candidate.candidate_type === "runtime_policy_patch" &&
        candidate.proposal.generated_by === "self_improvement.diagnostics_analysis" &&
        candidate.verificationPlan.required_commands.includes("node scripts/canonical-verification-runner.mjs --dry-run") &&
        candidate.verificationPlan.required_commands.includes(
          "node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b",
        ),
    ),
    JSON.stringify(candidates),
  );

  const events = db
    .prepare(
      `SELECT event_type
       FROM run_events
       WHERE run_id = ? AND event_type IN (
         'self_improvement.diagnostics_analysis.started',
         'self_improvement.diagnostics_analysis.completed',
         'self_improvement.candidates.queued'
       )`,
    )
    .all(runId)
    .map((row) => row.event_type);
  expect(
    "diagnostics analysis events persisted",
    events.includes("self_improvement.diagnostics_analysis.started") &&
      events.includes("self_improvement.diagnostics_analysis.completed") &&
      events.includes("self_improvement.candidates.queued"),
    JSON.stringify(events),
  );
} finally {
  for (const item of cleanup.reverse()) {
    item();
  }
  db.close();
  restoreReceipts();
  if (server) {
    server.kill("SIGTERM");
    await delay(500);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
  }
}

finish();

function backupReceipts() {
  mkdirSync(verificationDir, { recursive: true });
  for (const receiptPath of receiptPaths) {
    receiptBackups.set(receiptPath, existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : null);
  }
}

function restoreReceipts() {
  for (const [receiptPath, content] of receiptBackups.entries()) {
    if (content === null) {
      rmSync(receiptPath, { force: true });
    } else {
      writeFileSync(receiptPath, content);
    }
  }
}

function writeSyntheticCanonicalReceipts() {
  writeJson(receiptPaths[0], {
    receiptSchema: "dataswarm.canonical-verification.v1",
    mode: "dry-run",
    startedAt: "2026-06-11T00:00:00.000Z",
    completedAt: "2026-06-11T00:00:01.000Z",
    filters: { phases: [], only: [], requireLiveE2b: false, stopOnFailure: false },
    summary: { total: 43, passed: 0, failed: 0, gatedSkip: 0, notRun: 43 },
    phaseSummary: {
      phase1: { total: 7, passed: 0, failed: 0, gatedSkip: 0, notRun: 7 },
      phase2: { total: 3, passed: 0, failed: 0, gatedSkip: 0, notRun: 3 },
      phase3: { total: 13, passed: 0, failed: 0, gatedSkip: 0, notRun: 13 },
      phase4: { total: 10, passed: 0, failed: 0, gatedSkip: 0, notRun: 10 },
      phase5: { total: 10, passed: 0, failed: 0, gatedSkip: 0, notRun: 10 },
    },
    results: [
      { phase: "phase4", key: "e2b-live-sandbox", command: "node scripts/e2b-sandbox-smoke.mjs", status: "not_run" },
      { phase: "phase4", key: "e2b-orchestrator-e2e", command: "node scripts/e2b-orchestrator-e2e-smoke.mjs", status: "not_run" },
      {
        phase: "phase5",
        key: "canonical-verification-diagnostics",
        command: "node scripts/canonical-verification-diagnostics-smoke.mjs",
        status: "not_run",
      },
      {
        phase: "phase5",
        key: "canonical-goal-audit-smoke",
        command: "node scripts/canonical-goal-audit-smoke.mjs",
        status: "not_run",
      },
    ],
  });
  writeJson(receiptPaths[1], {
    receiptSchema: "dataswarm.canonical-verification.v1",
    mode: "run",
    startedAt: "2026-06-11T00:01:00.000Z",
    completedAt: "2026-06-11T00:01:01.000Z",
    filters: { phases: ["phase4"], only: ["e2b-readiness", "e2b-live-receipt", "e2b-live-sandbox", "e2b-orchestrator-e2e"], requireLiveE2b: false, stopOnFailure: false },
    summary: { total: 4, passed: 2, failed: 0, gatedSkip: 2, notRun: 0 },
    phaseSummary: { phase4: { total: 4, passed: 2, failed: 0, gatedSkip: 2, notRun: 0 } },
    results: [
      { phase: "phase4", key: "e2b-readiness", command: "node scripts/e2b-readiness-smoke.mjs", status: "passed" },
      { phase: "phase4", key: "e2b-live-receipt", command: "node scripts/e2b-live-receipt-smoke.mjs", status: "passed" },
      { phase: "phase4", key: "e2b-live-sandbox", command: "node scripts/e2b-sandbox-smoke.mjs", liveExternalGate: true, status: "gated_skip" },
      { phase: "phase4", key: "e2b-orchestrator-e2e", command: "node scripts/e2b-orchestrator-e2e-smoke.mjs", liveExternalGate: true, status: "gated_skip" },
    ],
  });
  writeJson(receiptPaths[2], {
    receiptSchema: "dataswarm.canonical-verification.v1",
    mode: "run",
    startedAt: "2026-06-11T00:02:00.000Z",
    completedAt: "2026-06-11T00:02:01.000Z",
    filters: { phases: ["phase4"], only: ["e2b-live-sandbox", "e2b-orchestrator-e2e"], requireLiveE2b: true, stopOnFailure: false },
    summary: { total: 2, passed: 0, failed: 0, gatedSkip: 2, notRun: 0 },
    phaseSummary: { phase4: { total: 2, passed: 0, failed: 0, gatedSkip: 2, notRun: 0 } },
    results: [
      {
        phase: "phase4",
        key: "e2b-live-sandbox",
        command: "node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b",
        liveExternalGate: true,
        status: "gated_skip",
      },
      {
        phase: "phase4",
        key: "e2b-orchestrator-e2e",
        command: "node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b",
        liveExternalGate: true,
        status: "gated_skip",
      },
    ],
  });
}

function writeJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function runProductionBuild() {
  const output = [];
  const child = spawn("npm", ["--prefix", "apps/web", "run", "build"], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  expect("production build refreshed", exitCode === 0, output.join("\n").slice(-3000));
  if (exitCode !== 0) {
    finish();
  }
}

async function waitForHealth(output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/system/snapshot`).catch(() => null);
    if (response?.ok) {
      expect("production server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("production server healthy", false, output.join("\n").slice(-3000));
  finish();
}

async function postJson(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.status, text };
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function expect(name, condition, detail = "") {
  const record = { name, passed: Boolean(condition), detail: String(detail) };
  results.push(record);
  console.log(`${record.passed ? "PASS" : "FAIL"} ${record.name}: ${record.detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nSelf-improvement diagnostics smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSelf-improvement diagnostics smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
