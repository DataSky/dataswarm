import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const agentPath = path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py");
const results = [];
const failures = [];

const source = readFileSync(agentPath, "utf8");
const proxySource = readFileSync(path.join(root, "apps/web/src/server/runtime/sandbox-tool-proxy.ts"), "utf8");
const providerSource = readFileSync(path.join(root, "apps/web/src/server/runtime/sandbox-provider.ts"), "utf8");
expect("sandbox agent declares v3 protocol", /dataswarm\.sandbox-agent\.v3/.test(source));
expect("sandbox agent has model-driven v3 loop", /def run_v3/.test(source) && /propose_v3_action/.test(source));
expect("sandbox agent can parse and repair model actions", /extract_json_object/.test(source) && /repair_action_with_model/.test(source));
expect("sandbox v3 records model action source", /modelDrivenReactLoop/.test(source) && /actionSource/.test(source));
expect("sandbox v3 has native validator", /def validate_v3_action/.test(source) && /verify_evidence/.test(source));
expect("parent sandbox protocol defaults to v3", /return "dataswarm\.sandbox-agent\.v3"/.test(proxySource));
expect("sandbox provider accepts v3 jobs", /dataswarm\.sandbox-agent\.v3/.test(providerSource));

const job = {
  protocolVersion: "dataswarm.sandbox-agent.v3",
  agentProtocol: "dataswarm.sandbox-agent.v3",
  runId: "run_sandbox_v3_smoke",
  conversationId: "conv_sandbox_v3_smoke",
  taskId: "task_sandbox_v3_smoke",
  branchId: "branch_sandbox_v3_smoke",
  sandboxSessionId: "sbx_sandbox_v3_smoke",
  agentSessionId: "agent_sandbox_v3_smoke",
  agentName: "Sandbox V3 Smoke Branch",
  modelProfile: "deepseek:deepseek-v4-flash",
  objective: "Search the web for DataSwarm Branch Agent ReAct V3 evidence and draw f=sin(x) as an image.",
  instruction: "Use model-selected actions, call web.search through parent proxy, generate an image, and return a final answer.",
  contextBundleUri: "local://context-bundles/sandbox-v3-smoke.json",
  contextBundleContent: JSON.stringify({ objective: "sandbox-v3-smoke", note: "scoped context only" }),
  executionMode: "local-smoke",
  maxSteps: 8,
  maxToolCalls: 4,
  maxRuntimeMs: 120000,
  maxOutputTokens: 4096,
  toolCatalog: [
    { name: "web.search", capability: "web_search", adapterMode: "parent" },
    { name: "artifact.create", capability: "artifact_create", adapterMode: "parent" },
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
    allowedTools: ["web.search", "artifact.create"],
    authMode: "signed_token",
  },
  sandboxModel: {
    mode: "mock_actions",
    model: "mock-deepseek-action-model",
    mockActions: [
      { type: "use_skill", skillName: "web-research", reason: "Apply research policy." },
      { type: "read_context", reason: "Read scoped context first." },
      {
        type: "call_tool",
        toolName: "web.search",
        input: { query: "DataSwarm Branch Agent ReAct V3", max_results: 5 },
        reason: "Collect external evidence through the parent proxy.",
      },
      { type: "run_python", reason: "Generate the requested f=sin(x) image artifact." },
      { type: "create_artifact", reason: "Prepare artifact manifest for parent recovery." },
      {
        type: "reflect",
        summary: "The branch has context, parent-proxy search evidence, and an image artifact.",
        evidenceStatus: "sufficient",
        next: "verify evidence before final answer.",
      },
      {
        type: "verify_evidence",
        claims: ["Parent-proxy evidence and image artifact were created."],
        observationIds: ["sbo_v3_03_tool", "sbo_v3_04_python", "sbo_v3_05_artifact"],
        artifactIds: ["sin-plot.png"],
        status: "passed",
        sourceCoverage: 1,
        artifactCoverage: 1,
      },
      {
        type: "final_answer",
        answer: "Mock action model completed a V3 branch with parent-proxy evidence and image artifact recovery.",
        usedObservationIds: ["sbo_v3_03_tool", "sbo_v3_04_python", "sbo_v3_07_verification"],
        artifactIds: ["sin-plot.png"],
        limitations: [],
        reason: "All requested branch evidence has been collected.",
      },
    ],
  },
};

