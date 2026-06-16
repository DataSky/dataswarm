import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
loadEnvFile(path.join(root, ".env.local"));
loadEnvFile(path.join(root, "apps", "web", ".env.local"));

const port = Number(process.env.DATASWARM_E2B_ORCHESTRATOR_V3_E2E_PORT ?? 3234);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const templateReceiptPath = path.resolve(
  root,
  process.env.DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT ??
    path.join(dataDir, "e2b", "template-verification.json"),
);
const tunnelUrlFile = path.join(dataDir, "e2b", "parent-proxy-url.txt");
const smokeTitle = "Smoke E2B orchestrator V3 real action e2e";
const parentProxyMode = process.env.DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY === "1";
const complexBenchmarkMode = process.env.DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK === "1";
const autoTunnelMode = (process.env.DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_AUTOTUNNEL ?? "").trim().toLowerCase();
const tunnelCommand = (process.env.DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND ?? "").trim();
const sandboxMaxSteps = complexBenchmarkMode ? "10" : "6";
const sandboxMaxToolCalls = complexBenchmarkMode ? "6" : "4";
const forceMockTools = (process.env.DATASWARM_E2B_ORCHESTRATOR_V3_MOCK_TOOLS ?? "0") === "1";
const forceMockModel = (process.env.DATASWARM_E2B_ORCHESTRATOR_V3_MOCK_MODEL ?? "0") === "1";
const tunnelReachabilityTimeoutMs = Number(process.env.DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_REACHABILITY_MS ?? 18_000);
let publicBaseUrl = process.env.DATASWARM_PUBLIC_BASE_URL || "";
let parentProxyUrl = process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL || publicBaseUrl || "";
const toolProxyMode = parentProxyMode ? "parent" : "mock";
const results = [];
let server;
let tunnel;
let activeConversationId = "";
let activeRunId = "";

if (!process.env.E2B_API_KEY) {
  console.log("SKIP E2B orchestrator V3 real-action e2e: set E2B_API_KEY to create real branch sandboxes.");
  process.exit(0);
}

if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_BASE_URL) {
  console.log("SKIP E2B orchestrator V3 real-action e2e: set DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL.");
  process.exit(0);
}

if (!existsSync(templateReceiptPath) && !process.env.DATASWARM_E2B_TEMPLATE_BUILD_ID && process.env.DATASWARM_E2B_TEMPLATE_VERIFIED !== "1") {
  console.log("SKIP E2B orchestrator V3 real-action e2e: provide a matching template verification receipt or DATASWARM_E2B_TEMPLATE_BUILD_ID.");
  process.exit(0);
}

if (parentProxyMode && hasTunnelConfig() && (isLocalOnlyUrl(parentProxyUrl) || isLocalOnlyUrl(publicBaseUrl))) {
  publicBaseUrl = "";
  parentProxyUrl = "";
}

