import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const agentPath = path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py");
const results = [];

if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_BASE_URL) {
  expect("sandbox model smoke skipped", true, "set DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL to enable");
  finish();
}

const job = {
  branchId: "branch_model_smoke",
  agentName: "Model Smoke Branch",
  modelProfile: "deepseek:deepseek-v4-flash",
  objective: "Verify DataSwarm sandbox agent can call the configured sandbox model.",
  instruction: "Return a concise branch analysis using only the runtime fact that this sandbox model call returned text successfully; do not invent context bundle contents.",
  contextBundleUri: "local://context-bundles/model-smoke.json",
  executionMode: "local-model-smoke",
  sandboxModel: {
    mode: "real",
    model: process.env.DATASWARM_SANDBOX_AGENT_MODEL_NAME || "deepseek-v4-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    authScheme: process.env.DATASWARM_SANDBOX_AGENT_AUTH_SCHEME || "bearer",
    maxTokens: 300,
    timeoutSeconds: 60,
  },
};

const result = spawnSync("python3", [agentPath], {
  cwd: root,
  encoding: "utf8",
  input: JSON.stringify(job),
  env: { ...process.env, PYTHONUTF8: "1" },
});
expect("sandbox model agent exits successfully", result.status === 0, result.stderr || result.stdout.slice(0, 1000));

const lines = parseJsonLines(result.stdout);
const events = lines.filter((line) => typeof line.type === "string" && line.type.startsWith("sandbox.agent."));
const final = lines.at(-1);
expect("sandbox model emits model call started", events.some((event) => event.type === "sandbox.agent.model_call_started"), result.stdout);
expect("sandbox model emits model call completed", events.some((event) => event.type === "sandbox.agent.model_call_completed"), result.stdout);
expect("sandbox model emits heartbeat events", events.filter((event) => event.type === "sandbox.agent.heartbeat").length >= 3, result.stdout);
expect(
  "sandbox model emits action lifecycle events",
  events.some((event) => event.type === "sandbox.agent.action_proposed") &&
    events.some((event) => event.type === "sandbox.agent.action_completed"),
  result.stdout,
);
expect(
  "sandbox model emits observation events",
  events.filter((event) => event.type === "sandbox.agent.observation_created").length >= 4,
  result.stdout,
);
expect("sandbox model emits artifact recovery manifest", events.some((event) => event.type === "sandbox.agent.artifact_recovery_manifest"), result.stdout);
expect("sandbox model final result completed", final?.status === "completed", JSON.stringify(final));
expect("sandbox model quality signals mark real model used", final?.qualitySignals?.modelUsed === true, JSON.stringify(final?.qualitySignals));
expect("sandbox model quality signals mark recovery ready", final?.qualitySignals?.artifactRecoveryReady === true, JSON.stringify(final?.qualitySignals));
expect(
  "sandbox model quality signals include runtime counts",
  final?.qualitySignals?.runtimeVersion === "dataswarm.sandbox-runtime.v1" &&
    final?.qualitySignals?.actionCount >= 8 &&
    final?.qualitySignals?.observationCount >= 4,
  JSON.stringify(final?.qualitySignals),
);
expect(
  "sandbox model final result includes runtime logs",
  final?.runtime?.version === "dataswarm.sandbox-runtime.v1" &&
    Array.isArray(final?.runtime?.actions) &&
    final.runtime.actions.length >= 8 &&
    Array.isArray(final?.runtime?.observations) &&
    final.runtime.observations.length >= 4,
  JSON.stringify(final?.runtime),
);

finish();

function parseJsonLines(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function expect(name, passed, detail) {
  results.push({ name, passed, detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nSandbox agent model smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSandbox agent model smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
