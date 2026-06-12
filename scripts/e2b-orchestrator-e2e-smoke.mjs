import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_E2B_ORCHESTRATOR_E2E_PORT ?? 3231);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const templateReceiptPath = path.resolve(
  root,
  process.env.DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT ??
    path.join(dataDir, "e2b", "template-verification.json"),
);
const smokeTitle = "Smoke E2B orchestrator e2e";
const results = [];
let server;

if (!process.env.E2B_API_KEY) {
  console.log("SKIP E2B orchestrator e2e: set E2B_API_KEY to create real orchestrator branch sandboxes.");
  process.exit(0);
}

if (!existsSync(templateReceiptPath) && !process.env.DATASWARM_E2B_TEMPLATE_BUILD_ID && process.env.DATASWARM_E2B_TEMPLATE_VERIFIED !== "1") {
  console.log("SKIP E2B orchestrator e2e: provide a matching template verification receipt or DATASWARM_E2B_TEMPLATE_BUILD_ID.");
  process.exit(0);
}

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  cleanupSmokeRows();

  if (process.env.DATASWARM_E2B_ORCHESTRATOR_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_AGENT_MAX_STEPS: "4",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT: path.relative(path.join(root, "apps", "web"), templateReceiptPath),
      DATASWARM_E2B_TIMEOUT_MS: process.env.DATASWARM_E2B_TIMEOUT_MS ?? "120000",
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_SANDBOX_BRANCH_MAX_RETRIES: "0",
      DATASWARM_SANDBOX_PROVIDER: "e2b",
      DATASWARM_SWARM_REVIEW_MODE: "mock",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(String(chunk)));
  server.stderr.on("data", (chunk) => output.push(String(chunk)));

  await waitForHealth(output);

  const snapshot = await fetch(`${baseUrl}/api/system/snapshot`).then((response) => response.json());
  const readiness = snapshot?.sandbox?.e2b;
  expect("snapshot reports real e2b orchestrator readiness", readiness?.readyForOrchestrator === true && readiness?.status === "ready", JSON.stringify(readiness));
  expect("snapshot does not leak e2b key", !JSON.stringify(readiness).includes(process.env.E2B_API_KEY), JSON.stringify(readiness));

  const conversation = await postJson("/api/conversations", {
    title: smokeTitle,
    defaultModel: "dmx:claude-opus-4-8",
  });
  const conversationId = conversation?.conversation?.id;
  expect("conversation created", typeof conversationId === "string", JSON.stringify(conversation));

  const accepted = await postJson(`/api/conversations/${conversationId}/messages`, {
    text: "请用 swarm 并行多分支沙箱执行一次真实 E2B orchestrator e2e 验证",
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  expect("real e2b swarm message accepted", typeof runId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("run completed", terminal?.status === "completed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const swarmPlanEvents = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.plan'
         ORDER BY seq ASC`,
      )
      .all(runId);
    expect("planner spawned one real e2b swarm cycle", swarmPlanEvents.length === 1, `${swarmPlanEvents.length} swarm.plan event(s)`);
    const swarmPlanPayload = unwrapEventPayload(swarmPlanEvents[0]?.payload_json);
    expect(
      "real e2b swarm plan uses planner branch definitions",
      swarmPlanPayload.plan_source === "model_branches" &&
        Array.isArray(swarmPlanPayload.branches) &&
        swarmPlanPayload.branches.length === 3,
      JSON.stringify(swarmPlanPayload),
    );

    const sandboxRows = db
      .prepare(
        `SELECT id, status, provider, external_sandbox_id, metadata_json
         FROM sandbox_sessions
         WHERE run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId);
    const sandboxMetadata = sandboxRows.map((row) => parseJson(row.metadata_json, {}));
    expect("real e2b swarm created three branch sessions", sandboxRows.length === 3, `${sandboxRows.length} sandbox session(s)`);
    expect(
      "all real e2b branch sessions completed externally",
      sandboxRows.every((row) => row.provider === "e2b" && row.status === "completed" && typeof row.external_sandbox_id === "string" && row.external_sandbox_id.startsWith("i")) &&
        sandboxMetadata.every(
          (item) =>
            item.provider_mode === "e2b" &&
            Number(item.event_count) >= 10 &&
            item.quality_signals?.runtimeVersion === "dataswarm.sandbox-runtime.v1" &&
            item.quality_signals?.artifactRecoveryReady === true,
        ),
      JSON.stringify(sandboxRows.map((row) => ({ status: row.status, provider: row.provider, external: row.external_sandbox_id }))),
    );

    const sandboxAgentEvents = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'sandbox.agent.event'
         ORDER BY seq ASC`,
      )
      .all(runId)
      .map((row) => unwrapEventPayload(row.payload_json));
    const sandboxAgentEventTypes = sandboxAgentEvents.map((payload) => payload.agent_event_type ?? payload.type);
    expect(
      "real e2b sandbox agent events are bridged to parent run",
      sandboxAgentEventTypes.filter((type) => type === "sandbox.agent.heartbeat").length >= 9 &&
        sandboxAgentEventTypes.includes("sandbox.agent.artifact_recovery_manifest") &&
        sandboxAgentEventTypes.includes("sandbox.agent.action_proposed") &&
        sandboxAgentEventTypes.includes("sandbox.agent.observation_created"),
      JSON.stringify({
        total: sandboxAgentEvents.length,
        eventTypes: [...new Set(sandboxAgentEventTypes)],
        firstEvents: sandboxAgentEvents.slice(0, 3),
      }),
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
      "real e2b branches create real observations",
      branchObservations.length === 3 &&
        branchObservations.every((row) => row.status === "completed" && row.evidence_level === "real") &&
        branchObservationMetadata.every(
          (item) =>
            item.branch_id &&
            item.sandbox_session_id &&
            item.artifact_id &&
            item.execution_mode === "real" &&
            item.quality_signals?.runtimeVersion === "dataswarm.sandbox-runtime.v1",
        ),
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
      "real e2b branch completed events link observations",
      branchCompletedEvents.length === 3 &&
        branchCompletedEvents.every(
          (payload) =>
            payload.execution_mode === "real" &&
            branchObservationIds.has(payload.observation_id) &&
            typeof payload.external_sandbox_id === "string",
        ),
      JSON.stringify(branchCompletedEvents),
    );

    const reducePayload = latestEventPayload(db, runId, "swarm.reduce");
    expect(
      "real e2b swarm reduce carries branch evidence",
      reducePayload.status === "completed" &&
        Array.isArray(reducePayload.branch_observation_ids) &&
        reducePayload.branch_observation_ids.length === 3 &&
        reducePayload.branch_observation_ids.every((id) => branchObservationIds.has(id)) &&
        Array.isArray(reducePayload.branch_items) &&
        reducePayload.branch_items.length === 3,
      JSON.stringify(reducePayload),
    );

    const mergePayload = latestEventPayload(db, runId, "swarm.merge");
    expect(
      "real e2b swarm merge carries branch observation ids",
      Array.isArray(mergePayload.branch_observation_ids) &&
        mergePayload.branch_observation_ids.length === 3 &&
        mergePayload.branch_observation_ids.every((id) => branchObservationIds.has(id)) &&
        mergePayload.reduction_summary === reducePayload.summary,
      JSON.stringify(mergePayload),
    );

    const verifyPayload = latestEventPayload(db, runId, "swarm.verify");
    expect(
      "real e2b swarm verify passes branch evidence checks",
      verifyPayload.status === "passed" &&
        Array.isArray(verifyPayload.branch_observation_ids) &&
        verifyPayload.branch_observation_ids.length === 3 &&
        verifyPayload.branch_observation_ids.every((id) => branchObservationIds.has(id)) &&
        Array.isArray(verifyPayload.checks) &&
        verifyPayload.checks.some((check) => check.id === "branch_observations_present" && check.status === "passed") &&
        verifyPayload.checks.some((check) => check.id === "failed_branch_isolation" && check.status === "passed"),
      JSON.stringify(verifyPayload),
    );

    const swarmObservation = db
      .prepare(
        `SELECT id, status, evidence_level, metadata_json
         FROM observations
         WHERE run_id = ? AND source_type = 'agent' AND source_name = 'swarm.e2b'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId);
    const swarmObservationMetadata = parseJson(swarmObservation?.metadata_json, {});
    expect(
      "orchestrator records completed swarm.e2b observation",
      swarmObservation?.status === "completed" &&
        swarmObservation?.evidence_level === "real" &&
        swarmObservationMetadata.execution_mode === "e2b_deferred_or_real_provider" &&
        Array.isArray(swarmObservationMetadata.branch_observation_ids) &&
        swarmObservationMetadata.branch_observation_ids.length === 3,
      JSON.stringify(swarmObservation),
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
      expect("real e2b orchestrator server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("real e2b orchestrator server healthy", false, output.join("\n").slice(-3000));
  finish();
}

async function waitForRun(runId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const deadline = Date.now() + Number(process.env.DATASWARM_E2B_ORCHESTRATOR_E2E_RUN_TIMEOUT_MS ?? 240_000);
    while (Date.now() < deadline) {
      const run = db.prepare("SELECT id, status FROM runs WHERE id = ?").get(runId);
      if (run?.status === "completed" || run?.status === "failed" || run?.status === "cancelled") {
        return run;
      }
      await delay(1000);
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

function latestEventPayload(db, runId, eventType) {
  const row = db
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE run_id = ? AND event_type = ?
       ORDER BY seq DESC
       LIMIT 1`,
    )
    .get(runId, eventType);
  return unwrapEventPayload(row?.payload_json);
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
  results.push({ name, passed: Boolean(passed), detail: String(detail ?? "") });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${redactSecrets(result.detail)}`);
  }
  if (failed.length > 0) {
    console.error(`\nE2B orchestrator e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nE2B orchestrator e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}

function redactSecrets(value) {
  return String(value)
    .replace(/e2b_[a-f0-9]{40}/gi, "[REDACTED_E2B_KEY]")
    .replace(/tvly-[A-Za-z0-9_-]{12,}/g, "[REDACTED_TAVILY_KEY]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]");
}
