import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_TOOL_EVENT_CONTRACT_E2E_PORT ?? 3233);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const smokeTitle = "Smoke tool event contract e2e";
const results = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  if (process.env.DATASWARM_TOOL_EVENT_CONTRACT_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_SANDBOX_PROVIDER: "mock",
      DATASWARM_AGENT_MAX_STEPS: "3",
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
    text: "搜索互联网，查询 DataSwarm tool event contract smoke",
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  expect("tool event smoke message accepted", typeof runId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("run completed", terminal?.status === "completed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const action = db
      .prepare(
        `SELECT id, status
         FROM agent_actions
         WHERE run_id = ? AND action_type = 'call_tool'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(runId);
    const actionRows = db
      .prepare(
        `SELECT id, action_type, status, substr(action_json, 1, 500) AS action_preview
         FROM agent_actions
         WHERE run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId);
    expect("call_tool action persisted", typeof action?.id === "string", JSON.stringify(action ?? actionRows));

    const observation = db
      .prepare(
        `SELECT id, action_id, source_type, source_name, status, evidence_level, metadata_json
         FROM observations
         WHERE run_id = ? AND source_type = 'tool' AND source_name = 'web.search'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(runId);
    const observationMetadata = parseJson(observation?.metadata_json, {});
    expect(
      "tool observation persisted",
      observation?.action_id === action?.id &&
        observation?.status === "completed" &&
        observation?.evidence_level === "mock" &&
        observationMetadata.capability_kind === "web_search" &&
        observationMetadata.logical_tool_name === "web.search" &&
        observationMetadata.provider_tool_name === "tavily.search" &&
        observationMetadata.provider === "tavily" &&
        typeof observationMetadata.tool_call_id === "string",
      JSON.stringify(observation ?? null),
    );

    const completedEvent = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'tool.call.completed'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(runId);
    const completedPayload = unwrapEventPayload(completedEvent?.payload_json);
    expect(
      "tool.call.completed carries action and evidence contract",
      completedPayload.action_id === action?.id &&
        completedPayload.tool_call_id === observationMetadata.tool_call_id &&
        completedPayload.tool_name === "web.search" &&
        completedPayload.capability_kind === "web_search" &&
        completedPayload.logical_tool_name === "web.search" &&
        completedPayload.provider_tool_name === "tavily.search" &&
        completedPayload.provider === "tavily" &&
        completedPayload.observation_id === observation?.id &&
        completedPayload.evidence_level === observation?.evidence_level &&
        completedPayload.status === observation?.status,
      JSON.stringify(completedPayload),
    );

    const outputEvent = db
      .prepare(
        `SELECT payload_json
         FROM run_events
         WHERE run_id = ? AND event_type = 'tool.call.output'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(runId);
    const outputPayload = unwrapEventPayload(outputEvent?.payload_json);
    expect(
      "tool.call.output carries evidence level before terminal event",
      outputPayload.action_id === action?.id &&
        outputPayload.tool_call_id === observationMetadata.tool_call_id &&
        outputPayload.capability_kind === "web_search" &&
        outputPayload.logical_tool_name === "web.search" &&
        outputPayload.provider_tool_name === "tavily.search" &&
        outputPayload.provider === "tavily" &&
        outputPayload.evidence_level === observation?.evidence_level,
      JSON.stringify(outputPayload),
    );

    const evalRow = db
      .prepare(
        `SELECT checks_json
         FROM eval_results
         WHERE run_id = ? AND eval_type = 'run_health'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId);
    const checks = parseJson(evalRow?.checks_json, []);
    const terminalCheck = Array.isArray(checks)
      ? checks.find((check) => check?.id === "terminal_tool_events_have_observation_evidence")
      : null;
    expect(
      "evaluator verifies terminal tool event evidence",
      terminalCheck?.passed === true,
      JSON.stringify(terminalCheck ?? null),
    );
  } finally {
    db.close();
  }

  const diagnostic = await fetch(`${baseUrl}/api/diagnostics/conversations/${conversationId}`).then((response) =>
    response.ok ? response.json() : null,
  );
  const diagnosticSummary = diagnostic?.diagnostic?.summary;
  expect(
    "diagnostics API recognizes generic web_search without Tavily-specific action",
    diagnosticSummary?.hasWebSearchTool === true &&
      diagnosticSummary?.hasTavily === false &&
      diagnosticSummary?.likelyUsedMockSearch === true,
    JSON.stringify(diagnosticSummary ?? null),
  );
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
      expect("mock production server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("mock production server healthy", false, output.join("\n").slice(-3000));
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

function expect(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nTool event contract e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nTool event contract e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
