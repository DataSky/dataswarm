import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
loadEnvFile(path.join(root, ".env.local"));
loadEnvFile(path.join(root, "apps", "web", ".env.local"));

const apiKey = process.env.E2B_API_KEY;
const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL;
const template = process.env.DATASWARM_E2B_TEMPLATE || process.env.E2B_TEMPLATE_ID || process.env.E2B_TEMPLATE || "dataswarm-agent-runtime";
const timeoutMs = Number(
  process.env.DATASWARM_E2B_V3_REAL_ACTION_TIMEOUT_MS ??
    process.env.DATASWARM_E2B_SMOKE_TIMEOUT_MS ??
    process.env.DATASWARM_E2B_TIMEOUT_MS ??
    process.env.DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS ??
    180_000,
);
const receiptPath = path.resolve(
  root,
  process.env.DATASWARM_E2B_V3_REAL_ACTION_RECEIPT ?? path.join("data", "e2b", "live-smoke-receipt-v3-real-action.json"),
);
const publicBaseUrl = process.env.DATASWARM_PUBLIC_BASE_URL || "";
const publicBaseUrlFile = process.env.DATASWARM_PUBLIC_BASE_URL_FILE || "";
const proxyUrl = resolveProxyUrl(
  process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL || process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE || publicBaseUrl || publicBaseUrlFile,
);
const parentProxyMode = proxyUrl && !proxyUrl.includes("host.docker.internal") ? "parent" : "mock";
const agentPath = path.join(root, "sandbox", "agent", "dataswarm_sandbox_agent.py");
const agentSource = readFileSync(agentPath, "utf8");

if (!apiKey) {
  console.log("SKIP E2B V3 real-action smoke: set E2B_API_KEY to create a real sandbox.");
  process.exit(0);
}

if (!deepseekApiKey || !deepseekBaseUrl) {
  console.log("SKIP E2B V3 real-action smoke: set DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL to verify real sandbox action model calls.");
  process.exit(0);
}

const job = {
  protocolVersion: "dataswarm.sandbox-agent.v3",
  agentProtocol: "dataswarm.sandbox-agent.v3",
  runId: "run_e2b_v3_real_action_smoke",
  conversationId: "conv_e2b_v3_real_action_smoke",
  taskId: "task_e2b_v3_real_action_smoke",
  branchId: "branch_e2b_v3_real_action_smoke",
  sandboxSessionId: "sbx_e2b_v3_real_action_smoke",
  agentSessionId: "agent_e2b_v3_real_action_smoke",
  agentName: "E2B V3 Real Action Smoke Branch",
  modelProfile: "deepseek:deepseek-v4-flash",
  objective:
    "Verify DataSwarm sandbox-agent V3 in a real E2B sandbox using a real DeepSeek/OpenAI-compatible model to choose each ReAct action, collect parent-proxy web evidence, and draw f=sin(x) as an image.",
  instruction:
    "Select exactly one action per step. To satisfy this verification, activate the web-research skill policy, read the scoped context, request web.search through the parent proxy, run Python to create an f=sin(x) image, prepare artifacts, then final_answer from observations. Do not invent facts outside observations.",
  contextBundleUri: "local://context-bundles/e2b-v3-real-action-smoke.json",
  contextBundleContent: JSON.stringify({
    purpose: "e2b-v3-real-action-smoke",
    qualityGate:
      "The branch must prove real_model action selection, parent-proxy tool observation, local image artifact generation, and V3 quality signals.",
  }),
  executionMode: "e2b-live-v3-real-action-smoke",
  maxSteps: 6,
  maxToolCalls: 4,
  maxRuntimeMs: 160_000,
  maxOutputTokens: 4096,
  toolCatalog: [
    { name: "web.search", capability: "web_search", adapterMode: "parent", risk: "low" },
    { name: "artifact.create", capability: "artifact_create", adapterMode: "parent", risk: "low" },
    { name: "trace.query", capability: "trace_query", adapterMode: "parent", risk: "low" },
    { name: "run_python", capability: "visualization", adapterMode: "local", risk: "medium" },
  ],
  skillManifests: [
    {
      name: "web-research",
      version: "0.1.0",
      purpose: "Research external information using parent-proxied tool observations.",
      activationGuidance: "Use when external facts or web evidence are required.",
      requiredTools: ["web.search"],
      qualityChecks: ["Use observations as evidence.", "State limitations.", "Do not fabricate sources."],
      outputExpectations: ["Final answer cites observation-backed evidence and artifact manifest status."],
    },
  ],
  parentToolProxy: {
    mode: parentProxyMode,
    url: proxyUrl ? `${proxyUrl.replace(/\/$/, "")}/api/internal/sandbox/tool-proxy` : "",
    proxySessionToken: "mock-e2b-v3-real-action-token",
    allowedTools: ["web.search", "artifact.create", "trace.query"],
    authMode: "signed_token",
  },
  capabilityPlane: {
    invokeUrl: proxyUrl ? `${proxyUrl.replace(/\/$/, "")}/api/internal/capabilities/invoke` : "",
    enabledCapabilities: ["web_search", "artifact_create", "file_read", "trace_query", "visualization"],
    manifestPath: "sandbox://capability-plane/smoke.json",
    version: "v1",
    invocationMode: parentProxyMode,
  },
  artifactPolicy: {
    allowedKinds: ["markdown", "html", "json", "csv", "image"],
    maxBytes: 2_000_000,
    allowBase64: true,
  },
  sandboxModel: {
    mode: "real",
    model: process.env.DATASWARM_SANDBOX_AGENT_MODEL_NAME || "deepseek-v4-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    authScheme: process.env.DATASWARM_SANDBOX_AGENT_AUTH_SCHEME || (deepseekBaseUrl.includes("api.deepseek.com") ? "bearer" : "raw"),
    jsonMode: true,
    actionMaxTokens: Number(process.env.DATASWARM_SANDBOX_AGENT_ACTION_MAX_TOKENS ?? 1600),
    maxTokens: Number(process.env.DATASWARM_SANDBOX_AGENT_MAX_TOKENS ?? 1600),
    timeoutSeconds: Number(process.env.DATASWARM_SANDBOX_AGENT_TIMEOUT_SECONDS ?? 60),
  },
};

