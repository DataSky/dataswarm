import type { ModelProfile } from "../repositories/model-profiles";
import { errorPayload, logServer } from "../observability/logger";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelStreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number };

export type ModelProvider = {
  streamChat(input: {
    profile: ModelProfile;
    messages: ChatMessage[];
    purpose: string;
    maxOutputTokens?: number;
  }): AsyncGenerator<ModelStreamChunk>;
};

export class ModelProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function createModelProvider(): ModelProvider {
  if (process.env.DATASWARM_MOCK_MODEL === "1") {
    logServer("warn", "model.provider.mock.enabled", { reason: "DATASWARM_MOCK_MODEL=1" });
    return new MockModelProvider();
  }
  logServer("info", "model.provider.real.enabled", { provider: "openai-compatible" });
  return new OpenAiCompatibleProvider();
}

class MockModelProvider implements ModelProvider {
  async *streamChat(input: {
    profile: ModelProfile;
    messages: ChatMessage[];
    purpose: string;
    maxOutputTokens?: number;
  }): AsyncGenerator<ModelStreamChunk> {
    if (input.purpose === "orchestrator_planner") {
      const latestUser = [...input.messages].reverse().find((message) => message.role === "user");
      const content = latestUser?.content ?? "";
      const latestTask = extractLatestPlannerUserMessage(content);
      const hasSwarmObservation = /\[agent:swarm\.(?:mock|e2b)\]\s+status=completed/i.test(content);
      const hasSkillObservation = /\[skill:[^\]]+\]\s+status=completed/i.test(content);
      const shouldSwarm = /\bswarm\b|蜂群|并行|多分支|多个沙箱|沙箱.*分支|多agent|multi-agent|multi agents/i.test(latestTask);
      const shouldUseSkill =
        !hasSkillObservation &&
        /skill smoke|use_skill smoke|trace-diagnostics skill|使用.*skill|启用.*skill|选择.*skill/i.test(latestTask);
      const shouldSearch = /搜索|联网|查询|新闻|来源|最新|recent|latest|前几部|表现|口碑|评分|播放量|进展/i.test(latestTask);
      const action = hasSwarmObservation
        ? {
            action: {
              type: "final_answer",
              content: buildMockSwarmFinalAnswer(content),
              evidenceObservationIds: extractMockObservationIds(content, "agent:swarm").slice(0, 6),
              limitations: [],
              recommendedNextQuestions: [],
            },
            confidence: 0.78,
            assumptions: [],
            policyNotes: ["Mock planner finalized after observing a completed swarm result to prevent duplicate branch spawning."],
          }
        : shouldUseSkill
        ? {
            action: {
              type: "use_skill",
              skillName: pickMockSkillName(latestTask),
              objective: buildMockSearchQuery(latestTask) || "Verify planner-selected skill observation lifecycle.",
              reason: "Mock planner selected a skill because the request explicitly asks to exercise skill selection.",
            },
            confidence: 0.81,
            assumptions: [],
            policyNotes: ["Mock planner selected use_skill for deterministic local skill observation verification."],
          }
        : shouldSwarm
        ? {
            action: {
              type: "spawn_swarm",
              objective: buildMockSearchQuery(latestTask) || "Run a deterministic mock swarm task.",
              strategy: "parallel_branch_then_merge",
              branchCount: 3,
              branchRoles: ["research", "analysis", "validation"],
              branches: [
                {
                  title: "Research Branch",
                  instruction: `Gather task-specific facts, inputs, and evidence for: ${latestTask}`,
                  modelProfile: "deepseek:deepseek-v4-pro",
                },
                {
                  title: "Analysis Branch",
                  instruction: `Analyze trade-offs, risks, and implementation implications for: ${latestTask}`,
                  modelProfile: "deepseek:deepseek-v4-flash",
                },
                {
                  title: "Validation Branch",
                  instruction: `Design verification checks, acceptance criteria, and failure signals for: ${latestTask}`,
                  modelProfile: "deepseek:deepseek-v4-pro",
                },
              ],
              contextRefs: [],
              sandboxRequired: true,
            },
            confidence: 0.86,
            assumptions: [],
            policyNotes: ["Mock planner selected spawn_swarm for deterministic local swarm verification."],
          }
        : shouldSearch
        ? {
            action: {
              type: "call_tool",
              toolName: "web.search",
              input: { query: buildMockSearchQuery(latestTask) },
              reason: "Mock planner selected a web_search tool because the request needs external evidence.",
              expectedEvidence: ["external sources"],
            },
            confidence: 0.82,
            assumptions: [],
            policyNotes: [],
          }
        : {
            action: {
              type: "final_answer",
              content: "这是一个不需要工具调用的直接回复。",
              evidenceObservationIds: [],
              limitations: [],
              recommendedNextQuestions: [],
            },
            confidence: 0.74,
            assumptions: [],
            policyNotes: [],
          };
      yield { type: "text-delta", text: JSON.stringify(action) };
      yield {
        type: "usage",
        inputTokens: input.messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0),
        outputTokens: Math.ceil(JSON.stringify(action).length / 4),
      };
      return;
    }

    if (input.purpose === "swarm_model_review") {
      const review = {
        summary: "Mock model-assisted swarm review completed without adding new facts.",
        confidence: 0.72,
        findings: [],
        recommendations: ["Keep deterministic reducer and verifier results as the evidence contract."],
        requiredFollowUp: false,
      };
      yield { type: "text-delta", text: JSON.stringify(review) };
      yield {
        type: "usage",
        inputTokens: input.messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0),
        outputTokens: Math.ceil(JSON.stringify(review).length / 4),
      };
      return;
    }

    const latestUser = [...input.messages].reverse().find((message) => message.role === "user");
    const text = [
      `DataSwarm Orchestrator completed the request with ${input.profile.model}.`,
      latestUser?.content
        ? `Request: ${latestUser.content}`
        : "Request: empty task.",
      "Trace, events, artifacts, and evaluation records were persisted for replay.",
    ].join("\n\n");

    const chunks = chunkText(text, 28);
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield { type: "text-delta", text: chunk };
    }
    yield {
      type: "usage",
      inputTokens: input.messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0),
      outputTokens: Math.ceil(text.length / 4),
    };
  }
}

