import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const reviewer = read("apps/web/src/server/runtime/swarm-reviewer.ts");
const swarm = read("apps/web/src/server/runtime/swarm.ts");
const orchestrator = read("apps/web/src/server/runtime/orchestrator.ts");
const modelProvider = read("apps/web/src/server/models/provider.ts");
const runTracePage = read("apps/web/src/app/runs/[id]/page.tsx");
const conversationUi = read("apps/web/src/app/ui/conversation-workspace.tsx");
const eventProtocol = read("EVENT_PROTOCOL.md");
const schema = read("SCHEMA.md");
const architecture = read("ARCHITECTURE.md");
const status = read("IMPLEMENTATION_STATUS.md");
const executionPlan = read("AGENTIC_LOOP_V2_EXECUTION_PLAN.md");

expect(
  "reviewer is an independent optional stage",
  /export async function reviewSwarmResult/.test(reviewer) &&
    /DATASWARM_SWARM_REVIEW_MODE/.test(reviewer) &&
    /"disabled" \| "mock" \| "model"/.test(reviewer),
  "Reviewer should be explicitly disabled/mock/model rather than an always-on hidden helper.",
);

expect(
  "reviewer can use model provider without inventing facts",
  /purpose: "swarm_model_review"/.test(reviewer) &&
    /Do not add new facts/.test(reviewer) &&
    /Return strict JSON only/.test(reviewer),
  "Model-assisted review should be a structured critique of reducer/verifier output.",
);

expect(
  "mock model provider supports swarm_model_review JSON",
  /input\.purpose === "swarm_model_review"/.test(modelProvider) &&
    /Mock model-assisted swarm review/.test(modelProvider),
  "Mock model provider should make model review tests deterministic.",
);

expect(
  "swarm emits review span and event after verify",
  /spanKind: "swarm\.review"/.test(swarm) &&
    /type: "swarm\.review"/.test(swarm) &&
    /parentSpanId: verifySpan\.id/.test(swarm) &&
    /review_mode: review\.reviewMode/.test(swarm),
  "Swarm review should be a persisted lifecycle event, not a hidden local variable.",
);

expect(
  "orchestrator passes parent model provider into swarm review",
  /reviewer: \{\s*provider,\s*profile: modelProfile,\s*\}/s.test(orchestrator) &&
    /review: swarmResult\.review/.test(orchestrator),
  "Swarm model review should reuse the Orchestrator model boundary when explicitly enabled.",
);

expect(
  "conversation UI listens for swarm.review",
  /"swarm\.review"/.test(conversationUi) &&
    /"review mode", payload\.review_mode/.test(conversationUi),
  "Conversation runtime cards should render review state from events.",
);

expect(
  "Run Trace renders dedicated review panel",
  /reviews: Array/.test(runTracePage) &&
    /event\.type === "swarm\.review"/.test(runTracePage) &&
    /Panel title="Review"/.test(runTracePage) &&
    /title="swarm\.review"/.test(runTracePage),
  "Run Trace should expose reviewer output separately from reduce/merge/verify.",
);

expect(
  "protocol and schema document swarm.review",
  /`swarm\.review`/.test(eventProtocol) &&
    /review_mode/.test(eventProtocol) &&
    /DATASWARM_SWARM_REVIEW_MODE/.test(eventProtocol) &&
    /`swarm\.review`/.test(schema),
  "Public contracts should describe review modes and span kind.",
);

expect(
  "architecture records review as optional above deterministic contracts",
  /swarm\.review optional/.test(architecture) &&
    /without replacing deterministic reducer\/verifier contracts/.test(architecture),
  "Architecture should prevent review from becoming a fake replacement for deterministic checks.",
);

expect(
  "status and execution plan track review implementation",
  /Swarm review smoke passed/.test(status) &&
    /\[x\] Add optional model-assisted reducer\/verifier review/.test(executionPlan),
  "Status docs should record review verification evidence.",
);

finish();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function expect(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nSwarm review smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSwarm review smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
