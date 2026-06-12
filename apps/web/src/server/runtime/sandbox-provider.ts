import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  isSandboxSessionCancelRequested,
  updateSandboxSessionHeartbeat,
  updateSandboxSessionStatus,
} from "../repositories/sandbox-sessions";
import { nowIso } from "../storage/ids";
import { dataDir } from "../storage/paths";

export const DATASWARM_E2B_TEMPLATE_ALIAS = "dataswarm-agent-runtime";
export const DATASWARM_E2B_TEMPLATE_BUILD_COMMAND =
  "npx --yes @e2b/cli template create dataswarm-agent-runtime -p sandbox -d e2b/e2b.Dockerfile -c 'sudo /root/.jupyter/start-up.sh' --ready-cmd 'python -c \"import urllib.request; urllib.request.urlopen(\\\"http://localhost:49999/health\\\", timeout=5).read()\" && python /home/user/dataswarm/entrypoint.py --ready'";

export type SandboxBranchJob = {
  runId: string;
  branchId: string;
  sandboxSessionId: string;
  agentSessionId: string;
  agentName: string;
  modelProfile: string;
  objective: string;
  instruction: string;
  contextBundleUri: string;
};

export type SandboxBranchResult = {
  branchId: string;
  sandboxSessionId: string;
  status: "completed" | "failed" | "cancelled";
  executionMode: "mock" | "real";
  externalSandboxId?: string;
  attempt: number;
  maxAttempts: number;
  outputMarkdown: string;
  outputSummary: string;
  agentEvents: SandboxAgentEvent[];
  qualitySignals?: Record<string, unknown>;
  sandboxArtifacts?: Array<Record<string, unknown>>;
  sandboxRuntime?: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
};

export type SandboxAgentEvent = {
  protocolVersion?: string;
  type: string;
  level?: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
};

export type SandboxProvider = {
  executeBranch(job: SandboxBranchJob): Promise<SandboxBranchResult>;
};

export type E2bSandboxReadiness = {
  providerSelected: boolean;
  sdkDependency: string;
  apiKeyConfigured: boolean;
  template: string;
  templateSource: "DATASWARM_E2B_TEMPLATE" | "E2B_TEMPLATE_ID" | "E2B_TEMPLATE" | "default";
  templateVerified: boolean;
  templateVerificationSource:
    | "DATASWARM_E2B_TEMPLATE_VERIFIED"
    | "DATASWARM_E2B_TEMPLATE_BUILD_ID"
    | "DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT"
    | "unverified";
  templateBuildId?: string;
  templateVerificationReceiptPath?: string;
  templateVerifiedAt?: string;
  liveSmokeVerified: boolean;
  liveSmokeReceiptPath: string;
  liveSmokeReceiptStatus?: string;
  liveSmokeVerifiedAt?: string;
  liveSmokeExternalSandboxId?: string;
  liveSmokeElapsedMs?: number;
  timeoutMs: number;
  retryMaxAttempts: number;
  sandboxAgentProtocol: "dataswarm.sandbox-agent.v1";
  modelMode: "deterministic" | "real";
  modelSecretsForwarding: "disabled" | "enabled";
  templateBuildCommand: string;
  liveSmokeCommand: string;
  requiredEnv: string[];
  missingEnv: string[];
  verificationCommands: string[];
  nextSteps: string[];
  readinessReasons: string[];
  readyForLiveSmoke: boolean;
  readyForOrchestrator: boolean;
  status: "ready" | "needs_provider_selection" | "needs_credentials" | "needs_template_verification";
};

export function createSandboxProvider(): SandboxProvider {
  if (process.env.DATASWARM_SANDBOX_PROVIDER === "e2b") {
    return new E2bSandboxProvider();
  }
  return new MockSandboxProvider();
}

