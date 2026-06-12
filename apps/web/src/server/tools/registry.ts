import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getToolByName, createToolCall, updateToolCall } from "../repositories/tools";
import { createTextArtifact } from "../repositories/artifacts";
import { diagnoseConversation } from "../repositories/diagnostics";
import { atomicWriteText, localUri, resolveLocalUri } from "../storage/paths";
import { getDb, defaults } from "../storage/db";
import { errorPayload, logServer } from "../observability/logger";
import type { CallToolAction, Observation, ObservationClaim } from "../runtime/agentic-types";

export type TavilySource = {
  title: string;
  url: string;
  content: string;
};

type WebSearchProviderName = "tavily" | "mock";

type WebSearchOptions = {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news";
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
};

type WebSearchInput = WebSearchOptions & {
  query: string;
  providerName?: WebSearchProviderName;
};

export type WebSearchProvider = {
  name: WebSearchProviderName;
  providerToolName: string;
  search(input: {
    query: string;
    options: WebSearchOptions;
  }): Promise<{ sources: TavilySource[]; executionMode: "mock" | "real" }>;
};

export type ToolExecutionResult = {
  toolCallId: string;
  outputSummary: string;
  executionMode: "mock" | "real";
  payloadUri?: string;
  logicalToolName?: string;
  providerToolName?: string;
  provider?: string;
  sources?: TavilySource[];
  claims?: ObservationClaim[];
};

export type GenericToolExecutionResult = ToolExecutionResult & {
  toolName: string;
  evidenceLevel: "real" | "mock" | "inferred" | "user_provided";
  observationStatus?: Observation["status"];
  artifacts?: Array<{
    id: string;
    versionId: string;
    type: string;
    mimeType: string;
    title: string;
    storageUri: string;
    previewUri: string;
    deduped?: boolean;
  }>;
};

type ToolAdapter = {
  toolName: string;
  execute(input: {
    runId: string;
    agentSessionId: string;
    traceSpanId: string;
    conversationId: string;
    action: CallToolAction;
    observations?: Observation[];
    onToolCallCreated?: (toolCallId: string) => Promise<void>;
  }): Promise<GenericToolExecutionResult>;
};

const toolAdapters: Record<string, ToolAdapter> = {
  "web.search": {
    toolName: "web.search",
    execute: executeWebSearchAction,
  },
  "tavily.search": {
    toolName: "tavily.search",
    execute: executeTavilyAction,
  },
  "trace.query": {
    toolName: "trace.query",
    execute: executeTraceQueryAction,
  },
  "artifact.create": {
    toolName: "artifact.create",
    execute: executeArtifactCreateAction,
  },
  "file.read": {
    toolName: "file.read",
    execute: executeFileReadAction,
  },
  "approval.request": {
    toolName: "approval.request",
    execute: executeApprovalRequestAction,
  },
};

export function listImplementedToolAdapterNames() {
  return Object.keys(toolAdapters);
}

export async function executeToolAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  observations?: Observation[];
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<GenericToolExecutionResult> {
  const adapter = toolAdapters[input.action.toolName];
  if (!adapter) {
    throw new Error(`Tool adapter is not implemented: ${input.action.toolName}`);
  }

  return adapter.execute(input);
}

async function executeTavilyAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<GenericToolExecutionResult> {
  return executeSearchViaProvider(input, "tavily");
}

async function executeWebSearchAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<GenericToolExecutionResult> {
  return executeSearchViaProvider(input);
}

const webSearchProviders: Record<WebSearchProviderName, WebSearchProvider> = {
  tavily: {
    name: "tavily",
    providerToolName: "tavily.search",
    async search({ query, options }) {
      const useMock = process.env.DATASWARM_MOCK_TOOLS === "1" || !process.env.TAVILY_API_KEY;
      const sources = useMock ? mockTavilySources(query) : await tavilyRestSearch(query, options);
      return { sources, executionMode: useMock ? "mock" : "real" };
    },
  },
  mock: {
    name: "mock",
    providerToolName: "mock.search",
    async search({ query }) {
      return { sources: mockWebSearchSources(query), executionMode: "mock" };
    },
  },
};

