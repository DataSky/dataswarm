import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const apiKey = process.env.E2B_API_KEY;
const template = process.env.DATASWARM_E2B_TEMPLATE || process.env.E2B_TEMPLATE_ID || process.env.E2B_TEMPLATE || "dataswarm-agent-runtime";
const timeoutMs = Number(
  process.env.DATASWARM_E2B_SMOKE_TIMEOUT_MS ??
    process.env.DATASWARM_E2B_TIMEOUT_MS ??
    process.env.DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS ??
    120_000,
);
const root = process.cwd();
const agentSource = readFileSync(path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py"), "utf8");
const args = parseArgs(process.argv.slice(2));
const receiptPath =
  args.receipt ??
  process.env.DATASWARM_E2B_LIVE_SMOKE_RECEIPT ??
  path.join(root, "data", "e2b", "live-smoke-receipt.json");
const job = {
  branchId: "branch_e2b_smoke",
  agentName: "E2B Smoke Branch",
  modelProfile: "deepseek:deepseek-v4-flash",
  objective: "Verify DataSwarm sandbox agent protocol inside a real E2B sandbox.",
  instruction: "Return deterministic markdown, events, quality signals, and artifact metadata.",
  contextBundleUri: "local://context-bundles/e2b-smoke.json",
  executionMode: "e2b-live-smoke",
  sandboxModel: {
    mode: process.env.DATASWARM_SANDBOX_AGENT_MODEL === "real" ? "real" : "deterministic",
    model: process.env.DATASWARM_SANDBOX_AGENT_MODEL_NAME || "deepseek-v4-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    authScheme: process.env.DATASWARM_SANDBOX_AGENT_AUTH_SCHEME || "bearer",
    maxTokens: 900,
    timeoutSeconds: 60,
  },
};

if (!apiKey) {
  console.log("SKIP E2B live smoke: set E2B_API_KEY to create a real sandbox.");
  process.exit(0);
}

const startedAt = Date.now();
const startedAtIso = new Date().toISOString();
const requireFromWeb = createRequire(path.join(root, "apps/web/package.json"));
const { Sandbox } = await import(requireFromWeb.resolve("@e2b/code-interpreter"));
let sandbox;

try {
  sandbox = template
    ? await Sandbox.create(template, { apiKey, timeoutMs })
    : await Sandbox.create({ apiKey, timeoutMs });

  const externalSandboxId = String(sandbox.sandboxId ?? sandbox.id ?? "unknown");
  const result = await sandbox.runCode(
    `
job_json = ${JSON.stringify(JSON.stringify(job))}
import json
import os
import sys
os.environ["DATASWARM_AGENT_JOB_JSON"] = job_json
try:
    sys.path.insert(0, "/home/user/dataswarm")
    import dataswarm_sandbox_agent as dataswarm_agent
except Exception:
    agent_source = ${JSON.stringify(agentSource)}
    namespace = {"__name__": "dataswarm_sandbox_agent"}
    exec(compile(agent_source, "dataswarm_sandbox_agent.py", "exec"), namespace)
    result = namespace["run"]()
    namespace["emit"]("sandbox.agent.completed", "Sandbox branch completed.", {"branchId": result["branchId"]})
else:
    result = dataswarm_agent.run()
    dataswarm_agent.emit("sandbox.agent.completed", "Sandbox branch completed.", {"branchId": result["branchId"]})
print(json.dumps(result, ensure_ascii=False))
result
`,
    { language: "python", timeoutMs, envs: sandboxModelEnv() },
  );

  const outputLines = collectOutputLines(result);
  const outputPreview = outputLines.slice(0, 12).join("\n").slice(0, 1000);
  if (!outputLines.some((line) => line.includes("dataswarm.sandbox-agent.v1")) || !outputLines.some((line) => line.includes("branch_e2b_smoke"))) {
    throw new Error(`Unexpected E2B output: ${outputPreview}`);
  }
  const lines = outputLines
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const events = lines.filter((line) => typeof line.type === "string" && line.type.startsWith("sandbox.agent."));
  const final = [...lines].reverse().find((line) => typeof line.outputMarkdown === "string");
  if (events.filter((event) => event.type === "sandbox.agent.heartbeat").length < 3) {
    throw new Error(`E2B sandbox did not emit required heartbeat events. ${eventDebug(events, outputPreview)}`);
  }
  if (!events.some((event) => event.type === "sandbox.agent.action_proposed") || !events.some((event) => event.type === "sandbox.agent.action_completed")) {
    throw new Error(`E2B sandbox did not emit required action lifecycle events. ${eventDebug(events, outputPreview)}`);
  }
  if (events.filter((event) => event.type === "sandbox.agent.observation_created").length < 4) {
    throw new Error(`E2B sandbox did not emit required observation events. ${eventDebug(events, outputPreview)}`);
  }
  if (!events.some((event) => event.type === "sandbox.agent.artifact_recovery_manifest")) {
    throw new Error(`E2B sandbox did not emit artifact recovery manifest. ${eventDebug(events, outputPreview)}`);
  }
  if (final?.qualitySignals?.artifactRecoveryReady !== true) {
    throw new Error("E2B sandbox final result did not mark artifact recovery ready.");
  }
  if (final?.qualitySignals?.runtimeVersion !== "dataswarm.sandbox-runtime.v1" || final?.qualitySignals?.actionCount < 8 || final?.qualitySignals?.observationCount < 4) {
    throw new Error("E2B sandbox final result did not include expected runtime quality signals.");
  }

  const receipt = writeLiveSmokeReceipt({
    externalSandboxId,
    events,
    final,
    startedAtIso,
    elapsedMs: Date.now() - startedAt,
  });
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (sandbox) {
    await Promise.race([sandbox.kill(), delay(10_000)]);
  }
}

function sandboxModelEnv() {
  if (process.env.DATASWARM_SANDBOX_AGENT_MODEL !== "real") {
    return {};
  }
  if (process.env.DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS !== "1") {
    return {};
  }
  return {
    ...(process.env.DEEPSEEK_BASE_URL ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } : {}),
    ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
  };
}