export function getE2bSandboxReadiness(): E2bSandboxReadiness {
  const config = getE2bSandboxConfig();
  const providerSelected = process.env.DATASWARM_SANDBOX_PROVIDER === "e2b";
  const apiKeyConfigured = Boolean(process.env.E2B_API_KEY);
  const templateVerification = getE2bTemplateVerification(config.template);
  const liveSmokeReceipt = readE2bLiveSmokeReceipt(getE2bLiveSmokeReceiptPath(), config.template);
  const modelMode = process.env.DATASWARM_SANDBOX_AGENT_MODEL === "real" ? "real" : "deterministic";
  const modelSecretsForwarding =
    modelMode === "real" && process.env.DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS === "1" ? "enabled" : "disabled";
  const verificationCommands = [
    "node scripts/e2b-template-smoke.mjs",
    "node scripts/e2b-readiness-smoke.mjs",
    "node scripts/e2b-live-receipt-smoke.mjs",
    "node scripts/e2b-sandbox-smoke.mjs",
  ];
  const requiredEnv = [
    "E2B_API_KEY",
    "DATASWARM_SANDBOX_PROVIDER=e2b",
    "DATASWARM_E2B_TEMPLATE_VERIFIED=1 or DATASWARM_E2B_TEMPLATE_BUILD_ID or local template verification receipt",
  ];
  const missingEnv = [
    ...(apiKeyConfigured ? [] : ["E2B_API_KEY"]),
    ...(providerSelected ? [] : ["DATASWARM_SANDBOX_PROVIDER=e2b"]),
    ...(templateVerification.templateVerified
      ? []
      : ["DATASWARM_E2B_TEMPLATE_VERIFIED=1 or DATASWARM_E2B_TEMPLATE_BUILD_ID or local template verification receipt"]),
  ];
  const readinessReasons = [
    ...(providerSelected ? [] : ["E2B provider is not selected for orchestrator sandbox execution."]),
    ...(apiKeyConfigured ? [] : ["E2B_API_KEY is not configured, so live sandbox creation is gated."]),
    ...(templateVerification.templateVerified
      ? [`E2B template verification recorded via ${templateVerification.templateVerificationSource}.`]
      : ["E2B template verification is not recorded; build/verify the template before enabling orchestrator execution."]),
    ...(liveSmokeReceipt.liveSmokeVerified
      ? [`E2B live smoke receipt recorded at ${liveSmokeReceipt.liveSmokeVerifiedAt}.`]
      : ["E2B live smoke receipt is not recorded; run the live smoke after credentials and template verification are ready."]),
    ...(config.template === DATASWARM_E2B_TEMPLATE_ALIAS
      ? ["Using the canonical DataSwarm E2B template alias."]
      : ["Using a custom E2B template override; verify it packages the DataSwarm sandbox agent."]),
  ];
  const nextSteps = [
    ...(config.template === DATASWARM_E2B_TEMPLATE_ALIAS
      ? [`Build or verify the canonical template: ${DATASWARM_E2B_TEMPLATE_BUILD_COMMAND}`]
      : [`Verify custom template '${config.template}' with the DataSwarm entrypoint readiness contract.`]),
    ...(apiKeyConfigured ? [] : ["Set E2B_API_KEY in the server runtime environment."]),
    ...(templateVerification.templateVerified
      ? []
      : [
          `After template build/readiness succeeds, set DATASWARM_E2B_TEMPLATE_VERIFIED=1, set DATASWARM_E2B_TEMPLATE_BUILD_ID, or write a matching local receipt to ${templateVerification.templateVerificationReceiptPath}.`,
        ]),
    ...(providerSelected ? [] : ["Set DATASWARM_SANDBOX_PROVIDER=e2b when enabling real orchestrator sandbox execution."]),
    ...(liveSmokeReceipt.liveSmokeVerified
      ? []
      : [`After a real live smoke succeeds, preserve the receipt at ${liveSmokeReceipt.liveSmokeReceiptPath}.`]),
    `Run verification: ${verificationCommands.join(" && ")}`,
  ];
  const readyForLiveSmoke = apiKeyConfigured;
  const readyForOrchestrator = providerSelected && apiKeyConfigured && templateVerification.templateVerified;
  return {
    providerSelected,
    sdkDependency: "@e2b/code-interpreter",
    apiKeyConfigured,
    template: config.template ?? "default-code-interpreter",
    templateSource: config.templateSource,
    templateVerified: templateVerification.templateVerified,
    templateVerificationSource: templateVerification.templateVerificationSource,
    templateBuildId: templateVerification.templateBuildId,
    templateVerificationReceiptPath: templateVerification.templateVerificationReceiptPath,
    templateVerifiedAt: templateVerification.templateVerifiedAt,
    liveSmokeVerified: liveSmokeReceipt.liveSmokeVerified,
    liveSmokeReceiptPath: liveSmokeReceipt.liveSmokeReceiptPath,
    liveSmokeReceiptStatus: liveSmokeReceipt.liveSmokeReceiptStatus,
    liveSmokeVerifiedAt: liveSmokeReceipt.liveSmokeVerifiedAt,
    liveSmokeExternalSandboxId: liveSmokeReceipt.liveSmokeExternalSandboxId,
    liveSmokeElapsedMs: liveSmokeReceipt.liveSmokeElapsedMs,
    timeoutMs: config.timeoutMs,
    retryMaxAttempts: getSandboxBranchMaxAttempts(),
    sandboxAgentProtocol: "dataswarm.sandbox-agent.v1",
    modelMode,
    modelSecretsForwarding,
    templateBuildCommand: DATASWARM_E2B_TEMPLATE_BUILD_COMMAND,
    liveSmokeCommand: "node scripts/e2b-sandbox-smoke.mjs",
    requiredEnv,
    missingEnv,
    verificationCommands,
    nextSteps,
    readinessReasons,
    readyForLiveSmoke,
    readyForOrchestrator,
    status: readinessStatus({
      providerSelected,
      apiKeyConfigured,
      templateVerified: templateVerification.templateVerified,
    }),
  };
}