const startedAt = Date.now();
const startedAtIso = new Date().toISOString();
const requireFromWeb = createRequire(path.join(root, "apps/web/package.json"));
const { Sandbox } = await import(requireFromWeb.resolve("@e2b/code-interpreter"));
let sandbox;

try {
  sandbox = template ? await Sandbox.create(template, { apiKey, timeoutMs }) : await Sandbox.create({ apiKey, timeoutMs });
  const externalSandboxId = String(sandbox.sandboxId ?? sandbox.id ?? "unknown");
  const execution = await sandbox.runCode(
    `
job_json = ${JSON.stringify(JSON.stringify(job))}
agent_source = ${JSON.stringify(agentSource)}
import json
import os
namespace = {"__name__": "dataswarm_sandbox_agent"}
os.environ["DATASWARM_AGENT_JOB_JSON"] = job_json
exec(compile(agent_source, "dataswarm_sandbox_agent.py", "exec"), namespace)
result = namespace["run"]()
namespace["emit"]("sandbox.agent.completed", "Sandbox branch completed.", {"branchId": result["branchId"], "protocolVersion": result.get("protocolVersion")})
print(json.dumps(result, ensure_ascii=False))
result
`,
    { language: "python", timeoutMs, envs: sandboxModelEnv() },
  );

  const outputLines = collectOutputLines(execution);
  const parsed = parseJsonLines(outputLines);
  const events = parsed.filter((line) => typeof line.type === "string" && line.type.startsWith("sandbox.agent."));
  const final = [...parsed].reverse().find((line) => typeof line.outputMarkdown === "string");

  assert(final, "E2B V3 sandbox did not produce a final JSON result.", { outputPreview: outputLines.slice(0, 20).join("\n").slice(0, 1500) });
  assert(final.protocolVersion === "dataswarm.sandbox-agent.v3", "E2B V3 sandbox final protocol mismatch.", compactFinal(final));
  assert(final.qualitySignals?.runtimeVersion === "dataswarm.sandbox-runtime.v3", "E2B V3 sandbox runtime mismatch.", compactFinal(final));
  assert(final.qualitySignals?.modelUsed === true, "E2B V3 sandbox did not mark real model usage.", compactFinal(final));
  assert(Number(final.qualitySignals?.realModelActionCount ?? 0) >= 3, "E2B V3 sandbox did not record enough real_model actions.", compactFinal(final));
  assert(Number(final.qualitySignals?.fallbackActionCount ?? 0) === 0, "E2B V3 sandbox fell back to deterministic action selection.", compactFinal(final));
  assert(events.filter((event) => event.type === "sandbox.agent.model_call_started" && event.payload?.purpose === "next_action").length >= 3, "E2B V3 sandbox did not start enough next_action model calls.", eventSummary(events));
  assert(events.filter((event) => event.type === "sandbox.agent.model_call_completed" && event.payload?.purpose === "next_action").length >= 3, "E2B V3 sandbox did not complete enough next_action model calls.", eventSummary(events));
  assert(events.some((event) => event.type === "sandbox.agent.action.proposed" && event.payload?.actionSource === "real_model"), "E2B V3 sandbox did not emit real_model action lifecycle events.", eventSummary(events));
  assert(events.some((event) => event.type === "sandbox.agent.tool.completed"), "E2B V3 sandbox did not complete a parent-proxy tool call.", eventSummary(events));
  assert(events.some((event) => event.type === "sandbox.agent.artifact.created"), "E2B V3 sandbox did not create a local artifact.", eventSummary(events));
  assert(final.artifacts?.some((artifact) => artifact.kind === "image" && artifact.contentBase64), "E2B V3 sandbox did not return a recoverable image artifact manifest.", compactFinal(final));

  const receipt = writeReceipt({
    externalSandboxId,
    final,
    events,
    startedAtIso,
    elapsedMs: Date.now() - startedAt,
  });
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (sandbox) {
    await Promise.race([sandbox.kill(), delay(10_000)]).catch(() => undefined);
  }
}

