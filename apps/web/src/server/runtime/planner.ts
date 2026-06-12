import type { ModelProfile } from "../repositories/model-profiles";
import type { SkillRecord } from "../repositories/skills";
import type { ChatMessage, ModelProvider } from "../models/provider";
import type {
  AgentAction,
  PlannerOutput,
  SwarmActionBranchDefinition,
  ToolCapability,
  Observation,
} from "./agentic-types";

export async function callPlannerModel(input: {
  provider: ModelProvider;
  profile: ModelProfile;
  dateContext: string;
  history: ChatMessage[];
  latestUserMessage: string;
  observations: Observation[];
  toolCapabilities: ToolCapability[];
  availableSkills?: SkillRecord[];
  activeSkills?: SkillRecord[];
  maxOutputTokens?: number;
}): Promise<{ output: PlannerOutput; rawText: string }> {
  const messages = buildPlannerMessages(input);
  let rawText = "";
  for await (const chunk of input.provider.streamChat({
    profile: input.profile,
    purpose: "orchestrator_planner",
    messages,
    maxOutputTokens: input.maxOutputTokens ?? 4096,
  })) {
    if (chunk.type === "text-delta") {
      rawText += chunk.text;
    }
  }

  const parsed = parsePlannerOutput(rawText);
  validatePlannerOutput(parsed, input.toolCapabilities, input.availableSkills ?? []);
  return { output: parsed, rawText };
}

function buildPlannerMessages(input: {
  dateContext: string;
  history: ChatMessage[];
  latestUserMessage: string;
  observations: Observation[];
  toolCapabilities: ToolCapability[];
  availableSkills?: SkillRecord[];
  activeSkills?: SkillRecord[];
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are DataSwarm Orchestrator Planner.",
        "Return only valid JSON. Do not include Markdown, prose, or code fences.",
        "",
        "Required envelope:",
        '{"action": AgentAction, "confidence": number, "assumptions": string[], "policyNotes": string[]}',
        "",
        "Choose exactly one action.",
        "",
        "Allowed AgentAction shapes:",
        '{"type":"use_skill","skillName":"<exact available skill name>","objective":"<what this skill should guide>","reason":"<why this skill is useful now>"}',
        '{"type":"call_tool","toolName":"<exact implemented tool name>","input":{},"reason":"<why this tool now>","expectedEvidence":[],"fallbackToolNames":[]}',
        '{"type":"spawn_agent","agentRole":"<branch or swarm role>","objective":"<subtask or swarm objective>","contextRefs":[],"modelProfile":"deepseek:deepseek-v4-pro|deepseek:deepseek-v4-flash","sandboxRequired":true}',
        '{"type":"spawn_swarm","objective":"<parallel swarm objective>","strategy":"parallel_branch_then_merge","branchCount":3,"branchRoles":["research","analysis","validation"],"contextRefs":[],"sandboxRequired":true}',
        '{"type":"create_artifact","artifactType":"markdown|html|json|csv|image","title":"<artifact title>","sourceObservationIds":[],"instructions":"<what to produce from observations>"}',
        '{"type":"final_answer","content":"<answer text>","evidenceObservationIds":[],"limitations":[],"recommendedNextQuestions":[]}',
        "",
        "Field names are strict: use skillName for use_skill, toolName for call_tool, and content for final_answer.",
        "You may choose final_answer only when available messages and observations are sufficient.",
        "You may choose use_skill when a skill policy/workflow is useful and not already active.",
        "If a low-risk implemented tool is clearly needed, you may choose call_tool directly without first activating a skill.",
        "Do not choose use_skill merely because a matching skill exists; choose it only when the skill changes the next-step policy.",
        "If the task needs fresh external evidence, local file inspection, computation, trace diagnosis, or approval, choose call_tool for the best available tool capability.",
        "If the user explicitly asks for a report, HTML, Markdown, or persisted deliverable after evidence exists, choose create_artifact.",
        "If the task is explicitly multi-agent, swarm, parallel branch, sandbox, or requires independent research/analysis/validation branches, choose spawn_swarm. Use spawn_agent only for a single delegated agent.",
        "For spawn_swarm, prefer a branches array with task-specific title, instruction, and modelProfile for each branch. Avoid generic research/analysis/validation branches unless those roles genuinely match the user goal.",
        "Choose call_tool only for tools with enabled=true and adapterStatus=implemented. Planned tools are visible for roadmap awareness but are not executable.",
        "Active skills are execution guidance and domain policy, not proof that work has happened. Use them to choose the next action, then rely on tool Observations for evidence.",
        "When trace-diagnostics is active for a conversation/run/trace analysis task, prefer trace.query before making claims about runtime behavior.",
        "When web-research is active for fresh/current facts, prefer any implemented web_search capability and use source-diverse queries.",
        "When report-generation is active, create artifacts only after observations provide concrete content; do not embed raw HTML in final_answer.",
        "The runtime may call you multiple times in one run. Treat Existing observations as the current working state, not as final truth.",
        "If Existing observations already include a completed swarm/mock/e2b agent observation for the current objective, do not choose spawn_swarm or spawn_agent again unless the user explicitly asks to rerun, retry, or add new branches. Choose final_answer or create_artifact from those branch observations.",
        "If a web-search observation returned 0 sources or weak/off-topic sources, do not final_answer unless the step budget is exhausted. Choose another call_tool with a broader, alternative, or complementary query.",
        "For source verification, diversify queries across primary domains, GitHub repositories/releases, official docs/news pages, and broad web search. Avoid repeating a query that already returned 0 sources.",
        "For web_search tools, pass useful parameters such as query, max_results, search_depth, topic, include_domains, exclude_domains, include_raw_content, and include_answer when the selected tool supports them.",
        "For current news requests, use topic:'news' when suitable and include query terms that preserve the user's named entity.",
        "For trace or conversation diagnostics, call trace.query with conversation_id, run_id, or trace_id when available.",
        "Never claim a tool result. Tool results arrive only as Observations after the runtime executes your action.",
        "Use tool names exactly as provided in Available tool capabilities. Do not hard-code Tavily if another implemented web_search tool is available.",
        `Current date context: ${input.dateContext}.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Latest user message:\n${input.latestUserMessage}`,
        "",
        `Recent conversation:\n${formatHistory(input.history)}`,
        "",
        `Existing observations:\n${formatObservations(input.observations)}`,
        "",
        `Active skills:\n${formatSkills(input.activeSkills ?? [])}`,
        "",
        `Available skills:\n${formatSkills(input.availableSkills ?? [])}`,
        "",
        `Available tool capabilities:\n${JSON.stringify(input.toolCapabilities, null, 2)}`,
      ].join("\n"),
    },
  ];
}