function extractLatestPlannerUserMessage(content: string) {
  const match = content.match(/Latest user message:\n([\s\S]*?)(?:\n\nRecent conversation:|$)/);
  return (match?.[1] ?? content).trim();
}

function buildMockSwarmFinalAnswer(content: string) {
  const observationIds = extractMockObservationIds(content, "agent:swarm");
  const evidenceLine =
    observationIds.length > 0
      ? `\n\nEvidence observations: ${observationIds.slice(0, 6).join(", ")}.`
      : "";
  return `Swarm branch execution completed. I synthesized the available branch observations instead of spawning another swarm cycle.${evidenceLine}`;
}

function pickMockSkillName(content: string) {
  const lower = extractLatestUserText(content).toLowerCase();
  if (lower.includes("web-research") || lower.includes("web research")) {
    return "web-research";
  }
  if (lower.includes("report-generation") || lower.includes("report generation")) {
    return "report-generation";
  }
  if (lower.includes("data-profiling") || lower.includes("data profiling")) {
    return "data-profiling";
  }
  return "trace-diagnostics";
}

function extractLatestUserText(content: string) {
  return /Latest user message:\s*([\s\S]*?)(?:\n\n|$)/.exec(content)?.[1] ?? content;
}

function extractMockObservationIds(content: string, sourcePrefix?: string) {
  const ids: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const match = /^(obs_[a-zA-Z0-9]+)/.exec(line.trim());
    if (!match) {
      continue;
    }
    if (sourcePrefix && !line.includes(`[${sourcePrefix}`)) {
      continue;
    }
    if (!ids.includes(match[1])) {
      ids.push(match[1]);
    }
  }
  return ids;
}

function buildMockSearchQuery(content: string) {
  const latestUser = extractLatestUserText(content);
  const inheritedTopic = /Recent conversation:\s*([\s\S]*?)Available tool capabilities:/i.exec(content)?.[1] ?? "";
  return `${inheritedTopic} ${latestUser}`
    .replace(/搜索互联网|联网|查询|相关的信息|相关信息|Latest user message:|Recent conversation:/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function chunkText(text: string, size: number) {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [text];
}

class OpenAiCompatibleProvider implements ModelProvider {
  async *streamChat(input: {
    profile: ModelProfile;
    messages: ChatMessage[];
    purpose: string;
    maxOutputTokens?: number;
  }): AsyncGenerator<ModelStreamChunk> {
    const apiKeyEnv = input.profile.apiKeyEnv ?? "DMX_API_KEY";
    const baseUrlEnv = input.profile.baseUrlEnv ?? "DMX_BASE_URL";
    const apiKey = process.env[apiKeyEnv];
    const baseUrl = process.env[baseUrlEnv] ?? "https://www.dmxapi.cn/v1";
    const maxOutputTokens = input.maxOutputTokens ?? defaultMaxOutputTokens(input.purpose);

    if (!apiKey) {
      logServer("error", "model.provider.auth_missing", {
        modelProfile: input.profile.id,
        model: input.profile.model,
        apiKeyEnv,
        baseUrlEnv,
      });
      throw new ModelProviderError(
        `${apiKeyEnv} is not configured. Set DATASWARM_MOCK_MODEL=1 for local mock streaming or provide the key.`,
        "provider_auth_missing",
        false,
      );
    }

    logServer("info", "model.provider.request.start", {
      modelProfile: input.profile.id,
      provider: input.profile.provider,
      model: input.profile.model,
      baseUrl,
      messageCount: input.messages.length,
      purpose: input.purpose,
      stream: true,
      maxOutputTokens,
    });

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.profile.model,
        messages: input.messages,
        stream: true,
        max_tokens: maxOutputTokens,
      }),
    });

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      logServer("error", "model.provider.request.failed", {
        modelProfile: input.profile.id,
        model: input.profile.model,
        status: response.status,
        statusText: response.statusText,
        bodyPreview: body.slice(0, 500),
      });
      throw new ModelProviderError(
        `Provider request failed with HTTP ${response.status}`,
        response.status === 429 ? "provider_rate_limit" : "provider_http_error",
        response.status >= 500 || response.status === 429,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice("data:".length).trim();
          if (data === "[DONE]") {
            return;
          }
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const text = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
            if (text) {
              logServer("debug", "model.provider.delta", {
                modelProfile: input.profile.id,
                model: input.profile.model,
                deltaLength: text.length,
              });
              yield { type: "text-delta", text };
            }
            if (parsed.usage) {
              logServer("info", "model.provider.usage", {
                modelProfile: input.profile.id,
                model: input.profile.model,
                inputTokens: parsed.usage.prompt_tokens,
                outputTokens: parsed.usage.completion_tokens,
              });
              yield {
                type: "usage",
                inputTokens: parsed.usage.prompt_tokens,
                outputTokens: parsed.usage.completion_tokens,
              };
            }
          } catch (error) {
            logServer("debug", "model.provider.chunk_parse_ignored", errorPayload(error));
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function defaultMaxOutputTokens(purpose: string) {
  if (purpose === "orchestrator_response") {
    return Number(process.env.DATASWARM_ORCHESTRATOR_MAX_TOKENS ?? 8192);
  }
  return Number(process.env.DATASWARM_MODEL_MAX_TOKENS ?? 4096);
}
