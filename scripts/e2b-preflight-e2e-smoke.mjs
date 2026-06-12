import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_E2B_PREFLIGHT_E2E_PORT ?? 3227);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const results = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  if (process.env.DATASWARM_E2B_PREFLIGHT_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      E2B_API_KEY: "",
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_SANDBOX_PROVIDER: "e2b",
      DATASWARM_DATA_DIR: "../../data",
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
  expect("snapshot reports e2b provider selected", readiness?.providerSelected === true, JSON.stringify(readiness));
  expect("snapshot reports missing E2B key", Array.isArray(readiness?.missingEnv) && readiness.missingEnv.includes("E2B_API_KEY"), JSON.stringify(readiness));
  expect("snapshot reports missing template verification", readiness?.templateVerified === false && readiness?.missingEnv?.some((item) => String(item).includes("DATASWARM_E2B_TEMPLATE_VERIFIED")), JSON.stringify(readiness));

  const conversation = await postJson("/api/conversations", {
    title: "Smoke E2B preflight diagnostics",
    defaultModel: "dmx:claude-opus-4-8",
  });
  const conversationId = conversation?.conversation?.id;
  expect("conversation created", typeof conversationId === "string", JSON.stringify(conversation));

  const accepted = await postJson(`/api/conversations/${conversationId}/messages`, {
    text: "请用 swarm 多分支沙箱执行一次 E2B preflight 诊断验证",
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  expect("e2b preflight swarm message accepted", typeof runId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("run reached terminal state", terminal?.status === "completed" || terminal?.status === "failed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sandboxRows = db
      .prepare(
        `SELECT status, provider, metadata_json
         FROM sandbox_sessions
         WHERE run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId);
    const metadata = sandboxRows.map((row) => parseJson(row.metadata_json, {}));
    expect("e2b preflight creates branch sandbox sessions", sandboxRows.length === 3, `${sandboxRows.length} sandbox session(s)`);
    expect("all branch sessions use e2b provider", sandboxRows.every((row) => row.provider === "e2b"), JSON.stringify(sandboxRows));
    expect("all branch sessions fail by preflight", sandboxRows.every((row) => row.status === "failed"), JSON.stringify(sandboxRows.map((row) => row.status)));
    expect(
      "sandbox metadata records secret-safe preflight evidence",
      metadata.every(
        (item) =>
          item.provider_mode === "e2b" &&
          item.error_code === "sandbox_preflight_failed" &&
          item.e2b_preflight?.status === "needs_credentials" &&
          item.e2b_preflight?.api_key_configured === false &&
          item.e2b_preflight?.template_verified === false &&
          Array.isArray(item.e2b_preflight?.missing_env) &&
          item.e2b_preflight.missing_env.includes("E2B_API_KEY") &&
          item.e2b_preflight.missing_env.some((value) => String(value).includes("DATASWARM_E2B_TEMPLATE_VERIFIED")) &&
          !JSON.stringify(item.e2b_preflight).includes("sk-"),
      ),
      JSON.stringify(metadata.slice(0, 1)),
    );

    const branchFailures = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.branch.failed'
         ORDER BY seq ASC`,
      )
      .all(runId)
      .map((row) => {
        const event = parseJson(row.payload_json, {});
        return event.payload ?? event;
      });
    expect("branch failed events are persisted", branchFailures.length === 3, `${branchFailures.length} branch failure event(s)`);
    expect(
      "branch failed events carry preflight code and missing env",
      branchFailures.every(
        (payload) =>
          payload.error_code === "sandbox_preflight_failed" &&
          typeof payload.observation_id === "string" &&
          Array.isArray(payload.attempt_failures) &&
          payload.attempt_failures.some(
            (failure) =>
              Array.isArray(failure.missing_env) &&
              failure.missing_env.includes("E2B_API_KEY") &&
              failure.missing_env.some((value) => String(value).includes("DATASWARM_E2B_TEMPLATE_VERIFIED")),
          ),
      ),
      JSON.stringify(branchFailures.slice(0, 1)),
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
      "failed e2b branches create observations",
      branchObservations.length === 3 &&
        branchObservations.every((row) => row.status === "failed" && row.evidence_level === "real") &&
        branchObservationMetadata.every(
          (item) =>
            item.error_code === "sandbox_preflight_failed" &&
            item.sandbox_session_id &&
            item.context_bundle_id &&
            item.branch_id,
        ),
      JSON.stringify(branchObservations),
    );

    const branchObservationIds = new Set(branchObservations.map((row) => row.id));
    expect(
      "failed branch events link observations",
      branchFailures.length === 3 && branchFailures.every((payload) => branchObservationIds.has(payload.observation_id)),
      JSON.stringify(branchFailures),
    );

    const branchObservationEvents = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'observation.created' AND payload_json LIKE '%"source_name":"swarm.branch.%'
         ORDER BY seq ASC`,
      )
      .all(runId)
      .map((row) => unwrapEventPayload(row.payload_json));
    expect(
      "failed branch observation.created events persisted",
      branchObservationEvents.length === 3 &&
        branchObservationEvents.every(
          (payload) => branchObservationIds.has(payload.observation_id) && payload.status === "failed",
        ),
      JSON.stringify(branchObservationEvents),
    );

    const mergeEvent = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.merge'
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(runId);
    const mergePayload = unwrapEventPayload(mergeEvent?.payload_json);
    expect(
      "failed swarm merge carries branch observation ids",
      Array.isArray(mergePayload.branch_observation_ids) &&
        mergePayload.branch_observation_ids.length === 3 &&
        mergePayload.branch_observation_ids.every((id) => branchObservationIds.has(id)),
      JSON.stringify(mergePayload),
    );

    const verifyEvent = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'swarm.verify'
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(runId);
    const verifyPayload = unwrapEventPayload(verifyEvent?.payload_json);
    expect(
      "failed swarm verify records failed branch evidence",
      verifyPayload.status === "failed" &&
        Array.isArray(verifyPayload.branch_observation_ids) &&
        verifyPayload.branch_observation_ids.length === 3 &&
        verifyPayload.branch_observation_ids.every((id) => branchObservationIds.has(id)) &&
        Array.isArray(verifyPayload.checks) &&
        verifyPayload.checks.some((check) => check.id === "failed_branch_isolation" && check.status === "failed"),
      JSON.stringify(verifyPayload),
    );
  } finally {
    db.close();
  }

  cleanupSmokeRows();
} finally {
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
      expect("e2b preflight server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("e2b preflight server healthy", false, output.join("\n").slice(-3000));
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
  const db = new DatabaseSync(dbPath);
  try {
    const conversations = db
      .prepare("SELECT id FROM conversations WHERE title = ?")
      .all("Smoke E2B preflight diagnostics")
      .map((row) => row.id);
    if (conversations.length === 0) {
      expect("smoke rows cleaned", true, "no smoke conversations found");
      return;
    }

    const runs = selectIds(db, "SELECT id FROM runs WHERE conversation_id IN", conversations);
    const tasks = selectIds(db, "SELECT id FROM tasks WHERE conversation_id IN", conversations);
    const artifacts = runs.length > 0 ? selectIds(db, "SELECT id FROM artifacts WHERE run_id IN", runs) : [];

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

    const remaining = db
      .prepare("SELECT COUNT(*) AS count FROM conversations WHERE title = ?")
      .get("Smoke E2B preflight diagnostics");
    expect("smoke rows cleaned", Number(remaining?.count ?? 0) === 0, `${conversations.length} conversation(s) removed`);
  } finally {
    db.close();
  }
}

function selectIds(db, sqlPrefix, ids) {
  if (ids.length === 0) {
    return [];
  }
  return db
    .prepare(`${sqlPrefix} (${ids.map(() => "?").join(",")})`)
    .all(...ids)
    .map((row) => row.id);
}

function runDelete(db, sqlPrefix, ids) {
  if (ids.length === 0) {
    return;
  }
  db.prepare(`${sqlPrefix} (${ids.map(() => "?").join(",")})`).run(...ids);
}

function expect(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nE2B preflight e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nE2B preflight e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
