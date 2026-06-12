import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

function readProjectFile(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function expect(name, passed, detail) {
  results.push({ name, passed, detail });
}

const agenticTypes = readProjectFile("apps/web/src/server/runtime/agentic-types.ts");
const planner = readProjectFile("apps/web/src/server/runtime/planner.ts");
const modelProvider = readProjectFile("apps/web/src/server/models/provider.ts");
const orchestrator = readProjectFile("apps/web/src/server/runtime/orchestrator.ts");
const swarm = readProjectFile("apps/web/src/server/runtime/swarm.ts");
const canonicalPlan = readProjectFile("DATASWARM_CANONICAL_PLAN.md");
const implementationStatus = readProjectFile("IMPLEMENTATION_STATUS.md");

expect(
  "AgentAction swarm branches are part of the type contract",
  /export type SwarmActionBranchDefinition/.test(agenticTypes) &&
    /branches\?: SwarmActionBranchDefinition\[\]/.test(agenticTypes) &&
    /export type SpawnSwarmAction/.test(agenticTypes),
  "spawn_agent/spawn_swarm should accept planner-provided branch definitions.",
);

expect(
  "planner prompt asks for task-specific model branches",
  /prefer a branches array with task-specific title, instruction, and modelProfile/.test(planner) &&
    /Avoid generic research\/analysis\/validation branches/.test(planner),
  "Planner prompt must ask the model to define branches instead of relying on runtime templates.",
);

expect(
  "planner normalizes branch aliases",
  /function normalizeSwarmBranches/.test(planner) &&
    /branch_definitions/.test(planner) &&
    /branchDefinitions/.test(planner) &&
    /branch\.instruction/.test(planner) &&
    /branch\.model_profile/.test(planner),
  "Planner should accept common model output aliases for branches.",
);

expect(
  "planner validates branch contract",
  /function validateSwarmBranches/.test(planner) &&
    /branches must include 1-6 branch definitions/.test(planner) &&
    /branch \$\{index \+ 1\} requires instruction/.test(planner),
  "Invalid branch arrays should fail validation before sandbox execution.",
);

expect(
  "mock planner emits model-owned branches for e2e coverage",
  /branches: \[/.test(modelProvider) &&
    /Gather task-specific facts/.test(modelProvider) &&
    /Design verification checks/.test(modelProvider),
  "Mock-mode production e2e should prove the action branch path, not only the fallback template.",
);

expect(
  "orchestrator passes the model action into executeSwarm",
  /executeSwarm\(\{[\s\S]*action,/.test(orchestrator) &&
    /plan_source: swarmResult\.plan\.planSource/.test(orchestrator),
  "Swarm executor needs the original AgentAction and must persist its plan source.",
);

expect(
  "swarm builds plans from action branches before fallback",
  /buildSwarmPlan\(objective: string, action\?: SpawnAgentAction \| SpawnSwarmAction\): SwarmPlan/.test(swarm) &&
    /planSource: "model_branches"/.test(swarm) &&
    /"model_single_agent"/.test(swarm) &&
    /planSource: "model_roles"/.test(swarm) &&
    /planSource: "runtime_fallback"/.test(swarm),
  "Runtime should prefer model branches, then model roles, and only then fallback.",
);

expect(
  "swarm events expose branch instructions and plan source",
  /plan_source: plan\.planSource/.test(swarm) &&
    /instruction: branch\.instruction/.test(swarm) &&
    /requested_branch_count/.test(swarm) &&
    /plan_source: plan\.planSource/.test(swarm),
  "Run Trace should show whether a branch plan came from the model and what each branch was asked to do.",
);

expect(
  "branch ids remain stable for existing research/analysis/validation titles",
  /replace\(\/\\bbranch\\b\/g, ""\)/.test(swarm) &&
    /return `branch_\$\{base \|\| index \+ 1\}`/.test(swarm),
  "Research Branch should still normalize to branch_research for compatibility.",
);

expect(
  "canonical docs track model-provided branch plans",
  /planner-provided branch definitions/i.test(canonicalPlan) &&
    /Swarm action plan smoke passed/i.test(implementationStatus),
  "Docs/status should record this verification gate.",
);

const failed = results.filter((result) => !result.passed);
for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
}
if (failed.length > 0) {
  process.exitCode = 1;
  console.error(`Swarm action plan smoke failed: ${failed.length}/${results.length} checks failed.`);
} else {
  console.log(`Swarm action plan smoke passed: ${results.length}/${results.length} checks passed.`);
}