class MockSandboxProvider implements SandboxProvider {
  async executeBranch(job: SandboxBranchJob): Promise<SandboxBranchResult> {
    const startedAt = nowIso();
    const externalSandboxId = `mock-${job.branchId}`;
    const maxAttempts = getSandboxBranchMaxAttempts();
    const retryEvents: SandboxAgentEvent[] = [];
    const attemptFailures: Array<Record<string, unknown>> = [];
    try {
      await assertSandboxNotCancelled(job);
      await updateSandboxSessionStatus(job.sandboxSessionId, "running", {
        externalSandboxId,
        metadata: {
          context_bundle_uri: job.contextBundleUri,
          provider_mode: "mock",
          agent_protocol: "dataswarm.sandbox-agent.v1",
          timeout_ms: getSandboxBranchTimeoutMs(),
          max_attempts: maxAttempts,
        },
      });

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await assertSandboxNotCancelled(job);
          await persistSandboxAttemptMetadata(job, attempt, maxAttempts, attemptFailures);
          const parsed = executeLocalSandboxAgent(job, "mock", attempt);
          const agentEvents = [...retryEvents, ...parsed.agentEvents];
          await persistSandboxAgentRuntimeMetadata(job.sandboxSessionId, agentEvents);
          const outputMarkdown = parsed.outputMarkdown;
          const outputSummary = parsed.outputSummary || `${job.agentName} completed sandbox branch ${job.branchId}.`;

          const endedAt = nowIso();
          await updateSandboxSessionStatus(job.sandboxSessionId, "completed", {
            endedAt,
            metadata: {
              output_bytes: Buffer.byteLength(outputMarkdown, "utf8"),
              event_count: agentEvents.length,
              attempt,
              max_attempts: maxAttempts,
              attempt_failures: attemptFailures,
              quality_signals: parsed.qualitySignals,
              sandbox_artifacts: parsed.sandboxArtifacts,
              sandbox_runtime: parsed.sandboxRuntime,
              artifact_recovery: collectArtifactRecovery(agentEvents),
            },
          });

          return {
            branchId: job.branchId,
            sandboxSessionId: job.sandboxSessionId,
            status: "completed",
            executionMode: "mock",
            externalSandboxId,
            attempt,
            maxAttempts,
            outputMarkdown,
            outputSummary,
            agentEvents,
            qualitySignals: parsed.qualitySignals,
            sandboxArtifacts: parsed.sandboxArtifacts,
            sandboxRuntime: parsed.sandboxRuntime,
            startedAt,
            endedAt,
          };
        } catch (error) {
          const normalized = normalizeSandboxExecutionError(error);
          attemptFailures.push({ attempt, code: normalized.code, message: normalized.message, retryable: isRetryableSandboxError(normalized) });
          if (!shouldRetrySandboxAttempt(normalized, attempt, maxAttempts)) {
            throw new SandboxBranchExecutionError(normalized.code, normalized.message, normalized.status, attemptFailures);
          }
          const retryEvent = buildSandboxRetryEvent(job, attempt, maxAttempts, normalized);
          retryEvents.push(retryEvent);
          await updateSandboxSessionStatus(job.sandboxSessionId, "running", {
            metadata: {
              retry_scheduled: true,
              attempt_failures: attemptFailures,
              next_attempt: attempt + 1,
              last_error_code: normalized.code,
              last_error: normalized.message,
            },
          });
        }
      }

      throw new SandboxBranchExecutionError("sandbox_execution_failed", `Sandbox branch ${job.branchId} exhausted retries.`, "failed", attemptFailures);
    } catch (error) {
      await markSandboxExecutionFailure(job, error, "mock");
      throw error;
    }
  }
}