function collectOutputLines(execution) {
  const stdout = Array.isArray(execution?.logs?.stdout) ? execution.logs.stdout : [];
  const stderr = Array.isArray(execution?.logs?.stderr) ? execution.logs.stderr : [];
  const rawChunks = [...stdout, ...stderr, execution?.text]
    .filter((item) => item !== undefined && item !== null)
    .map((item) => String(item));
  return rawChunks
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

function eventDebug(events, outputPreview) {
  const count = (type) => events.filter((event) => event.type === type).length;
  return JSON.stringify({
    totalEvents: events.length,
    heartbeatCount: count("sandbox.agent.heartbeat"),
    actionProposedCount: count("sandbox.agent.action_proposed"),
    actionCompletedCount: count("sandbox.agent.action_completed"),
    observationCreatedCount: count("sandbox.agent.observation_created"),
    outputPreview,
  });
}

function writeLiveSmokeReceipt(input) {
  const completedAt = new Date().toISOString();
  const receipt = {
    receiptSchema: "dataswarm.e2b-live-smoke-receipt.v1",
    status: "passed",
    provider: "e2b",
    template: template ?? "default",
    externalSandboxId: input.externalSandboxId,
    startedAt: input.startedAtIso,
    completedAt,
    elapsedMs: input.elapsedMs,
    protocol: {
      agent: "dataswarm.sandbox-agent.v1",
      runtime: "dataswarm.sandbox-runtime.v1",
    },
    sandboxModel: {
      mode: job.sandboxModel.mode,
      model: job.sandboxModel.model,
      modelSecretsForwarded: process.env.DATASWARM_SANDBOX_AGENT_MODEL === "real" && process.env.DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS === "1",
    },
    verification: {
      heartbeatCount: input.events.filter((event) => event.type === "sandbox.agent.heartbeat").length,
      actionProposedCount: input.events.filter((event) => event.type === "sandbox.agent.action_proposed").length,
      actionCompletedCount: input.events.filter((event) => event.type === "sandbox.agent.action_completed").length,
      observationCreatedCount: input.events.filter((event) => event.type === "sandbox.agent.observation_created").length,
      artifactRecoveryManifest: input.events.some((event) => event.type === "sandbox.agent.artifact_recovery_manifest"),
      qualitySignals: input.final?.qualitySignals ?? {},
    },
    evidence: {
      sourceHashes: {
        "sandbox/agent/dataswarm_sandbox_agent.py": sha256File(path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py")),
        "sandbox/e2b/e2b.Dockerfile": sha256File(path.join(root, "sandbox/e2b/e2b.Dockerfile")),
        "sandbox/e2b/entrypoint.py": sha256File(path.join(root, "sandbox/e2b/entrypoint.py")),
      },
      receiptPath: path.relative(root, receiptPath),
      generatedBy: "scripts/e2b-sandbox-smoke.mjs",
    },
  };
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--receipt") {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error("--receipt requires a path");
      }
      parsed.receipt = path.resolve(root, value);
      index += 1;
    }
  }
  return parsed;
}