function formatSkills(skills: SkillRecord[]) {
  if (skills.length === 0) {
    return "(none)";
  }
  return skills
    .map((skill) =>
      [
        `- name: ${skill.name}`,
        `  version: ${skill.version}`,
        `  path: ${skill.path}`,
        skill.description ? `  description: ${skill.description}` : "",
        skill.manifest?.purpose ? `  purpose: ${skill.manifest.purpose}` : "",
        skill.manifest?.activationGuidance?.length
          ? `  activation_guidance: ${skill.manifest.activationGuidance.slice(0, 4).join(" | ")}`
          : "",
        skill.manifest?.requiredTools?.length ? `  required_tools: ${skill.manifest.requiredTools.join(", ")}` : "",
        skill.manifest?.preferredCapabilities?.length
          ? `  preferred_capabilities: ${skill.manifest.preferredCapabilities.join(", ")}`
          : "",
        skill.manifest?.qualityChecks?.length
          ? `  quality_checks: ${skill.manifest.qualityChecks.slice(0, 4).join(" | ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

function formatHistory(history: ChatMessage[]) {
  if (history.length === 0) {
    return "(none)";
  }
  return history.map((message) => `${message.role}: ${message.content}`).join("\n\n").slice(-8000);
}

function formatObservations(observations: Observation[]) {
  if (observations.length === 0) {
    return "(none)";
  }
  return observations
    .map((observation) => {
      const metadata = isRecord(observation.metadata) ? observation.metadata : {};
      const sources = Array.isArray(metadata.sources)
        ? metadata.sources
            .slice(0, 8)
            .map((source) => {
              if (!isRecord(source)) {
                return "";
              }
              return [source.title, source.url].filter(Boolean).join(" - ");
            })
            .filter(Boolean)
        : [];
      const actionInput = isRecord(metadata.action_input) ? JSON.stringify(metadata.action_input) : "";
      return [
        `${observation.id} [${observation.sourceType}:${observation.sourceName}] status=${observation.status} evidence=${observation.evidenceLevel}`,
        `Summary: ${observation.summary}`,
        actionInput ? `Action input: ${actionInput}` : "",
        `Source count: ${sources.length}`,
        sources.length > 0 ? `Sources:\n${sources.map((source, index) => `  ${index + 1}. ${source}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n")
    .slice(-6000);
}

function parsePlannerOutput(rawText: string): PlannerOutput {
  const jsonText = extractJson(rawText);
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Planner did not return a valid action envelope: ${rawText.slice(0, 300)}`);
  }
  const rawAction = extractRawAction(parsed);
  if (!rawAction) {
    throw new Error(`Planner did not return a valid action object: ${rawText.slice(0, 300)}`);
  }
  return {
    action: normalizeAction(rawAction),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String) : [],
    policyNotes: Array.isArray(parsed.policyNotes) ? parsed.policyNotes.map(String) : [],
  };
}

function extractRawAction(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(parsed.action)) {
    return parsed.action;
  }
  if (typeof parsed.action === "string") {
    return { ...parsed, type: parsed.action };
  }
  if (Array.isArray(parsed.actions) && isRecord(parsed.actions[0])) {
    return parsed.actions[0];
  }
  if (isRecord(parsed.next_action)) {
    return parsed.next_action;
  }
  if (isRecord(parsed.nextAction)) {
    return parsed.nextAction;
  }
  if (isRecord(parsed.tool_call)) {
    return { ...parsed.tool_call, type: "call_tool" };
  }
  if (isRecord(parsed.toolCall)) {
    return { ...parsed.toolCall, type: "call_tool" };
  }
  if (
    typeof parsed.type === "string" ||
    typeof parsed.kind === "string" ||
    typeof parsed.action_type === "string" ||
    typeof parsed.actionType === "string" ||
    typeof parsed.content === "string" ||
    typeof parsed.answer === "string" ||
    typeof parsed.response === "string" ||
    typeof parsed.reply === "string" ||
    typeof parsed.message === "string" ||
    typeof parsed.text === "string" ||
    typeof parsed.summary === "string" ||
    typeof parsed.summaryMarkdown === "string" ||
    typeof parsed.markdown === "string" ||
    typeof parsed.final_answer === "string" ||
    typeof parsed.finalAnswer === "string" ||
    typeof parsed.toolName === "string" ||
    typeof parsed.tool_name === "string" ||
    typeof parsed.tool === "string"
  ) {
    return parsed;
  }
  return null;
}

