import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_RUN_CANCEL_API_PORT ?? 3223);
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
  const ids = insertSyntheticRun(db);
  expect("synthetic cancellable run inserted", true, ids.runId);

  if (process.env.DATASWARM_RUN_CANCEL_API_SKIP_BUILD !== "1") {
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

  const cancelled = await postJson(`/api/runs/${ids.runId}/cancel`, {
    reason: "run cancel API smoke",
  });
  expect("cancel API returns accepted state", cancelled?.status === "cancelling", JSON.stringify(cancelled));
  expect("cancel API fans out sandbox cancel", cancelled?.sandbox_cancel_count === 1, JSON.stringify(cancelled));

  const runRow = db
    .prepare("SELECT status, metadata_json FROM runs WHERE id = ?")
    .get(ids.runId);
  const runMetadata = parseJson(runRow?.metadata_json, {});
  expect(
    "run status and metadata record cancellation",
    runRow?.status === "cancelling" && runMetadata.cancel_requested === true,
    JSON.stringify({ status: runRow?.status, metadata: runMetadata }),
  );

  const sandboxRow = db
    .prepare("SELECT status, metadata_json FROM sandbox_sessions WHERE id = ?")
    .get(ids.sandboxId);
  const sandboxMetadata = parseJson(sandboxRow?.metadata_json, {});
  expect(
    "sandbox status and metadata record cancellation",
    sandboxRow?.status === "cancelling" && sandboxMetadata.cancel_requested === true,
    JSON.stringify({ status: sandboxRow?.status, metadata: sandboxMetadata }),
  );

  const eventTypes = db
    .prepare("SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq ASC")
    .all(ids.runId)
    .map((row) => row.event_type);
  expect(
    "cancel events persisted",
    eventTypes.includes("run.cancel.requested") && eventTypes.includes("sandbox.cancel.requested"),
    JSON.stringify(eventTypes),
  );
} finally {
  for (const item of cleanup.reverse()) {
    item();
  }
  db.close();
  if (server) {
    server.kill("SIGTERM");
  }
}

finish();

function insertSyntheticRun(database) {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  const conversationId = `conv_cancel_smoke_${suffix}`;
  const taskId = `task_cancel_smoke_${suffix}`;
  const runId = `run_cancel_smoke_${suffix}`;
  const agentId = `agent_cancel_smoke_${suffix}`;
  const sandboxId = `sandbox_cancel_smoke_${suffix}`;

  database.exec("BEGIN;");
  try {
    database
      .prepare(
        `INSERT INTO conversations
         (id, tenant_id, project_id, user_id, title, status, default_model, context_summary, last_run_id, last_message_at, metadata_json, created_at, updated_at)
         VALUES (?, 'ten_default', 'prj_default', 'usr_local', ?, 'active', 'dmx:claude-opus-4-8', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, "[smoke] run cancel API", runId, now, JSON.stringify({ smoke: true }), now, now);
    database
      .prepare(
        `INSERT INTO tasks
         (id, tenant_id, project_id, conversation_id, parent_task_id, title, objective, task_type, status, priority, risk_level,
          input_refs_json, acceptance_criteria_json, metadata_json, created_at, updated_at)
         VALUES (?, 'ten_default', 'prj_default', ?, NULL, 'Run cancel API smoke', 'Synthetic cancellable run', 'chat', 'running', 0, 'low', '[]', '[]', ?, ?, ?)`,
      )
      .run(taskId, conversationId, JSON.stringify({ smoke: true }), now, now);
    database
      .prepare(
        `INSERT INTO runs
         (id, tenant_id, project_id, conversation_id, task_id, mode, status, model_profile, attempt, started_at, ended_at,
          budget_json, result_summary, error_json, metadata_json, created_at, updated_at)
         VALUES (?, 'ten_default', 'prj_default', ?, ?, 'agent', 'running', 'dmx:claude-opus-4-8', 1, ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        runId,
        conversationId,
        taskId,
        now,
        JSON.stringify({ max_tokens: 200000, max_seconds: 600, max_tool_calls: 0, max_sandboxes: 1 }),
        JSON.stringify({ smoke: true }),
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO agent_sessions
         (id, tenant_id, project_id, run_id, parent_agent_session_id, agent_role, agent_name, model_profile, status,
          instructions_hash, context_bundle_id, tool_policy_json, metadata_json, created_at, updated_at)
         VALUES (?, 'ten_default', 'prj_default', ?, NULL, 'swarm_branch', 'Cancel Smoke Branch', 'deepseek:deepseek-v4-flash', 'running',
          NULL, NULL, '{}', ?, ?, ?)`,
      )
      .run(agentId, runId, JSON.stringify({ smoke: true }), now, now);
    database
      .prepare(
        `INSERT INTO sandbox_sessions
         (id, tenant_id, project_id, run_id, agent_session_id, provider, external_sandbox_id, status, template, started_at, ended_at,
          last_heartbeat_at, resource_limits_json, env_policy_json, metadata_json, created_at, updated_at)
         VALUES (?, 'ten_default', 'prj_default', ?, ?, 'mock', 'mock-cancel-smoke', 'running', 'dataswarm-agent-runtime', ?, NULL,
          ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sandboxId,
        runId,
        agentId,
        now,
        now,
        JSON.stringify({ cpu: 1, memory_mb: 1024, timeout_seconds: 120 }),
        JSON.stringify({ allow_secret_env: false, allow_network: false }),
        JSON.stringify({ smoke: true }),
        now,
        now,
      );
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }

  cleanup.push(() => database.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId));
  cleanup.push(() => database.prepare("DELETE FROM sandbox_sessions WHERE id = ?").run(sandboxId));
  cleanup.push(() => database.prepare("DELETE FROM agent_sessions WHERE id = ?").run(agentId));
  cleanup.push(() => database.prepare("DELETE FROM runs WHERE id = ?").run(runId));
  cleanup.push(() => database.prepare("DELETE FROM tasks WHERE id = ?").run(taskId));
  cleanup.push(() => database.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId));

  return { conversationId, taskId, runId, agentId, sandboxId };
}

async function runProductionBuild() {
  const result = spawnSync("npm", ["--prefix", "apps/web", "run", "build"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    timeout: 120000,
  });
  expect("production build refreshed", result.status === 0, `${result.stdout}\n${result.stderr}`);
  if (result.status !== 0) {
    finish();
  }
}

async function waitForHealth(output) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const response = await fetch(`${baseUrl}/api/system/snapshot`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) {
      expect("production server healthy", true, baseUrl);
      return;
    }
    await delay(500);
  }
  expect("production server healthy", false, output.join("").slice(-2000));
  finish();
}

async function postJson(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { error: `HTTP ${response.status}`, payload };
  }
  return payload;
}

function parseJson(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function expect(name, passed, detail) {
  results.push({ name, passed, detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nRun cancel API smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nRun cancel API smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
