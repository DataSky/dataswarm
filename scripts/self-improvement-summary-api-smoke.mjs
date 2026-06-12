import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const port = Number(process.env.DATASWARM_SELF_IMPROVEMENT_SUMMARY_PORT ?? 3230);
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
  const conversationId = `conv_si_summary_${suffix}`;
  const runId = `run_si_summary_${suffix}`;
  const taskId = `task_si_summary_${suffix}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO conversations
     (id, tenant_id, project_id, user_id, title, status, default_model, context_summary, last_run_id, last_message_at, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', 'usr_default', '[smoke] self improvement summary', 'active',
      'dmx:claude-opus-4-8', NULL, ?, ?, '{}', ?, ?)`,
  ).run(conversationId, runId, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId));

  db.prepare(
    `INSERT INTO tasks
     (id, tenant_id, project_id, conversation_id, parent_task_id, title, objective, task_type, status, priority, risk_level,
      input_refs_json, acceptance_criteria_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, '[smoke] self improvement summary task',
      'verify self-improvement queue summary', 'diagnostics', 'completed', 0, 'low', '[]', '[]', '{}', ?, ?)`,
  ).run(taskId, conversationId, now, now);
  cleanup.push(() => db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId));

  db.prepare(
    `INSERT INTO runs
     (id, tenant_id, project_id, conversation_id, task_id, mode, status, model_profile, attempt, started_at, ended_at,
      budget_json, result_summary, error_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, 'agent', 'completed', 'dmx:claude-opus-4-8', 1, ?, ?,
      '{}', 'self-improvement summary smoke', NULL, '{}', ?, ?)`,
  ).run(runId, conversationId, taskId, now, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM runs WHERE id = ?").run(runId));
  cleanup.push(() => db.prepare("DELETE FROM self_improvement_candidates WHERE run_id = ?").run(runId));

  const requiredCommands = [
    "npm --prefix apps/web run typecheck",
    "node scripts/self-improvement-summary-smoke.mjs",
  ];
  const candidates = [
    { id: "queued_high", type: "runtime_policy_patch", status: "queued", severity: "high", proposal: {} },
    { id: "shadow_ready", type: "prompt_patch", status: "shadow_tested", severity: "medium", proposal: {} },
    { id: "patch_ready", type: "tool_adapter_patch", status: "patch_prepared", severity: "high", proposal: {} },
    { id: "approved_waiting", type: "skill_patch", status: "approved", severity: "low", proposal: {} },
    {
      id: "applied_with_receipt",
      type: "ui_bug_report",
      status: "applied",
      severity: "medium",
      proposal: {
        decisions: [
          {
            action: "mark_applied",
            status: "applied",
            verificationReceipt: {
              commandResults: requiredCommands.map((command) => ({ command, status: "passed", summary: "passed in smoke" })),
            },
          },
        ],
      },
    },
    { id: "applied_missing_receipt", type: "runtime_policy_patch", status: "applied", severity: "high", proposal: { decisions: [] } },
    { id: "rejected_candidate", type: "prompt_patch", status: "rejected", severity: "high", proposal: {} },
    { id: "deferred_candidate", type: "tool_adapter_patch", status: "deferred", severity: "medium", proposal: {} },
  ];

  for (const candidate of candidates) {
    insertCandidate({
      id: `sic_${candidate.id}_${suffix}`,
      runId,
      conversationId,
      candidateType: candidate.type,
      status: candidate.status,
      severity: candidate.severity,
      title: `[smoke] ${candidate.id}`,
      proposal: candidate.proposal,
      verificationPlan: {
        required_commands: requiredCommands,
        acceptance: "Summary API reports queue health accurately.",
      },
      now,
    });
  }
  expect("synthetic self-improvement candidates inserted", true, `${candidates.length} candidate(s)`);

  if (process.env.DATASWARM_SELF_IMPROVEMENT_SUMMARY_SKIP_BUILD !== "1") {
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

  const response = await getJson(`/api/runs/${runId}/improvements`);
  const summary = response?.summary ?? {};
  expect("API returns improvements and summary", response?.improvements?.length === candidates.length && summary.total === candidates.length, JSON.stringify(response));
  expect("summary reports queue health needs attention", summary.queueHealth === "needs_attention", JSON.stringify(summary));
  expect("summary reports lifecycle counters", summary.open === 4 && summary.pendingShadowTest === 1 && summary.readyForPatchBundle === 1 && summary.readyForHumanDecision === 1 && summary.approvedAwaitingApplication === 1, JSON.stringify(summary));
  expect("summary reports risk and receipt counters", summary.highSeverityOpen === 2 && summary.applied === 2 && summary.appliedWithReceipt === 1 && summary.appliedMissingReceipt === 1 && summary.receiptCommandResults === 2, JSON.stringify(summary));
  expect("summary reports distributions", summary.byStatus?.queued === 1 && summary.byStatus?.applied === 2 && summary.bySeverity?.high === 4 && summary.byType?.runtime_policy_patch === 2, JSON.stringify(summary));
  expect(
    "summary reports required commands and next actions",
    summary.requiredCommands?.includes("node scripts/self-improvement-summary-smoke.mjs") &&
      summary.nextOperatorActions?.some((action) => action.id === "repair-applied-receipts") &&
      summary.nextOperatorActions?.some((action) => action.id === "triage-high-severity") &&
      summary.nextOperatorActions?.some((action) => action.id === "run-shadow-tests"),
    JSON.stringify(summary),
  );
} finally {
  for (const item of cleanup.reverse()) {
    item();
  }
  db.close();
  if (server) {
    server.kill("SIGTERM");
    await delay(500);
  }
}

finish();

function insertCandidate(input) {
  db.prepare(
    `INSERT INTO self_improvement_candidates
     (id, tenant_id, project_id, run_id, conversation_id, eval_result_id, candidate_type, status, severity, title, rationale,
      evidence_json, proposal_json, verification_plan_json, trace_span_id, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, NULL, ?, ?, ?, ?, ?,
      ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.conversationId,
    input.candidateType,
    input.status,
    input.severity,
    input.title,
    "Synthetic self-improvement summary smoke candidate.",
    JSON.stringify({ source: "self-improvement-summary-api-smoke" }),
    JSON.stringify(input.proposal),
    JSON.stringify(input.verificationPlan),
    input.now,
    input.now,
  );
}

async function runProductionBuild() {
  const result = spawnSync("npm", ["--prefix", "apps/web", "run", "build"], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    encoding: "utf8",
  });
  expect("production build refreshed", result.status === 0, `${result.stdout}\n${result.stderr}`);
  if (result.status !== 0) {
    finish();
  }
}

async function waitForHealth(output) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`${baseUrl}/api/system/snapshot`);
      if (response.ok) {
        expect("production server healthy", true, baseUrl);
        return;
      }
    } catch {
      // keep waiting
    }
    if (output.some((line) => /EADDRINUSE|Error:/i.test(line))) {
      break;
    }
    await delay(500);
  }
  expect("production server healthy", false, output.join("\n"));
  finish();
}

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed with ${response.status}: ${text}`);
  }
  return body;
}

function expect(name, condition, detail = "") {
  results.push({ name, passed: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nSelf-improvement summary API smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSelf-improvement summary API smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
