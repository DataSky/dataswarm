#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = resolve(repoRoot, "apps", "web");

const tunnelName = process.env.DATASWARM_CLOUDFLARE_TUNNEL_NAME || "dataswarm-dev";
const publicBaseUrl =
  process.env.DATASWARM_PUBLIC_BASE_URL || "https://dataswarm-dev.metad.ai";
const modelName = process.env.DATASWARM_SANDBOX_AGENT_MODEL_NAME || "deepseek-v4-flash";
const tunnelReadinessTimeoutMs = Number(process.env.DATASWARM_CLOUDFLARE_TUNNEL_READINESS_TIMEOUT_MS ?? 45_000);

const forbiddenMockEnv = [
  ["DATASWARM_ALLOW_EXPLICIT_MOCK", "1"],
  ["DATASWARM_MOCK_MODEL", "1"],
  ["DATASWARM_MOCK_TOOLS", "1"],
  ["DATASWARM_SANDBOX_PROVIDER", "mock"],
  ["DATASWARM_SANDBOX_AGENT_MODEL", "mock"],
  ["DATASWARM_SANDBOX_AGENT_MODEL", "deterministic"],
  ["DATASWARM_SANDBOX_TOOL_PROXY", "mock"],
  ["DATASWARM_SANDBOX_TOOL_PROXY", "disabled"],
];

const mockViolations = forbiddenMockEnv.filter(([key, forbidden]) => {
  const value = process.env[key];
  return typeof value === "string" && value.trim().toLowerCase() === forbidden;
});

if (mockViolations.length > 0) {
  process.stderr.write(
    [
      "DataSwarm real tunnel startup refused because mock/degraded env was detected.",
      ...mockViolations.map(([key, value]) => "- " + key + "=" + value),
      "Use `npm run dev:mock` for explicit mock mode, or unset these variables before real tunnel startup.",
    ].join("\n") + "\n",
  );
  process.exit(1);
}

const childEnv = {
  ...process.env,
  DATASWARM_RUNTIME_PROFILE: "real-dev-tunnel",
  DATASWARM_SANDBOX_PROVIDER: "e2b",
  DATASWARM_SANDBOX_AGENT_MODEL: "real",
  DATASWARM_SANDBOX_TOOL_PROXY: "parent",
  DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS:
    process.env.DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS || "1",
  DATASWARM_SANDBOX_AGENT_MODEL_NAME: modelName,
  DATASWARM_DATA_DIR: process.env.DATASWARM_DATA_DIR || "../../data",
  DATASWARM_WORKSPACE_ROOT: process.env.DATASWARM_WORKSPACE_ROOT || "../..",
  DATASWARM_PUBLIC_BASE_URL: publicBaseUrl,
  DATASWARM_SANDBOX_TOOL_PROXY_URL:
    process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL ||
    `${publicBaseUrl}/api/internal/sandbox/tool-proxy`,
  DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL:
    process.env.DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL ||
    `${publicBaseUrl}/api/internal/capabilities/invoke`,
};

delete childEnv.DATASWARM_MOCK_MODEL;
delete childEnv.DATASWARM_MOCK_TOOLS;

let cloudflared;
let nextDev;
let shuttingDown = false;
let nextStarted = false;
let startupTimer;

function log(message) {
  process.stdout.write(`[dataswarm-dev] ${message}\n`);
}

function pipeOutput(child, prefix) {
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (
      prefix === "cloudflared" &&
      !nextStarted &&
      /Registered tunnel connection|Environment is healthy|Starting metrics server/.test(text)
    ) {
      startNextDev();
    }
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    if (
      prefix === "cloudflared" &&
      !nextStarted &&
      /Registered tunnel connection|Environment is healthy|Starting metrics server/.test(text)
    ) {
      startNextDev();
    }
  });
}

function startCloudflared() {
  log(`starting Cloudflare Tunnel '${tunnelName}' for ${publicBaseUrl}`);
  cloudflared = spawn("cloudflared", ["tunnel", "run", tunnelName], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeOutput(cloudflared, "cloudflared");
  cloudflared.on("exit", (code, signal) => {
    if (!shuttingDown) {
      log(`cloudflared exited with code=${code ?? "null"} signal=${signal ?? "null"}`);
      shutdown(code || 1);
    }
  });
  startupTimer = setTimeout(() => {
    if (!nextStarted && cloudflared && !cloudflared.killed) {
      log("cloudflared readiness signal was not observed within 12s; starting Next dev anyway");
      startNextDev();
    }
  }, 12_000);
}

function startNextDev() {
  if (nextStarted) return;
  nextStarted = true;
  clearTimeout(startupTimer);
  log("starting DataSwarm Next dev with real E2B + parent capability proxy");
  log(`public base URL: ${childEnv.DATASWARM_PUBLIC_BASE_URL}`);
  log(`tool proxy URL: ${childEnv.DATASWARM_SANDBOX_TOOL_PROXY_URL}`);
  log(`capability invoke URL: ${childEnv.DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL}`);
  nextDev = spawn("npx", ["next", "dev"], {
    cwd: webDir,
    env: childEnv,
    stdio: "inherit",
  });
  waitForTunnelReadiness(childEnv.DATASWARM_PUBLIC_BASE_URL).catch((error) => {
    log(`public tunnel readiness check failed: ${error.message}`);
    shutdown(1);
  });
  nextDev.on("exit", (code, signal) => {
    if (!shuttingDown) {
      log(`next dev exited with code=${code ?? "null"} signal=${signal ?? "null"}`);
      shutdown(code || 1);
    }
  });
}

function terminate(child, signal = "SIGTERM") {
  if (!child || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // Best-effort shutdown.
  }
}

async function waitForTunnelReadiness(baseUrl) {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const deadline = Date.now() + tunnelReadinessTimeoutMs;
  let lastState = "initializing";
  while (Date.now() < deadline) {
    const healthCheck = await probePublicEndpoint(`${normalizedBase}/api/internal/sandbox/health`);
    const snapshotCheck = await probePublicEndpoint(`${normalizedBase}/api/system/snapshot`);
    lastState = `${healthCheck.status ?? healthCheck.error}|${snapshotCheck.status ?? snapshotCheck.error}`;
    if (healthCheck.ok && snapshotCheck.ok && healthCheck.payload?.status === "ready") {
      log(`public tunnel readiness verified (${healthCheck.payload?.status}, snapshot=${snapshotCheck.statusCode})`);
      return;
    }
    await delay(1000);
  }
  throw new Error(`public URL ${baseUrl} not ready in ${tunnelReadinessTimeoutMs}ms; last state=${lastState}`);
}

async function probePublicEndpoint(url) {
  try {
    const response = await Promise.race([
      fetch(url),
      delay(4_000).then(() => {
        throw new Error("timeout");
      }),
    ]);
    const statusCode = response.status;
    const bodyText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      // Keep raw body for debug when endpoint is not JSON.
    }
    return {
      ok: response.ok,
      statusCode,
      status: payload?.status ?? String(statusCode),
      payload,
      raw: bodyText.slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      status: "error",
      error: String(error?.message ?? error),
    };
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(startupTimer);
  log("shutting down DataSwarm dev service and Cloudflare Tunnel");
  terminate(nextDev, "SIGINT");
  terminate(cloudflared, "SIGINT");
  setTimeout(() => process.exit(exitCode), 1_500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
process.on("uncaughtException", (error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  shutdown(1);
});

startCloudflared();