function normalizeAction(rawAction: Record<string, unknown>): AgentAction {
  const type = String(
      rawAction.type ??
      rawAction.kind ??
      rawAction.action_type ??
      rawAction.actionType ??
      (rawAction.toolName || rawAction.tool_name || rawAction.tool
        ? "call_tool"
        : hasSkillActionFields(rawAction)
          ? "use_skill"
        : rawAction.content ||
            rawAction.answer ||
            rawAction.response ||
            rawAction.reply ||
            rawAction.message ||
            rawAction.text ||
            rawAction.summary ||
            rawAction.summaryMarkdown ||
            rawAction.markdown ||
            rawAction.final_answer ||
            rawAction.finalAnswer
          ? "final_answer"
          : ""),
  );
  if (type === "call_tool") {
    const input = isRecord(rawAction.input)
      ? rawAction.input
      : isRecord(rawAction.arguments)
        ? rawAction.arguments
        : isRecord(rawAction.params)
          ? rawAction.params
          : {};
    return {
      type: "call_tool",
      toolName: String(rawAction.toolName ?? rawAction.tool_name ?? rawAction.tool ?? ""),
      input,
      reason: String(rawAction.reason ?? rawAction.rationale ?? ""),
      expectedEvidence: normalizeStringArray(rawAction.expectedEvidence ?? rawAction.expected_evidence),
      fallbackToolNames: normalizeStringArray(rawAction.fallbackToolNames ?? rawAction.fallback_tool_names),
    };
  }
  if (type === "use_skill") {
    return {
      type: "use_skill",
      skillName: extractSkillName(rawAction),
      objective: String(rawAction.objective ?? rawAction.goal ?? rawAction.task ?? rawAction.reason ?? nestedActionValue(rawAction, "objective") ?? ""),
      reason: String(rawAction.reason ?? rawAction.rationale ?? ""),
    };
  }
  if (type === "final_answer") {
    return {
      type: "final_answer",
      content: String(
        rawAction.content ??
          rawAction.answer ??
          rawAction.response ??
          rawAction.reply ??
          rawAction.message ??
          rawAction.text ??
          rawAction.summaryMarkdown ??
          rawAction.markdown ??
          rawAction.summary ??
          rawAction.final_answer ??
          rawAction.finalAnswer ??
          "",
      ),
      evidenceObservationIds: normalizeStringArray(
        rawAction.evidenceObservationIds ?? rawAction.evidence_observation_ids,
      ),
      limitations: normalizeStringArray(rawAction.limitations),
      recommendedNextQuestions: normalizeStringArray(
        rawAction.recommendedNextQuestions ?? rawAction.recommended_next_questions,
      ),
    };
  }
  if (type === "create_artifact") {
    const rawArtifactType = String(rawAction.artifactType ?? rawAction.artifact_type ?? rawAction.type_hint ?? "markdown");
    const artifactType = ["markdown", "html", "json", "csv", "image"].includes(rawArtifactType)
      ? (rawArtifactType as "markdown" | "html" | "json" | "csv" | "image")
      : "markdown";
    return {
      type: "create_artifact",
      artifactType,
      title: String(rawAction.title ?? rawAction.name ?? "DataSwarm Analysis Report"),
      sourceObservationIds: normalizeStringArray(
        rawAction.sourceObservationIds ?? rawAction.source_observation_ids ?? rawAction.observationIds ?? rawAction.observation_ids,
      ),
      instructions: String(rawAction.instructions ?? rawAction.objective ?? rawAction.prompt ?? ""),
    };
  }
  if (type === "spawn_swarm") {
    return {
      type: "spawn_swarm",
      objective: String(rawAction.objective ?? rawAction.goal ?? rawAction.task ?? rawAction.instruction ?? ""),
      strategy:
        rawAction.strategy === "parallel_branch_then_merge" || rawAction.strategy === undefined
          ? "parallel_branch_then_merge"
          : "parallel_branch_then_merge",
      branchCount: typeof rawAction.branchCount === "number" ? rawAction.branchCount : undefined,
      branchRoles: normalizeStringArray(rawAction.branchRoles ?? rawAction.branch_roles),
      branches: normalizeSwarmBranches(rawAction.branches ?? rawAction.branch_definitions ?? rawAction.branchDefinitions),
      contextRefs: normalizeStringArray(rawAction.contextRefs ?? rawAction.context_refs),
      sandboxRequired: typeof rawAction.sandboxRequired === "boolean" ? rawAction.sandboxRequired : true,
    };
  }
  if (type === "spawn_agent") {
    return {
      type: "spawn_agent",
      agentRole: String(rawAction.agentRole ?? rawAction.agent_role ?? rawAction.role ?? "swarm"),
      objective: String(rawAction.objective ?? rawAction.goal ?? rawAction.task ?? rawAction.instruction ?? ""),
      contextRefs: normalizeStringArray(rawAction.contextRefs ?? rawAction.context_refs),
      modelProfile:
        typeof rawAction.modelProfile === "string"
          ? rawAction.modelProfile
          : typeof rawAction.model_profile === "string"
            ? rawAction.model_profile
            : undefined,
      sandboxRequired: typeof rawAction.sandboxRequired === "boolean" ? rawAction.sandboxRequired : true,
      branches: normalizeSwarmBranches(rawAction.branches ?? rawAction.branch_definitions ?? rawAction.branchDefinitions),
    };
  }
  return rawAction as AgentAction;
}

