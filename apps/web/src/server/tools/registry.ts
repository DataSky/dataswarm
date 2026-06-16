import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getToolByName, createToolCall, updateToolCall } from "../repositories/tools";
import { createBinaryArtifact, createTextArtifact } from "../repositories/artifacts";
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
    toolCallMetadata?: Record<string, unknown>;
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
  "run_python": {
    toolName: "run_python",
    execute: executeRunPythonAction,
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
  toolCallMetadata?: Record<string, unknown>;
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
  toolCallMetadata?: Record<string, unknown>;
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
  toolCallMetadata?: Record<string, unknown>;
}): Promise<GenericToolExecutionResult> {
  return executeSearchViaProvider(input);
}

function explicitMockToolsEnabled() {
  return process.env.DATASWARM_MOCK_TOOLS === "1" || process.env.DATASWARM_ALLOW_EXPLICIT_MOCK === "1";
}

const webSearchProviders: Record<WebSearchProviderName, WebSearchProvider> = {
  tavily: {
    name: "tavily",
    providerToolName: "tavily.search",
    async search({ query, options }) {
      const sources = await tavilyRestSearch(query, options);
      return { sources, executionMode: "real" };
    },
  },
  mock: {
    name: "mock",
    providerToolName: "mock.search",
    async search({ query }) {
      if (!explicitMockToolsEnabled()) {
        throw new Error("mock web.search provider requires DATASWARM_MOCK_TOOLS=1 or DATASWARM_ALLOW_EXPLICIT_MOCK=1");
      }
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
  toolCallMetadata?: Record<string, unknown>;
}, forcedProviderName?: WebSearchProviderName): Promise<GenericToolExecutionResult> {
  const searchInput = extractWebSearchInput(input.action.input);
  const providerName = forcedProviderName ?? searchInput.providerName ?? defaultWebSearchProviderName();
  if (providerName === "mock" && !explicitMockToolsEnabled()) {
    throw new Error("web.search provider=mock requires explicit mock mode; use DATASWARM_MOCK_TOOLS=1 only for mock verification.");
  }
  const provider = webSearchProviders[providerName];
  const result = await executeWebSearch({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    traceSpanId: input.traceSpanId,
    toolName: input.action.toolName,
    provider,
    ...searchInput,
    onToolCallCreated: input.onToolCallCreated,
    toolCallMetadata: input.toolCallMetadata,
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
  toolCallMetadata?: Record<string, unknown>;
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
  toolCallMetadata?: Record<string, unknown>;
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
    metadata: input.toolCallMetadata,
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
  const configured = webSearchProviderName(process.env.DATASWARM_WEB_SEARCH_PROVIDER);
  if (configured) {
    return configured;
  }
  if (explicitMockToolsEnabled()) {
    return "mock";
  }
  return "tavily";
}

type TraceQueryContext = { conversationId?: string; runId?: string; traceSpanId?: string };

async function executeTraceQueryAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
  toolCallMetadata?: Record<string, unknown>;
}): Promise<GenericToolExecutionResult> {
  const tool = await getToolByName("trace.query");
  if (!tool || !tool.enabled) {
    throw new Error("trace.query tool is not enabled");
  }

  const resolvedTarget = await resolveTraceQueryTarget(input.action.input, {
    conversationId: input.conversationId,
    runId: input.runId,
    traceSpanId: input.traceSpanId,
  });
  if (!resolvedTarget.conversationId) {
    throw new Error("trace.query requires input.conversation_id, input.run_id, or input.trace_id");
  }
  const requestedConversationId = stringValue(input.action.input.conversation_id ?? input.action.input.conversationId ?? input.action.input.id);
  const requestedRunId = stringValue(input.action.input.run_id ?? input.action.input.runId);
  const requestedTraceId = stringValue(input.action.input.trace_id ?? input.action.input.traceId);

  const toolCall = await createToolCall({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    toolId: tool.id,
    traceSpanId: input.traceSpanId,
    status: "running",
    inputSummary: `${resolvedTarget.kind}=${resolvedTarget.id}`,
    metadata: {
      ...(input.toolCallMetadata ?? {}),
      trace_query: {
        requestedConversationId: requestedConversationId ?? "",
        requestedRunId: requestedRunId ?? "",
        requestedTraceId: requestedTraceId ?? "",
        resolvedKind: resolvedTarget.kind,
        resolvedId: resolvedTarget.id,
        resolvedConversationId: resolvedTarget.conversationId,
        usedActiveConversationFallback:
          !requestedConversationId ||
          ["current", "this", "active", "current_conversation"].includes(requestedConversationId.trim().toLowerCase()),
      },
    },
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
  toolCallMetadata?: Record<string, unknown>;
}): Promise<GenericToolExecutionResult> {
  const tool = await getToolByName("artifact.create");
  if (!tool || !tool.enabled) {
    throw new Error("artifact.create tool is not enabled");
  }

  const spec = extractArtifactSpec(input.action.input);
  const selectedObservations = selectSourceObservations(input.observations ?? [], spec.sourceObservationIds);
  const resolvedSourceObservationIds = Array.from(
    new Set([
      ...selectedObservations.map((observation) => observation.id),
      ...spec.sourceObservationIds,
    ].filter(Boolean)),
  );
  const content =
    spec.content ??
    (spec.type === "html"
      ? buildHtmlArtifact({ ...spec, observations: selectedObservations })
      : buildMarkdownArtifact({ ...spec, observations: selectedObservations }));
  const substance = classifyTextArtifactSubstance({
    type: spec.type,
    title: spec.title,
    instructions: spec.instructions,
    content,
    sourceObservationIds: resolvedSourceObservationIds,
  });

  const toolCall = await createToolCall({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    toolId: tool.id,
    traceSpanId: input.traceSpanId,
    status: "running",
    inputSummary: `${spec.type}:${spec.title}`,
    metadata: input.toolCallMetadata,
  });
  await input.onToolCallCreated?.(toolCall.id);

  try {
    const provenanceMetadata = artifactProvenanceMetadata(input.toolCallMetadata, {
      toolCallId: toolCall.id,
      toolName: input.action.toolName,
      agentSessionId: input.agentSessionId,
    });
    const storageArtifactType = spec.type === "image_metadata" ? "json" : spec.type;
    logServer("info", "tool.artifact.create.start", {
      runId: input.runId,
      toolCallId: toolCall.id,
      artifactType: spec.type,
      title: spec.title,
      sourceObservationIds: resolvedSourceObservationIds,
    });

    const artifact = await createTextArtifact({
      conversationId: input.conversationId,
      runId: input.runId,
      producerAgentSessionId: input.agentSessionId,
      type: storageArtifactType,
      title: spec.title,
      content,
      sourceTraceId: input.traceSpanId,
      metadata: {
        ...provenanceMetadata,
        artifactKind: substance.artifactKind,
        sourceObservationIds: resolvedSourceObservationIds,
        resolvedParentObservationIds: selectedObservations.map((observation) => observation.id),
        instructions: spec.instructions,
        createdByToolCallId: toolCall.id,
        qualitySignals: substance.qualitySignals,
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
      artifactKind: substance.artifactKind,
      substanceStatus: substance.qualitySignals.substanceStatus,
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

async function executeRunPythonAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
  toolCallMetadata?: Record<string, unknown>;
}): Promise<GenericToolExecutionResult> {
  const tool = await getToolByName("run_python");
  if (!tool || !tool.enabled) {
    throw new Error("run_python tool is not enabled");
  }

  const spec = extractRunPythonImageSpec(input.action.input);
  const toolCall = await createToolCall({
    runId: input.runId,
    agentSessionId: input.agentSessionId,
    toolId: tool.id,
    traceSpanId: input.traceSpanId,
    status: "running",
    inputSummary: spec.mimeType + ":" + spec.title,
    metadata: input.toolCallMetadata,
  });
  await input.onToolCallCreated?.(toolCall.id);

  try {
    const sourceObservationIds = stringArray(input.action.input.source_observation_ids ?? input.action.input.sourceObservationIds ?? input.action.input.observation_ids ?? input.action.input.observationIds) ?? [];
    const provenanceMetadata = artifactProvenanceMetadata(input.toolCallMetadata, {
      toolCallId: toolCall.id,
      toolName: input.action.toolName,
      agentSessionId: input.agentSessionId,
    });
    logServer("info", "tool.run_python.start", { runId: input.runId, toolCallId: toolCall.id, title: spec.title, mimeType: spec.mimeType });
    const artifact = await createBinaryArtifact({
      conversationId: input.conversationId,
      runId: input.runId,
      producerAgentSessionId: input.agentSessionId,
      type: "image",
      title: spec.title,
      content: spec.content,
      mimeType: spec.mimeType,
      extension: spec.extension,
      sourceTraceId: input.traceSpanId,
      metadata: {
        ...provenanceMetadata,
        purpose: spec.purpose,
        generatedBy: "run_python",
        runPythonInputMode: spec.inputMode,
        artifactKind: "generated_image",
        sourceObservationIds,
        createdByToolCallId: toolCall.id,
        qualitySignals: {
          substanceStatus: "substantive",
          deliverableEligible: true,
          countsAsImageArtifact: true,
          runPythonInputMode: spec.inputMode,
          provenanceComplete: sourceObservationIds.length > 0 || Boolean(provenanceMetadata.branchId),
        },
      },
    });
    const outputSummary = (artifact.deduped ? "Reused existing" : "Created") + " image artifact \"" + artifact.title + "\" (" + artifact.id + ") via run_python.";
    await updateToolCall({ id: toolCall.id, status: "completed", outputSummary, outputPayloadUri: artifact.storageUri });
    logServer("info", "tool.run_python.completed", { runId: input.runId, toolCallId: toolCall.id, artifactId: artifact.id, deduped: artifact.deduped });
    return {
      toolCallId: toolCall.id,
      toolName: input.action.toolName,
      outputSummary,
      executionMode: "real",
      evidenceLevel: "real",
      payloadUri: artifact.storageUri,
      artifacts: [artifact],
      claims: [{ claim: outputSummary, support: "direct", sourceRefs: [{ payloadPath: artifact.storageUri }] }],
    };
  } catch (error) {
    await updateToolCall({
      id: toolCall.id,
      status: "failed",
      error: { code: "tool_execution_failed", message: error instanceof Error ? error.message : "Unknown run_python error" },
    });
    throw error;
  }
}

function artifactProvenanceMetadata(
  metadata: Record<string, unknown> | undefined,
  input: { toolCallId: string; toolName: string; agentSessionId: string },
) {
  const branchId = stringValue(metadata?.branch_id ?? metadata?.branchId) ?? "";
  const sandboxSessionId = stringValue(metadata?.sandbox_session_id ?? metadata?.sandboxSessionId) ?? "";
  const sandboxActionId = stringValue(metadata?.sandbox_action_id ?? metadata?.sandboxActionId) ?? "";
  const capabilityName = stringValue(metadata?.capability_name ?? metadata?.capabilityName ?? metadata?.tool_name ?? metadata?.toolName) ?? input.toolName;
  const branchIds = branchId ? [branchId] : [];
  return {
    branchId,
    branchIds,
    sandboxSessionId,
    latestSandboxSessionId: sandboxSessionId,
    sandboxActionId,
    producerActionId: sandboxActionId,
    latestSandboxActionId: sandboxActionId,
    toolCallId: input.toolCallId,
    createdByToolCallId: input.toolCallId,
    producerToolCallId: input.toolCallId,
    capabilityName,
    capabilityPlaneVersion: "dataswarm.capability-plane.v4",
    producer: {
      kind: "tool",
      toolName: input.toolName,
      capabilityName,
      toolCallId: input.toolCallId,
      agentSessionId: input.agentSessionId,
      branchId,
      sandboxSessionId,
      sandboxActionId,
    },
  };
}

type RunPythonImageSpec = {
  title: string;
  purpose: string;
  content: Buffer;
  mimeType: "image/png" | "image/svg+xml" | "image/jpeg";
  extension: "png" | "svg" | "jpg" | "jpeg";
  inputMode: "svg" | "base64" | "chart_spec" | "code_summary" | "placeholder";
};

function extractRunPythonImageSpec(input: Record<string, unknown>): RunPythonImageSpec {
  const title = stringValue(input.title) ?? stringValue(input.name) ?? "DataSwarm run_python image artifact";
  const purpose = stringValue(input.purpose) ?? stringValue(input.reason) ?? "Sandbox-requested image artifact";
  const svg = stringValue(input.svg);
  if (svg) {
    return { title, purpose, content: Buffer.from(svg, "utf8"), mimeType: "image/svg+xml", extension: "svg", inputMode: "svg" };
  }
  const contentBase64 = stringValue(input.content_base64 ?? input.contentBase64);
  const mimeType = runPythonMimeType(input.mime_type ?? input.mimeType);
  if (contentBase64) {
    return { title, purpose, content: Buffer.from(contentBase64, "base64"), mimeType, extension: extensionForMimeType(mimeType), inputMode: "base64" };
  }
  const chartSeries = runPythonChartSeries(input);
  const code = stringValue(input.code ?? input.python ?? input.script);
  const chartType = stringValue(input.chart_type ?? input.chartType ?? input.kind) ?? "bar";
  const generatedSvg = buildRunPythonEvidenceSvg(title, purpose, {
    chartType,
    labels: chartSeries.labels,
    values: chartSeries.values,
    code,
  });
  return {
    title,
    purpose,
    content: Buffer.from(generatedSvg, "utf8"),
    mimeType: "image/svg+xml",
    extension: "svg",
    inputMode: chartSeries.values.length > 0 ? "chart_spec" : code ? "code_summary" : "placeholder",
  };
}

function runPythonChartSeries(input: Record<string, unknown>) {
  const explicitLabels = stringArray(input.labels) ?? [];
  const explicitValues = numberArray(input.values);
  if (explicitValues.length > 0) {
    return {
      labels: explicitValues.map((_, index) => explicitLabels[index] ?? `Item ${index + 1}`),
      values: explicitValues,
    };
  }
  const records = Array.isArray(input.data) ? input.data.filter(isRecord) : [];
  const labels: string[] = [];
  const values: number[] = [];
  for (const [index, record] of records.entries()) {
    const value = Number(record.value ?? record.y ?? record.count ?? record.score ?? record.amount);
    if (!Number.isFinite(value)) {
      continue;
    }
    labels.push(stringValue(record.label ?? record.x ?? record.name ?? record.category) ?? `Item ${index + 1}`);
    values.push(value);
  }
  return { labels, values };
}

function numberArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function runPythonMimeType(value: unknown): "image/png" | "image/svg+xml" | "image/jpeg" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return "image/svg+xml";
}

function extensionForMimeType(mimeType: "image/png" | "image/svg+xml" | "image/jpeg"): "png" | "svg" | "jpg" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  return "svg";
}

function buildRunPythonEvidenceSvg(
  title: string,
  purpose: string,
  options: { chartType?: string; labels?: string[]; values?: number[]; code?: string } = {},
) {
  const safeTitle = escapeHtml(title);
  const safePurpose = escapeHtml(purpose.slice(0, 180));
  const labels = options.labels ?? [];
  const values = options.values ?? [];
  const maxValue = Math.max(...values.map((value) => Math.abs(value)), 1);
  const bars = values.slice(0, 6).map((value, index) => {
    const width = Math.max(24, Math.round((Math.abs(value) / maxValue) * 590));
    const y = 176 + index * 48;
    const color = ["#0f766e", "#2563eb", "#f97316", "#7c3aed", "#db2777", "#0891b2"][index % 6];
    const label = escapeHtml((labels[index] ?? `Item ${index + 1}`).slice(0, 42));
    const valueText = escapeHtml(String(value));
    return `  <text x="92" y="${y - 8}" font-family="Arial, sans-serif" font-size="14" fill="#334155">${label}: ${valueText}</text>\n` +
      `  <rect x="92" y="${y}" width="${width}" height="28" rx="10" fill="${color}" opacity="0.9"/>\n`;
  }).join("");
  const code = options.code ? escapeHtml(options.code.replace(/\s+/g, " ").slice(0, 180)) : "";
  const body = bars || (
    "  <rect x=\"92\" y=\"180\" width=\"590\" height=\"38\" rx=\"12\" fill=\"#0f766e\" opacity=\"0.92\"/>\n" +
    "  <rect x=\"92\" y=\"252\" width=\"486\" height=\"38\" rx=\"12\" fill=\"#2563eb\" opacity=\"0.9\"/>\n" +
    "  <rect x=\"92\" y=\"324\" width=\"342\" height=\"38\" rx=\"12\" fill=\"#f97316\" opacity=\"0.9\"/>\n" +
    "  <rect x=\"92\" y=\"396\" width=\"532\" height=\"38\" rx=\"12\" fill=\"#7c3aed\" opacity=\"0.9\"/>\n"
  );
  const codeLine = code
    ? `  <text x="92" y="456" font-family="Arial, sans-serif" font-size="13" fill="#475569">Code intent: ${code}</text>\n`
    : "";
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"960\" height=\"540\" viewBox=\"0 0 960 540\">\n" +
    "  <rect width=\"960\" height=\"540\" fill=\"#f8fafc\"/>\n" +
    "  <rect x=\"48\" y=\"42\" width=\"864\" height=\"456\" rx=\"28\" fill=\"#ffffff\" stroke=\"#dbe4ee\"/>\n" +
    "  <text x=\"92\" y=\"94\" font-family=\"Arial, sans-serif\" font-size=\"30\" font-weight=\"700\" fill=\"#0f172a\">" + safeTitle + "</text>\n" +
    "  <text x=\"92\" y=\"128\" font-family=\"Arial, sans-serif\" font-size=\"16\" fill=\"#64748b\">" + safePurpose + "</text>\n" +
    "  <text x=\"92\" y=\"154\" font-family=\"Arial, sans-serif\" font-size=\"13\" fill=\"#94a3b8\">Input mode: " + escapeHtml(options.chartType ?? "bar") + "</text>\n" +
    body +
    codeLine +
    "  <text x=\"92\" y=\"470\" font-family=\"Arial, sans-serif\" font-size=\"15\" fill=\"#64748b\">Generated by DataSwarm parent run_python capability.</text>\n" +
    "</svg>";
}

async function executeFileReadAction(input: {
  runId: string;
  agentSessionId: string;
  traceSpanId: string;
  conversationId: string;
  action: CallToolAction;
  onToolCallCreated?: (toolCallId: string) => Promise<void>;
  toolCallMetadata?: Record<string, unknown>;
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
    metadata: input.toolCallMetadata,
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

async function resolveTraceQueryTarget(input: Record<string, unknown>, context: TraceQueryContext = {}) {
  const normalizeCurrentId = (value: string | undefined, fallback: string | undefined) => {
    if (!value) return fallback;
    const normalized = value.trim().toLowerCase();
    return ["current", "this", "active", "current_conversation", "current-run", "current_run"].includes(normalized)
      ? fallback
      : value;
  };
  const conversationId = normalizeCurrentId(stringValue(input.conversation_id ?? input.conversationId ?? input.id), context.conversationId);
  if (conversationId) {
    return { kind: "conversation_id", id: conversationId, conversationId };
  }

  const runId = normalizeCurrentId(stringValue(input.run_id ?? input.runId), context.runId);
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
    throw new Error("TAVILY_API_KEY is required for real web.search/tavily.search; mock sources are only available through explicit provider=mock with DATASWARM_MOCK_TOOLS=1.");
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
  type: "markdown" | "html" | "json" | "image_metadata";
  title: string;
  instructions: string;
  sourceObservationIds: string[];
  content?: string;
};

function extractArtifactSpec(input: Record<string, unknown>): ArtifactSpec {
  const rawType = stringValue(input.artifact_type ?? input.artifactType ?? input.type ?? input.format);
  const type = normalizeArtifactCreateType(rawType);
  const title =
    stringValue(input.title ?? input.name) ||
    (type === "html"
      ? "DataSwarm Analysis Report HTML"
      : type === "json"
        ? "DataSwarm Structured Evidence JSON"
        : type === "image_metadata"
          ? "DataSwarm Image Evidence Metadata"
          : "DataSwarm Analysis Report");
  const instructions = stringValue(input.instructions ?? input.objective ?? input.prompt) || "Create a concise, evidence-grounded DataSwarm artifact.";
  const sourceObservationIds = stringArray(input.source_observation_ids ?? input.sourceObservationIds ?? input.observation_ids ?? input.observationIds) ?? [];
  const content = artifactCreateContent(input, type);
  return {
    type,
    title: title.slice(0, 120),
    instructions,
    sourceObservationIds,
    content: content || undefined,
  };
}

function normalizeArtifactCreateType(rawType: string | undefined): ArtifactSpec["type"] {
  const normalized = (rawType ?? "").trim().toLowerCase();
  if (normalized === "html" || normalized === "text/html") return "html";
  if (normalized === "json" || normalized === "application/json" || normalized === "structured_json") return "json";
  if (normalized === "image_metadata" || normalized === "image.metadata" || normalized === "image-meta" || normalized === "image/json") return "image_metadata";
  return "markdown";
}

function artifactCreateContent(input: Record<string, unknown>, type: ArtifactSpec["type"]) {
  if (type === "json" || type === "image_metadata") {
    const direct =
      type === "image_metadata"
        ? input.image_metadata ?? input.imageMetadata ?? input.metadata ?? input.json ?? input.data ?? input.object ?? input.content
        : input.json ?? input.data ?? input.object ?? input.content;
    if (typeof direct === "string") {
      try {
        return JSON.stringify(JSON.parse(direct), null, 2);
      } catch {
        return type === "image_metadata"
          ? JSON.stringify({ kind: "image_metadata", description: direct }, null, 2)
          : direct;
      }
    }
    if (direct && typeof direct === "object") {
      return JSON.stringify(type === "image_metadata" ? { kind: "image_metadata", ...direct } : direct, null, 2);
    }
    if (type === "image_metadata") {
      return JSON.stringify(
        {
          kind: "image_metadata",
          title: stringValue(input.title ?? input.name) ?? "DataSwarm Image Evidence Metadata",
          imageArtifactIds: stringArray(input.image_artifact_ids ?? input.imageArtifactIds ?? input.artifactIds ?? input.artifacts) ?? [],
          previewUri: stringValue(input.preview_uri ?? input.previewUri) ?? "",
          mimeType: stringValue(input.mime_type ?? input.mimeType) ?? "",
          description: stringValue(input.description ?? input.instructions ?? input.objective ?? input.prompt) ?? "",
        },
        null,
        2,
      );
    }
  }
  return stringValue(input.content ?? input.markdown ?? input.html ?? input.json);
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

function classifyTextArtifactSubstance(input: {
  type: "markdown" | "html" | "json" | "image_metadata";
  title: string;
  instructions: string;
  content: string;
  sourceObservationIds: string[];
}) {
  const plainText = stripMarkup(input.content);
  const sectionCount = countSections(input.content, input.type);
  const characterCount = plainText.length;
  const evidenceCitationCount = countEvidenceCitations(input.content, input.sourceObservationIds);
  const runtimeSummaryLike = isRuntimeSummaryLike(input.content);
  const requestedFinalReport = /html|report|报告|analysis|分析|brief|方案|deliverable|落地|可行性|executive|summary/i.test(
    `${input.title}\n${input.instructions}`,
  );
  if (input.type === "json" || input.type === "image_metadata") {
    const validJson = isValidJson(input.content);
    return {
      artifactKind: input.type === "image_metadata" ? "image_metadata" : "structured_json",
      qualitySignals: {
        substanceStatus: validJson && characterCount >= 120 ? "substantive" : "thin",
        deliverableEligible: validJson && characterCount >= 120,
        countsAsImageArtifact: false,
        runtimeSummaryLike,
        validJson,
        sectionCount,
        characterCount,
        evidenceCitationCount,
        sourceObservationCount: input.sourceObservationIds.length,
        minimumCharacterThreshold: 120,
        minimumSectionThreshold: 0,
      },
    };
  }
  const artifactKind = runtimeSummaryLike
    ? "branch_runtime_summary"
    : input.type === "html"
      ? requestedFinalReport
        ? "final_html_report"
        : "html_document"
      : requestedFinalReport
        ? "branch_final_report"
        : "markdown_document";
  const hasMinimumSubstance =
    !runtimeSummaryLike &&
    characterCount >= (input.type === "html" ? 900 : 700) &&
    sectionCount >= 3 &&
    (input.sourceObservationIds.length === 0 || evidenceCitationCount > 0);
  return {
    artifactKind,
    qualitySignals: {
      substanceStatus: hasMinimumSubstance ? "substantive" : runtimeSummaryLike ? "runtime_summary" : "thin",
      deliverableEligible: hasMinimumSubstance,
      runtimeSummaryLike,
      sectionCount,
      characterCount,
      evidenceCitationCount,
      sourceObservationCount: input.sourceObservationIds.length,
      minimumCharacterThreshold: input.type === "html" ? 900 : 700,
      minimumSectionThreshold: 3,
    },
  };
}

function isValidJson(content: string) {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function stripMarkup(content: string) {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`>\-\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countSections(content: string, type: "markdown" | "html") {
  if (type === "html") {
    const headingMatches = content.match(/<h[1-6]\b/gi) ?? [];
    const sectionMatches = content.match(/<section\b/gi) ?? [];
    return Math.max(headingMatches.length, sectionMatches.length);
  }
  return (content.match(/^#{1,4}\s+/gm) ?? []).length;
}

function countEvidenceCitations(content: string, sourceObservationIds: string[]) {
  const explicitIds = sourceObservationIds.filter((id) => content.includes(id)).length;
  const genericObservationRefs = (content.match(/\b(obs|sbo|observation)[-_a-z0-9]*\b/gi) ?? []).length;
  return explicitIds + genericObservationRefs;
}

function isRuntimeSummaryLike(content: string) {
  const normalized = content.toLowerCase();
  const runtimeMarkers = [
    "actions emitted",
    "sandbox runtime loop",
    "model / deterministic synthesis",
    "runtime summary",
    "observations created",
    "limitations",
    "agent loop summary",
  ].filter((marker) => normalized.includes(marker)).length;
  const businessMarkers = [
    "market",
    "risk",
    "architecture",
    "financial",
    "recommendation",
    "竞争",
    "市场",
    "风险",
    "架构",
    "财务",
    "建议",
    "落地",
  ].filter((marker) => normalized.includes(marker)).length;
  return runtimeMarkers >= 3 && businessMarkers <= 1;
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
