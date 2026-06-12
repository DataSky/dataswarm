import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const agentPath = path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py");
const results = [];
const failures = [];

const source = readFileSync(agentPath, "utf8");
expect("sandbox agent declares protocol version", /dataswarm\.sandbox-agent\.v1/.test(source));
expect("sandbox agent emits progress events", /sandbox\.agent\.started/.test(source) && /sandbox\.agent\.completed/.test(source));
expect("sandbox agent emits heartbeat events", /sandbox\.agent\.heartbeat/.test(source) && /emit_heartbeat/.test(source));
expect("sandbox agent emits artifact recovery manifest", /sandbox\.agent\.artifact_recovery_manifest/.test(source));
expect("sandbox agent declares sandbox runtime version", /dataswarm\.sandbox-runtime\.v1/.test(source));
expect(
  "sandbox agent emits internal action and observation events",
  /emit_action/.test(source) &&
    /sandbox\.agent\.action_/.test(source) &&
    /"proposed"/.test(source) &&
    /"completed"/.test(source) &&
    /sandbox\.agent\.observation_created/.test(source),
);

const job = {
  branchId: "branch_smoke",
  agentName: "Smoke Branch",
  modelProfile: "deepseek:deepseek-v4-flash",
  objective: "Verify sandbox branch protocol, artifact metadata, and event bridge.",
  instruction: "Produce a deterministic branch summary and validation notes.",
  contextBundleUri: "local://context-bundles/smoke.json",
  executionMode: "local-smoke",
};

const ok = runAgent(job);
expect("sandbox agent exits successfully for valid job", ok.status === 0, ok.stderr);
const okLines = parseJsonLines(ok.stdout);
const okEvents = okLines.filter((line) => typeof line.type === "string" && line.type.startsWith("sandbox.agent."));
const okResult = okLines.at(-1);
expect("sandbox agent emits at least three events", okEvents.length >= 3, `${okEvents.length} event(s)`);
expect("sandbox agent emits heartbeat events during valid job", okEvents.filter((event) => event.type === "sandbox.agent.heartbeat").length >= 3, ok.stdout);
expect(
  "sandbox agent emits action lifecycle events during valid job",
  okEvents.some((event) => event.type === "sandbox.agent.action_proposed") &&
    okEvents.some((event) => event.type === "sandbox.agent.action_completed"),
  ok.stdout,
);
expect(
  "sandbox agent emits observation events during valid job",
  okEvents.filter((event) => event.type === "sandbox.agent.observation_created").length >= 4,
  ok.stdout,
);
expect(
  "sandbox agent emits artifact recovery manifest during valid job",
  okEvents.some((event) => event.type === "sandbox.agent.artifact_recovery_manifest"),
  ok.stdout,
);
expect(
  "sandbox agent reports deterministic model skip by default",
  okEvents.some((event) => event.type === "sandbox.agent.model_skipped"),
  ok.stdout,
);
expect("sandbox agent final result completed", okResult?.status === "completed", JSON.stringify(okResult));
expect("sandbox agent result includes markdown", typeof okResult?.outputMarkdown === "string" && okResult.outputMarkdown.includes("# Smoke Branch"));
expect("sandbox agent result includes artifact metadata", Array.isArray(okResult?.artifacts) && okResult.artifacts.length === 1);
expect("sandbox agent result includes quality signals", Boolean(okResult?.qualitySignals?.contentSha256));
expect("sandbox agent result records model mode", okResult?.qualitySignals?.modelMode === "deterministic", JSON.stringify(okResult?.qualitySignals));
expect("sandbox agent result records heartbeat count", okResult?.qualitySignals?.heartbeatCount >= 3, JSON.stringify(okResult?.qualitySignals));
expect("sandbox agent result records artifact recovery readiness", okResult?.qualitySignals?.artifactRecoveryReady === true, JSON.stringify(okResult?.qualitySignals));
expect(
  "sandbox agent result records runtime quality signals",
  okResult?.qualitySignals?.runtimeVersion === "dataswarm.sandbox-runtime.v1" &&
    okResult?.qualitySignals?.actionCount >= 8 &&
    okResult?.qualitySignals?.observationCount >= 4,
  JSON.stringify(okResult?.qualitySignals),
);
expect(
  "sandbox agent result includes runtime action and observation logs",
  okResult?.runtime?.version === "dataswarm.sandbox-runtime.v1" &&
    Array.isArray(okResult?.runtime?.actions) &&
    okResult.runtime.actions.length >= 8 &&
    Array.isArray(okResult?.runtime?.observations) &&
    okResult.runtime.observations.length >= 4,
  JSON.stringify(okResult?.runtime),
);
expect(
  "sandbox agent markdown includes runtime loop section",
  typeof okResult?.outputMarkdown === "string" && okResult.outputMarkdown.includes("## Sandbox Runtime Loop"),
);

const bad = runAgent({ ...job, instruction: "" });
expect("sandbox agent exits non-zero for invalid job", bad.status !== 0, bad.stdout);
const badLines = parseJsonLines(bad.stdout);
const badEvents = badLines.filter((line) => line.type === "sandbox.agent.failed");
const badResult = badLines.at(-1);
expect("sandbox agent emits failure event", badEvents.length === 1, `${badEvents.length} failure event(s)`);
expect("sandbox agent final failure result is structured", badResult?.status === "failed" && typeof badResult.error === "string");

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

for (const result of results) {
  console.log(`PASS ${result.name}: ${result.detail}`);
}
console.log(`\nSandbox agent smoke passed: ${results.length}/${results.length} check(s) passed.`);

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
  const record = { name, passed, detail: String(detail) };
  results.push(record);
  if (!passed) {
    failures.push(record);
  }
}
