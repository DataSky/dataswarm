import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildCapabilityManifest, invokeSandboxCapability } from "./capabilities";

export type SandboxToolProxyClaims = {
  runId: string;
  conversationId: string;
  taskId: string;
  branchId: string;
  sandboxSessionId: string;
  agentSessionId: string;
  traceId: string;
  traceSpanId: string;
  allowedTools: string[];
  exp: number;
  nonce: string;
};

export type SandboxToolProxyConfig = {
  mode: "parent" | "mock" | "disabled";
  url: string;
  capabilityInvokeUrl?: string;
  proxySessionToken: string;
  allowedTools: string[];
  authMode: "signed_token";
};

const DEFAULT_SANDBOX_ALLOWED_TOOLS = ["web.search", "file.read", "artifact.create", "trace.query", "run_python"];
const REQUIRED_V4_CAPABILITIES = ["web.search", "file.read", "artifact.create", "trace.query", "run_python"];
const TOKEN_TTL_MS = 30 * 60 * 1000;

export function sandboxAgentProtocol() {
  const raw = process.env.DATASWARM_SANDBOX_AGENT_PROTOCOL;
  if (raw === "v1" || raw === "dataswarm.sandbox-agent.v1") {
    return "dataswarm.sandbox-agent.v1";
  }
  if (raw === "v2" || raw === "dataswarm.sandbox-agent.v2") {
    return "dataswarm.sandbox-agent.v2";
  }
  return "dataswarm.sandbox-agent.v3";
}

export function sandboxAgentBudgets() {
  return {
    maxSteps: boundedInteger(process.env.DATASWARM_SANDBOX_AGENT_MAX_STEPS, 1, 24, 6),
    maxToolCalls: boundedInteger(process.env.DATASWARM_SANDBOX_AGENT_MAX_TOOL_CALLS, 0, 24, 4),
    maxRuntimeMs: boundedInteger(process.env.DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS, 5_000, 600_000, 120_000),
    maxOutputTokens: boundedInteger(process.env.DATASWARM_SANDBOX_AGENT_MAX_TOKENS, 512, 32_768, 4096),
  };
}

export function sandboxAllowedTools() {
  const configured = csv(process.env.DATASWARM_SANDBOX_ALLOWED_TOOLS);
  return configured.length > 0 ? configured : DEFAULT_SANDBOX_ALLOWED_TOOLS;
}

export function buildSandboxToolCatalog() {
  return buildCapabilityManifest(sandboxAllowedTools()).map((capability) => ({
    ...capability,
    authMode: "parent_proxy",
    adapterMode: "parent",
  }));
}

export function buildSandboxToolProxyConfig(claims: Omit<SandboxToolProxyClaims, "exp" | "nonce">): SandboxToolProxyConfig {
  const mode = sandboxToolProxyMode();
  const url = sandboxToolProxyUrl();
  const tokenClaims: SandboxToolProxyClaims = {
    ...claims,
    exp: Date.now() + TOKEN_TTL_MS,
    nonce: randomBytes(12).toString("hex"),
  };
  return {
    mode,
    url,
    capabilityInvokeUrl: sandboxCapabilityInvokeUrl(),
    proxySessionToken: signSandboxToolProxyToken(tokenClaims),
    allowedTools: claims.allowedTools,
    authMode: "signed_token",
  };
}

