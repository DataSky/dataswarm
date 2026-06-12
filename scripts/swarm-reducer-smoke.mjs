import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const reducer = read("apps/web/src/server/runtime/swarm-reducer.ts");
const verifier = read("apps/web/src/server/runtime/swarm-verifier.ts");
const swarm = read("apps/web/src/server/runtime/swarm.ts");
const runTracePage = read("apps/web/src/app/runs/[id]/page.tsx");
const conversationUi = read("apps/web/src/app/ui/conversation-workspace.tsx");
const eventProtocol = read("EVENT_PROTOCOL.md");
const canonicalPlan = read("DATASWARM_CANONICAL_PLAN.md");
const executionPlan = read("AGENTIC_LOOP_V2_EXECUTION_PLAN.md");
const implementationStatus = read("IMPLEMENTATION_STATUS.md");

expect(
  "swarm reducer is an independent runtime module",
  /export function buildSwarmReduction/.test(reducer) &&
    /export type SwarmReductionResult/.test(reducer) &&
    /reducerMode: "deterministic_runtime"/.test(reducer),
  "Reducer logic should be reusable by diagnostics and future model-assisted reduction.",
);

expect(
  "reducer reuses verifier conflict scanner",
  /import \{ detectContradictionSignals \} from "\.\/swarm-verifier"/.test(reducer) &&
    /conflictSignals = detectContradictionSignals/.test(reducer) &&
    /export type ContradictionSignal/.test(verifier),
  "Reduce and verify should share contradiction/source-mismatch signal semantics.",
);

expect(
  "swarm publishes a reduce stage before merge",
  /type: "swarm\.reduce"/.test(swarm) &&
    /spanKind: "swarm\.reduce"/.test(swarm) &&
    /parentSpanId: reduceSpan\.id/.test(swarm) &&
    /reduction_summary: reduction\.summary/.test(swarm),
  "Runtime should emit swarm.reduce and attach merge below the reduce span.",
);

expect(
  "merge and final observation use reducer output",
  /const mergeSummary = `\$\{reduction\.summary\}/.test(swarm) &&
    /Swarm reduction \(\$\{reduction\.status\}\)/.test(swarm) &&
    /reduction,/.test(swarm),
  "Reducer output should influence merge/final observations instead of being a detached card.",
);

expect(
  "Run Trace renders reduce events",
  /event\.type === "swarm\.reduce"/.test(runTracePage) &&
    /label="Reduce \/ Merge"/.test(runTracePage) &&
    /Panel title="Reduce \/ Merge"/.test(runTracePage),
  "Trace UI should place reduce and merge in a dedicated panel.",
);

expect(
  "conversation stream listens for swarm reduce lifecycle",
  /"swarm\.reduce"/.test(conversationUi) &&
    /"swarm\.merge"/.test(conversationUi) &&
    /"swarm\.verify"/.test(conversationUi) &&
    /title: event\.type/.test(conversationUi),
  "Conversation stream should render swarm process cards from events.",
);

expect(
  "event protocol documents swarm.reduce",
  /`swarm\.reduce`/.test(eventProtocol) &&
    /reducer_mode/.test(eventProtocol) &&
    /conflict_signals/.test(eventProtocol),
  "Event protocol should include reducer payload fields.",
);

expect(
  "canonical plan tracks reducer stage",
  /swarm-reducer-smoke/.test(canonicalPlan) &&
    /`swarm\.reduce`/.test(canonicalPlan),
  "Canonical gates should include reducer smoke and lifecycle wording.",
);

expect(
  "execution plan records reducer progress",
  /\[x\] Extract deterministic Swarm reducer into an independent, evented stage/.test(executionPlan),
  "Execution plan should reflect the reducer slice as implemented.",
);

expect(
  "implementation status records reducer smoke",
  /Swarm reducer smoke passed/i.test(implementationStatus),
  "Status snapshot should record reducer verification evidence.",
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
    console.error(`\nSwarm reducer smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSwarm reducer smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
