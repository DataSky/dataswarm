#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = resolve(repoRoot, "apps", "web");

const publicBaseUrl = process.env.DATASWARM_PUBLIC_BASE_URL || "http://127.0.0.1:3000";
const modelName = process.env.DATASWARM_SANDBOX_AGENT_MODEL_NAME || "deepseek-v4-flash";

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
      "DataSwarm real dev startup refused because mock/degraded env was detected.",
      ...mockViolations.map(([key, value]) => `- ${key}=${value}`),
      "Use `npm run dev:mock` for explicit mock mode, or unset these variables before real startup.",
    ].join("\n") + "\n",
  );
  process.exit(1);
}

function readFirstNonEmptyFile(rawPath) {
  if (!rawPath) return "";
  const filePath = rawPath.startsWith("/") ? rawPath : resolve(webDir, rawPath);
  if (!existsSync(filePath)) return "";
  return (
    readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ""
  );
}

function isLocalOnlyUrl(rawUrl) {
  if (!rawUrl) return true;
  try {
    const parsed = new URL(rawUrl);
    return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname);
  } catch {
    return true;
  }
}

const configuredProxyUrl =
  process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL ||
  readFirstNonEmptyFile(process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE || "../../data/e2b/parent-proxy-url.txt") ||
  process.env.DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL ||
  readFirstNonEmptyFile(process.env.DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL_FILE || "../../data/e2b/capability-invoke-url.txt") ||
  publicBaseUrl;

if (isLocalOnlyUrl(configuredProxyUrl) && process.env.DATASWARM_ALLOW_LOCAL_SANDBOX_PROXY !== "1") {
  process.stderr.write(
    [
      "DataSwarm local real startup refused because no public sandbox capability proxy URL was found.",
      `- DATASWARM_PUBLIC_BASE_URL=${publicBaseUrl}`,
      "- Provide DATASWARM_SANDBOX_TOOL_PROXY_URL or DATASWARM_PUBLIC_BASE_URL with a public HTTPS URL.",
      "- Recommended: use `npm run dev` or `npm run dev:real` to start the Cloudflare Tunnel profile.",
      "- For UI-only local debugging, set DATASWARM_ALLOW_LOCAL_SANDBOX_PROXY=1 explicitly; E2B parent-proxy validation will remain degraded.",
    ].join("\n") + "\n",
  );
  process.exit(1);
}

const childEnv = {
  ...process.env,
  DATASWARM_RUNTIME_PROFILE: "real-dev",
  DATASWARM_SANDBOX_PROVIDER: "e2b",
  DATASWARM_SANDBOX_AGENT_MODEL: "real",
  DATASWARM_SANDBOX_TOOL_PROXY: "parent",
  DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS: process.env.DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS || "1",
  DATASWARM_SANDBOX_AGENT_MODEL_NAME: modelName,
  DATASWARM_DATA_DIR: process.env.DATASWARM_DATA_DIR || "../../data",
  DATASWARM_WORKSPACE_ROOT: process.env.DATASWARM_WORKSPACE_ROOT || "../..",
  DATASWARM_PUBLIC_BASE_URL: publicBaseUrl,
  DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE:
    process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE || "../../data/e2b/parent-proxy-url.txt",
  DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL_FILE:
    process.env.DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL_FILE || "../../data/e2b/capability-invoke-url.txt",
};

delete childEnv.DATASWARM_MOCK_MODEL;
delete childEnv.DATASWARM_MOCK_TOOLS;

process.stdout.write(
  [
    "[dataswarm-dev-real] starting Next dev with real defaults",
    `- DATASWARM_SANDBOX_PROVIDER=${childEnv.DATASWARM_SANDBOX_PROVIDER}`,
    `- DATASWARM_SANDBOX_AGENT_MODEL=${childEnv.DATASWARM_SANDBOX_AGENT_MODEL}`,
    `- DATASWARM_SANDBOX_TOOL_PROXY=${childEnv.DATASWARM_SANDBOX_TOOL_PROXY}`,
    `- DATASWARM_PUBLIC_BASE_URL=${childEnv.DATASWARM_PUBLIC_BASE_URL}`,
    `- sandbox proxy URL source=${configuredProxyUrl}`,
    `- DATASWARM_SANDBOX_AGENT_MODEL_NAME=${childEnv.DATASWARM_SANDBOX_AGENT_MODEL_NAME}`,
  ].join("\n") + "\n",
);

const child = spawn("npx", ["next", "dev"], {
  cwd: webDir,
  env: childEnv,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
