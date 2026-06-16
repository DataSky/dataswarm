import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const agentPath = path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py");
const results = [];
const failures = [];

const source = readFileSync(agentPath, "utf8");
expect("sandbox agent declares v2 protocol", /dataswarm\.sandbox-agent\.v2/.test(source));
expect("sandbox agent emits v2 loop lifecycle", /sandbox\.agent\.loop\.started/.test(source) && /sandbox\.agent\.loop\.completed/.test(source));
expect("sandbox agent supports parent tool proxy", /call_parent_tool/.test(source) && /sandbox\.agent\.tool\.requested/.test(source));
expect("sandbox agent supports v2 action lifecycle", /sandbox\.agent\.action\.\{status\}/.test(source) || /sandbox\.agent\.action\./.test(source));

const job = {
  protocolVersion: "dataswarm.sandbox-agent.v2",
  agentProtocol: "dataswarm.sandbox-agent.v2",
  runId: "run_sandbox_v2_smoke",
  conversationId: "conv_sandbox_v2_smoke",
  taskId: "task_sandbox_v2_smoke",
  branchId: "branch_sandbox_v2_smoke",
  sandboxSessionId: "sbx_sandbox_v2_smoke",
  agentSessionId: "agent_sandbox_v2_smoke",
  agentName: "Sandbox V2 Smoke Branch",
  modelProfile: "deepseek:deepseek-v4-flash",
  objective: "Search the web for DataSwarm sandbox agent evidence and draw f=sin(x) as an image.",
  instruction: "Use the sandbox ReAct loop, call web.search through parent proxy, and create an image artifact.",
  contextBundleUri: "local://context-bundles/sandbox-v2-smoke.json",
  contextBundleContent: JSON.stringify({ objective: "sandbox-v2-smoke", note: "scoped context only" }),
  executionMode: "local-smoke",
  maxSteps: 6,
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
    mode: "deterministic",
    model: "deepseek-v4-flash",
  },
};

const run = runAgent(job);
expect("sandbox v2 agent exits successfully", run.status === 0, run.status === 0 ? "" : run.stderr || run.stdout.slice(0, 2000));
const lines = parseJsonLines(run.stdout);
const events = lines.filter((line) => typeof line.type === "string" && line.type.startsWith("sandbox.agent."));
const result = lines.at(-1);

expect("sandbox v2 emits loop started", events.some((event) => event.type === "sandbox.agent.loop.started"), eventPreview(events));
expect("sandbox v2 emits loop completed", events.some((event) => event.type === "sandbox.agent.loop.completed"), eventPreview(events));
expect(
  "sandbox v2 emits dotted action lifecycle",
  events.some((event) => event.type === "sandbox.agent.action.proposed") &&
    events.some((event) => event.type === "sandbox.agent.action.completed"),
  eventPreview(events),
);
expect(
  "sandbox v2 emits tool request and completion",
  events.some((event) => event.type === "sandbox.agent.tool.requested") &&
    events.some((event) => event.type === "sandbox.agent.tool.completed"),
  eventPreview(events),
);
expect("sandbox v2 emits observation.created events", events.filter((event) => event.type === "sandbox.agent.observation.created").length >= 4, eventPreview(events));
expect("sandbox v2 emits artifact created for image", events.some((event) => event.type === "sandbox.agent.artifact.created"), eventPreview(events));
expect("sandbox v2 emits model usage", events.some((event) => event.type === "sandbox.agent.model.usage"), eventPreview(events));
expect("sandbox v2 final result completed", result?.status === "completed", result?.status === "completed" ? "" : JSON.stringify(result));
expect("sandbox v2 result uses v2 protocol", result?.protocolVersion === "dataswarm.sandbox-agent.v2", result?.protocolVersion === "dataswarm.sandbox-agent.v2" ? "" : JSON.stringify(result));
expect("sandbox v2 quality signals prove loop entered", result?.qualitySignals?.reactLoopEntered === true, result?.qualitySignals?.reactLoopEntered === true ? "" : JSON.stringify(result?.qualitySignals));
expect("sandbox v2 quality signals record tool call", result?.qualitySignals?.toolCallCount >= 1, result?.qualitySignals?.toolCallCount >= 1 ? "" : JSON.stringify(result?.qualitySignals));
expect(
  "sandbox v2 returns image artifact manifest",
  Array.isArray(result?.artifacts) && result.artifacts.some((artifact) => artifact.kind === "image" && artifact.contentBase64),
  Array.isArray(result?.artifacts) && result.artifacts.some((artifact) => artifact.kind === "image" && artifact.contentBase64) ? "" : JSON.stringify(result?.artifacts),
);
expect("sandbox v2 markdown reports limitations", typeof result?.outputMarkdown === "string" && result.outputMarkdown.includes("## Limitations"));

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

for (const item of results) {
  console.log(`PASS ${item.name}: ${item.passed ? "" : item.detail}`);
}
console.log(`\nSandbox agent v2 smoke passed: ${results.length}/${results.length} check(s) passed.`);

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

function eventPreview(events) {
  return events
    .slice(0, 20)
    .map((event) => event.type)
    .join(", ");
}
