import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const root = process.cwd();
const agentPath = path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py");
const results = [];
const failures = [];

const actions = [
  { type: "use_skill", skillName: "web-research", reason: "Apply branch research policy before collecting evidence." },
  { type: "read_context", reason: "Read the scoped context bundle before taking external actions." },
  {
    type: "call_tool",
    toolName: "web.search",
    input: { query: "DataSwarm E2B Branch Agent ReAct V3", max_results: 5 },
    reason: "Collect parent-proxied web evidence for the branch objective.",
  },
  { type: "run_python", reason: "Generate the requested f=sin(x) image artifact inside the sandbox runtime." },
  { type: "create_artifact", reason: "Prepare artifact manifests for parent recovery." },
  {
    type: "final_answer",
    answer:
      "The V3 branch agent completed a model-selected ReAct sequence using parent-proxied tool evidence and local artifact generation.",
    reason: "The branch has enough observations and artifacts to return a final answer.",
  },
];

const serverState = { requestCount: 0, nextActionIndex: 0, lastActionIndex: 0, requests: [] };
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const body = JSON.parse(rawBody);
  serverState.requestCount += 1;
  serverState.requests.push({
    model: body.model,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    responseFormat: body.response_format,
    maxTokens: body.max_tokens,
  });

  const isRepairRequest = rawBody.includes("invalidOutput") || rawBody.includes("retryReason");
  const actionIndex = isRepairRequest
    ? serverState.lastActionIndex
    : Math.min(serverState.nextActionIndex++, actions.length - 1);
  serverState.lastActionIndex = actionIndex;
  const action = actions[actionIndex];
  const content = isRepairRequest ? JSON.stringify(action) : formatActionContent(action, actionIndex);
  const usage = {
    prompt_tokens: JSON.stringify(body.messages ?? []).length,
    completion_tokens: content.length,
    total_tokens: JSON.stringify(body.messages ?? []).length + content.length,
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: `chatcmpl_sandbox_v3_${serverState.requestCount}`,
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage,
    }),
  );
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const job = {
    protocolVersion: "dataswarm.sandbox-agent.v3",
    agentProtocol: "dataswarm.sandbox-agent.v3",
    runId: "run_sandbox_v3_real_action_smoke",
    conversationId: "conv_sandbox_v3_real_action_smoke",
    taskId: "task_sandbox_v3_real_action_smoke",
    branchId: "branch_sandbox_v3_real_action_smoke",
    sandboxSessionId: "sbx_sandbox_v3_real_action_smoke",
    agentSessionId: "agent_sandbox_v3_real_action_smoke",
    agentName: "Sandbox V3 Real Action Smoke Branch",
    modelProfile: "deepseek:deepseek-v4-flash",
    objective:
      "Search parent-proxied web evidence for DataSwarm Branch Agent ReAct V3 and draw f=sin(x) as an image.",
    instruction:
      "Use real model action selection through an OpenAI-compatible endpoint, call web.search through parent proxy, generate an image, and return a final answer.",
    contextBundleUri: "local://context-bundles/sandbox-v3-real-action-smoke.json",
    contextBundleContent: JSON.stringify({
      objective: "sandbox-v3-real-action-smoke",
      requirement: "prove mode=real model calls can drive stepwise SandboxAgentAction execution",
    }),
    executionMode: "local-real-action-smoke",
    maxSteps: 6,
    maxToolCalls: 4,
    maxRuntimeMs: 120000,
    maxOutputTokens: 4096,
    toolCatalog: [
      { name: "web.search", capability: "web_search", adapterMode: "parent" },
      { name: "artifact.create", capability: "artifact_create", adapterMode: "parent" },
      { name: "run_python", capability: "visualization", adapterMode: "local" },
    ],
    skillManifests: [
      {
        name: "web-research",
        version: "0.1.0",
        purpose: "Research external information using tool observations.",
        qualityChecks: ["Cite parent tool observations.", "State limitations."],
      },
    ],
    parentToolProxy: {
      mode: "mock",
      url: "",
      proxySessionToken: "mock-token",
      allowedTools: ["web.search", "artifact.create", "run_python"],
      authMode: "signed_token",
    },
    sandboxModel: {
      mode: "real",
      model: "mock-openai-compatible-action-model",
      baseUrl,
      baseUrlEnv: "DATASWARM_TEST_MODEL_BASE_URL",
      apiKeyEnv: "DATASWARM_TEST_MODEL_API_KEY",
      authScheme: "bearer",
      jsonMode: true,
      actionMaxTokens: 700,
      maxTokens: 700,
      timeoutSeconds: 10,
    },
  };

  const run = await runAgent(job, {
    DATASWARM_TEST_MODEL_BASE_URL: baseUrl,
    DATASWARM_TEST_MODEL_API_KEY: "test-key",
  });
  expect(
    "sandbox v3 real-action agent exits successfully",
    run.status === 0,
    run.status === 0 ? "" : run.stderr || run.stdout.slice(0, 2000),
  );

  const lines = parseJsonLines(run.stdout);
  const events = lines.filter((line) => typeof line.type === "string" && line.type.startsWith("sandbox.agent."));
  const result = lines.at(-1);
  const loopStarted = events.find((event) => event.type === "sandbox.agent.loop.started");

  expect(
    "mock model server received one request per action step",
    serverState.requestCount >= 6,
    serverState.requestCount >= 6 ? "" : String(serverState.requestCount),
  );
  expect("model requests used OpenAI-compatible chat payloads", serverState.requests.every((item) => item.messageCount >= 2));
  expect(
    "model requests enabled JSON response mode",
    serverState.requests.every((item) => item.responseFormat?.type === "json_object"),
    serverState.requests.every((item) => item.responseFormat?.type === "json_object") ? "" : JSON.stringify(serverState.requests),
  );
  expect(
    "sandbox emitted next_action model call starts",
    events.filter((event) => event.type === "sandbox.agent.model_call_started" && event.payload?.purpose === "next_action").length >= 6,
  );
  expect(
    "sandbox loop declares V4.1 action schema and repair budget policy",
    loopStarted?.payload?.actionSchemaVersion === "dataswarm.sandbox-action-schema.v4.1" &&
      Array.isArray(loopStarted?.payload?.canonicalActionTypes) &&
      loopStarted.payload.canonicalActionTypes.includes("web.search") &&
      loopStarted.payload.canonicalActionTypes.includes("artifact.create") &&
      loopStarted.payload.repairPolicy?.maxRepairAttempts === 2 &&
      loopStarted.payload.budgetPolicy?.maxSteps === 6,
    JSON.stringify(loopStarted?.payload),
  );
  expect(
    "sandbox emitted next_action model call completions",
    events.filter((event) => event.type === "sandbox.agent.model_call_completed" && event.payload?.purpose === "next_action").length >= 6,
  );
  expect(
    "sandbox emitted parse repair lifecycle events",
    events.some((event) => event.type === "sandbox.agent.action_repair_started" && event.payload?.repairAttempt === 1) &&
      events.some((event) => event.type === "sandbox.agent.action_repair_succeeded" && event.payload?.repairAttempt === 1),
    JSON.stringify(events.filter((event) => event.type.startsWith("sandbox.agent.action_repair_")).map((event) => event.payload)),
  );
  expect(
    "sandbox recorded real_model action source",
    events.filter((event) => event.type === "sandbox.agent.action.proposed" && event.payload?.actionSource === "real_model").length >= 6,
  );
  expect("sandbox v3 used parent proxy tool", events.some((event) => event.type === "sandbox.agent.tool.completed"));
  expect("sandbox v3 created observations", events.filter((event) => event.type === "sandbox.agent.observation.created").length >= 5);
  expect("sandbox v3 created image artifact", events.some((event) => event.type === "sandbox.agent.artifact.created"));
  expect("sandbox v3 final result completed", result?.status === "completed", result?.status === "completed" ? "" : compactResult(result));
  expect(
    "sandbox v3 result uses v3 protocol",
    result?.protocolVersion === "dataswarm.sandbox-agent.v3",
    result?.protocolVersion === "dataswarm.sandbox-agent.v3" ? "" : compactResult(result),
  );
  expect(
    "sandbox v3 quality signals prove real model action selection",
    result?.qualitySignals?.realModelActionCount >= 6 && result?.qualitySignals?.modelUsed === true,
    result?.qualitySignals?.realModelActionCount >= 6 && result?.qualitySignals?.modelUsed === true
      ? ""
      : JSON.stringify(result?.qualitySignals),
  );
  expect(
    "sandbox v3 did not use deterministic fallback",
    result?.qualitySignals?.fallbackActionCount === 0,
    result?.qualitySignals?.fallbackActionCount === 0 ? "" : JSON.stringify(result?.qualitySignals),
  );
  expect(
    "sandbox v3 counted repaired model actions",
    result?.qualitySignals?.repairedActionCount >= 1,
    result?.qualitySignals?.repairedActionCount >= 1 ? "" : JSON.stringify(result?.qualitySignals),
  );
  expect(
    "sandbox v3 returned recoverable image artifact manifest",
    Array.isArray(result?.artifacts) && result.artifacts.some((artifact) => artifact.kind === "image" && artifact.contentBase64),
    Array.isArray(result?.artifacts) && result.artifacts.some((artifact) => artifact.kind === "image" && artifact.contentBase64)
      ? ""
      : JSON.stringify(result?.artifacts),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

for (const item of results) {
  console.log(`PASS ${item.name}: ${item.detail}`);
}
console.log(`\nSandbox agent v3 real-action smoke passed: ${results.length}/${results.length} check(s) passed.`);

function formatActionContent(action, index) {
  if (index === 0) {
    return `\`\`\`json\n${JSON.stringify(action)}\n\`\`\``;
  }
  if (index === 1) {
    return `I will take the next branch action now.\n${JSON.stringify({ next_action: action })}`;
  }
  if (index === 2) {
    return JSON.stringify({
      tool_calls: [
        {
          type: "function",
          function: {
            name: action.toolName,
            arguments: JSON.stringify(action.input),
          },
        },
      ],
    });
  }
  if (index === 3) {
    return "I cannot produce JSON for this step yet. Please repair this into a run_python SandboxAgentAction.";
  }
  if (index === 4) {
    return JSON.stringify({ response: action });
  }
  return JSON.stringify(action);
}

function runAgent(payload, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn("python3", [agentPath], {
      cwd: root,
      env: { ...process.env, ...extraEnv, PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function parseJsonLines(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function expect(name, passed, detail = "") {
  const record = { name, passed: Boolean(passed), detail: String(detail) };
  results.push(record);
  if (!passed) {
    failures.push(record);
  }
}

function compactResult(result) {
  if (!result || typeof result !== "object") {
    return JSON.stringify(result);
  }
  return JSON.stringify({
    protocolVersion: result.protocolVersion,
    status: result.status,
    branchId: result.branchId,
    qualitySignals: result.qualitySignals,
    artifactKinds: Array.isArray(result.artifacts) ? result.artifacts.map((artifact) => artifact.kind) : [],
  });
}