async function executeSearchViaProvider(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}, forcedProviderName?: WebSearchProviderName): Promise<GenericToolExecutionResult> {
  const searchInput = extractWebSearchInput(input.action.input);
  const providerName = forcedProviderName ?? searchInput.providerName ?? defaultWebSearchProviderName();
  const provider = webSearchProviders[providerName];
  const result = await executeWebSearch({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    traceSpanId: input.traceSpanId,
    toolName: input.action.toolName,
    provider,
    ...searchInput,
    onToolCallCreated: input.onToolCallCreated,
  });
  return { ...result, toolName: input.action.toolName, evidenceLevel: result.executionMode === "real" ? "real" : "mock" };
}

export async function executeTavilySearch(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  toolName?: string;
  query: string;
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news";
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<ToolExecutionResult> {
  return executeWebSearch({
    ...input,
    provider: webSearchProviders.tavily,
  });
}

export async function executeWebSearch(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  toolName?: string;
  provider: WebSearchProvider;
  query: string;
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news";
  includeAnswer?: boolean;
  includeRawContent?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<ToolExecutionResult> {
  const logicalToolName = input.toolName ?? "tavily.search";
  const tool = await getToolByName(logicalToolName);
  if (!tool || !tool.enabled) {
    throw new Error(`${logicalToolName} tool is not enabled`);
  }

  const toolCall = await createToolCall({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    toolId: tool.id,
    traceSpanId: input.traceSpanId,
    status: "running",
    inputSummary: input.query.slice(0, 240),
  });
  await input.onToolCallCreated?.(toolCall.id);

  try {
    logServer("info", "tool.web_search.start", {
      runId: input.runId,
      toolCallId: toolCall.id,
      provider: input.provider.name,
      providerToolName: input.provider.providerToolName,
      queryLength: input.query.length,
      queryPreview: input.query.slice(0, 200),
    });
    const searchOptions = {
      maxResults: input.maxResults,
      searchDepth: input.searchDepth,
      topic: input.topic,
      includeAnswer: input.includeAnswer,
      includeRawContent: input.includeRawContent,
      includeDomains: input.includeDomains,
      excludeDomains: input.excludeDomains,
    };
    const { sources, executionMode } = await input.provider.search({
      query: input.query,
      options: searchOptions,
    });
    const outputSummary =
      logicalToolName === "web.search"
        ? `Web search returned ${sources.length} source(s) via ${input.provider.name} provider.`
        : `${input.provider.providerToolName} returned ${sources.length} source(s).`;
    const payloadUri = localUri("traces", defaults.projectId, input.runId, `${toolCall.id}.json`);
    await atomicWriteText(
      resolveLocalUri(payloadUri),
      JSON.stringify(
        {
          query: input.query,
          options: searchOptions,
          logicalToolName,
          providerToolName: input.provider.providerToolName,
          provider: input.provider.name,
          sources,
        },
        null,
        2,
      ),
    );

    await updateToolCall({
      id: toolCall.id,
      status: "completed",
      outputSummary,
      outputPayloadUri: payloadUri,
    });
    logServer("info", "tool.web_search.completed", {
      runId: input.runId,
      toolCallId: toolCall.id,
      provider: input.provider.name,
      providerToolName: input.provider.providerToolName,
      sourceCount: sources.length,
      sourceUrls: sources.map((source) => source.url).slice(0, 5),
    });

    return {
      toolCallId: toolCall.id,
      outputSummary,
      executionMode,
      payloadUri,
      logicalToolName,
      providerToolName: input.provider.providerToolName,
      provider: input.provider.name,
      sources,
      claims: sources.map((source) => ({
        claim: source.content.slice(0, 240),
        support: "direct",
        sourceRefs: [{ title: source.title, url: source.url }],
      })),
    };
  } catch (error) {
    logServer("error", "tool.web_search.failed", {
      runId: input.runId,
      toolCallId: toolCall.id,
      provider: input.provider.name,
      providerToolName: input.provider.providerToolName,
      ...errorPayload(error),
    });
    await updateToolCall({
      id: toolCall.id,
      status: "failed",
      error: {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : "Unknown tool error",
      },
    });
    throw error;
  }
}

function extractTavilyQuery(input: Record<string, unknown>) {
  const query = input.query;
  if (typeof query === "string" && query.trim().length > 0) {
    return query.trim().slice(0, 240);
  }
  const text = input.text;
  if (typeof text === "string" && text.trim().length > 0) {
    return text.trim().slice(0, 240);
  }
  throw new Error("tavily.search requires input.query");
}

function extractWebSearchInput(input: Record<string, unknown>): WebSearchInput {
  return {
    query: extractTavilyQuery(input),
    providerName: webSearchProviderName(input.provider ?? input.provider_name ?? input.search_provider),
    maxResults: boundedInteger(input.max_results ?? input.maxResults, 1, 20),
    searchDepth: enumValue(input.search_depth ?? input.searchDepth, ["basic", "advanced"] as const),
    topic: enumValue(input.topic, ["general", "news"] as const),
    includeAnswer: booleanValue(input.include_answer ?? input.includeAnswer),
    includeRawContent: booleanValue(input.include_raw_content ?? input.includeRawContent),
    includeDomains: stringArray(input.include_domains ?? input.includeDomains),
    excludeDomains: stringArray(input.exclude_domains ?? input.excludeDomains),
  };
}

function webSearchProviderName(value: unknown): WebSearchProviderName | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "tavily" || normalized === "mock") {
    return normalized;
  }
  return undefined;
}

