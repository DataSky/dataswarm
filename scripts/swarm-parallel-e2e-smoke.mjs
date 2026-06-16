import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_SWARM_PARALLEL_E2E_PORT ?? 3223);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const smokeTitle = "Smoke swarm parallel execution e2e";
const results = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  if (process.env.DATASWARM_SWARM_PARALLEL_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_SANDBOX_PROVIDER: "mock",
      DATASWARM_SANDBOX_TOOL_PROXY: "mock",
      DATASWARM_SWARM_MAX_CONCURRENCY: "3",
      DATASWARM_SWARM_REVIEW_MODE: "mock",
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
    text: "请用 swarm 并行启动6个沙箱分支，验证 parallel execution queue，并合并结果",
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  expect("six-branch swarm message accepted", typeof runId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("run completed", terminal?.status === "completed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const events = db
      .prepare(
        `SELECT seq, event_type, payload_json
         FROM run_events
         WHERE run_id = ?
         ORDER BY seq ASC`,
      )
      .all(runId)
      .map((row) => ({
        seq: Number(row.seq),
        type: String(row.event_type),
        payload: unwrapEventPayload(row.payload_json),
      }));

    const planEvents = events.filter((event) => event.type === "swarm.plan");
    const planPayload = planEvents[0]?.payload ?? {};
    expect("single six-branch swarm plan persisted", planEvents.length === 1 && planPayload.branch_count === 6, JSON.stringify(planPayload));
    expect(
      "plan records bounded parallel concurrency",
      planPayload.max_concurrency === 3 &&
        planPayload.effective_concurrency === 3 &&
        planPayload.execution_mode === "batched_parallel" &&
        planPayload.batch_count === 2,
      JSON.stringify(planPayload),
    );

    const branchStarted = events.filter((event) => event.type === "swarm.branch.started");
    const branchTerminal = events.filter((event) => event.type === "swarm.branch.completed" || event.type === "swarm.branch.failed");
    expect("all six branches started", branchStarted.length === 6, `${branchStarted.length} start event(s)`);
    expect("all six branches settled", branchTerminal.length === 6, `${branchTerminal.length} terminal event(s)`);

    const firstTerminalSeq = Math.min(...branchTerminal.map((event) => event.seq));
    const startsBeforeFirstTerminal = branchStarted.filter((event) => event.seq < firstTerminalSeq).length;
    expect(
      "first concurrency wave starts before any branch settles",
      startsBeforeFirstTerminal >= 3,
      `${startsBeforeFirstTerminal} start event(s) before first terminal seq ${firstTerminalSeq}`,
    );

    const startedPayloads = branchStarted.map((event) => event.payload);
    const batchIndexes = startedPayloads.map((payload) => Number(payload.batch_index));
    const slots = startedPayloads.map((payload) => Number(payload.concurrency_slot));
    expect(
      "started branch events carry batch and slot metadata",
      batchIndexes.filter((value) => value === 0).length === 3 &&
        batchIndexes.filter((value) => value === 1).length === 3 &&
        slots.every((value) => value >= 1 && value <= 3),
      JSON.stringify(startedPayloads),
    );

    const reduce = events.find((event) => event.type === "swarm.reduce");
    const maxTerminalSeq = Math.max(...branchTerminal.map((event) => event.seq));
    expect(
      "swarm.reduce waits for every branch to settle",
      Boolean(reduce) && reduce.seq > maxTerminalSeq,
      `reduce seq ${reduce?.seq ?? "missing"}, max terminal seq ${maxTerminalSeq}`,
    );

    const reducePayload = reduce?.payload ?? {};
    expect(
      "reduce sees all branch observations",
      reducePayload.branch_count === 6 &&
        reducePayload.completed_branch_count === 6 &&
        reducePayload.failed_branch_count === 0 &&
        Array.isArray(reducePayload.branch_observation_ids) &&
        reducePayload.branch_observation_ids.length === 6,
      JSON.stringify(reducePayload),
    );

    const sandboxRows = db
      .prepare(
        `SELECT id, status, metadata_json
         FROM sandbox_sessions
         WHERE run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(runId);
    const sandboxMetadata = sandboxRows.map((row) => parseJson(row.metadata_json, {}));
    expect(
      "each branch owns an independent sandbox session with concurrency metadata",
      sandboxRows.length === 6 &&
        sandboxRows.every((row) => row.status === "completed") &&
        sandboxMetadata.every((metadata) => metadata.branch_id && Number(metadata.effective_concurrency) === 3),
      JSON.stringify(sandboxMetadata),
    );
  } finally {
    db.close();
  }

  cleanupSmokeRows();
  finish();
} catch (error) {
  expect("swarm parallel e2e did not throw", false, error?.stack ?? String(error));
  cleanupSmokeRows();
  finish();
} finally {
  if (server) {
    server.kill("SIGTERM");
  }
}

async function runProductionBuild() {
  const build = spawn("npm", ["run", "build"], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_SANDBOX_PROVIDER: "mock",
      DATASWARM_SANDBOX_TOOL_PROXY: "mock",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve) => build.on("close", resolve));
  expect("production build completed", exitCode === 0, `exit ${exitCode}`);
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
    const deadline = Date.now() + 90_000;
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
  results.push({ name, passed: Boolean(passed), detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nSwarm parallel e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSwarm parallel e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