function sandboxModelEnv() {
  return {
    DATASWARM_SANDBOX_AGENT_PROTOCOL: "dataswarm.sandbox-agent.v3",
    DEEPSEEK_BASE_URL: deepseekBaseUrl,
    DEEPSEEK_API_KEY: deepseekApiKey,
  };
}

function writeReceipt(input) {
  const receipt = {
    receiptSchema: "dataswarm.e2b-live-v3-real-action-receipt.v1",
    status: "passed",
    provider: "e2b",
    template: template ?? "default",
    externalSandboxId: input.externalSandboxId,
    startedAt: input.startedAtIso,
    completedAt: new Date().toISOString(),
    elapsedMs: input.elapsedMs,
    protocol: {
      agent: "dataswarm.sandbox-agent.v3",
      runtime: "dataswarm.sandbox-runtime.v3",
    },
    sandboxModel: {
      mode: "real",
      model: job.sandboxModel.model,
      modelSecretsForwarded: true,
      jsonMode: true,
    },
    verification: {
      modelCallStartedCount: input.events.filter((event) => event.type === "sandbox.agent.model_call_started" && event.payload?.purpose === "next_action").length,
      modelCallCompletedCount: input.events.filter((event) => event.type === "sandbox.agent.model_call_completed" && event.payload?.purpose === "next_action").length,
      realModelActionCount: input.final.qualitySignals?.realModelActionCount ?? 0,
      fallbackActionCount: input.final.qualitySignals?.fallbackActionCount ?? 0,
      toolCompletedCount: input.events.filter((event) => event.type === "sandbox.agent.tool.completed").length,
      observationCreatedCount: input.events.filter((event) => event.type === "sandbox.agent.observation.created").length,
      artifactCreatedCount: input.events.filter((event) => event.type === "sandbox.agent.artifact.created").length,
      imageArtifactCount: input.final.qualitySignals?.imageArtifactCount ?? 0,
      qualitySignals: input.final.qualitySignals ?? {},
    },
    evidence: {
      sourceHashes: {
        "sandbox/agent/dataswarm_sandbox_agent.py": sha256File(agentPath),
        "sandbox/e2b/e2b.Dockerfile": sha256File(path.join(root, "sandbox/e2b/e2b.Dockerfile")),
        "sandbox/e2b/entrypoint.py": sha256File(path.join(root, "sandbox/e2b/entrypoint.py")),
      },
      receiptPath: path.relative(root, receiptPath),
      generatedBy: "scripts/e2b-sandbox-v3-real-action-smoke.mjs",
    },
  };
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
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

function parseJsonLines(lines) {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function assert(condition, message, detail) {
  if (condition) {
    return;
  }
  const error = new Error(`${message} ${redactSecrets(JSON.stringify(detail ?? {})).slice(0, 3000)}`);
  error.detail = detail;
  throw error;
}

function compactFinal(final) {
  return {
    protocolVersion: final?.protocolVersion,
    status: final?.status,
    branchId: final?.branchId,
    qualitySignals: final?.qualitySignals,
    artifactKinds: Array.isArray(final?.artifacts) ? final.artifacts.map((artifact) => artifact.kind) : [],
  };
}

function eventSummary(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return { count: events.length, counts };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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

function redactSecrets(value) {
  return String(value)
    .replace(/(^|[^A-Za-z0-9_-])e2b_[A-Za-z0-9_-]{20,}/g, "$1[REDACTED_E2B_KEY]")
    .replace(/tvly-[A-Za-z0-9_-]{12,}/g, "[REDACTED_TAVILY_KEY]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]");
}

function resolveProxyUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (existsSync(trimmed)) {
    const fileValue = readFileSync(trimmed, "utf8").trim();
    return fileValue.replace(/\\n/g, "").trim();
  }
  return trimmed;
}