function defaultWebSearchProviderName(): WebSearchProviderName {
  return webSearchProviderName(process.env.DATASWARM_WEB_SEARCH_PROVIDER) ?? "tavily";
}

async function executeTraceQueryAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<GenericToolExecutionResult> {
  const tool = await getToolByName("trace.query");
  if (!tool || !tool.enabled) {
    throw new Error("trace.query tool is not enabled");
  }

  const resolvedTarget = await resolveTraceQueryTarget(input.action.input);
  if (!resolvedTarget.conversationId) {
    throw new Error("trace.query requires input.conversation_id, input.run_id, or input.trace_id");
  }

  const toolCall = await createToolCall({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    toolId: tool.id,
    traceSpanId: input.traceSpanId,
    status: "running",
    inputSummary: `${resolvedTarget.kind}=${resolvedTarget.id}`,
  });
  await input.onToolCallCreated?.(toolCall.id);

  try {
    logServer("info", "tool.trace.query.start", {
      runId: input.runId,
      toolCallId: toolCall.id,
      targetKind: resolvedTarget.kind,
      targetId: resolvedTarget.id,
      conversationId: resolvedTarget.conversationId,
    });
    const diagnostic = await diagnoseConversation(resolvedTarget.conversationId);
    if (!diagnostic) {
      throw new Error(`Conversation not found: ${resolvedTarget.conversationId}`);
    }

    const payloadUri = localUri("traces", defaults.projectId, input.runId, `${toolCall.id}.json`);
    await atomicWriteText(resolveLocalUri(payloadUri), JSON.stringify({ target: resolvedTarget, diagnostic }, null, 2));
    const qualityIssueCount = diagnostic.summary.qualityIssues?.length ?? 0;
    const outputSummary = formatTraceQuerySummary({
      targetKind: resolvedTarget.kind,
      targetId: resolvedTarget.id,
      summary: diagnostic.summary,
    });

    await updateToolCall({
      id: toolCall.id,
      status: "completed",
      outputSummary,
      outputPayloadUri: payloadUri,
    });
    logServer("info", "tool.trace.query.completed", {
      runId: input.runId,
      toolCallId: toolCall.id,
      targetKind: resolvedTarget.kind,
      targetId: resolvedTarget.id,
      conversationId: resolvedTarget.conversationId,
      qualityIssueCount,
      selfImprovementCandidateCount: diagnostic.summary.selfImprovement?.candidateCount ?? 0,
      appliedImprovementReceiptCoverage: diagnostic.summary.selfImprovement
        ? `${diagnostic.summary.selfImprovement.appliedWithVerificationReceiptCount}/${diagnostic.summary.selfImprovement.appliedCount}`
        : "0/0",
    });

    return {
      toolCallId: toolCall.id,
      toolName: input.action.toolName,
      outputSummary,
      executionMode: "real",
      evidenceLevel: "real",
      payloadUri,
      claims: [
        {
          claim: outputSummary,
          support: qualityIssueCount > 0 ? "direct" : "indirect",
          sourceRefs: [{ payloadPath: payloadUri }],
        },
      ],
    };
  } catch (error) {
    await updateToolCall({
      id: toolCall.id,
      status: "failed",
      error: {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : "Unknown trace query error",
      },
    });
    throw error;
  }
}