if (parentProxyMode && (!parentProxyUrl || isLocalOnlyUrl(parentProxyUrl)) && !hasTunnelConfig()) {
  console.log(
    "SKIP E2B orchestrator V3 parent-proxy e2e: set DATASWARM_PUBLIC_BASE_URL or DATASWARM_SANDBOX_TOOL_PROXY_URL to a URL reachable from E2B, set DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_AUTOTUNNEL=localtunnel, or set DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND to a command that prints an HTTPS tunnel URL.",
  );
  process.exit(0);
}

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  cleanupSmokeRows();

  if (process.env.DATASWARM_E2B_ORCHESTRATOR_V3_E2E_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }

  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_AGENT_MAX_STEPS: "4",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT: path.relative(path.join(root, "apps", "web"), templateReceiptPath),
      DATASWARM_E2B_TIMEOUT_MS: process.env.DATASWARM_E2B_TIMEOUT_MS ?? "180000",
      DATASWARM_MOCK_MODEL: forceMockModel ? "1" : "0",
      DATASWARM_MOCK_TOOLS: forceMockTools ? "1" : "0",
      DATASWARM_SANDBOX_AGENT_ACTION_MAX_TOKENS: process.env.DATASWARM_SANDBOX_AGENT_ACTION_MAX_TOKENS ?? "900",
      DATASWARM_SANDBOX_AGENT_JSON_MODE: "1",
      DATASWARM_SANDBOX_AGENT_MAX_STEPS: sandboxMaxSteps,
      DATASWARM_SANDBOX_AGENT_MAX_TOOL_CALLS: sandboxMaxToolCalls,
      DATASWARM_SANDBOX_AGENT_MODEL: "real",
      DATASWARM_SANDBOX_AGENT_MODEL_NAME: process.env.DATASWARM_SANDBOX_AGENT_MODEL_NAME ?? "deepseek-v4-flash",
      DATASWARM_SANDBOX_AGENT_PROTOCOL: "dataswarm.sandbox-agent.v3",
      DATASWARM_SANDBOX_AGENT_AUTH_SCHEME: process.env.DATASWARM_SANDBOX_AGENT_AUTH_SCHEME ?? "bearer",
      DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS: "1",
      DATASWARM_SANDBOX_BRANCH_MAX_RETRIES: "0",
      DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS: process.env.DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS ?? "180000",
      DATASWARM_SANDBOX_PROVIDER: "e2b",
      DATASWARM_SANDBOX_TOOL_PROXY: toolProxyMode,
      DATASWARM_SANDBOX_TOOL_PROXY_URL: parentProxyMode ? parentProxyUrl : (process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL ?? ""),
      DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE: parentProxyMode ? tunnelUrlFile : "",
      DATASWARM_PUBLIC_BASE_URL: publicBaseUrl || baseUrl,
      DATASWARM_PUBLIC_BASE_URL_FILE: parentProxyMode ? tunnelUrlFile : "",
      DATASWARM_SWARM_MAX_CONCURRENCY: "2",
      DATASWARM_SWARM_REVIEW_MODE: process.env.DATASWARM_SWARM_REVIEW_MODE || "disabled",
      DATASWARM_WEB_SEARCH_PROVIDER: process.env.DATASWARM_WEB_SEARCH_PROVIDER || (forceMockTools ? "mock" : "tavily"),
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(String(chunk)));
  server.stderr.on("data", (chunk) => output.push(String(chunk)));

  await waitForHealth(output);

  if (parentProxyMode && (!parentProxyUrl || isLocalOnlyUrl(parentProxyUrl)) && hasTunnelConfig()) {
    tunnel = await startTunnel();
    publicBaseUrl = tunnel.url;
    parentProxyUrl = new URL("/api/internal/sandbox/tool-proxy", publicBaseUrl).toString();
    mkdirSync(path.dirname(tunnelUrlFile), { recursive: true });
    writeFileSync(tunnelUrlFile, parentProxyUrl, "utf8");
    expect("localtunnel exposes parent proxy URL for live E2B", /^https:\/\//.test(parentProxyUrl), parentProxyUrl);
  }

  if (parentProxyMode) {
    const proxyReachability = await verifyCallbackReachability(parentProxyUrl);
    expect("parent proxy callback is externally reachable and exposes sandbox health", proxyReachability.ok, JSON.stringify(proxyReachability));
  }

  const snapshot = await fetch(`${baseUrl}/api/system/snapshot`).then((response) => response.json());
  const readiness = snapshot?.sandbox?.e2b;
  expect("snapshot reports real e2b orchestrator readiness", readiness?.readyForOrchestrator === true && readiness?.status === "ready", JSON.stringify(readiness));
  expect("snapshot reports V3 sandbox agent protocol", readiness?.sandboxAgentProtocol === "dataswarm.sandbox-agent.v3", JSON.stringify(readiness));
  expect("snapshot reports real sandbox model mode", readiness?.modelMode === "real", JSON.stringify(readiness));
  expect("snapshot does not leak e2b or model secrets", !containsKnownSecrets(JSON.stringify(readiness)), JSON.stringify(readiness));

  const conversation = await postJson("/api/conversations", {
    title: smokeTitle,
    defaultModel: "dmx:claude-opus-4-8",
  });
  const conversationId = conversation?.conversation?.id;
  activeConversationId = typeof conversationId === "string" ? conversationId : "";
  expect("conversation created", typeof conversationId === "string", JSON.stringify(conversation));

  const accepted = await postJson(`/api/conversations/${conversationId}/messages`, {
    text: buildSmokePrompt(),
    model: "dmx:claude-opus-4-8",
    mode: "agent",
  });
  const runId = accepted?.run_id;
  activeRunId = typeof runId === "string" ? runId : "";
  expect("real e2b V3 swarm message accepted", typeof runId === "string", JSON.stringify(accepted));

  const terminal = await waitForRun(runId);
  expect("run completed", terminal?.status === "completed", JSON.stringify(terminal));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const swarmPlanPayload = latestEventPayload(db, runId, "swarm.plan");
    expect(
      "planner spawned a real e2b V3 swarm cycle",
      swarmPlanPayload.plan_source === "model_branches" &&
        Number(swarmPlanPayload.branch_count ?? swarmPlanPayload.branchCount ?? 0) >= 3 &&
        Number(swarmPlanPayload.effective_concurrency ?? 0) >= 1,
      JSON.stringify(swarmPlanPayload),
    );

    const branchStartedEvents = eventPayloads(db, runId, "swarm.branch.started");
    expect(
      `branch started events expose V3 protocol and ${toolProxyMode} proxy mode`,
      branchStartedEvents.length >= 3 &&
        branchStartedEvents.every(
          (payload) =>
            payload.agent_protocol === "dataswarm.sandbox-agent.v3" &&
            payload.sandbox_tool_proxy?.mode === toolProxyMode &&
            (toolProxyMode !== "parent" || payload.sandbox_tool_proxy?.url_configured === true) &&
            Number(payload.sandbox_budgets?.maxSteps ?? 0) === Number(sandboxMaxSteps),
        ),
      JSON.stringify(branchStartedEvents),
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
    expect("real e2b V3 swarm created branch sessions", sandboxRows.length >= 3, `${sandboxRows.length} sandbox session(s)`);
    expect(
      "all real e2b branch sessions completed with V3 real-model quality signals",
      sandboxRows.every((row) => row.provider === "e2b" && row.status === "completed" && typeof row.external_sandbox_id === "string" && row.external_sandbox_id.startsWith("i")) &&
        sandboxMetadata.every((item) => provesV3RealModelBranch(item)),
      JSON.stringify(
        sandboxRows.map((row, index) => ({
          id: row.id,
          status: row.status,
          provider: row.provider,
          external: row.external_sandbox_id,
          quality: sandboxMetadata[index]?.quality_signals,
        })),
      ),
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
    const sandboxActionTypes = sandboxAgentEvents
      .filter((payload) => (payload.agent_event_type ?? payload.type) === "sandbox.agent.action.proposed")
      .map((payload) => payload.event_payload?.action?.type)
      .filter(Boolean);
    const realModelActionEvents = sandboxAgentEvents.filter(
      (payload) => (payload.agent_event_type ?? payload.type) === "sandbox.agent.action.proposed" && payload.event_payload?.actionSource === "real_model",
    );
    expect(
      "real e2b V3 sandbox agent events are bridged to parent run",
      sandboxAgentEventTypes.includes("sandbox.agent.loop.started") &&
        sandboxAgentEventTypes.includes("sandbox.agent.model_call_completed") &&
        sandboxAgentEventTypes.includes("sandbox.agent.action.proposed") &&
        sandboxAgentEventTypes.includes("sandbox.agent.observation.created") &&
        realModelActionEvents.length >= 6,
      JSON.stringify({ total: sandboxAgentEvents.length, eventTypes: [...new Set(sandboxAgentEventTypes)], realModelActionEvents: realModelActionEvents.length }),
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
      "real e2b V3 branches create real observations with V3 quality signals",
      branchObservations.length >= 3 &&
        branchObservations.every((row) => row.status === "completed" && row.evidence_level === "real") &&
        branchObservationMetadata.every((item) => item.execution_mode === "real" && provesV3RealModelQuality(item.quality_signals)),
      JSON.stringify(summarizeBranchObservations(branchObservations, branchObservationMetadata)),
    );

    const completedEvents = eventPayloads(db, runId, "swarm.branch.completed");
    expect(
      "real e2b V3 branch completed events link V3 observations",
      completedEvents.length >= 3 &&
        completedEvents.every((payload) => payload.execution_mode === "real" && typeof payload.external_sandbox_id === "string" && payload.observation_id),
      JSON.stringify(summarizeBranchCompletedEvents(completedEvents)),
    );

    const reducePayload = latestEventPayload(db, runId, "swarm.reduce");
    expect(
      "real e2b V3 swarm reduce waits for branch observations",
      reducePayload.status === "completed" &&
        Array.isArray(reducePayload.branch_observation_ids) &&
        reducePayload.branch_observation_ids.length >= 3 &&
        Array.isArray(reducePayload.branch_items) &&
        reducePayload.branch_items.length >= 3,
      JSON.stringify(summarizeReducePayload(reducePayload)),
    );

    const verifyPayload = latestEventPayload(db, runId, "swarm.verify");
    expect(
      "real e2b V3 swarm verify passes branch evidence checks",
      verifyPayload.status === "passed" &&
        Array.isArray(verifyPayload.checks) &&
        verifyPayload.checks.some((check) => check.id === "branch_observations_present" && check.status === "passed"),
      JSON.stringify(verifyPayload),
    );

    const imageArtifactIds = uniqueStrings(branchObservationMetadata.flatMap((item) => (Array.isArray(item.image_artifact_ids) ? item.image_artifact_ids : [])));
    const imageArtifacts =
      imageArtifactIds.length > 0
        ? db
            .prepare(
              `SELECT id, title, type, mime_type, metadata_json
               FROM artifacts
               WHERE id IN (${imageArtifactIds.map(() => "?").join(",")})
               ORDER BY created_at ASC`,
            )
            .all(...imageArtifactIds)
        : [];
    expect(
      "real e2b V3 swarm recovers at least one image artifact when requested",
      imageArtifactIds.length >= 1 && imageArtifacts.some((artifact) => artifact.type === "image"),
      JSON.stringify({ imageArtifactIds, imageArtifacts }),
    );

    if (complexBenchmarkMode) {
      const qualitySignals = sandboxMetadata.map((item) => item.quality_signals ?? {});
      const artifactRows = db
        .prepare(
          `SELECT id, title, type, mime_type, metadata_json
           FROM artifacts
           WHERE run_id = ?
           ORDER BY created_at ASC`,
        )
        .all(runId);
      expect(
        "complex live e2b V3 benchmark records reflection and evidence verification",
        qualitySignals.some((quality) => Number(quality.reflectionCount ?? 0) >= 1) &&
          qualitySignals.some((quality) => Number(quality.evidenceVerificationCount ?? 0) >= 1) &&
          sandboxActionTypes.includes("reflect") &&
          sandboxActionTypes.includes("verify_evidence"),
        JSON.stringify({
          qualitySignals: qualitySignals.map(summarizeQualitySignals),
          actionTypes: sandboxActionTypes,
        }),
      );
      expect(
        "complex live e2b V3 benchmark attempts query revision or multiple parent-proxy searches",
        sandboxActionTypes.includes("revise_query") || qualitySignals.some((quality) => Number(quality.toolCallCount ?? 0) >= 2),
        JSON.stringify({
          qualitySignals: qualitySignals.map(summarizeQualitySignals),
          actionTypes: sandboxActionTypes,
        }),
      );
      expect(
        "complex live e2b V3 benchmark recovers durable report artifacts",
        artifactRows.some((artifact) => artifact.type === "markdown") &&
          (artifactRows.some((artifact) => artifact.type === "html") || artifactRows.length >= 3),
        JSON.stringify(
          artifactRows.map((artifact) => ({
            id: artifact.id,
            title: artifact.title,
            type: artifact.type,
            mimeType: artifact.mime_type,
          })),
        ),
      );
    }

    if (parentProxyMode) {
      const proxyCompletedEvents = eventPayloads(db, runId, "sandbox.tool_proxy.call.completed");
      const proxyObservations = db
        .prepare(
          `SELECT id, action_id, source_name, status, evidence_level, metadata_json
           FROM observations
           WHERE run_id = ? AND source_type = 'tool' AND source_name LIKE 'sandbox.proxy.%'
           ORDER BY created_at ASC`,
        )
        .all(runId);
      const completedToolCalls = db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ? AND status = 'completed'")
        .get(runId);
      expect(
        "live e2b V3 parent proxy calls reached the parent runtime",
        proxyCompletedEvents.length >= (complexBenchmarkMode ? 3 : 1) &&
          proxyObservations.length >= (complexBenchmarkMode ? 3 : 1) &&
          Number(completedToolCalls?.count ?? 0) >= (complexBenchmarkMode ? 3 : 1) &&
          proxyCompletedEvents.some((payload) => payload.tool_name === "web.search" && payload.observation_id && payload.tool_call_id),
        JSON.stringify({
          proxyCompletedEvents: summarizeProxyCompletedEvents(proxyCompletedEvents),
          proxyObservations: proxyObservations.map((row) => ({
            id: row.id,
            actionId: row.action_id,
            sourceName: row.source_name,
            status: row.status,
            evidenceLevel: row.evidence_level,
            metadata: summarizeProxyObservationMetadata(parseJson(row.metadata_json, {})),
          })),
          completedToolCallCount: completedToolCalls?.count,
        }),
      );
    }
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
  if (tunnel) {
    tunnel.process.kill("SIGTERM");
    await delay(500);
    if (!tunnel.process.killed) {
      tunnel.process.kill("SIGKILL");
    }
  }
  if (autoTunnelMode === "localtunnel" || tunnelCommand) {
    rmSync(tunnelUrlFile, { force: true });
  }
  if (shouldKeepSmokeRows()) {
    console.log(
      `Preserved smoke rows for diagnostics: conversation=${activeConversationId || "unknown"} run=${activeRunId || "unknown"}`,
    );
  } else {
    cleanupSmokeRows();
  }
}

finish();

function buildSmokePrompt() {
  if (complexBenchmarkMode) {
    return [
      "请用 swarm 并行 3 个真实 E2B 沙箱执行 DataSwarm Branch Agent ReAct V3 complex benchmark。",
      "所有分支都必须由沙箱内真实模型逐步选择 action，不能使用 deterministic fallback。",
      "三个分支都必须至少通过父进程工具代理调用一次 web.search；分支 A 需要在 reflect/revise_query 后再执行第二次 web.search。",
      "分支 A：先 read_context，再通过父进程工具代理 web.search 查询 DataSwarm Branch Agent ReAct V3 parent proxy evidence；如果第一轮证据不够，需要 reflect 后 revise_query，再执行第二次 web.search，并用 verify_evidence 核验来源。",
      "分支 B：执行 run_python 绘制 f=sin(x) 图片，随后 reflect 并 verify_evidence，确保图片 artifact 可以被父进程回收。",
      "分支 C：基于观察结果生成 Markdown 与 HTML 报告 artifact，必须通过 create_artifact 产出，并用 verify_evidence 说明 artifact 来源。",
      "最后 swarm.reduce / swarm.verify 需要等待全部分支 settled 后再合并，最终回答要引用 observation 与 artifact。",
    ].join("\n");
  }
  if (parentProxyMode) {
    return "请用 swarm 并行 3 个真实 E2B 沙箱验证 DataSwarm V3 Branch Agent ReAct parent proxy；每个分支都必须先读取上下文，然后通过父进程工具代理调用 web.search 查询 DataSwarm Branch Agent ReAct V3 parent proxy evidence；其中一个分支需要绘制 f=sin(x) 图片。";
  }
  return "请用 swarm 并行 3 个真实 E2B 沙箱验证 DataSwarm V3 Branch Agent ReAct，每个分支都需要真实模型逐步选择 action，并至少读取上下文；其中一个分支需要绘制 f=sin(x) 图片。";
}

function provesV3RealModelBranch(metadata) {
  return (
    metadata?.provider_mode === "e2b" &&
    Number(metadata.event_count ?? 0) >= 10 &&
    metadata.agent_protocol === "dataswarm.sandbox-agent.v3" &&
    provesV3RealModelQuality(metadata.quality_signals)
  );
}

function provesV3RealModelQuality(quality) {
  return (
    quality?.runtimeVersion === "dataswarm.sandbox-runtime.v3" &&
    quality?.modelUsed === true &&
    Number(quality?.realModelActionCount ?? 0) >= 1 &&
    Number(quality?.fallbackActionCount ?? 0) === 0 &&
    quality?.modelDrivenReactLoop === true &&
    quality?.artifactRecoveryReady === true
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

async function startTunnel() {
  if (tunnelCommand) {
    return startTunnelCommand(tunnelCommand);
  }
  return startLocalTunnel();
}

async function startLocalTunnel() {
  const output = [];
  const child = spawn("npx", ["-y", "localtunnel", "--port", String(port)], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + Number(process.env.DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS ?? 60_000);
  while (Date.now() < deadline) {
    const text = output.join("\n");
    const match = text.match(/https:\/\/[a-z0-9.-]+\.loca\.lt/i);
    if (match?.[0]) {
      return { process: child, url: match[0] };
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }

  expect("localtunnel exposes parent proxy URL for live E2B", false, describeTunnelFailure("npx -y localtunnel --port " + port, output));
  finish();
}

async function startTunnelCommand(command) {
  const output = [];
  const child = spawn(command, {
    cwd: root,
    env: { ...process.env, DATASWARM_LOCAL_PORT: String(port), DATASWARM_LOCAL_URL: baseUrl },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const deadline = Date.now() + Number(process.env.DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS ?? 60_000);
  while (Date.now() < deadline) {
    const text = output.join("\n");
    const url = extractTunnelUrl(text);
    if (url) {
      const reachability = await verifyCallbackReachability(url);
      if (reachability.ok) {
        return { process: child, url };
      }
      output.push(`callback reachability check failed for ${url}: ${JSON.stringify(reachability)}`);
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }

  expect("custom tunnel command exposes parent proxy URL for live E2B", false, describeTunnelFailure(command, output));
  finish();
}

function describeTunnelFailure(command, output) {
  const text = output.join("\n").trim();
  return JSON.stringify({
    command,
    timeoutMs: Number(process.env.DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS ?? 60_000),
    outputTail: text ? text.slice(-3000) : "<no stdout/stderr captured>",
  });
}

function extractTunnelUrl(text) {
  const cleaned = stripAnsi(text);
  const urls = [...cleaned.matchAll(/https:\/\/[^\s'")<>]+/gi)].map((match) => match[0].replace(/[.,;:]+$/, ""));
  const preferred = urls.find((url) =>
    [
      ".loca.lt",
      ".lhr.life",
      ".serveousercontent.com",
      ".run.pinggy-free.link",
      ".free.pinggy.net",
      ".trycloudflare.com",
      ".ngrok-free.app",
      ".ngrok.io",
    ].some((host) => url.includes(host)),
  );
  if (preferred) {
    return preferred;
  }
  return (
    urls.find((url) => {
      if (/twitter|docs|dashboard|console|admin|settings/i.test(url)) {
        return false;
      }
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (host === "www.cloudflare.com") {
          return false;
        }
        if (host.endsWith(".cloudflare.com") && !host.endsWith(".trycloudflare.com")) {
          return false;
        }
        if (/\/api\//.test(parsed.pathname) || /\/docs\//.test(parsed.pathname)) {
          return false;
        }
      } catch {
        return false;
      }
      return true;
    }) ?? ""
  );
}

async function verifyCallbackReachability(baseUrl) {
  if (!baseUrl) {
    return { ok: false, baseUrl, details: [], reason: "missing callback base URL" };
  }

  const healthBaseUrl = deriveServiceBaseUrl(baseUrl);
  const checks = [
    { path: "/api/internal/sandbox/health", requiredStatus: "ready", requireStatusBody: true },
    { path: "/api/system/snapshot", requiredStatus: "available", requireStatusBody: false },
  ];
  const details = [];

  for (const check of checks) {
    const fullUrl = `${healthBaseUrl.replace(/\/$/, "")}${check.path}`;
    const result = await probeUrl(fullUrl, { timeoutMs: tunnelReachabilityTimeoutMs / checks.length });
    const next = { path: check.path, status: result.status, ok: result.ok };
    if (!result.ok) {
      details.push({ ...next, reason: result.body?.slice(0, 200) ?? result.statusText ?? "unreachable" });
      return { ok: false, baseUrl, details };
    }

    if (check.requireStatusBody) {
      try {
        const payload = JSON.parse(result.body || "{}");
        const passes = payload?.status === check.requiredStatus;
        details.push({ ...next, bodyStatus: payload?.status ?? null, parsed: true });
        if (!passes) {
          return {
            ok: false,
            baseUrl,
            details,
            reason: `health status mismatch for ${check.path}: ${payload?.status ?? "unknown"}`,
          };
        }
      } catch {
        details.push({ ...next, parsed: false, reason: "health body invalid JSON" });
        return { ok: false, baseUrl, details };
      }
    } else {
      details.push(next);
    }
  }

  return { ok: true, baseUrl, details };
}

function deriveServiceBaseUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const knownToolPaths = ["/api/internal/sandbox/tool-proxy", "/api/internal/capabilities/invoke"];
    for (const suffix of knownToolPaths) {
      if (parsed.pathname === suffix || parsed.pathname.startsWith(`${suffix}/`)) {
        return `${parsed.origin}${parsed.pathname.slice(0, -suffix.length) || ""}`.replace(/\/$/, "");
      }
    }
    return rawUrl.replace(/\/$/, "");
  } catch {
    return rawUrl.replace(/\/$/, "");
  }
}

async function probeUrl(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 5000);
  try {
    const response = await Promise.race([
      fetch(url, { method: "GET", cache: "no-store" }),
      delay(timeoutMs).then(() => {
        throw new Error(`callback probe timeout (${timeoutMs}ms)`);
      }),
    ]);
    const body = await response.text();
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      body: body.slice(0, 1200),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "error",
      body: String(error?.message ?? error),
    };
  }
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function hasTunnelConfig() {
  return autoTunnelMode === "localtunnel" || Boolean(tunnelCommand);
}

function isLocalOnlyUrl(value) {
  if (!value) {
    return false;
  }
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "host.docker.internal";
  } catch {
    return true;
  }
}

async function waitForHealth(output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/system/snapshot`).catch(() => null);
    if (response?.ok) {
      expect("real e2b V3 orchestrator server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("real e2b V3 orchestrator server healthy", false, output.join("\n").slice(-3000));
  finish();
}

async function waitForRun(runId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const deadline = Date.now() + Number(process.env.DATASWARM_E2B_ORCHESTRATOR_V3_E2E_RUN_TIMEOUT_MS ?? 360_000);
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
  const payloads = eventPayloads(db, runId, eventType);
  return payloads.at(-1) ?? {};
}

function eventPayloads(db, runId, eventType) {
  return db
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE run_id = ? AND event_type = ?
       ORDER BY seq ASC`,
    )
    .all(runId, eventType)
    .map((row) => unwrapEventPayload(row.payload_json));
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

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function summarizeBranchObservations(rows, metadata) {
  return rows.map((row, index) => {
    const item = metadata[index] ?? {};
    const quality = item.quality_signals ?? {};
    return {
      id: row.id,
      sourceName: row.source_name,
      status: row.status,
      evidenceLevel: row.evidence_level,
      branchId: item.branch_id,
      executionMode: item.execution_mode,
      externalSandboxId: item.external_sandbox_id,
      artifactIds: Array.isArray(item.artifact_ids) ? item.artifact_ids : [],
      imageArtifactIds: Array.isArray(item.image_artifact_ids) ? item.image_artifact_ids : [],
      quality: {
        runtimeVersion: quality.runtimeVersion,
        realModelActionCount: quality.realModelActionCount,
        fallbackActionCount: quality.fallbackActionCount,
        toolCallCount: quality.toolCallCount,
        imageArtifactCount: quality.imageArtifactCount,
        modelDrivenReactLoop: quality.modelDrivenReactLoop,
      },
    };
  });
}

function summarizeQualitySignals(quality) {
  return {
    runtimeVersion: quality.runtimeVersion,
    realModelActionCount: quality.realModelActionCount,
    fallbackActionCount: quality.fallbackActionCount,
    toolCallCount: quality.toolCallCount,
    reflectionCount: quality.reflectionCount,
    evidenceVerificationCount: quality.evidenceVerificationCount,
    contextRequestCount: quality.contextRequestCount,
    imageArtifactCount: quality.imageArtifactCount,
    modelDrivenReactLoop: quality.modelDrivenReactLoop,
  };
}

function summarizeProxyObservationMetadata(metadata) {
  return {
    branchId: metadata.branch_id,
    sandboxSessionId: metadata.sandbox_session_id,
    sandboxActionId: metadata.sandbox_action_id,
    toolCallId: metadata.tool_call_id,
    toolName: metadata.tool_name,
    provider: metadata.provider,
    logicalToolName: metadata.logical_tool_name,
    providerToolName: metadata.provider_tool_name,
    sourceCount: Array.isArray(metadata.sources) ? metadata.sources.length : 0,
  };
}

function summarizeBranchCompletedEvents(events) {
  return events.map((payload) => ({
    branchId: payload.branch_id,
    branchIndex: payload.branch_index,
    status: payload.status,
    executionMode: payload.execution_mode,
    externalSandboxId: payload.external_sandbox_id,
    observationId: payload.observation_id,
    artifactIds: Array.isArray(payload.artifact_ids) ? payload.artifact_ids : [],
    imageArtifactIds: Array.isArray(payload.image_artifact_ids) ? payload.image_artifact_ids : [],
    quality: summarizeQualitySignals(payload.quality_signals ?? {}),
    sandboxArtifactCount: Array.isArray(payload.sandbox_artifacts) ? payload.sandbox_artifacts.length : 0,
  }));
}

function summarizeReducePayload(payload) {
  return {
    status: payload.status,
    branchCount: payload.branch_count,
    completedBranchCount: payload.completed_branch_count,
    failedBranchCount: payload.failed_branch_count,
    artifactIds: payload.artifact_ids,
    branchObservationIds: payload.branch_observation_ids,
    branchItems: Array.isArray(payload.branch_items)
      ? payload.branch_items.map((item) => ({
          branchId: item.branchId,
          title: item.title,
          status: item.status,
          observationId: item.observationId,
          artifactId: item.artifactId,
          summary: truncate(item.summary, 360),
        }))
      : [],
    conflictSignalCount: Array.isArray(payload.conflict_signals) ? payload.conflict_signals.length : 0,
    summary: truncate(payload.summary, 500),
  };
}

function summarizeProxyCompletedEvents(events) {
  return events.map((payload) => ({
    branchId: payload.branch_id,
    sandboxSessionId: payload.sandbox_session_id,
    sandboxActionId: payload.sandbox_action_id,
    toolName: payload.tool_name,
    toolCallId: payload.tool_call_id,
    observationId: payload.observation_id,
    executionMode: payload.execution_mode,
    evidenceLevel: payload.evidence_level,
    outputSummary: truncate(payload.output_summary, 300),
  }));
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

function shouldKeepSmokeRows() {
  if (process.env.DATASWARM_E2B_ORCHESTRATOR_V3_KEEP_ROWS === "1") {
    return true;
  }
  if (process.env.DATASWARM_E2B_ORCHESTRATOR_V3_KEEP_ROWS_ON_FAILURE !== "1") {
    return false;
  }
  return results.some((result) => !result.passed);
}

function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}...<truncated ${text.length - limit} chars>` : text;
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${redactSecrets(result.detail)}`);
  }
  if (failed.length > 0) {
    console.error(`\nE2B orchestrator V3 real-action e2e smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nE2B orchestrator V3 real-action e2e smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = unquoteEnv(match[2]);
  }
}

function unquoteEnv(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function containsKnownSecrets(value) {
  return /e2b_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{12,}|tvly-[A-Za-z0-9_-]{12,}/.test(String(value));
}

function redactSecrets(value) {
  return String(value)
    .replace(/(^|[^A-Za-z0-9_-])e2b_[A-Za-z0-9_-]{20,}/g, "$1[REDACTED_E2B_KEY]")
    .replace(/tvly-[A-Za-z0-9_-]{12,}/g, "[REDACTED_TAVILY_KEY]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]");
}