class E2bSandboxProvider implements SandboxProvider {
  async executeBranch(job: SandboxBranchJob): Promise<SandboxBranchResult> {
    const startedAt = nowIso();
    let sandbox: E2bSandboxLike | null = null;
    const maxAttempts = getSandboxBranchMaxAttempts();
    const retryEvents: SandboxAgentEvent[] = [];
    const attemptFailures: Array<Record<string, unknown>> = [];
    try {
      const readiness = getE2bSandboxReadiness();
      const preflight = buildE2bPreflightEvidence(readiness);
      await updateSandboxSessionStatus(job.sandboxSessionId, "running", {
        metadata: {
          provider_mode: "e2b",
          branch_id: job.branchId,
          e2b_preflight: preflight,
        },
      });
      if (!readiness.readyForOrchestrator) {
        throw new SandboxBranchExecutionError(
          "sandbox_preflight_failed",
          `E2B preflight failed for branch ${job.branchId}: ${readiness.missingEnv.join(", ") || readiness.status}.`,
          "failed",
          [
            {
              attempt: 0,
              code: "sandbox_preflight_failed",
              message: "E2B live sandbox execution is gated until required environment is configured.",
              retryable: false,
              readiness_status: readiness.status,
              missing_env: readiness.missingEnv,
              verification_commands: readiness.verificationCommands,
            },
          ],
        );
      }

      await assertSandboxNotCancelled(job);
      const { Sandbox } = (await import("@e2b/code-interpreter")) as {
        Sandbox: {
          create(templateOrOpts?: string | Record<string, unknown>, opts?: Record<string, unknown>): Promise<E2bSandboxLike>;
        };
      };
      const { template, timeoutMs } = getE2bSandboxConfig();

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await assertSandboxNotCancelled(job);
          await persistSandboxAttemptMetadata(job, attempt, maxAttempts, attemptFailures);
          sandbox = template
            ? await Sandbox.create(template, { apiKey: process.env.E2B_API_KEY, timeoutMs })
            : await Sandbox.create({ apiKey: process.env.E2B_API_KEY, timeoutMs });
          const externalSandboxId = sandbox.sandboxId ?? `e2b-${job.branchId}`;

          await updateSandboxSessionStatus(job.sandboxSessionId, "running", {
            externalSandboxId,
            metadata: {
              context_bundle_uri: job.contextBundleUri,
              provider_mode: "e2b",
              template: template ?? "default-code-interpreter",
              agent_protocol: "dataswarm.sandbox-agent.v1",
              timeout_ms: timeoutMs,
              attempt,
              max_attempts: maxAttempts,
            },
          });
          await assertSandboxNotCancelled(job);

          const code = buildE2bBranchPython(job);
          const execution = await sandbox.runCode(code, {
            language: "python",
            timeoutMs,
            envs: {
              DATASWARM_BRANCH_ID: job.branchId,
              DATASWARM_MODEL_PROFILE: job.modelProfile,
              ...e2bSandboxModelEnv(),
            },
          });
          const stdout = execution.logs?.stdout ?? [];
          const stderr = execution.logs?.stderr ?? [];
          if (execution.error) {
            throw new SandboxBranchExecutionError(
              "sandbox_execution_failed",
              `E2B branch execution failed: ${execution.error.name}: ${execution.error.value}`,
            );
          }
          const parsed = parseSandboxAgentOutput(execution.text, stdout);
          const agentEvents = [...retryEvents, ...parsed.agentEvents];
          await persistSandboxAgentRuntimeMetadata(job.sandboxSessionId, agentEvents);
          const outputMarkdown = parsed.outputMarkdown;
          const outputSummary = parsed.outputSummary || `${job.agentName} completed E2B sandbox branch ${job.branchId}.`;
          const endedAt = nowIso();

          await updateSandboxSessionStatus(job.sandboxSessionId, "completed", {
            endedAt,
            metadata: {
              output_bytes: Buffer.byteLength(outputMarkdown, "utf8"),
              event_count: agentEvents.length,
              attempt,
              max_attempts: maxAttempts,
              attempt_failures: attemptFailures,
              quality_signals: parsed.qualitySignals,
              sandbox_artifacts: parsed.sandboxArtifacts,
              sandbox_runtime: parsed.sandboxRuntime,
              artifact_recovery: collectArtifactRecovery(agentEvents),
              stdout_preview: stdout.join("\n").slice(0, 2000),
              stderr_preview: stderr.join("\n").slice(0, 2000),
            },
          });

          return {
            branchId: job.branchId,
            sandboxSessionId: job.sandboxSessionId,
            status: "completed",
            executionMode: "real",
            externalSandboxId,
            attempt,
            maxAttempts,
            outputMarkdown,
            outputSummary,
            agentEvents,
            qualitySignals: parsed.qualitySignals,
            sandboxArtifacts: parsed.sandboxArtifacts,
            sandboxRuntime: parsed.sandboxRuntime,
            startedAt,
            endedAt,
          };
        } catch (error) {
          const normalized = normalizeSandboxExecutionError(error);
          attemptFailures.push({ attempt, code: normalized.code, message: normalized.message, retryable: isRetryableSandboxError(normalized) });
          if (sandbox) {
            await sandbox.kill().catch(() => undefined);
            sandbox = null;
          }
          if (!shouldRetrySandboxAttempt(normalized, attempt, maxAttempts)) {
            throw new SandboxBranchExecutionError(normalized.code, normalized.message, normalized.status, attemptFailures);
          }
          const retryEvent = buildSandboxRetryEvent(job, attempt, maxAttempts, normalized);
          retryEvents.push(retryEvent);
          await updateSandboxSessionStatus(job.sandboxSessionId, "running", {
            metadata: {
              retry_scheduled: true,
              attempt_failures: attemptFailures,
              next_attempt: attempt + 1,
              last_error_code: normalized.code,
              last_error: normalized.message,
            },
          });
        }
      }

      throw new SandboxBranchExecutionError("sandbox_execution_failed", `Sandbox branch ${job.branchId} exhausted retries.`, "failed", attemptFailures);
    } catch (error) {
      await markSandboxExecutionFailure(job, error, "e2b");
      throw error;
    } finally {
      if (sandbox) {
        await sandbox.kill().catch(() => undefined);
      }
    }
  }
}

type E2bSandboxLike = {
  sandboxId?: string;
  runCode(
    code: string,
    opts?: {
      language?: string;
      timeoutMs?: number;
      envs?: Record<string, string>;
    },
  ): Promise<{
    text?: string;
    logs?: { stdout?: string[]; stderr?: string[] };
    error?: { name?: string; value?: string };
  }>;
  kill(): Promise<void>;
};