function formatTraceQuerySummary(input: {
  targetKind: string;
  targetId: string;
  summary: {
    runCount: number;
    eventCount: number;
    qualityIssues?: unknown[];
    sandbox?: {
      sessionCount?: number;
      preflightFailureCount?: number;
    };
    selfImprovement?: {
      candidateCount?: number;
      appliedCount?: number;
      appliedWithVerificationReceiptCount?: number;
      appliedMissingVerificationReceiptCount?: number;
      appliedReceiptCommandResultCount?: number;
    };
    canonicalVerification?: {
      receiptCount?: number;
      totalGates?: number;
      passed?: number;
      failed?: number;
      gatedSkip?: number;
      liveE2bGated?: boolean;
    };
    remediation?: unknown[];
  };
}) {
  const qualityIssueCount = input.summary.qualityIssues?.length ?? 0;
  const sandboxSessionCount = input.summary.sandbox?.sessionCount ?? 0;
  const sandboxPreflightFailureCount = input.summary.sandbox?.preflightFailureCount ?? 0;
  const selfImprovementCandidateCount = input.summary.selfImprovement?.candidateCount ?? 0;
  const appliedCount = input.summary.selfImprovement?.appliedCount ?? 0;
  const appliedWithReceiptCount = input.summary.selfImprovement?.appliedWithVerificationReceiptCount ?? 0;
  const appliedMissingReceiptCount = input.summary.selfImprovement?.appliedMissingVerificationReceiptCount ?? 0;
  const receiptCommandResultCount = input.summary.selfImprovement?.appliedReceiptCommandResultCount ?? 0;
  const canonicalReceiptCount = input.summary.canonicalVerification?.receiptCount ?? 0;
  const canonicalPassed = input.summary.canonicalVerification?.passed ?? 0;
  const canonicalTotal = input.summary.canonicalVerification?.totalGates ?? 0;
  const canonicalFailed = input.summary.canonicalVerification?.failed ?? 0;
  const canonicalGated = input.summary.canonicalVerification?.gatedSkip ?? 0;
  const liveE2bGated = input.summary.canonicalVerification?.liveE2bGated === true;
  const remediationCount = input.summary.remediation?.length ?? 0;

  return [
    `Trace diagnostics completed for ${input.targetKind} ${input.targetId}: ${input.summary.runCount} run(s), ${input.summary.eventCount} event(s), ${qualityIssueCount} quality issue(s).`,
    `Sandbox: ${sandboxSessionCount} session(s), ${sandboxPreflightFailureCount} preflight failure(s).`,
    `Self-improvement: ${selfImprovementCandidateCount} candidate(s), applied receipt coverage ${appliedWithReceiptCount}/${appliedCount}, ${appliedMissingReceiptCount} missing receipt(s), ${receiptCommandResultCount} command result(s).`,
    `Canonical verification: ${canonicalReceiptCount} receipt(s), ${canonicalPassed}/${canonicalTotal} passed, ${canonicalFailed} failed, ${canonicalGated} gated, liveE2B gated=${liveE2bGated}.`,
    `Remediation: ${remediationCount} structured item(s).`,
  ].join(" ");
}

