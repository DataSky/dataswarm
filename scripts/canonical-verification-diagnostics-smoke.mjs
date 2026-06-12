import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const port = Number(process.env.DATASWARM_CANONICAL_DIAGNOSTICS_PORT ?? 3238);
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
  writeSyntheticReceipts();

  const suffix = Date.now();
  const conversationId = `conv_canonical_diag_${suffix}`;
  const runId = `run_canonical_diag_${suffix}`;
  const taskId = `task_canonical_diag_${suffix}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO conversations
     (id, tenant_id, project_id, user_id, title, status, default_model, context_summary, last_run_id, last_message_at, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', 'usr_default', '[smoke] canonical verification diagnostics', 'active',
      'dmx:claude-opus-4-8', NULL, ?, ?, '{}', ?, ?)`,
  ).run(conversationId, runId, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId));

  db.prepare(
    `INSERT INTO tasks
     (id, tenant_id, project_id, conversation_id, parent_task_id, title, objective, task_type, status, priority, risk_level,
      input_refs_json, acceptance_criteria_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, '[smoke] canonical diagnostics task',
      'diagnose canonical verification receipts', 'diagnostics', 'completed', 0, 'low', '[]', '[]', '{}', ?, ?)`,
  ).run(taskId, conversationId, now, now);
  cleanup.push(() => db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId));

  db.prepare(
    `INSERT INTO runs
     (id, tenant_id, project_id, conversation_id, task_id, mode, status, model_profile, attempt, started_at, ended_at,
      budget_json, result_summary, error_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, 'chat', 'completed', 'dmx:claude-opus-4-8', 1, ?, ?,
      '{}', 'completed', NULL, '{}', ?, ?)`,
  ).run(runId, conversationId, taskId, now, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM runs WHERE id = ?").run(runId));
  expect("synthetic canonical diagnostics conversation inserted", true, `${conversationId} ${runId}`);

  if (process.env.DATASWARM_CANONICAL_DIAGNOSTICS_SKIP_BUILD !== "1") {
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
  expect(
    "diagnostic exposes canonical verification receipt summary",
    diagnostic?.summary?.canonicalVerification?.receiptCount === 3 &&
      diagnostic.summary.canonicalVerification.totalGates === 49 &&
      diagnostic.summary.canonicalVerification.passed === 2 &&
      diagnostic.summary.canonicalVerification.failed === 0 &&
      diagnostic.summary.canonicalVerification.gatedSkip === 4 &&
      diagnostic.summary.canonicalVerification.notRun === 43 &&
      diagnostic.summary.canonicalVerification.liveE2bRequired === true &&
      diagnostic.summary.canonicalVerification.liveE2bGated === true,
    JSON.stringify(diagnostic?.summary?.canonicalVerification ?? null),
  );
  expect(
    "diagnostic canonical phase summary is present",
    diagnostic?.summary?.canonicalVerification?.phases?.phase4?.total === 16 &&
      diagnostic.summary.canonicalVerification.phases.phase4.gatedSkip === 4,
    JSON.stringify(diagnostic?.summary?.canonicalVerification?.phases ?? null),
  );
  expect(
    "diagnosis text mentions canonical live E2B gating",
    diagnostic?.summary?.diagnosis?.some((item) => String(item).includes("Canonical verification receipts")) &&
      diagnostic.summary.diagnosis.some((item) => String(item).includes("live E2B sandbox execution is still gated")),
    JSON.stringify(diagnostic?.summary?.diagnosis ?? null),
  );
  expect(
    "diagnostic remediation includes canonical verification gates",
    diagnostic?.summary?.remediation?.some(
      (item) =>
        item.id === "canonical-verification-gates" &&
        item.category === "verification" &&
        item.verificationCommands.includes(
          "node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b",
        ),
    ),
    JSON.stringify(diagnostic?.summary?.remediation ?? null),
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

function writeSyntheticReceipts() {
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
  const build = spawn("npm", ["--prefix", "apps/web", "run", "build"], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  build.stdout.on("data", (chunk) => output.push(String(chunk)));
  build.stderr.on("data", (chunk) => output.push(String(chunk)));
  const status = await new Promise((resolve) => build.on("close", resolve));
  expect("production build refreshed", status === 0, output.join("\n").slice(-4000));
  if (status !== 0) {
    finish();
  }
}

async function waitForHealth(output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/conversations`);
      if (response.ok) {
        expect("canonical diagnostics server healthy", true, baseUrl);
        return;
      }
    } catch {
      // keep waiting
    }
    await delay(500);
  }
  expect("canonical diagnostics server healthy", false, output.join("\n").slice(-4000));
  finish();
}

function expect(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nCanonical verification diagnostics smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nCanonical verification diagnostics smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
