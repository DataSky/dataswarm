import { createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_SANDBOX_TOOL_PROXY_E2E_PORT ?? 3237);
const baseUrl = `http://localhost:${port}`;
const proxySecret = "dataswarm-sandbox-tool-proxy-e2e-secret";
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const smokeTitle = "Smoke sandbox tool proxy e2e";
const branchId = "branch_proxy_e2e";
const sandboxSessionId = "sandbox_proxy_e2e";
const sandboxActionId = "sba_proxy_e2e_01_call_tool";
const targetReadPath = path.resolve(root, "README.md");
const results = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  cleanupSmokeRows();

  if (process.env.DATASWARM_SANDBOX_TOOL_PROXY_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_AGENT_MAX_STEPS: "2",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_MOCK_MODEL: "1",
      DATASWARM_MOCK_TOOLS: "1",
      DATASWARM_PUBLIC_BASE_URL: baseUrl,
      DATASWARM_SANDBOX_PROVIDER: "mock",
      DATASWARM_SANDBOX_TOOL_PROXY: "parent",
      DATASWARM_SANDBOX_TOOL_PROXY_SECRET: proxySecret,
      DATASWARM_WEB_SEARCH_PROVIDER: "mock",
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
    text: "介绍下 DataSwarm sandbox tool proxy e2e smoke",
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  const taskId = accepted?.task_id;
  expect("baseline run accepted", typeof runId === "string" && typeof taskId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("baseline run completed", terminal?.status === "completed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let agentSession;
  let traceSpan;
  try {
    agentSession = db
      .prepare(
        `SELECT id
         FROM agent_sessions
         WHERE run_id = ?
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(runId);
    traceSpan = db
      .prepare(
        `SELECT id, trace_id
         FROM trace_spans
         WHERE run_id = ?
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(runId);
  } finally {
    db.close();
  }
  expect("baseline run has agent session and trace span", Boolean(agentSession?.id && traceSpan?.id && traceSpan?.trace_id), JSON.stringify({ agentSession, traceSpan }));

  const token = signProxyToken({
    runId,
    conversationId,
    taskId,
    branchId,
    sandboxSessionId,
    agentSessionId: agentSession.id,
    traceId: traceSpan.trace_id,
    traceSpanId: traceSpan.id,
    allowedTools: ["web.search", "artifact.create", "file.read", "trace.query"],
    exp: Date.now() + 10 * 60 * 1000,
    nonce: randomBytes(12).toString("hex"),
  });

  const invalidTokenResponse = await postProxy({
    proxySessionToken: tamperSignature(token),
    runId,
    branchId,
    sandboxSessionId,
    actionId: "sba_proxy_e2e_invalid",
    toolName: "web.search",
    input: { query: "DataSwarm sandbox proxy invalid token" },
  });
  expect("sandbox tool proxy rejects invalid token", invalidTokenResponse?.status === "failed", JSON.stringify(invalidTokenResponse));

  const webSearchResponse = await postProxy({
    proxySessionToken: token,
    runId,
    branchId,
    sandboxSessionId,
    actionId: sandboxActionId,
    toolName: "web.search",
    input: {
      query: "DataSwarm sandbox parent tool proxy e2e",
      provider: "mock",
      max_results: 3,
    },
  });

  const artifactCreateResponse = await postProxy({
    proxySessionToken: token,
    runId,
    branchId,
    sandboxSessionId,
    actionId: "sba_proxy_e2e_02_artifact_create",
    toolName: "artifact.create",
    input: {
      artifactType: "markdown",
      title: "DataSwarm Proxy Artifact",
      content: "# Proxy Artifact\n\nThis artifact is produced by parent tool proxy.\n",
    },
  });

  const fileReadResponse = await postProxy({
    proxySessionToken: token,
    runId,
    branchId,
    sandboxSessionId,
    actionId: "sba_proxy_e2e_03_file_read",
    toolName: "file.read",
    input: {
      path: targetReadPath,
      max_chars: 80,
    },
  });

  const traceQueryResponse = await postProxy({
    proxySessionToken: token,
    runId,
    branchId,
    sandboxSessionId,
    actionId: "sba_proxy_e2e_04_trace_query",
    toolName: "trace.query",
    input: {
      conversation_id: conversationId,
    },
  });

  const capabilityInvokeResponse = await postCapability({
    proxySessionToken: token,
    runId,
    branchId,
    sandboxSessionId,
    actionId: "sba_proxy_e2e_05_capability_web_search",
    capabilityName: "web.search",
    input: {
      query: "DataSwarm V4 capability plane invoke smoke",
      provider: "mock",
      max_results: 2,
    },
  });

  const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    verifyToolProxyResponse({
      db: verifyDb,
      runId,
      branchId,
      sandboxSessionId,
      actionId: sandboxActionId,
      toolName: "web.search",
      proxyResponse: webSearchResponse,
      expectedEvidenceLevel: "mock",
      expectedSummaryPattern: /mock provider/i,
      expectedExecutionMode: "mock",
    });
    verifyToolProxyResponse({
      db: verifyDb,
      runId,
      branchId,
      sandboxSessionId,
      actionId: "sba_proxy_e2e_02_artifact_create",
      toolName: "artifact.create",
      proxyResponse: artifactCreateResponse,
      expectedEvidenceLevel: "real",
      expectedSummaryPattern: /markdown artifact/i,
      expectedExecutionMode: "real",
    });
    verifyToolProxyResponse({
      db: verifyDb,
      runId,
      branchId,
      sandboxSessionId,
      actionId: "sba_proxy_e2e_03_file_read",
      toolName: "file.read",
      proxyResponse: fileReadResponse,
      expectedEvidenceLevel: "real",
      expectedSummaryPattern: /Read file README\.md/i,
      expectedExecutionMode: "real",
    });
    verifyToolProxyResponse({
      db: verifyDb,
      runId,
      branchId,
      sandboxSessionId,
      actionId: "sba_proxy_e2e_04_trace_query",
      toolName: "trace.query",
      proxyResponse: traceQueryResponse,
      expectedEvidenceLevel: "real",
      expectedSummaryPattern: /Trace diagnostics completed/i,
      expectedExecutionMode: "real",
    });
    verifyToolProxyResponse({
      db: verifyDb,
      runId,
      branchId,
      sandboxSessionId,
      actionId: "sba_proxy_e2e_05_capability_web_search",
      toolName: "web.search",
      proxyResponse: capabilityInvokeResponse,
      expectedEvidenceLevel: "mock",
      expectedSummaryPattern: /mock provider/i,
      expectedExecutionMode: "mock",
    });

    const proxyEventCount = verifyDb
      .prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND event_type LIKE 'sandbox.tool_proxy.call.%'")
      .get(runId)?.count;
    expect(
      "parent proxy emitted started and completed events for all five tool calls",
      Number(proxyEventCount) >= 10,
      JSON.stringify({ proxyEventCount }),
    );
    const capabilityEventCount = verifyDb
      .prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND event_type LIKE 'capability.invoke.%'")
      .get(runId)?.count;
    expect(
      "capability plane emitted started and completed events for all five invocations",
      Number(capabilityEventCount) >= 10,
      JSON.stringify({ capabilityEventCount }),
    );
  } finally {
    verifyDb.close();
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
      expect("sandbox tool proxy e2e server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("sandbox tool proxy e2e server healthy", false, output.join("\n").slice(-3000));
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

async function postProxy(body) {
  return postJson("/api/internal/sandbox/tool-proxy", body);
}

async function postCapability(body) {
  return postJson("/api/internal/capabilities/invoke", body);
}

function signProxyToken(claims) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", proxySecret).update(payload).digest("base64url")}`;
}

function tamperSignature(token) {
  const [payload, signature] = token.split(".");
  const replacement = signature.endsWith("A") ? "B" : "A";
  return `${payload}.${signature.slice(0, -1)}${replacement}`;
}

function latestToolEventPayload(db, runId, eventType, toolName, actionId) {
  const rows = db
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE run_id = ? AND event_type = ?
       ORDER BY seq DESC`,
    )
    .all(runId, eventType);
  return (
    rows
      .map((row) => unwrapEventPayload(row.payload_json))
      .find(
        (payload) =>
          (payload?.tool_name === toolName || payload?.toolName === toolName) &&
          (!actionId || payload?.sandbox_action_id === actionId || payload?.sandboxActionId === actionId),
      ) ?? null
  );
}

function verifyToolProxyResponse({
  db,
  runId,
  branchId,
  sandboxSessionId,
  actionId,
  toolName,
  proxyResponse,
  expectedEvidenceLevel,
  expectedSummaryPattern,
  expectedExecutionMode,
}) {
  expect(
    `${toolName} tool proxy route returns completed observation`,
    proxyResponse?.status === "completed" &&
      typeof proxyResponse?.toolCallId === "string" &&
      proxyResponse?.observation?.status === "completed" &&
      proxyResponse?.observation?.evidenceLevel === expectedEvidenceLevel,
    JSON.stringify(proxyResponse),
  );
  if (expectedSummaryPattern) {
    expect(
      `${toolName} proxy output summary matches expectation`,
      expectedSummaryPattern.test(proxyResponse?.observation?.summary ?? ""),
      JSON.stringify(proxyResponse?.observation),
    );
  }

  const toolCall = db
    .prepare(
      `SELECT id, status, output_summary, output_payload_uri
       FROM tool_calls
       WHERE id = ?
       LIMIT 1`,
    )
    .get(proxyResponse?.toolCallId);
  expect(
    `${toolName} tool_call is persisted as completed`,
    toolCall?.status === "completed" &&
      typeof toolCall?.output_summary === "string" &&
      toolCall.output_summary.length > 0 &&
      typeof toolCall?.output_payload_uri === "string",
    JSON.stringify(toolCall),
  );

  const observation = db
    .prepare(
      `SELECT id, action_id, source_type, source_name, status, evidence_level, metadata_json
       FROM observations
       WHERE id = ?
       LIMIT 1`,
    )
    .get(proxyResponse?.observation?.id);
  const observationMetadata = parseJson(observation?.metadata_json, {});
  expect(
    `${toolName} observation is persisted with sandbox provenance`,
    observation?.action_id === actionId &&
      observation?.source_type === "tool" &&
      observation?.source_name === `sandbox.proxy.${toolName}` &&
      observation?.status === "completed" &&
      observation?.evidence_level === expectedEvidenceLevel &&
      observationMetadata.branch_id === branchId &&
      observationMetadata.sandbox_session_id === sandboxSessionId &&
      observationMetadata.sandbox_action_id === actionId &&
      observationMetadata.tool_call_id === proxyResponse?.toolCallId &&
      observationMetadata.tool_name === toolName,
    JSON.stringify({ observation, observationMetadata }),
  );

  const startedPayload = latestToolEventPayload(db, runId, "sandbox.tool_proxy.call.started", toolName, actionId);
  expect(
    `${toolName} sandbox.tool_proxy.call.started event records branch and action`,
    startedPayload?.branch_id === branchId &&
      startedPayload?.sandbox_session_id === sandboxSessionId &&
      startedPayload?.sandbox_action_id === actionId &&
      startedPayload?.tool_name === toolName &&
      startedPayload?.toolCallId === undefined,
    JSON.stringify(startedPayload),
  );

  const completedPayload = latestToolEventPayload(db, runId, "sandbox.tool_proxy.call.completed", toolName, actionId);
  expect(
    `${toolName} sandbox.tool_proxy.call.completed event links tool call and observation`,
    completedPayload?.branch_id === branchId &&
      completedPayload?.sandbox_session_id === sandboxSessionId &&
      completedPayload?.sandbox_action_id === actionId &&
      completedPayload?.tool_name === toolName &&
      completedPayload?.tool_call_id === proxyResponse?.toolCallId &&
      completedPayload?.observation_id === proxyResponse?.observation?.id &&
      completedPayload?.execution_mode === expectedExecutionMode,
    JSON.stringify(completedPayload),
  );
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
  results.push({ name, passed: Boolean(passed), detail: String(detail ?? "") });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nSandbox tool proxy e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSandbox tool proxy e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