async function executeArtifactCreateAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  observations?: Observation[];
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<GenericToolExecutionResult> {
  const tool = await getToolByName("artifact.create");
  if (!tool || !tool.enabled) {
    throw new Error("artifact.create tool is not enabled");
  }

  const spec = extractArtifactSpec(input.action.input);
  const selectedObservations = selectSourceObservations(input.observations ?? [], spec.sourceObservationIds);
  const content =
    spec.content ??
    (spec.type === "html"
      ? buildHtmlArtifact({ ...spec, observations: selectedObservations })
      : buildMarkdownArtifact({ ...spec, observations: selectedObservations }));

  const toolCall = await createToolCall({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    toolId: tool.id,
    traceSpanId: input.traceSpanId,
    status: "running",
    inputSummary: `${spec.type}:${spec.title}`,
  });
  await input.onToolCallCreated?.(toolCall.id);

  try {
    logServer("info", "tool.artifact.create.start", {
      runId: input.runId,
      toolCallId: toolCall.id,
      artifactType: spec.type,
      title: spec.title,
      sourceObservationIds: selectedObservations.map((observation) => observation.id),
    });

    const artifact = await createTextArtifact({
      conversationId: input.conversationId,
      runId: input.runId,
      producerAgentSessionId: input.agentSessionId,
      type: spec.type,
      title: spec.title,
      content,
      sourceTraceId: input.traceSpanId,
      metadata: {
        sourceObservationIds: selectedObservations.map((observation) => observation.id),
        instructions: spec.instructions,
        createdByToolCallId: toolCall.id,
      },
    });

    const outputSummary = `${artifact.deduped ? "Reused existing" : "Created"} ${spec.type} artifact "${artifact.title}" (${artifact.id}).`;
    await updateToolCall({
      id: toolCall.id,
      status: "completed",
      outputSummary,
      outputPayloadUri: artifact.storageUri,
    });
    logServer("info", "tool.artifact.create.completed", {
      runId: input.runId,
      toolCallId: toolCall.id,
      artifactId: artifact.id,
      deduped: artifact.deduped,
    });

    return {
      toolCallId: toolCall.id,
      toolName: input.action.toolName,
      outputSummary,
      executionMode: "real",
      evidenceLevel: "real",
      payloadUri: artifact.storageUri,
      artifacts: [artifact],
      claims: [
        {
          claim: outputSummary,
          support: "direct",
          sourceRefs: [{ payloadPath: artifact.storageUri }],
        },
      ],
    };
  } catch (error) {
    await updateToolCall({
      id: toolCall.id,
      status: "failed",
      error: {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : "Unknown artifact create error",
      },
    });
    throw error;
  }
}

async function executeFileReadAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<GenericToolExecutionResult> {
  const tool = await getToolByName("file.read");
  if (!tool || !tool.enabled) {
    throw new Error("file.read tool is not enabled");
  }

  const targetPath = extractReadableFilePath(input.action.input);
  const toolCall = await createToolCall({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    toolId: tool.id,
    traceSpanId: input.traceSpanId,
    status: "running",
    inputSummary: targetPath,
  });
  await input.onToolCallCreated?.(toolCall.id);

  try {
    const content = await fs.readFile(/* turbopackIgnore: true */ targetPath, "utf8");
    const maxChars = boundedInteger(input.action.input.max_chars ?? input.action.input.maxChars, 100, 200_000) ?? 24_000;
    const excerpt = content.slice(0, maxChars);
    const payloadUri = localUri("traces", defaults.projectId, input.runId, `${toolCall.id}.json`);
    await atomicWriteText(
      resolveLocalUri(payloadUri),
      JSON.stringify({ path: targetPath, sizeBytes: Buffer.byteLength(content), excerpt, truncated: content.length > excerpt.length }, null, 2),
    );
    const outputSummary = `Read file ${path.basename(targetPath)} (${Buffer.byteLength(content)} bytes${content.length > excerpt.length ? ", truncated" : ""}).`;
    await updateToolCall({ id: toolCall.id, status: "completed", outputSummary, outputPayloadUri: payloadUri });
    return {
      toolCallId: toolCall.id,
      toolName: input.action.toolName,
      outputSummary,
      executionMode: "real",
      evidenceLevel: "real",
      payloadUri,
      claims: [
        {
          claim: outputSummary,
          support: "direct",
          sourceRefs: [{ payloadPath: payloadUri }],
        },
      ],
    };
  } catch (error) {
    await updateToolCall({
      id: toolCall.id,
      status: "failed",
      error: {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : "Unknown file read error",
      },
    });
    throw error;
  }
}

