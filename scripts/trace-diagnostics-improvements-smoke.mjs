import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const port = Number(process.env.DATASWARM_TRACE_DIAGNOSTICS_IMPROVEMENTS_PORT ?? 3225);
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
  const conversationId = `conv_diag_improvements_${suffix}`;
  const runId = `run_diag_improvements_${suffix}`;
  const taskId = `task_diag_improvements_${suffix}`;
  const candidateId = `sic_diag_improvements_${suffix}`;
  const appliedCandidateId = `sic_diag_improvements_applied_${suffix}`;
  const now = new Date().toISOString();
  const appliedRequiredCommands = [
    "npm --prefix apps/web run typecheck",
    "node scripts/e2b-template-smoke.mjs",
    "node scripts/e2b-template-receipt-smoke.mjs",
    "node scripts/e2b-readiness-smoke.mjs",
  ];

  db.prepare(
    `INSERT INTO conversations
     (id, tenant_id, project_id, user_id, title, status, default_model, context_summary, last_run_id, last_message_at, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', 'usr_default', '[smoke] diagnostics improvements', 'active',
      'dmx:claude-opus-4-8', NULL, ?, ?, '{}', ?, ?)`,
  ).run(conversationId, runId, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId));

  db.prepare(
    `INSERT INTO tasks
     (id, tenant_id, project_id, conversation_id, parent_task_id, title, objective, task_type, status, priority, risk_level,
      input_refs_json, acceptance_criteria_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, '[smoke] diagnostics task',
      'diagnose self-improvement visibility', 'diagnostics', 'completed', 0, 'low', '[]', '[]', '{}', ?, ?)`,
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

  db.prepare(
    `INSERT INTO self_improvement_candidates
     (id, tenant_id, project_id, run_id, conversation_id, eval_result_id, candidate_type, status, severity, title, rationale,
      evidence_json, proposal_json, verification_plan_json, trace_span_id, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, NULL, 'runtime_policy_patch', 'queued', 'medium',
      'Improve E2B template readiness', 'Synthetic diagnostic candidate.',
      ?, ?, ?, NULL, ?, ?)`,
  ).run(
    candidateId,
    runId,
    conversationId,
    JSON.stringify({ check_id: "e2b_template_contract", trace_id: "trace_diag_improvements" }),
    JSON.stringify({ recommendation: "Verify E2B template contract before live smoke.", generated_by: "smoke" }),
    JSON.stringify({
      required_commands: [
        "npm --prefix apps/web run typecheck",
        "node scripts/e2b-template-smoke.mjs",
        "node scripts/e2b-template-receipt-smoke.mjs",
        "node scripts/e2b-readiness-smoke.mjs",
      ],
      acceptance: "Diagnostics expose candidate verification commands.",
    }),
    now,
    now,
  );
  cleanup.push(() => db.prepare("DELETE FROM self_improvement_candidates WHERE id = ?").run(candidateId));

  db.prepare(
    `INSERT INTO self_improvement_candidates
     (id, tenant_id, project_id, run_id, conversation_id, eval_result_id, candidate_type, status, severity, title, rationale,
      evidence_json, proposal_json, verification_plan_json, trace_span_id, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, NULL, 'runtime_policy_patch', 'applied', 'medium',
      'Applied E2B template readiness improvement', 'Synthetic applied diagnostic candidate.',
      ?, ?, ?, NULL, ?, ?)`,
  ).run(
    appliedCandidateId,
    runId,
    conversationId,
    JSON.stringify({ check_id: "e2b_template_contract_applied", trace_id: "trace_diag_improvements" }),
    JSON.stringify({
      recommendation: "Verify E2B template contract before live smoke.",
      generated_by: "smoke",
      decisions: [
        { action: "approve", status: "approved", decidedAt: now, actor: "local_user" },
        {
          action: "mark_applied",
          status: "applied",
          decidedAt: now,
          actor: "local_user",
          verificationReceipt: {
            recordedAt: now,
            actor: "local_user",
            operatorConfirmed: true,
            submittedAt: now,
            requiredCommands: appliedRequiredCommands,
            commandResults: appliedRequiredCommands.map((command) => ({
              command,
              status: "passed",
              summary: "Diagnostics smoke verified command-level applied receipt coverage.",
            })),
            policy: {
              autoApply: false,
              sourcePatchAppliedBySystem: false,
            },
          },
        },
      ],
    }),
    JSON.stringify({
      required_commands: appliedRequiredCommands,
      acceptance: "Diagnostics expose applied verification receipt coverage.",
    }),
    now,
    now,
  );
  cleanup.push(() => db.prepare("DELETE FROM self_improvement_candidates WHERE id = ?").run(appliedCandidateId));
  expect("synthetic conversation/run/candidate inserted", true, `${conversationId} ${runId} ${candidateId}`);

  if (process.env.DATASWARM_TRACE_DIAGNOSTICS_IMPROVEMENTS_SKIP_BUILD !== "1") {
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
    "diagnostic includes self-improvement candidate rows",
    diagnostic?.selfImprovementCandidates?.some((item) => item.id === candidateId) &&
      diagnostic.selfImprovementCandidates.some((item) => item.id === appliedCandidateId),
    JSON.stringify(diagnostic?.selfImprovementCandidates ?? null),
  );
  expect(
    "diagnostic summary includes self-improvement counts",
    diagnostic?.summary?.selfImprovement?.candidateCount === 2 &&
      diagnostic.summary.selfImprovement.queuedCount === 1 &&
      diagnostic.summary.selfImprovement.appliedCount === 1 &&
      diagnostic.summary.selfImprovement.candidateTypes.runtime_policy_patch === 2,
    JSON.stringify(diagnostic?.summary?.selfImprovement ?? null),
  );
  expect(
    "diagnostic summary exposes candidate verification commands",
    diagnostic?.summary?.selfImprovement?.requiredCommands?.includes("node scripts/e2b-template-smoke.mjs") &&
      diagnostic.summary.selfImprovement.requiredCommands.includes("node scripts/e2b-template-receipt-smoke.mjs") &&
      diagnostic.summary.selfImprovement.requiredCommands.includes("node scripts/e2b-readiness-smoke.mjs"),
    JSON.stringify(diagnostic?.summary?.selfImprovement ?? null),
  );
  expect(
    "diagnostic summary exposes applied receipt coverage",
    diagnostic?.summary?.selfImprovement?.appliedWithVerificationReceiptCount === 1 &&
      diagnostic.summary.selfImprovement.appliedMissingVerificationReceiptCount === 0 &&
      diagnostic.summary.selfImprovement.appliedReceiptCommandResultCount === appliedRequiredCommands.length &&
      diagnostic.summary.selfImprovement.appliedReceiptRequiredCommandCoverage?.[appliedCandidateId]?.complete === true,
    JSON.stringify(diagnostic?.summary?.selfImprovement ?? null),
  );
  expect(
    "diagnostic summary reports no missing applied receipts",
    diagnostic?.summary?.selfImprovement?.appliedMissingVerificationReceiptCount === 0 &&
      diagnostic.summary.selfImprovement.appliedWithVerificationReceiptCount === diagnostic.summary.selfImprovement.appliedCount,
    JSON.stringify(diagnostic?.summary?.selfImprovement ?? null),
  );
  expect(
    "diagnosis text mentions self-improvement candidates",
    diagnostic?.summary?.diagnosis?.some((item) => String(item).includes("self-improvement candidate")) &&
      diagnostic.summary.diagnosis.some((item) => String(item).includes("e2b-template-smoke")) &&
      diagnostic.summary.diagnosis.some((item) => String(item).includes("command-level verification receipts")),
    JSON.stringify(diagnostic?.summary?.diagnosis ?? null),
  );
  expect(
    "diagnostic summary exposes self-improvement remediation plan",
    diagnostic?.summary?.remediation?.some(
      (item) =>
        item.id === "self-improvement-review" &&
        item.category === "self_improvement" &&
        item.verificationCommands.includes("node scripts/e2b-template-smoke.mjs"),
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
    console.error(`\nTrace diagnostics improvements smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nTrace diagnostics improvements smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
