export type ToolCapabilityKind =
  | "web_search"
  | "web_extract"
  | "file_read"
  | "file_write"
  | "code_execution"
  | "data_query"
  | "data_profile"
  | "visualization"
  | "artifact_create"
  | "trace_query"
  | "approval"
  | "sandbox"
  | "custom";

export type ToolCapability = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  provider: string;
  adapterStatus: "implemented" | "planned" | "disabled";
  capabilityKind: ToolCapabilityKind;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  authStatus: "available" | "missing_credentials" | "not_configured";
  freshness: "realtime" | "near_realtime" | "static" | "local";
  costHint?: "free" | "low" | "medium" | "high";
  latencyHintMs?: number;
  evidenceKind:
    | "external_source"
    | "local_file"
    | "computed_result"
    | "artifact"
    | "trace"
    | "user_approval"
    | "sandbox_result";
  enabled: boolean;
};

export type ThinkAction = {
  type: "think";
  summary: string;
  next?: string;
};

export type UseSkillAction = {
  type: "use_skill";
  skillName: string;
  objective: string;
  reason: string;
};

export type CallToolAction = {
  type: "call_tool";
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  expectedEvidence: string[];
  fallbackToolNames?: string[];
};

export type SwarmActionBranchDefinition = {
  id?: string;
  title: string;
  instruction: string;
  modelProfile?: string;
};

export type SpawnAgentAction = {
  type: "spawn_agent";
  agentRole: string;
  objective: string;
  contextRefs: string[];
  modelProfile?: string;
  sandboxRequired: boolean;
  branches?: SwarmActionBranchDefinition[];
};

export type SpawnSwarmAction = {
  type: "spawn_swarm";
  objective: string;
  strategy?: "parallel_branch_then_merge";
  branchCount?: number;
  branchRoles?: string[];
  branches?: SwarmActionBranchDefinition[];
  contextRefs: string[];
  sandboxRequired: boolean;
};

export type CreateArtifactAction = {
  type: "create_artifact";
  artifactType: "markdown" | "html" | "json" | "csv" | "image";
  title: string;
  sourceObservationIds: string[];
  instructions: string;
};

export type AskUserAction = {
  type: "ask_user";
  question: string;
  reason: string;
  requiredToProceed: boolean;
};

export type FinalAnswerAction = {
  type: "final_answer";
  content: string;
  evidenceObservationIds: string[];
  limitations: string[];
  recommendedNextQuestions: string[];
};

export type AgentAction =
  | ThinkAction
  | UseSkillAction
  | CallToolAction
  | SpawnAgentAction
  | SpawnSwarmAction
  | CreateArtifactAction
  | AskUserAction
  | FinalAnswerAction;

export type PlannerOutput = {
  action: AgentAction;
  confidence: number;
  assumptions: string[];
  policyNotes: string[];
};

export type ObservationClaim = {
  claim: string;
  support: "direct" | "indirect" | "weak" | "contradicted";
  sourceRefs: Array<{
    title?: string;
    url?: string;
    payloadPath?: string;
  }>;
};

export type Observation = {
  id: string;
  runId: string;
  actionId?: string;
  sourceType: "tool" | "skill" | "agent" | "artifact" | "user" | "system";
  sourceName: string;
  status: "completed" | "failed" | "blocked";
  summary: string;
  payloadUri?: string;
  evidenceLevel: "real" | "mock" | "inferred" | "user_provided";
  claims: ObservationClaim[];
  metadata?: Record<string, unknown>;
  createdAt: string;
};