async function executeApprovalRequestAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
}): Promise<GenericToolExecutionResult> {
  const tool = await getToolByName("approval.request");
  if (!tool || !tool.enabled) {
    throw new Error("approval.request tool is not enabled");
  }
  const summary = stringValue(input.action.input.summary ?? input.action.input.request_summary) || input.action.reason || "Approval requested.";
  const riskLevel = enumValue(input.action.input.risk_level ?? input.action.input.riskLevel, ["low", "medium", "high"] as const) ?? "medium";
  const toolCall = await createToolCall({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    toolId: tool.id,
    traceSpanId: input.traceSpanId,
    status: "running",
    inputSummary: summary.slice(0, 240),
  });
  await input.onToolCallCreated?.(toolCall.id);

  const db = await getDb();
  const approvalId = `appr_${cryptoRandomId()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO approvals
     (id, tenant_id, project_id, run_id, agent_session_id, tool_call_id, status, risk_level, request_summary, request_payload_uri, decision_by_user_id, decision_comment, expires_at, resolved_at, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    approvalId,
    defaults.tenantId,
    defaults.projectId,
    input.runId,
    input.agentSessionId,
    toolCall.id,
    "pending",
    riskLevel,
    summary,
    null,
    null,
    null,
    null,
    null,
    JSON.stringify({ action: input.action }),
    now,
    now,
  );

  const outputSummary = `Approval requested (${approvalId}) and is pending user decision.`;
  await updateToolCall({ id: toolCall.id, status: "completed", outputSummary });
  return {
    toolCallId: toolCall.id,
    toolName: input.action.toolName,
    outputSummary,
    executionMode: "real",
    evidenceLevel: "user_provided",
    observationStatus: "blocked",
    claims: [
      {
        claim: outputSummary,
        support: "direct",
        sourceRefs: [{ payloadPath: `approval:${approvalId}` }],
      },
    ],
  };
}

async function resolveTraceQueryTarget(input: Record<string, unknown>) {
  const conversationId = stringValue(input.conversation_id ?? input.conversationId ?? input.id);
  if (conversationId) {
    return { kind: "conversation_id", id: conversationId, conversationId };
  }

  const runId = stringValue(input.run_id ?? input.runId);
  if (runId) {
    const db = await getDb();
    const row = db.prepare(`SELECT conversation_id FROM runs WHERE id = ?`).get(runId) as { conversation_id?: string } | undefined;
    return { kind: "run_id", id: runId, conversationId: row?.conversation_id ?? "" };
  }

  const traceId = stringValue(input.trace_id ?? input.traceId);
  if (traceId) {
    const db = await getDb();
    const row = db
      .prepare(
        `SELECT r.conversation_id
         FROM trace_spans ts
         JOIN runs r ON r.id = ts.run_id
         WHERE ts.trace_id = ?
         ORDER BY ts.started_at ASC
         LIMIT 1`,
      )
      .get(traceId) as { conversation_id?: string } | undefined;
    return { kind: "trace_id", id: traceId, conversationId: row?.conversation_id ?? "" };
  }

  return { kind: "unknown", id: "", conversationId: "" };
}

function mockTavilySources(query: string): TavilySource[] {
  return [
    {
      title: "DataSwarm Architecture",
      url: "local://docs/ARCHITECTURE.md",
      content: `Mock source for "${query}": DataSwarm uses an Orchestrator, typed run events, Trace, Skill and Tool registries, and sandbox-ready Swarm execution.`,
    },
    {
      title: "DataSwarm Event Protocol",
      url: "local://docs/EVENT_PROTOCOL.md",
      content:
        "Mock source: DataSwarm persists run events before streaming them over SSE, enabling replay and reliable UI state reconstruction.",
    },
    {
      title: "DataSwarm MVP Tasks",
      url: "local://docs/MVP_TASKS.md",
      content:
        "Mock source: M2 focuses on ToolRegistry, Tavily, Skill discovery, Markdown/HTML artifacts, and tool/skill/artifact trace spans.",
    },
  ];
}

function mockWebSearchSources(query: string): TavilySource[] {
  return [
    {
      title: "Mock Web Search Provider Result",
      url: "local://providers/mock.search/result-1",
      content: `Mock web_search provider result for "${query}". This source proves web.search can route through a provider other than Tavily while preserving the same Observation contract.`,
    },
    {
      title: "Mock Provider Capability Contract",
      url: "local://providers/mock.search/capability-contract",
      content:
        "Mock web_search provider source: logical tool names, provider tool names, provider ids, sources, and claims are persisted independently.",
    },
    {
      title: "Mock Provider Fallback Notes",
      url: "local://providers/mock.search/fallback-notes",
      content:
        "Mock web_search provider source: this provider is intended for offline verification, provider fallback tests, and deterministic smoke coverage.",
    },
  ];
}

async function tavilyRestSearch(
  query: string,
  options: {
    maxResults?: number;
    searchDepth?: "basic" | "advanced";
    topic?: "general" | "news";
    includeAnswer?: boolean;
    includeRawContent?: boolean;
    includeDomains?: string[];
    excludeDomains?: string[];
  },
): Promise<TavilySource[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return mockTavilySources(query);
  }

  logServer("info", "tool.tavily.rest.request", {
    endpoint: "https://api.tavily.com/search",
    queryLength: query.length,
  });
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: options.maxResults ?? 5,
      search_depth: options.searchDepth ?? "basic",
      topic: options.topic,
      include_answer: options.includeAnswer,
      include_raw_content: options.includeRawContent,
      include_domains: options.includeDomains,
      exclude_domains: options.excludeDomains,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logServer("error", "tool.tavily.rest.failed", {
      status: response.status,
      statusText: response.statusText,
      bodyPreview: body.slice(0, 500),
    });
    throw new Error(`Tavily request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  const sources = (payload.results ?? []).map((result) => ({
    title: result.title ?? "Untitled source",
    url: result.url ?? "",
    content: result.content ?? "",
  }));
  logServer("info", "tool.tavily.rest.ok", {
    sourceCount: sources.length,
    sourceUrls: sources.map((source) => source.url).slice(0, 5),
  });
  return sources;
}

