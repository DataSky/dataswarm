import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_RETRY_E2E_PORT ?? 3217);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const smokeTitle = "Smoke sandbox retry e2e";
const results = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  if (process.env.DATASWARM_RETRY_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_SANDBOX_PROVIDER: "mock",
      DATASWARM_SWARM_REVIEW_MODE: "mock",
      DATASWARM_SANDBOX_BRANCH_MAX_RETRIES: "1",
      DATASWARM_SANDBOX_FAIL_FIRST_ATTEMPT: "1",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(String(chunk)));
  server.stderr.on("data", (chunk) => output.push(String(chunk)));

  await waitForHealth(output);

  const conversation = await postJson("/api/conversations", {
    title: smokeTitle,
    defaultModel: "dmx:claude-opus-4-8",
  });
  const conversationId = conversation?.conversation?.id;
  expect("conversation created", typeof conversationId === "string", JSON.stringify(conversation));

  const accepted = await postJson(`/api/conversations/${conversationId}/messages`, {
    text: "请用 swarm 并行多分支沙箱验证 sandbox retry policy",
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  expect("swarm message accepted", typeof runId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("run completed", terminal?.status === "completed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const retryEvents = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'sandbox.agent.event' AND payload_json LIKE '%sandbox.agent.retry_scheduled%'`,
      )
      .all(runId);
    expect("retry event persisted", retryEvents.length >= 1, `${retryEvents.length} retry event(s)`);

    const swarmPlanEvents = db
      .prepare(
        `SELECT id, payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.plan'`,
      )
      .all(runId);
    expect(
      "planner spawned one swarm cycle",
      swarmPlanEvents.length === 1,
      `${swarmPlanEvents.length} swarm.plan event(s)`,
    );
    const swarmPlanPayload = unwrapEventPayload(swarmPlanEvents[0]?.payload_json);
    expect(
      "planner-owned swarm plan uses model branch definitions",
      swarmPlanPayload.plan_source === "model_branches" &&
        Array.isArray(swarmPlanPayload.branches) &&
        swarmPlanPayload.branches.length === 3 &&
        swarmPlanPayload.branches.every((branch) => typeof branch.instruction === "string" && branch.instruction.length > 20),
      JSON.stringify(swarmPlanPayload),
    );

    const sandboxRows = db
      .prepare(
        `SELECT status, metadata_json
         FROM sandbox_sessions
         WHERE run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId);
    const metadata = sandboxRows.map((row) => parseJson(row.metadata_json, {}));
    expect("single swarm created exactly three branch sessions", sandboxRows.length === 3, `${sandboxRows.length} sandbox session(s)`);
    expect(
      "retry attempt metadata persisted",
      metadata.some((item) => Number(item.max_attempts) === 2 && Array.isArray(item.attempt_failures) && item.attempt_failures.length >= 1),
      JSON.stringify(metadata.slice(0, 2)),
    );
    expect(
      "retry eventually succeeded",
      sandboxRows.some((row) => row.status === "completed") && metadata.some((item) => Number(item.attempt) === 2),
      JSON.stringify(sandboxRows.map((row) => row.status)),
    );

    const branchObservations = db
      .prepare(
        `SELECT id, action_id, source_name, status, evidence_level, metadata_json
         FROM observations
         WHERE run_id = ? AND source_type = 'agent' AND source_name LIKE 'swarm.branch.%'
         ORDER BY created_at ASC`,
      )
      .all(runId);
    const branchObservationMetadata = branchObservations.map((row) => parseJson(row.metadata_json, {}));
    expect(
      "each swarm branch created an observation",
      branchObservations.length === 3 &&
        branchObservations.every((row) => row.status === "completed" && row.evidence_level === "mock") &&
        branchObservationMetadata.every((item) => item.branch_id && item.sandbox_session_id && item.artifact_id),
      JSON.stringify(branchObservations),
    );

    const branchCompletedEvents = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.branch.completed'
         ORDER BY created_at ASC`,
      )
      .all(runId)
      .map((row) => unwrapEventPayload(row.payload_json));
    const branchObservationIds = new Set(branchObservations.map((row) => row.id));
    expect(
      "branch completed events link observations",
      branchCompletedEvents.length === 3 &&
        branchCompletedEvents.every((payload) => branchObservationIds.has(payload.observation_id)),
      JSON.stringify(branchCompletedEvents),
    );

    const branchObservationEvents = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'observation.created' AND payload_json LIKE '%"source_name":"swarm.branch.%'
         ORDER BY created_at ASC`,
      )
      .all(runId)
      .map((row) => unwrapEventPayload(row.payload_json));
    expect(
      "branch observation.created events persisted",
      branchObservationEvents.length === 3 &&
        branchObservationEvents.every((payload) => branchObservationIds.has(payload.observation_id)),
      JSON.stringify(branchObservationEvents),
    );

    const reduceEvent = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.reduce'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId);
    const reducePayload = unwrapEventPayload(reduceEvent?.payload_json);
    expect(
      "swarm reduce carries reduced branch evidence",
      reducePayload.status === "completed" &&
        reducePayload.reducer_mode === "deterministic_runtime" &&
        Array.isArray(reducePayload.branch_observation_ids) &&
        reducePayload.branch_observation_ids.length === 3 &&
        reducePayload.branch_observation_ids.every((id) => branchObservationIds.has(id)) &&
        Array.isArray(reducePayload.branch_items) &&
        reducePayload.branch_items.length === 3 &&
        Array.isArray(reducePayload.recommendations) &&
        typeof reducePayload.summary === "string" &&
        reducePayload.summary.includes("Reducer synthesized"),
      JSON.stringify(reducePayload),
    );

    const mergeEvent = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.merge'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId);
    const mergePayload = unwrapEventPayload(mergeEvent?.payload_json);
    expect(
      "swarm merge carries branch observation ids",
      Array.isArray(mergePayload.branch_observation_ids) &&
        mergePayload.branch_observation_ids.length === 3 &&
        mergePayload.branch_observation_ids.every((id) => branchObservationIds.has(id)) &&
        mergePayload.reducer_mode === "deterministic_runtime" &&
        mergePayload.reduction_summary === reducePayload.summary,
      JSON.stringify(mergePayload),
    );

    const verifyEvent = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.verify'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId);
    const verifyPayload = unwrapEventPayload(verifyEvent?.payload_json);
    expect(
      "swarm verify carries branch observation ids and passed checks",
      verifyPayload.status === "passed" &&
        Array.isArray(verifyPayload.branch_observation_ids) &&
        verifyPayload.branch_observation_ids.length === 3 &&
        verifyPayload.branch_observation_ids.every((id) => branchObservationIds.has(id)) &&
        Array.isArray(verifyPayload.checks) &&
        verifyPayload.checks.some((check) => check.id === "branch_observations_present" && check.status === "passed"),
      JSON.stringify(verifyPayload),
    );

    const reviewEvent = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.review'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId);
    const reviewPayload = unwrapEventPayload(reviewEvent?.payload_json);
    expect(
      "swarm review carries mock reviewer output",
      reviewPayload.status === "completed" &&
        reviewPayload.review_mode === "mock" &&
        Array.isArray(reviewPayload.branch_observation_ids) &&
        reviewPayload.branch_observation_ids.length === 3 &&
        reviewPayload.branch_observation_ids.every((id) => branchObservationIds.has(id)) &&
        Array.isArray(reviewPayload.recommendations) &&
        typeof reviewPayload.summary === "string" &&
        reviewPayload.summary.includes("Mock swarm review"),
      JSON.stringify(reviewPayload),
    );
  } finally {
    db.close();
  }
} finally {
  if (server) {
    server.kill("SIGTERM");
    await delay(500);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
  }
  cleanupSmokeRows();
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
      expect("mock dev server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("mock dev server healthy", false, output.join("\n").slice(-3000));
  finish();
}

async function waitForRun(runId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId);
      if (run?.status === "completed" || run?.status === "failed" || run?.status === "cancelled") {
        return run;
      }
      await delay(500);
    }
    return db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId);
  } finally {
    db.close();
  }
}

async function postJson(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function unwrapEventPayload(value) {
  const parsed = parseJson(value, {});
  if (parsed && typeof parsed === "object" && parsed.payload && typeof parsed.payload === "object") {
    return parsed.payload;
  }
  return parsed;
}

function cleanupSmokeRows() {
  if (!existsSync(dbPath)) {
    return;
  }
  const db = new DatabaseSync(dbPath);
  try {
    const conversations = db
      .prepare("SELECT id FROM conversations WHERE title = ?")
      .all(smokeTitle)
      .map((row) => row.id);
    if (conversations.length === 0) {
      return;
    }
    const runs = selectIds(db, "SELECT id FROM runs WHERE conversation_id IN", conversations);
    const tasks = selectIds(db, "SELECT id FROM tasks WHERE conversation_id IN", conversations);
    const artifacts = selectIds(db, "SELECT id FROM artifacts WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM self_improvement_candidates WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM messages WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM tasks WHERE id IN", tasks);
    runDelete(db, "DELETE FROM artifact_versions WHERE artifact_id IN", artifacts);
    runDelete(db, "DELETE FROM artifacts WHERE id IN", artifacts);
    runDelete(db, "DELETE FROM eval_results WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM observations WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM agent_actions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM tool_calls WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM approvals WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM skill_usages WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM sandbox_sessions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM context_bundles WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM trace_spans WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM agent_sessions WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM run_steps WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM run_events WHERE run_id IN", runs);
    runDelete(db, "DELETE FROM runs WHERE id IN", runs);
    runDelete(db, "DELETE FROM app_logs WHERE conversation_id IN", conversations);
    runDelete(db, "DELETE FROM conversations WHERE id IN", conversations);
  } finally {
    db.close();
  }
}

function selectIds(db, prefix, ids) {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`${prefix} (${placeholders})`)
    .all(...ids)
    .map((row) => row.id);
}

function runDelete(db, prefix, ids) {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`${prefix} (${placeholders})`).run(...ids);
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
    console.error(`\nSandbox retry e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSandbox retry e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