const run = runAgent(job);
expect("sandbox v3 agent exits successfully", run.status === 0, run.status === 0 ? "" : run.stderr || run.stdout.slice(0, 2000));
const lines = parseJsonLines(run.stdout);
const events = lines.filter((line) => typeof line.type === "string" && line.type.startsWith("sandbox.agent."));
const result = lines.at(-1);

expect("sandbox v3 emits loop started", events.some((event) => event.type === "sandbox.agent.loop.started"));
expect("sandbox v3 emits loop completed", events.some((event) => event.type === "sandbox.agent.loop.completed"));
expect("sandbox v3 emits model usage per action", events.filter((event) => event.type === "sandbox.agent.model.usage").length >= 5);
expect("sandbox v3 emits model-sourced action lifecycle", events.some((event) => event.type === "sandbox.agent.action.proposed" && event.payload?.actionSource === "mock_model"));
expect("sandbox v3 uses parent proxy tool", events.some((event) => event.type === "sandbox.agent.tool.completed"));
expect("sandbox v3 reflects before final", events.some((event) => event.type === "sandbox.agent.observation.created" && event.payload?.sourceType === "agent" && event.payload?.observationId === "sbo_v3_06_reflection"));
expect("sandbox v3 verifies evidence before final", events.some((event) => event.type === "sandbox.agent.observation.created" && event.payload?.sourceType === "verification"));
expect("sandbox v3 creates observations", events.filter((event) => event.type === "sandbox.agent.observation.created").length >= 5);
expect("sandbox v3 creates image artifact", events.some((event) => event.type === "sandbox.agent.artifact.created"));
expect("sandbox v3 final result completed", result?.status === "completed", result?.status === "completed" ? "" : JSON.stringify(result));
expect("sandbox v3 result uses v3 protocol", result?.protocolVersion === "dataswarm.sandbox-agent.v3", result?.protocolVersion === "dataswarm.sandbox-agent.v3" ? "" : JSON.stringify(result));
expect("sandbox v3 quality signals prove model-driven loop", result?.qualitySignals?.modelDrivenReactLoop === true, result?.qualitySignals?.modelDrivenReactLoop === true ? "" : JSON.stringify(result?.qualitySignals));
expect("sandbox v3 has no deterministic fallback in mock-action mode", result?.qualitySignals?.fallbackActionCount === 0, result?.qualitySignals?.fallbackActionCount === 0 ? "" : JSON.stringify(result?.qualitySignals));
expect("sandbox v3 records tool call", result?.qualitySignals?.toolCallCount >= 1, result?.qualitySignals?.toolCallCount >= 1 ? "" : JSON.stringify(result?.qualitySignals));
expect("sandbox v3 records reflection and evidence verification counts", result?.qualitySignals?.reflectionCount >= 1 && result?.qualitySignals?.evidenceVerificationCount >= 1, JSON.stringify(result?.qualitySignals));
expect("sandbox v3 records healthy fallback policy", result?.qualitySignals?.fallbackPolicyStatus === "healthy" && result?.qualitySignals?.degradedExecution === false, JSON.stringify(result?.qualitySignals));
expect("sandbox v3 returns image artifact manifest", Array.isArray(result?.artifacts) && result.artifacts.some((artifact) => artifact.kind === "image" && artifact.contentBase64), Array.isArray(result?.artifacts) && result.artifacts.some((artifact) => artifact.kind === "image" && artifact.contentBase64) ? "" : JSON.stringify(result?.artifacts));

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

for (const item of results) {
  console.log(`PASS ${item.name}: ${item.detail}`);
}
console.log(`\nSandbox agent v3 smoke passed: ${results.length}/${results.length} check(s) passed.`);

function runAgent(payload) {
  return spawnSync("python3", [agentPath], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: { ...process.env, PYTHONUTF8: "1" },
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