function boundedInteger(value: unknown, min: number, max: number) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

type ArtifactSpec = {
  type: "markdown" | "html";
  title: string;
  instructions: string;
  sourceObservationIds: string[];
  content?: string;
};

function extractArtifactSpec(input: Record<string, unknown>): ArtifactSpec {
  const rawType = stringValue(input.artifact_type ?? input.artifactType ?? input.type ?? input.format);
  const type = rawType === "html" ? "html" : "markdown";
  const title = stringValue(input.title ?? input.name) || (type === "html" ? "DataSwarm Analysis Report HTML" : "DataSwarm Analysis Report");
  const instructions = stringValue(input.instructions ?? input.objective ?? input.prompt) || "Create a concise, evidence-grounded DataSwarm artifact.";
  const sourceObservationIds = stringArray(input.source_observation_ids ?? input.sourceObservationIds ?? input.observation_ids ?? input.observationIds) ?? [];
  const content = stringValue(input.content ?? input.markdown ?? input.html);
  return {
    type,
    title: title.slice(0, 120),
    instructions,
    sourceObservationIds,
    content: content || undefined,
  };
}

function selectSourceObservations(observations: Observation[], sourceObservationIds: string[]) {
  if (sourceObservationIds.length === 0) {
    return observations.filter((observation) => observation.status === "completed");
  }
  const wanted = new Set(sourceObservationIds);
  return observations.filter((observation) => wanted.has(observation.id));
}

function buildMarkdownArtifact(input: ArtifactSpec & { observations: Observation[] }) {
  const sources = extractSources(input.observations);
  return [
    `# ${input.title}`,
    "",
    "## Objective",
    "",
    input.instructions,
    "",
    "## Evidence Summary",
    "",
    ...(input.observations.length > 0
      ? input.observations.map(
          (observation, index) =>
            `${index + 1}. **${observation.sourceName}** (${observation.id}, ${observation.evidenceLevel}): ${observation.summary}`,
        )
      : ["No completed source observations were available when this artifact was created."]),
    "",
    "## Source Details",
    "",
    ...(sources.length > 0
      ? sources.map((source, index) => `${index + 1}. [${source.title}](${source.url}) - ${source.content}`)
      : ["No external URL sources were attached to the selected observations."]),
    "",
    "## Provenance",
    "",
    `- Source observations: ${input.observations.map((observation) => observation.id).join(", ") || "none"}.`,
    "- Generated by the artifact.create adapter, not embedded directly in the assistant message.",
  ].join("\n");
}

