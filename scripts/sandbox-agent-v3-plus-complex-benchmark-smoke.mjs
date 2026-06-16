import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const agentPath = path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py");
const swarmSource = readFileSync(path.join(root, "apps/web/src/server/runtime/swarm.ts"), "utf8");
const results = [];
const failures = [];

expect("parent recovery accepts sandbox markdown artifacts", /kind === "markdown" \|\| kind === "html"/.test(swarmSource));
expect("parent recovery writes sandbox text artifacts", /createTextArtifact\(\{[\s\S]+sandboxArtifactKind/.test(swarmSource));

const research = runScenario("research-query-revision", {
  objective: "Research DataSwarm E2B Branch Agent ReAct V3+ and verify evidence quality.",
  instruction: "Search, reflect on evidence, revise the query, search again, verify evidence, and answer with observation references.",
  maxSteps: 7,
  mockActions: [
    { type: "read_context", reason: "Load scoped branch context." },
    { type: "call_tool", toolName: "web.search", input: { query: "DataSwarm E2B Branch Agent ReAct V3", max_results: 3 }, reason: "Collect first-pass evidence." },
    { type: "reflect", summary: "The first search is useful but too broad.", evidenceStatus: "partial", next: "revise query for V3+ validation and evidence coverage." },
    { type: "revise_query", toolName: "web.search", previousQuery: "DataSwarm E2B Branch Agent ReAct V3", newQuery: "DataSwarm sandbox agent V3+ evidence verification parent tool proxy", reason: "Focus the follow-up search." },
    { type: "call_tool", toolName: "web.search", input: { query: "DataSwarm sandbox agent V3+ evidence verification parent tool proxy", max_results: 3 }, reason: "Collect focused evidence." },
    { type: "verify_evidence", claims: ["Two parent-proxy web observations were collected."], observationIds: ["sbo_v3_02_tool", "sbo_v3_05_tool"], artifactIds: [], status: "passed", sourceCoverage: 1 },
    { type: "final_answer", answer: "Research branch completed two web searches, revised its query, and verified evidence.", usedObservationIds: ["sbo_v3_02_tool", "sbo_v3_05_tool", "sbo_v3_06_verification"], artifactIds: [], limitations: ["Parent proxy is mocked in this local benchmark."] },
  ],
});
expect("research branch completes", research.result?.status === "completed", summarize(research));
expect("research branch performs two parent-proxy tool calls", countEvent(research.events, "sandbox.agent.tool.completed") === 2, summarize(research));
expect("research branch revises query", hasObservation(research.events, "sbo_v3_04_query_revision"), summarize(research));
expect("research branch verifies evidence", research.result?.qualitySignals?.evidenceVerificationCount >= 1, summarize(research));
expect("research branch remains fallback-free", research.result?.qualitySignals?.fallbackActionCount === 0, summarize(research));

const plot = runScenario("scientific-plot", {
  objective: "Use sandbox Python to draw f=sin(x) and return the generated image artifact.",
  instruction: "Run Python locally, reflect, verify the image artifact, and answer with artifact references.",
  maxSteps: 5,
  mockActions: [
    { type: "read_context", reason: "Load plotting requirements." },
    { type: "run_python", reason: "Generate the f=sin(x) plot artifact." },
    { type: "reflect", summary: "The image artifact was created.", evidenceStatus: "sufficient", next: "verify artifact before final." },
    { type: "verify_evidence", claims: ["A sine plot image artifact was created."], observationIds: ["sbo_v3_02_python"], artifactIds: ["sin-plot.png"], status: "passed", artifactCoverage: 1 },
    { type: "final_answer", answer: "Plot branch generated and verified the f=sin(x) image artifact.", usedObservationIds: ["sbo_v3_02_python", "sbo_v3_04_verification"], artifactIds: ["sin-plot.png"], limitations: [] },
  ],
});
expect("plot branch completes", plot.result?.status === "completed", summarize(plot));
expect("plot branch returns image content", plot.result?.artifacts?.some((artifact) => artifact.kind === "image" && artifact.contentBase64), summarize(plot));
expect("plot branch verifies artifact evidence", plot.result?.qualitySignals?.evidenceVerificationCount >= 1, summarize(plot));

const report = runScenario("report-artifacts", {
  objective: "Create markdown and HTML branch report artifacts from verified observations.",
  instruction: "Create durable markdown and HTML artifacts, verify them, and answer with artifact references.",
  maxSteps: 5,
  mockActions: [
    { type: "read_context", reason: "Load report requirements." },
    { type: "create_artifact", artifactKind: "markdown", title: "V3+ Branch Report", content: "# V3+ Branch Report\n\n- Evidence-bound branch report.\n", reason: "Create markdown report artifact." },
    { type: "create_artifact", artifactKind: "html", title: "V3+ Branch Report HTML", content: "<!doctype html><html><body><h1>V3+ Branch Report</h1><p>Evidence-bound branch report.</p></body></html>", reason: "Create HTML report artifact." },
    { type: "verify_evidence", claims: ["Markdown and HTML report artifacts were created."], observationIds: ["sbo_v3_02_artifact", "sbo_v3_03_artifact"], artifactIds: ["V3+ Branch Report", "V3+ Branch Report HTML"], status: "passed", artifactCoverage: 1 },
    { type: "final_answer", answer: "Report branch created markdown and HTML artifacts and verified their provenance.", usedObservationIds: ["sbo_v3_02_artifact", "sbo_v3_03_artifact", "sbo_v3_04_verification"], artifactIds: ["V3+ Branch Report", "V3+ Branch Report HTML"], limitations: [] },
  ],
});
expect("report branch completes", report.result?.status === "completed", summarize(report));
expect("report branch returns markdown artifact content", report.result?.artifacts?.some((artifact) => artifact.kind === "markdown" && artifact.contentBase64), summarize(report));
expect("report branch returns html artifact content", report.result?.artifacts?.some((artifact) => artifact.kind === "html" && artifact.contentBase64), summarize(report));
expect("report branch emits two artifact created events", countEvent(report.events, "sandbox.agent.artifact.created") >= 2, summarize(report));

const contextRequest = runScenario("context-request", {
  objective: "Identify missing parent context without inventing unavailable data.",
  instruction: "Ask for more context when the scoped bundle is insufficient and finish with a limitation.",
  maxSteps: 2,
  mockActions: [
    { type: "request_more_context", neededContext: "Upload the source dataset or provide the parent trace bundle.", reason: "The branch cannot verify data lineage from the scoped context alone." },
    { type: "final_answer", answer: "The branch stopped and requested more context instead of guessing.", usedObservationIds: ["sbo_v3_01_context_request"], artifactIds: [], limitations: ["Source data was not available in the scoped context."] },
  ],
});
expect("context request branch completes", contextRequest.result?.status === "completed", summarize(contextRequest));
expect("context request branch records context request", contextRequest.result?.qualitySignals?.contextRequestCount === 1, summarize(contextRequest));
expect("context request branch has no fallback", contextRequest.result?.qualitySignals?.fallbackActionCount === 0, summarize(contextRequest));

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

for (const item of results) {
  console.log(`PASS ${item.name}: ${item.detail}`);
}
console.log(`\nSandbox agent V3+ complex benchmark smoke passed: ${results.length}/${results.length} check(s) passed.`);

function runScenario(name, input) {
  const branchId = `branch_${name.replace(/[^a-z0-9]+/gi, "_")}`;
  const payload = {
    protocolVersion: "dataswarm.sandbox-agent.v3",
    agentProtocol: "dataswarm.sandbox-agent.v3",
    runId: `run_${branchId}`,
    conversationId: `conv_${branchId}`,
    taskId: `task_${branchId}`,
    branchId,
    sandboxSessionId: `sbx_${branchId}`,
    agentSessionId: `agent_${branchId}`,
    agentName: `Sandbox V3+ ${name}`,
    modelProfile: "deepseek:deepseek-v4-flash",
    objective: input.objective,
    instruction: input.instruction,
    contextBundleUri: `local://context-bundles/${branchId}.json`,
    contextBundleContent: JSON.stringify({ scenario: name, objective: input.objective }),
    executionMode: "local-complex-benchmark",
    maxSteps: input.maxSteps,
    maxToolCalls: 4,
    maxRuntimeMs: 120000,
    maxOutputTokens: 4096,
    toolCatalog: [
      { name: "web.search", capability: "web_search", adapterMode: "parent" },
      { name: "artifact.create", capability: "artifact_create", adapterMode: "parent" },
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
      mockActions: input.mockActions,
    },
  };
  const run = spawnSync("python3", [agentPath], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  if (run.status !== 0) {
    return { name, status: run.status, stdout: run.stdout, stderr: run.stderr, events: [], result: null };
  }
  const lines = run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    name,
    status: run.status,
    events: lines.filter((line) => typeof line.type === "string" && line.type.startsWith("sandbox.agent.")),
    result: lines.at(-1),
  };
}

function countEvent(events, type) {
  return events.filter((event) => event.type === type).length;
}

function hasObservation(events, observationId) {
  return events.some((event) => event.type === "sandbox.agent.observation.created" && event.payload?.observationId === observationId);
}

function summarize(run) {
  return JSON.stringify({
    name: run.name,
    status: run.status,
    qualitySignals: run.result?.qualitySignals,
    artifacts: run.result?.artifacts?.map((artifact) => ({
      kind: artifact.kind,
      title: artifact.title,
      bytes: artifact.bytes,
      hasContent: Boolean(artifact.contentBase64),
    })),
  });
}

function expect(name, passed, detail = "") {
  const record = { name, passed: Boolean(passed), detail: String(detail) };
  results.push(record);
  if (!passed) {
    failures.push(record);
  }
}