function buildE2bBranchPython(job: SandboxBranchJob) {
  const agentSource = readSandboxAgentSource();
  const payload = buildSandboxAgentJob(job, "e2b");
  return `
job_json = ${JSON.stringify(JSON.stringify(payload))}
import os
os.environ["DATASWARM_AGENT_JOB_JSON"] = job_json
import json
if os.environ.get("DATASWARM_E2B_USE_TEMPLATE_AGENT") == "1":
    import sys
    sys.path.insert(0, "/home/user/dataswarm")
    import dataswarm_sandbox_agent as dataswarm_agent
    result = dataswarm_agent.run()
    dataswarm_agent.emit("sandbox.agent.completed", "Sandbox branch completed.", {"branchId": result["branchId"]})
else:
    agent_source = ${JSON.stringify(agentSource)}
    namespace = {"__name__": "dataswarm_sandbox_agent"}
    exec(compile(agent_source, "dataswarm_sandbox_agent.py", "exec"), namespace)
    result = namespace["run"]()
    namespace["emit"]("sandbox.agent.completed", "Sandbox branch completed.", {"branchId": result["branchId"]})
print(json.dumps(result, ensure_ascii=False))
result
`;
}

function executeLocalSandboxAgent(job: SandboxBranchJob, executionMode: "mock" | "local-smoke", attempt = 1) {
  const forcedFailures = Number(process.env.DATASWARM_SANDBOX_FAIL_ATTEMPTS ?? (process.env.DATASWARM_SANDBOX_FAIL_FIRST_ATTEMPT === "1" ? 1 : 0));
  if (Number.isFinite(forcedFailures) && attempt <= forcedFailures) {
    throw new SandboxBranchExecutionError("sandbox_execution_failed", `Forced sandbox retry smoke failure on attempt ${attempt}.`);
  }
  const agentPath = getSandboxAgentPath();
  const result = spawnSync("python3", [agentPath], {
    cwd: getWorkspaceRoot(),
    encoding: "utf8",
    input: JSON.stringify(buildSandboxAgentJob(job, executionMode)),
    env: { ...process.env, PYTHONUTF8: "1" },
    timeout: getSandboxBranchTimeoutMs(),
  });
  if (result.error) {
    const code = result.error.message.includes("ETIMEDOUT") ? "sandbox_timeout" : "sandbox_execution_failed";
    throw new SandboxBranchExecutionError(code, result.error.message, "failed");
  }
  if (result.status !== 0) {
    throw new Error(`Local sandbox agent failed: ${(result.stdout || result.stderr || "").slice(0, 2000)}`);
  }
  return parseSandboxAgentOutput(result.stdout, []);
}

function buildSandboxAgentJob(job: SandboxBranchJob, executionMode: "mock" | "e2b" | "local-smoke") {
  return {
    branchId: job.branchId,
    agentName: job.agentName,
    modelProfile: job.modelProfile,
    objective: job.objective,
    instruction: job.instruction,
    contextBundleUri: job.contextBundleUri,
    executionMode,
    sandboxModel: buildSandboxModelConfig(job.modelProfile),
  };
}

function buildSandboxModelConfig(modelProfile: string) {
  const model = process.env.DATASWARM_SANDBOX_AGENT_MODEL_NAME ?? (modelProfile.includes(":") ? modelProfile.split(":").at(-1) : modelProfile);
  const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL ?? "";
  return {
    mode: process.env.DATASWARM_SANDBOX_AGENT_MODEL === "real" ? "real" : "deterministic",
    model,
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    authScheme: process.env.DATASWARM_SANDBOX_AGENT_AUTH_SCHEME ?? (deepseekBaseUrl.includes("api.deepseek.com") ? "bearer" : "raw"),
    maxTokens: Number(process.env.DATASWARM_SANDBOX_AGENT_MAX_TOKENS ?? 900),
    timeoutSeconds: Number(process.env.DATASWARM_SANDBOX_AGENT_TIMEOUT_SECONDS ?? 60),
  };
}

