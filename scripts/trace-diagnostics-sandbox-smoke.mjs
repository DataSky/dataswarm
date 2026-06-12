import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const port = Number(process.env.DATASWARM_TRACE_DIAGNOSTICS_SANDBOX_PORT ?? 3228);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const results = [];
const cleanup = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

const db = new DatabaseSync(dbPath);

try {
  const suffix = Date.now();
  const conversationId = `conv_diag_sandbox_${suffix}`;
  const runId = `run_diag_sandbox_${suffix}`;
  const taskId = `task_diag_sandbox_${suffix}`;
  const agentSessionId = `agent_diag_sandbox_${suffix}`;
  const sandboxSessionId = `sandbox_diag_sandbox_${suffix}`;
  const observationId = `obs_diag_sandbox_${suffix}`;
  const eventId = `evt_diag_sandbox_${suffix}`;
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
     VALUES (?, 'ten_default', 'prj_default', 'usr_default', '[smoke] diagnostics sandbox', 'active',
      'dmx:claude-opus-4-8', NULL, ?, ?, '{}', ?, ?)`,
  ).run(conversationId, runId, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId));

  db.prepare(
    `INSERT INTO tasks
     (id, tenant_id, project_id, conversation_id, parent_task_id, title, objective, task_type, status, priority, risk_level,
      input_refs_json, acceptance_criteria_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, '[smoke] diagnostics sandbox task',
      'diagnose sandbox preflight visibility', 'diagnostics', 'completed', 0, 'low', '[]', '[]', '{}', ?, ?)`,
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
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, 'swarm_branch', 'Diagnostics Sandbox Branch',
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
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, 'agent', 'swarm.branch.branch_diag_sandbox',
      'failed', 'Diagnostics branch failed by sandbox preflight.', NULL, 'real', '[]', ?, ?, ?)`,
  ).run(
    observationId,
    runId,
    JSON.stringify({
      branch_id: "branch_diag_sandbox",
      sandbox_session_id: sandboxSessionId,
      context_bundle_id: "ctx_diag_sandbox",
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
        branch_id: "branch_diag_sandbox",
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
  expect("synthetic sandbox preflight conversation inserted", true, `${conversationId} ${runId}`);

  if (process.env.DATASWARM_TRACE_DIAGNOSTICS_SANDBOX_SKIP_BUILD !== "1") {
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

  const response = await fetch(`${baseUrl}/api/diagnostics/conversations/${conversationId}`);
  const body = await response.json();
  const diagnostic = body.diagnostic;
  expect("diagnostics API returns 200", response.ok, JSON.stringify(body));
  expect("diagnostic returned conversation", diagnostic?.conversation?.id === conversationId, JSON.stringify(diagnostic?.conversation ?? null));
  expect("diagnostic includes observation row", diagnostic?.observations?.some((item) => item.id === observationId), JSON.stringify(diagnostic?.observations ?? null));
  expect(
    "diagnostic summary includes observation evidence",
    diagnostic?.summary?.observations?.observationCount === 1 &&
      diagnostic.summary.observations.branchObservationCount === 1 &&
      diagnostic.summary.observations.failedBranchObservationCount === 1 &&
      diagnostic.summary.observations.sandboxPreflightBranchObservationCount === 1 &&
      diagnostic.summary.observations.missingEnv.includes("E2B_API_KEY") &&
      diagnostic.summary.observations.verificationCommands.includes("node scripts/e2b-readiness-smoke.mjs") &&
      diagnostic.summary.observations.verificationCommands.includes("node scripts/e2b-live-receipt-smoke.mjs") &&
      diagnostic.summary.observations.liveSmokeUnverifiedCount >= 1 &&
      diagnostic.summary.observations.liveSmokeReceiptPaths.includes("data/e2b/live-smoke-receipt.json"),
    JSON.stringify(diagnostic?.summary?.observations ?? null),
  );
  expect("diagnostic includes sandbox session row", diagnostic?.sandboxSessions?.some((item) => item.id === sandboxSessionId), JSON.stringify(diagnostic?.sandboxSessions ?? null));
  expect(
    "diagnostic summary counts e2b sandbox sessions",
    diagnostic?.summary?.sandbox?.sessionCount === 1 &&
      diagnostic.summary.sandbox.e2bSessionCount === 1 &&
      diagnostic.summary.sandbox.providers.e2b === 1 &&
      diagnostic.summary.sandbox.statuses.failed === 1,
    JSON.stringify(diagnostic?.summary?.sandbox ?? null),
  );
  expect(
    "diagnostic summary exposes sandbox preflight details",
    diagnostic?.summary?.sandbox?.preflightFailureCount >= 1 &&
      diagnostic.summary.sandbox.missingEnv.includes("E2B_API_KEY") &&
      diagnostic.summary.sandbox.verificationCommands.includes("node scripts/e2b-readiness-smoke.mjs") &&
      diagnostic.summary.sandbox.verificationCommands.includes("node scripts/e2b-live-receipt-smoke.mjs") &&
      diagnostic.summary.sandbox.liveSmokeUnverifiedCount >= 1 &&
      diagnostic.summary.sandbox.liveSmokeReceiptPaths.includes("data/e2b/live-smoke-receipt.json"),
    JSON.stringify(diagnostic?.summary?.sandbox ?? null),
  );
  expect(
    "diagnosis text mentions sandbox preflight failures",
    diagnostic?.summary?.diagnosis?.some((item) => String(item).includes("Sandbox preflight failures detected")) &&
      diagnostic.summary.diagnosis.some((item) => String(item).includes("sandbox preflight branch observation")) &&
      diagnostic.summary.diagnosis.some((item) => String(item).includes("e2b-readiness-smoke")) &&
      diagnostic.summary.diagnosis.some((item) => String(item).includes("live smoke receipt coverage")),
    JSON.stringify(diagnostic?.summary?.diagnosis ?? null),
  );
  expect(
    "diagnostic summary exposes sandbox remediation plan",
    diagnostic?.summary?.remediation?.some(
      (item) =>
        item.id === "e2b-preflight" &&
        item.category === "sandbox_e2b" &&
        item.verificationCommands.includes("node scripts/e2b-preflight-e2e-smoke.mjs"),
    ) &&
      diagnostic.summary.remediation.some(
        (item) =>
          item.id === "e2b-live-smoke-receipt" &&
          item.verificationCommands.includes("node scripts/e2b-sandbox-smoke.mjs"),
      ),
    JSON.stringify(diagnostic?.summary?.remediation ?? null),
  );
} finally {
  for (const item of cleanup.reverse()) {
    item();
  }
  db.close();
  if (server) {
    server.kill("SIGTERM");
    await delay(500);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
  }
}

finish();

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

function expect(name, condition, detail = "") {
  const record = { name, passed: Boolean(condition), detail: String(detail) };
  results.push(record);
  console.log(`${record.passed ? "PASS" : "FAIL"} ${record.name}: ${record.detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nTrace diagnostics sandbox smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nTrace diagnostics sandbox smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