export function getSandboxToolProxyReadiness() {
  const mode = sandboxToolProxyMode();
  const proxyUrl = sandboxToolProxyUrl();
  const capabilityInvokeUrl = sandboxCapabilityInvokeUrl();
  const allowedTools = sandboxAllowedTools();
  const manifest = buildCapabilityManifest(allowedTools);
  const manifestNames = manifest.map((capability) => capability.name);
  const missingRequiredCapabilities = REQUIRED_V4_CAPABILITIES.filter((name) => !manifestNames.includes(name));
  const urlConfigured = Boolean(proxyUrl || capabilityInvokeUrl);
  const localOnly = isLocalOnlyProxyUrl(proxyUrl) || isLocalOnlyProxyUrl(capabilityInvokeUrl);
  const capabilitySurfaceReady = missingRequiredCapabilities.length === 0;
  const readyForExternalSandbox = mode !== "parent" || (urlConfigured && !localOnly && capabilitySurfaceReady);
  const missingEnv = [
    ...(mode === "parent" && (!urlConfigured || localOnly)
      ? [
          "DATASWARM_SANDBOX_TOOL_PROXY_URL or DATASWARM_PUBLIC_BASE_URL must be a public URL reachable from E2B; URL file variants are also supported",
        ]
      : []),
    ...(capabilitySurfaceReady
      ? []
      : [`DATASWARM_SANDBOX_ALLOWED_TOOLS must include required V4 capabilities: ${missingRequiredCapabilities.join(", ")}`]),
  ];
  return {
    mode,
    proxyUrlConfigured: Boolean(proxyUrl),
    capabilityInvokeUrlConfigured: Boolean(capabilityInvokeUrl),
    localOnly,
    capabilitySurfaceReady,
    allowedTools,
    manifestNames,
    missingRequiredCapabilities,
    readyForExternalSandbox,
    missingEnv,
    urls: {
      proxy: redactUrl(proxyUrl),
      capabilityInvoke: redactUrl(capabilityInvokeUrl),
    },
  };
}

export function getSandboxCapabilityPlaneHealth() {
  const readiness = getSandboxToolProxyReadiness();
  const runtimeProfile = process.env.DATASWARM_RUNTIME_PROFILE || "unspecified";
  const realProfile = runtimeProfile.startsWith("real");
  const mockSignals = {
    allowExplicitMock: process.env.DATASWARM_ALLOW_EXPLICIT_MOCK === "1",
    mockModel: process.env.DATASWARM_MOCK_MODEL === "1",
    mockTools: process.env.DATASWARM_MOCK_TOOLS === "1",
    sandboxProviderMock: String(process.env.DATASWARM_SANDBOX_PROVIDER ?? "").toLowerCase() === "mock",
    sandboxAgentModelMock: ["mock", "deterministic", "mock_actions"].includes(
      String(process.env.DATASWARM_SANDBOX_AGENT_MODEL ?? "").toLowerCase(),
    ),
    sandboxToolProxyMock: ["mock", "disabled"].includes(String(process.env.DATASWARM_SANDBOX_TOOL_PROXY ?? "").toLowerCase()),
  };
  const mockContamination = Object.values(mockSignals).some(Boolean);
  const manifest = buildCapabilityManifest(readiness.allowedTools);
  const hardFailures = [
    ...(realProfile && mockContamination ? ["real_runtime_mock_contamination"] : []),
    ...(realProfile && readiness.mode !== "parent" ? ["real_runtime_parent_proxy_not_selected"] : []),
    ...(realProfile && !readiness.readyForExternalSandbox ? ["real_runtime_proxy_not_ready_for_external_sandbox"] : []),
    ...readiness.missingRequiredCapabilities.map((name) => `missing_required_capability:${name}`),
  ];

  return {
    status: hardFailures.length === 0 ? "ready" : "failed",
    runtimeProfile,
    realProfile,
    mockSignals,
    mockContamination,
    readiness,
    capabilityPlane: {
      version: "dataswarm.capability-plane.v4",
      requiredCapabilities: REQUIRED_V4_CAPABILITIES,
      manifest,
    },
    endpoints: {
      toolProxy: readiness.urls.proxy,
      capabilityInvoke: readiness.urls.capabilityInvoke,
      health: "/api/internal/sandbox/health",
    },
    hardFailures,
  };
}

export function verifySandboxToolProxyToken(token: string): SandboxToolProxyClaims {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) {
    throw new Error("Malformed sandbox tool proxy token");
  }
  const expected = hmac(payloadB64);
  if (!safeEqual(signature, expected)) {
    throw new Error("Invalid sandbox tool proxy token signature");
  }
  const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SandboxToolProxyClaims;
  if (!claims.exp || claims.exp < Date.now()) {
    throw new Error("Expired sandbox tool proxy token");
  }
  if (!Array.isArray(claims.allowedTools) || claims.allowedTools.length === 0) {
    throw new Error("Sandbox tool proxy token has no allowed tools");
  }
  return claims;
}

