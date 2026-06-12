import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const port = Number(process.env.DATASWARM_TRACE_DIAGNOSTICS_RUNTIME_PORT ?? 3231);
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
  const conversationId = `conv_diag_runtime_${suffix}`;
  const runId = `run_diag_runtime_${suffix}`;
  const taskId = `task_diag_runtime_${suffix}`;
  const modelSpanId = `span_diag_runtime_model_${suffix}`;
  const swarmPlanSpanId = `span_diag_runtime_plan_${suffix}`;
  const swarmReduceSpanId = `span_diag_runtime_reduce_${suffix}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO conversations
     (id, tenant_id, project_id, user_id, title, status, default_model, context_summary, last_run_id, last_message_at, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', 'usr_default', '[smoke] diagnostics runtime consistency', 'active',
      'dmx:claude-opus-4-8', NULL, ?, ?, '{}', ?, ?)`,
  ).run(conversationId, runId, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId));

  db.prepare(
    `INSERT INTO tasks
     (id, tenant_id, project_id, conversation_id, parent_task_id, title, objective, task_type, status, priority, risk_level,
      input_refs_json, acceptance_criteria_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, '[smoke] runtime consistency task',
      'diagnose stale runtime lifecycle state', 'diagnostics', 'completed', 0, 'low', '[]', '[]', '{}', ?, ?)`,
  ).run(taskId, conversationId, now, now);
  cleanup.push(() => db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId));

  db.prepare(
    `INSERT INTO runs
     (id, tenant_id, project_id, conversation_id, task_id, mode, status, model_profile, attempt, started_at, ended_at,
      budget_json, result_summary, error_json, metadata_json, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, 'agent', 'completed', 'dmx:claude-opus-4-8', 1, ?, ?,
      '{}', 'completed with intentionally stale runtime activity', NULL, '{}', ?, ?)`,
  ).run(runId, conversationId, taskId, now, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM runs WHERE id = ?").run(runId));

  db.prepare(
    `INSERT INTO trace_spans
     (id, tenant_id, project_id, trace_id, parent_span_id, run_id, agent_session_id, span_kind, name, status,
      started_at, ended_at, attributes_json, payload_uri, redaction_status, created_at, updated_at)
     VALUES (?, 'ten_default', 'prj_default', ?, NULL, ?, NULL, 'model.call', 'Model call without terminal event',
      'running', ?, NULL, '{}', NULL, 'clean', ?, ?)`,
  ).run(modelSpanId, `trace_diag_runtime_${suffix}`, runId, now, now, now);
  cleanup.push(() => db.prepare("DELETE FROM trace_spans WHERE id = ?").run(modelSpanId));

  insertRunEvent({
    id: `evt_diag_runtime_model_${suffix}`,
    runId,
    conversationId,
    taskId,
    seq: 1,
    type: "model.call.started",
    producerKind: "model",
    producerId: "dmx:claude-opus-4-8",
    trace: { trace_id: `trace_diag_runtime_${suffix}`, span_id: modelSpanId, parent_span_id: null },
    payload: {
      model_call_id: modelSpanId,
      model: "dmx:claude-opus-4-8",
      model_message_count: 3,
      max_output_tokens: 8192,
    },
    createdAt: now,
  });
  cleanup.push(() => db.prepare("DELETE FROM run_events WHERE id = ?").run(`evt_diag_runtime_model_${suffix}`));

  insertRunEvent({
    id: `evt_diag_runtime_plan_${suffix}`,
    runId,
    conversationId,
    taskId,
    seq: 2,
    type: "swarm.plan",
    producerKind: "agent",
    producerId: "orchestrator",
    trace: { trace_id: `trace_diag_runtime_${suffix}`, span_id: swarmPlanSpanId, parent_span_id: null },
    payload: {
      status: "running",
      strategy: "parallel",
      branch_count: 1,
      summary: "Synthetic plan that should be settled by reduce.",
    },
    createdAt: now,
  });
  cleanup.push(() => db.prepare("DELETE FROM run_events WHERE id = ?").run(`evt_diag_runtime_plan_${suffix}`));

  insertRunEvent({
    id: `evt_diag_runtime_reduce_${suffix}`,
    runId,
    conversationId,
    taskId,
    seq: 3,
    type: "swarm.reduce",
    producerKind: "agent",
    producerId: "orchestrator",
    trace: { trace_id: `trace_diag_runtime_${suffix}`, span_id: swarmReduceSpanId, parent_span_id: swarmPlanSpanId },
    payload: {
      status: "completed",
      reducer_mode: "deterministic",
      completed_branch_count: 1,
      failed_branch_count: 0,
      summary: "Synthetic reducer completed.",
    },
    createdAt: now,
  });
  cleanup.push(() => db.prepare("DELETE FROM run_events WHERE id = ?").run(`evt_diag_runtime_reduce_${suffix}`));
  expect("synthetic runtime consistency conversation inserted", true, `${conversationId} ${runId}`);

  if (process.env.DATASWARM_TRACE_DIAGNOSTICS_RUNTIME_SKIP_BUILD !== "1") {
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
  const runtime = diagnostic?.summary?.runtimeConsistency;
  expect("diagnostics API returns 200", response.ok, JSON.stringify(body));
  expect("diagnostic returned conversation", diagnostic?.conversation?.id === conversationId, JSON.stringify(diagnostic?.conversation ?? null));
  expect(
    "runtime consistency detects stale activity and trace span",
    runtime?.terminalRunCount === 1 &&
      runtime.staleRunningActivityCount === 1 &&
      runtime.staleTraceSpanCount === 1 &&
      runtime.openActivities.some((item) => item.kind === "model") &&
      runtime.staleTraceSpans.some((item) => item.id === modelSpanId),
    JSON.stringify(runtime ?? null),
  );
  expect(
    "runtime consistency settles swarm plan by later stage",
    runtime?.swarmPlanSettledByLaterStageCount === 1 &&
      runtime.openActivities.every((item) => item.kind !== "swarm.plan"),
    JSON.stringify(runtime ?? null),
  );
  expect(
    "diagnosis mentions runtime lifecycle inconsistency",
    diagnostic?.summary?.diagnosis?.some((item) => String(item).includes("Runtime lifecycle consistency")) &&
      diagnostic.summary.diagnosis.some((item) => String(item).includes("Runtime lifecycle inconsistencies detected")),
    JSON.stringify(diagnostic?.summary?.diagnosis ?? null),
  );
  expect(
    "remediation includes runtime event consistency item",
    diagnostic?.summary?.remediation?.some(
      (item) =>
        item.id === "runtime-event-consistency" &&
        item.category === "runtime_truth" &&
        item.verificationCommands.includes("node scripts/trace-diagnostics-runtime-consistency-smoke.mjs"),
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

function insertRunEvent(input) {
  db.prepare(
    `INSERT INTO run_events
     (id, tenant_id, project_id, run_id, seq, event_type, producer_kind, producer_id, payload_json, created_at)
     VALUES (?, 'ten_default', 'prj_default', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.seq,
    input.type,
    input.producerKind,
    input.producerId,
    JSON.stringify({
      schema_version: "2026-06-08.v1",
      id: input.id,
      run_id: input.runId,
      conversation_id: input.conversationId,
      task_id: input.taskId,
      seq: input.seq,
      type: input.type,
      timestamp: input.createdAt,
      producer: {
        kind: input.producerKind,
        id: input.producerId,
        name: input.producerId,
      },
      trace: input.trace,
      payload: input.payload,
    }),
    input.createdAt,
  );
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

function expect(name, condition, detail = "") {
  const record = { name, passed: Boolean(condition), detail: String(detail) };
  results.push(record);
  console.log(`${record.passed ? "PASS" : "FAIL"} ${record.name}: ${record.detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nTrace diagnostics runtime consistency smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nTrace diagnostics runtime consistency smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