function e2bSandboxModelEnv() {
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

function parseSandboxAgentOutput(text: string | undefined, stdout: string[]) {
  const candidates = [text, ...stdout].filter((item): item is string => Boolean(item?.trim()));
  const parsedLines = candidates
    .flatMap((candidate) => candidate.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonObject(line))
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const agentEvents = parsedLines.filter(isSandboxAgentEvent);
  const resultLine = [...parsedLines].reverse().find((item) => typeof item.outputMarkdown === "string");
  if (resultLine) {
    return {
      outputMarkdown: String(resultLine.outputMarkdown),
      outputSummary: typeof resultLine.outputSummary === "string" ? resultLine.outputSummary : "",
      agentEvents,
      qualitySignals: isRecord(resultLine.qualitySignals) ? resultLine.qualitySignals : undefined,
      sandboxArtifacts: Array.isArray(resultLine.artifacts)
        ? resultLine.artifacts.filter(isRecord)
        : undefined,
      sandboxRuntime: isRecord(resultLine.runtime) ? resultLine.runtime : undefined,
    };
  }

  for (const candidate of candidates) {
    for (const line of candidate.split("\n").reverse()) {
      try {
        const parsed = JSON.parse(line) as { outputMarkdown?: unknown; outputSummary?: unknown };
        if (typeof parsed.outputMarkdown === "string") {
          return {
            outputMarkdown: parsed.outputMarkdown,
            outputSummary: typeof parsed.outputSummary === "string" ? parsed.outputSummary : "",
            agentEvents,
            qualitySignals: undefined,
            sandboxArtifacts: undefined,
            sandboxRuntime: undefined,
          };
        }
      } catch {
        // Try the next line.
      }
    }
  }
  const fallback = candidates.join("\n").trim();
  return {
    outputMarkdown: fallback || "# E2B Branch\n\nNo branch output was returned.",
    outputSummary: "E2B branch completed with unstructured output.",
    agentEvents,
    qualitySignals: undefined,
    sandboxArtifacts: undefined,
    sandboxRuntime: undefined,
  };
}

async function assertSandboxNotCancelled(job: SandboxBranchJob) {
  const cancelledByEnv = csvSet(process.env.DATASWARM_CANCELLED_RUN_IDS).has(job.runId) || csvSet(process.env.DATASWARM_CANCELLED_BRANCH_IDS).has(job.branchId);
  if (cancelledByEnv || (await isSandboxSessionCancelRequested(job.sandboxSessionId))) {
    throw new SandboxBranchExecutionError("sandbox_cancelled", `Sandbox branch ${job.branchId} was cancelled before execution.`, "cancelled");
  }
}

async function markSandboxExecutionFailure(job: SandboxBranchJob, error: unknown, providerMode: "mock" | "e2b") {
  const normalized = normalizeSandboxExecutionError(error);
  await updateSandboxSessionStatus(job.sandboxSessionId, normalized.status, {
    metadata: {
      provider_mode: providerMode,
      error_code: normalized.code,
      error: normalized.message,
      branch_id: job.branchId,
      attempt_failures: normalized.attemptFailures,
    },
  });
}

async function persistSandboxAttemptMetadata(
  job: SandboxBranchJob,
  attempt: number,
  maxAttempts: number,
  attemptFailures: Array<Record<string, unknown>>,
) {
  await updateSandboxSessionStatus(job.sandboxSessionId, "running", {
    metadata: {
      attempt,
      max_attempts: maxAttempts,
      attempt_failures: attemptFailures,
      retry_policy: {
        max_attempts: maxAttempts,
        retryable_error_codes: ["sandbox_timeout", "sandbox_execution_failed"],
      },
    },
  });
}

async function persistSandboxAgentRuntimeMetadata(sandboxSessionId: string, events: SandboxAgentEvent[]) {
  const heartbeat = latestHeartbeat(events);
  if (heartbeat) {
    await updateSandboxSessionHeartbeat(sandboxSessionId, {
      heartbeatAt: heartbeat.timestamp,
      metadata: {
        heartbeat_count: events.filter((event) => event.type === "sandbox.agent.heartbeat").length,
        last_heartbeat_stage: heartbeat.payload?.stage,
      },
    });
  }
}

function collectArtifactRecovery(events: SandboxAgentEvent[]) {
  const manifest = [...events].reverse().find((event) => event.type === "sandbox.agent.artifact_recovery_manifest");
  return manifest?.payload ?? null;
}

function latestHeartbeat(events: SandboxAgentEvent[]) {
  return [...events].reverse().find((event) => event.type === "sandbox.agent.heartbeat" && typeof event.timestamp === "string");
}

function getSandboxBranchTimeoutMs() {
  const value = Number(process.env.DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

function getE2bSandboxConfig() {
  const templateEnv = process.env.DATASWARM_E2B_TEMPLATE
    ? { template: process.env.DATASWARM_E2B_TEMPLATE, templateSource: "DATASWARM_E2B_TEMPLATE" as const }
    : process.env.E2B_TEMPLATE_ID
      ? { template: process.env.E2B_TEMPLATE_ID, templateSource: "E2B_TEMPLATE_ID" as const }
      : process.env.E2B_TEMPLATE
        ? { template: process.env.E2B_TEMPLATE, templateSource: "E2B_TEMPLATE" as const }
        : { template: DATASWARM_E2B_TEMPLATE_ALIAS, templateSource: "default" as const };
  const timeoutMsValue = Number(
    process.env.DATASWARM_E2B_TIMEOUT_MS ??
      process.env.DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS ??
      120_000,
  );
  const timeoutMs = Number.isFinite(timeoutMsValue) && timeoutMsValue > 0 ? timeoutMsValue : 120_000;
  return { template: templateEnv.template, templateSource: templateEnv.templateSource, timeoutMs };
}

function getE2bTemplateVerification(template: string) {
  const buildId = process.env.DATASWARM_E2B_TEMPLATE_BUILD_ID?.trim();
  if (buildId) {
    return {
      templateVerified: true,
      templateVerificationSource: "DATASWARM_E2B_TEMPLATE_BUILD_ID" as const,
      templateBuildId: buildId,
      templateVerificationReceiptPath: getE2bTemplateVerificationReceiptPath(),
      templateVerifiedAt: undefined,
    };
  }
  if (process.env.DATASWARM_E2B_TEMPLATE_VERIFIED === "1") {
    return {
      templateVerified: true,
      templateVerificationSource: "DATASWARM_E2B_TEMPLATE_VERIFIED" as const,
      templateBuildId: undefined,
      templateVerificationReceiptPath: getE2bTemplateVerificationReceiptPath(),
      templateVerifiedAt: undefined,
    };
  }
  const receipt = readE2bTemplateVerificationReceipt(getE2bTemplateVerificationReceiptPath(), template);
  if (receipt.templateVerified) {
    return receipt;
  }
  return {
    templateVerified: false,
    templateVerificationSource: "unverified" as const,
    templateBuildId: undefined,
    templateVerificationReceiptPath: getE2bTemplateVerificationReceiptPath(),
    templateVerifiedAt: undefined,
  };
}

function getE2bTemplateVerificationReceiptPath() {
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.env.DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT ??
      path.join(dataDir, "e2b", "template-verification.json"),
  );
}

function getE2bLiveSmokeReceiptPath() {
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.env.DATASWARM_E2B_LIVE_SMOKE_RECEIPT ??
      path.join(dataDir, "e2b", "live-smoke-receipt.json"),
  );
}

function readE2bTemplateVerificationReceipt(receiptPath: string, expectedTemplate: string) {
  if (!existsSync(receiptPath)) {
    return {
      templateVerified: false,
      templateVerificationSource: "unverified" as const,
      templateBuildId: undefined,
      templateVerificationReceiptPath: receiptPath,
      templateVerifiedAt: undefined,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("receipt is not a JSON object");
    }
    const status = String(parsed.status ?? "").toLowerCase();
    const template = String(parsed.template ?? "");
    const buildId = typeof parsed.templateBuildId === "string" ? parsed.templateBuildId.trim() : "";
    const verifiedAt = typeof parsed.verifiedAt === "string" ? parsed.verifiedAt.trim() : "";
    const readyStatus = status === "ready" || status === "verified";
    const templateMatches = template === expectedTemplate;
    const hasReceiptEvidence = Boolean(buildId || verifiedAt);
    return {
      templateVerified: readyStatus && templateMatches && hasReceiptEvidence,
      templateVerificationSource: readyStatus && templateMatches && hasReceiptEvidence
        ? ("DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT" as const)
        : ("unverified" as const),
      templateBuildId: buildId || undefined,
      templateVerificationReceiptPath: receiptPath,
      templateVerifiedAt: verifiedAt || undefined,
    };
  } catch {
    return {
      templateVerified: false,
      templateVerificationSource: "unverified" as const,
      templateBuildId: undefined,
      templateVerificationReceiptPath: receiptPath,
      templateVerifiedAt: undefined,
    };
  }
}

function readE2bLiveSmokeReceipt(receiptPath: string, expectedTemplate: string) {
  const base = {
    liveSmokeVerified: false,
    liveSmokeReceiptPath: receiptPath,
    liveSmokeReceiptStatus: undefined,
    liveSmokeVerifiedAt: undefined,
    liveSmokeExternalSandboxId: undefined,
    liveSmokeElapsedMs: undefined,
  };
  if (!existsSync(receiptPath)) {
    return base;
  }
  try {
    const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("live smoke receipt is not a JSON object");
    }
    const status = String(parsed.status ?? "").toLowerCase();
    const provider = String(parsed.provider ?? "").toLowerCase();
    const template = String(parsed.template ?? "");
    const completedAt = typeof parsed.completedAt === "string" ? parsed.completedAt.trim() : "";
    const externalSandboxId = typeof parsed.externalSandboxId === "string" ? parsed.externalSandboxId.trim() : "";
    const elapsedMs = typeof parsed.elapsedMs === "number" && Number.isFinite(parsed.elapsedMs) ? parsed.elapsedMs : undefined;
    const liveSmokeVerified =
      status === "passed" &&
      provider === "e2b" &&
      template === expectedTemplate &&
      Boolean(completedAt && externalSandboxId);
    return {
      liveSmokeVerified,
      liveSmokeReceiptPath: receiptPath,
      liveSmokeReceiptStatus: status || undefined,
      liveSmokeVerifiedAt: completedAt || undefined,
      liveSmokeExternalSandboxId: liveSmokeVerified ? externalSandboxId : undefined,
      liveSmokeElapsedMs: liveSmokeVerified ? elapsedMs : undefined,
    };
  } catch {
    return base;
  }
}