export async function executeSandboxToolProxyCall(input: {
  proxySessionToken: string;
  runId: string;
  branchId: string;
  sandboxSessionId: string;
  actionId: string;
  toolName: string;
  input: Record<string, unknown>;
}) {
  const claims = verifySandboxToolProxyToken(input.proxySessionToken);
  assertProxyClaimMatch(claims.runId, input.runId, "runId");
  assertProxyClaimMatch(claims.branchId, input.branchId, "branchId");
  assertProxyClaimMatch(claims.sandboxSessionId, input.sandboxSessionId, "sandboxSessionId");
  return invokeSandboxCapability({
    claims,
    actionId: input.actionId,
    capabilityName: input.toolName,
    capabilityInput: input.input,
    legacyEventPrefix: "sandbox.tool_proxy.call",
  });
}

function signSandboxToolProxyToken(claims: SandboxToolProxyClaims) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${hmac(payload)}`;
}

function realRuntimeProfileEnabled() {
  return String(process.env.DATASWARM_RUNTIME_PROFILE ?? "").startsWith("real");
}

function sandboxToolProxyMode(): "parent" | "mock" | "disabled" {
  const raw = (process.env.DATASWARM_SANDBOX_TOOL_PROXY ?? "parent").trim().toLowerCase();
  if (raw === "mock" || raw === "disabled") {
    if (realRuntimeProfileEnabled()) {
      throw new Error(`DATASWARM_RUNTIME_PROFILE=real* refuses DATASWARM_SANDBOX_TOOL_PROXY=${raw}. Use npm run dev:mock for mock mode.`);
    }
    return raw;
  }
  return "parent";
}

export function sandboxToolProxyUrl() {
  const explicit = process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL;
  if (explicit) {
    return explicit;
  }
  const explicitFromFile = readFirstNonEmptyFile(process.env.DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE);
  if (explicitFromFile) {
    return explicitFromFile;
  }
  const base = process.env.DATASWARM_PUBLIC_BASE_URL;
  const baseFromFile = readFirstNonEmptyFile(process.env.DATASWARM_PUBLIC_BASE_URL_FILE);
  const resolvedBase = base || baseFromFile;
  if (!resolvedBase) {
    return "";
  }
  return new URL("/api/internal/sandbox/tool-proxy", resolvedBase).toString();
}

export function sandboxCapabilityInvokeUrl() {
  const explicit = process.env.DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL;
  if (explicit) {
    return explicit;
  }
  const explicitFromFile = readFirstNonEmptyFile(process.env.DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL_FILE);
  if (explicitFromFile) {
    return explicitFromFile;
  }
  const proxyUrl = sandboxToolProxyUrl();
  if (proxyUrl) {
    try {
      return new URL("/api/internal/capabilities/invoke", proxyUrl).toString();
    } catch {
      return "";
    }
  }
  const base = process.env.DATASWARM_PUBLIC_BASE_URL;
  const baseFromFile = readFirstNonEmptyFile(process.env.DATASWARM_PUBLIC_BASE_URL_FILE);
  const resolvedBase = base || baseFromFile;
  if (!resolvedBase) {
    return "";
  }
  return new URL("/api/internal/capabilities/invoke", resolvedBase).toString();
}

function hmac(payload: string) {
  return createHmac("sha256", sandboxToolProxySecret()).update(payload).digest("base64url");
}

function sandboxToolProxySecret() {
  return (
    process.env.DATASWARM_SANDBOX_TOOL_PROXY_SECRET ??
    process.env.E2B_API_KEY ??
    "dataswarm-dev-sandbox-tool-proxy-secret"
  );
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function assertProxyClaimMatch(expected: string, actual: string, field: string) {
  if (expected !== actual) {
    throw new Error(`Sandbox tool proxy ${field} mismatch`);
  }
}

function csv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLocalOnlyProxyUrl(value: string) {
  if (!value) {
    return false;
  }
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "host.docker.internal";
  } catch {
    return true;
  }
}

function redactUrl(value: string) {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? "redacted" : "";
      url.password = url.password ? "redacted" : "";
    }
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function readFirstNonEmptyFile(filePath: string | undefined) {
  if (!filePath) {
    return "";
  }
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}