function normalizeSwarmBranches(value: unknown): SwarmActionBranchDefinition[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const branches = value
    .filter(isRecord)
    .map((branch) => {
      const title = String(branch.title ?? branch.name ?? branch.role ?? branch.agentRole ?? branch.agent_role ?? "").trim();
      const instruction = String(
        branch.instruction ?? branch.instructions ?? branch.objective ?? branch.goal ?? branch.task ?? branch.prompt ?? "",
      ).trim();
      const modelProfile =
        typeof branch.modelProfile === "string"
          ? branch.modelProfile
          : typeof branch.model_profile === "string"
            ? branch.model_profile
            : undefined;
      const rawId = branch.id ?? branch.branch_id;
      const id = typeof rawId === "string" ? rawId.trim() : undefined;
      return { id, title, instruction, modelProfile };
    })
    .filter((branch) => branch.title.length > 0 || branch.instruction.length > 0)
    .slice(0, 6);

  if (branches.length === 0) {
    return undefined;
  }
  return branches.map((branch, index) => ({
    ...branch,
    title: branch.title || `Branch ${index + 1}`,
    instruction: branch.instruction || branch.title,
  }));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(String).filter((item) => item.length > 0);
}

function hasSkillActionFields(rawAction: Record<string, unknown>) {
  return Boolean(extractSkillName(rawAction));
}