function buildE2bPreflightEvidence(readiness: E2bSandboxReadiness) {
  return {
    status: readiness.status,
    provider_selected: readiness.providerSelected,
    api_key_configured: readiness.apiKeyConfigured,
    template: readiness.template,
    template_source: readiness.templateSource,
    template_verified: readiness.templateVerified,
    template_verification_source: readiness.templateVerificationSource,
    template_build_id: readiness.templateBuildId,
    template_verification_receipt_path: readiness.templateVerificationReceiptPath,
    template_verified_at: readiness.templateVerifiedAt,
    live_smoke_verified: readiness.liveSmokeVerified,
    live_smoke_receipt_path: readiness.liveSmokeReceiptPath,
    live_smoke_receipt_status: readiness.liveSmokeReceiptStatus,
    live_smoke_verified_at: readiness.liveSmokeVerifiedAt,
    live_smoke_external_sandbox_id: readiness.liveSmokeExternalSandboxId,
    live_smoke_elapsed_ms: readiness.liveSmokeElapsedMs,
    timeout_ms: readiness.timeoutMs,
    retry_max_attempts: readiness.retryMaxAttempts,
    sandbox_agent_protocol: readiness.sandboxAgentProtocol,
    model_mode: readiness.modelMode,
    model_secrets_forwarding: readiness.modelSecretsForwarding,
    missing_env: readiness.missingEnv,
    readiness_reasons: readiness.readinessReasons,
    next_steps: readiness.nextSteps,
    verification_commands: readiness.verificationCommands,
    ready_for_live_smoke: readiness.readyForLiveSmoke,
    ready_for_orchestrator: readiness.readyForOrchestrator,
  };
}