function buildHtmlArtifact(input: ArtifactSpec & { observations: Observation[] }) {
  const markdown = buildMarkdownArtifact(input);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root { color-scheme: light; --ink:#17212b; --muted:#627084; --line:#d9e2ee; --soft:#f6f8fb; --brand:#087568; --brand-soft:#e5f4f1; }
      * { box-sizing: border-box; }
      body { margin:0; background:#f7f9fc; color:var(--ink); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height:1.62; }
      main { width:min(1040px, 100%); margin:0 auto; padding:36px 24px 52px; }
      header { padding-bottom:18px; border-bottom:1px solid var(--line); margin-bottom:22px; }
      .eyebrow { color:var(--brand); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
      h1 { margin:8px 0 10px; font-size:clamp(26px, 4vw, 40px); line-height:1.15; color:#0d3f39; }
      h2 { margin:28px 0 12px; font-size:20px; color:#10202e; }
      p, li { font-size:15px; }
      section { background:white; border:1px solid var(--line); border-radius:10px; padding:18px; margin-top:16px; overflow-wrap:anywhere; }
      table { width:100%; border-collapse:collapse; margin:14px 0; font-size:14px; }
      th, td { border:1px solid var(--line); padding:8px 10px; vertical-align:top; }
      th { background:var(--soft); text-align:left; }
      code { background:var(--soft); border:1px solid var(--line); border-radius:6px; padding:1px 5px; }
      a { color:var(--brand); text-underline-offset:3px; }
      .meta { display:flex; flex-wrap:wrap; gap:8px; color:var(--muted); font-size:13px; }
      .pill { border:1px solid var(--line); border-radius:999px; background:white; padding:4px 10px; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="eyebrow">DataSwarm Artifact</div>
        <h1>${escapeHtml(input.title)}</h1>
        <div class="meta">
          <span class="pill">Generated by artifact.create</span>
          <span class="pill">Observations: ${input.observations.length}</span>
        </div>
      </header>
      <section>${markdownToHtml(markdown)}</section>
    </main>
  </body>
</html>`;
}

function extractSources(observations: Observation[]) {
  return observations.flatMap((observation) => {
    const sources = observation.metadata?.sources;
    if (!Array.isArray(sources)) {
      return [];
    }
    return sources
      .map((source) => {
        if (!isRecord(source)) {
          return null;
        }
        const title = stringValue(source.title) || "Untitled source";
        const url = stringValue(source.url);
        const content = stringValue(source.content);
        return url ? { title, url, content } : null;
      })
      .filter((source): source is TavilySource => Boolean(source));
  });
}

function extractReadableFilePath(input: Record<string, unknown>) {
  const rawPath = stringValue(input.path ?? input.file_path ?? input.filePath ?? input.uri);
  if (!rawPath) {
    throw new Error("file.read requires input.path");
  }
  if (/^local:\/\//.test(rawPath)) {
    return resolveLocalUri(rawPath);
  }
  const workspaceRoot = path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.env.DATASWARM_WORKSPACE_ROOT ?? ".",
  );
  const target = path.resolve(workspaceRoot, rawPath);
  const relative = path.relative(workspaceRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`file.read path is outside workspace root: ${rawPath}`);
  }
  return target;
}

function cryptoRandomId() {
  return randomUUID().replaceAll("-", "").slice(0, 24);
}

function markdownToHtml(markdown: string) {
  const lines = markdown.split("\n");
  const html: string[] = [];
  let listOpen = false;
  let paragraph: string[] = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      html.push(`<p>${inlineMarkdownToHtml(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  }

  function closeList() {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length, 3);
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inlineMarkdownToHtml(bullet[1])}</li>`);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  closeList();
  return html.join("\n");
}

function inlineMarkdownToHtml(value: string) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.map(String).map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