function extractSkillName(rawAction: Record<string, unknown>) {
  const direct =
    rawAction.skillName ??
    rawAction.skill_name ??
    rawAction.skillId ??
    rawAction.skill_id ??
    rawAction.targetSkill ??
    rawAction.target_skill ??
    rawAction.target ??
    rawAction.name;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  for (const key of ["skill", "input", "arguments", "params"]) {
    const value = rawAction[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (isRecord(value)) {
      const nested =
        value.skillName ??
        value.skill_name ??
        value.skillId ??
        value.skill_id ??
        value.name ??
        value.id ??
        value.value;
      if (typeof nested === "string" && nested.trim()) {
        return nested.trim();
      }
      if (isRecord(value.skill)) {
        const nestedSkill = value.skill.name ?? value.skill.id;
        if (typeof nestedSkill === "string" && nestedSkill.trim()) {
          return nestedSkill.trim();
        }
      }
    }
  }
  return "";
}

function nestedActionValue(rawAction: Record<string, unknown>, field: string) {
  for (const key of ["input", "arguments", "params"]) {
    const value = rawAction[key];
    if (isRecord(value) && typeof value[field] === "string") {
      return value[field];
    }
  }
  return "";
}

function extractJson(rawText: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(rawText);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return rawText.slice(start, end + 1);
  }
  return rawText.trim();
}

function validatePlannerOutput(output: PlannerOutput, tools: ToolCapability[], skills: SkillRecord[]) {
  const action = output.action;
  if (!isRecord(action) || typeof action.type !== "string") {
    throw new Error(`Planner action is missing a type: ${JSON.stringify(action).slice(0, 500)}`);
  }
  if (action.type === "call_tool") {
    if (typeof action.toolName !== "string" || !action.toolName) {
      throw new Error("call_tool action requires toolName.");
    }
    const selectedTool = tools.find((tool) => tool.name === action.toolName);
    if (!selectedTool?.enabled) {
      throw new Error(`Planner selected unavailable tool: ${action.toolName}`);
    }
    if (selectedTool.adapterStatus !== "implemented") {
      throw new Error(`Planner selected unimplemented tool adapter: ${action.toolName}`);
    }
    if (!isRecord(action.input)) {
      throw new Error("call_tool action requires object input.");
    }
  }
  if (action.type === "use_skill") {
    if (typeof action.skillName !== "string" || !action.skillName) {
      throw new Error(`use_skill action requires skillName. Received: ${JSON.stringify(action).slice(0, 500)}`);
    }
    if (!skills.some((skill) => skill.name === action.skillName)) {
      throw new Error(`Planner selected unavailable skill: ${action.skillName}`);
    }
  }
  if (action.type === "final_answer") {
    if (typeof action.content !== "string") {
      throw new Error("final_answer action requires content.");
    }
  }
  if (action.type === "create_artifact") {
    if (!["markdown", "html"].includes(action.artifactType)) {
      throw new Error(`create_artifact currently supports markdown or html artifacts. Received: ${action.artifactType}`);
    }
    const artifactTool = tools.find((tool) => tool.name === "artifact.create");
    if (!artifactTool?.enabled || artifactTool.adapterStatus !== "implemented") {
      throw new Error("create_artifact requires implemented artifact.create tool.");
    }
    if (typeof action.title !== "string" || !action.title.trim()) {
      throw new Error("create_artifact action requires title.");
    }
    if (!Array.isArray(action.sourceObservationIds)) {
      throw new Error("create_artifact action requires sourceObservationIds array.");
    }
  }
  if (action.type === "spawn_agent") {
    if (typeof action.objective !== "string" || !action.objective.trim()) {
      throw new Error("spawn_agent action requires objective.");
    }
    if (typeof action.agentRole !== "string" || !action.agentRole.trim()) {
      throw new Error("spawn_agent action requires agentRole.");
    }
    validateSwarmBranches(action.branches, "spawn_agent");
  }
  if (action.type === "spawn_swarm") {
    if (typeof action.objective !== "string" || !action.objective.trim()) {
      throw new Error("spawn_swarm action requires objective.");
    }
    if (!Array.isArray(action.contextRefs)) {
      throw new Error("spawn_swarm action requires contextRefs array.");
    }
    validateSwarmBranches(action.branches, "spawn_swarm");
  }
}

function validateSwarmBranches(branches: SwarmActionBranchDefinition[] | undefined, actionType: "spawn_agent" | "spawn_swarm") {
  if (branches === undefined) {
    return;
  }
  if (!Array.isArray(branches)) {
    throw new Error(`${actionType} branches must be an array when provided.`);
  }
  if (branches.length === 0 || branches.length > 6) {
    throw new Error(`${actionType} branches must include 1-6 branch definitions when provided.`);
  }
  for (const [index, branch] of branches.entries()) {
    if (!branch.title.trim()) {
      throw new Error(`${actionType} branch ${index + 1} requires title.`);
    }
    if (!branch.instruction.trim()) {
      throw new Error(`${actionType} branch ${index + 1} requires instruction.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