function readinessStatus({
  providerSelected,
  apiKeyConfigured,
  templateVerified,
}: {
  providerSelected: boolean;
  apiKeyConfigured: boolean;
  templateVerified: boolean;
}): E2bSandboxReadiness["status"] {
  if (!apiKeyConfigured) {
    return "needs_credentials";
  }
  if (!providerSelected) {
    return "needs_provider_selection";
  }
  if (!templateVerified) {
    return "needs_template_verification";
  }
  return "ready";
}

function getSandboxBranchMaxAttempts() {
  const retries = Number(process.env.DATASWARM_SANDBOX_BRANCH_MAX_RETRIES ?? 1);
  const normalizedRetries = Number.isFinite(retries) && retries >= 0 ? Math.floor(retries) : 1;
  return normalizedRetries + 1;
}

type NormalizedSandboxExecutionError = {
  code: string;
  message: string;
  status: "failed" | "cancelled";
  attemptFailures: Array<Record<string, unknown>>;
};

function normalizeSandboxExecutionError(error: unknown): NormalizedSandboxExecutionError {
  if (error instanceof SandboxBranchExecutionError) {
    return { code: error.code, message: error.message, status: error.status, attemptFailures: error.attemptFailures };
  }
  if (isRecord(error) && typeof error.code === "string") {
    return {
      code: error.code,
      message: typeof error.message === "string" ? error.message : "Unknown sandbox execution error",
      status: error.status === "cancelled" ? "cancelled" : ("failed" as const),
      attemptFailures: Array.isArray(error.attemptFailures) ? error.attemptFailures.filter(isRecord) : [],
    };
  }
  return {
    code: "sandbox_execution_failed",
    message: error instanceof Error ? error.message : "Unknown sandbox execution error",
    status: "failed" as const,
    attemptFailures: [],
  };
}

function shouldRetrySandboxAttempt(
  error: ReturnType<typeof normalizeSandboxExecutionError>,
  attempt: number,
  maxAttempts: number,
) {
  return attempt < maxAttempts && isRetryableSandboxError(error);
}

function isRetryableSandboxError(error: Pick<ReturnType<typeof normalizeSandboxExecutionError>, "code" | "status">) {
  return error.status !== "cancelled" && (error.code === "sandbox_timeout" || error.code === "sandbox_execution_failed");
}

function buildSandboxRetryEvent(
  job: SandboxBranchJob,
  attempt: number,
  maxAttempts: number,
  error: ReturnType<typeof normalizeSandboxExecutionError>,
): SandboxAgentEvent {
  return {
    protocolVersion: "dataswarm.sandbox-agent.v1",
    type: "sandbox.agent.retry_scheduled",
    level: "warn",
    message: `Sandbox branch attempt ${attempt} failed; retry ${attempt + 1}/${maxAttempts} scheduled.`,
    timestamp: nowIso(),
    payload: {
      branchId: job.branchId,
      failedAttempt: attempt,
      nextAttempt: attempt + 1,
      maxAttempts,
      errorCode: error.code,
      retryable: true,
    },
  };
}

function csvSet(value: string | undefined) {
  return new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

class SandboxBranchExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: "failed" | "cancelled" = "failed",
    public readonly attemptFailures: Array<Record<string, unknown>> = [],
  ) {
    super(message);
    this.name = "SandboxBranchExecutionError";
  }
}

function parseJsonObject(line: string) {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSandboxAgentEvent(value: Record<string, unknown>): value is SandboxAgentEvent {
  return typeof value.type === "string" && value.type.startsWith("sandbox.agent.") && typeof value.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSandboxAgentSource() {
  return readFileSync(getSandboxAgentPath(), "utf8");
}

function getSandboxAgentPath() {
  return path.join(getWorkspaceRoot(), "sandbox/agent/dataswarm_sandbox_agent.py");
}

function getWorkspaceRoot() {
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.env.DATASWARM_WORKSPACE_ROOT ?? ".",
  );
}
