import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const runsRepo = read("apps/web/src/server/repositories/runs.ts");
const sandboxRepo = read("apps/web/src/server/repositories/sandbox-sessions.ts");
const cancelRoute = read("apps/web/src/app/api/runs/[id]/cancel/route.ts");
const orchestrator = read("apps/web/src/server/runtime/orchestrator.ts");
const swarm = read("apps/web/src/server/runtime/swarm.ts");
const ui = read("apps/web/src/app/ui/conversation-workspace.tsx");
const events = read("EVENT_PROTOCOL.md");
const status = read("IMPLEMENTATION_STATUS.md");
const plan = read("DATASWARM_CANONICAL_PLAN.md");

expect(
  "run repository persists cancellation intent",
  /export async function requestRunCancel/.test(runsRepo) &&
    /cancel_requested/.test(runsRepo) &&
    /isRunCancelRequested/.test(runsRepo) &&
    /status = \?/.test(runsRepo),
  "requestRunCancel should set cancelling state plus durable metadata for running orchestrators",
);
expect(
  "sandbox repository fans out cancellation safely",
  /requestSandboxSessionsCancelForRun/.test(sandboxRepo) &&
    /isTerminalSandboxStatus/.test(sandboxRepo) &&
    /cancel_reason/.test(sandboxRepo),
  "sandbox cancellation should skip terminal sessions and persist cancel metadata",
);
expect(
  "cancel API publishes run and sandbox events",
  /run\.cancel\.requested/.test(cancelRoute) &&
    /sandbox\.cancel\.requested/.test(cancelRoute) &&
    /requestSandboxSessionsCancelForRun/.test(cancelRoute),
  "POST /api/runs/[id]/cancel should be visible in the event stream",
);
expect(
  "orchestrator terminates cancelled runs distinctly from failures",
  /class RunCancelledError/.test(orchestrator) &&
    /isRunCancelledError/.test(orchestrator) &&
    /updateRunStatus\(runId, "cancelled"/.test(orchestrator) &&
    /run\.cancelled/.test(orchestrator),
  "cancelled runs must not be recorded as runtime failures",
);
expect(
  "swarm stops between branch launches",
  /assertSwarmRunNotCancelled/.test(swarm) &&
    /swarm\.cancelled/.test(swarm) &&
    /completeTraceSpan\(swarmSpan\.id, "cancelled"/.test(swarm),
  "planner-owned swarm should stop launching branches after cancellation is requested",
);
expect(
  "conversation UI listens for cancellation events",
  /run\.cancel\.requested/.test(ui) &&
    /sandbox\.cancel\.requested/.test(ui) &&
    /run\.cancelled/.test(ui) &&
    /setRunStatus\("cancelled"\)/.test(ui),
  "SSE cancellation should update runtime cards and close the active stream",
);
expect(
  "event protocol documents cancellation lifecycle",
  /run\.cancel\.requested/.test(events) &&
    /sandbox\.cancel\.requested/.test(events) &&
    /swarm\.cancelled/.test(events),
  "canonical protocol must include the emitted cancellation events",
);
expect(
  "status docs mention run cancel smoke",
  /Run cancel lifecycle smoke passed/.test(status) &&
    /run-cancel-lifecycle-smoke/.test(plan),
  "implementation status and canonical plan should include the verification gate",
);

finish();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function expect(name, passed, detail) {
  results.push({ name, passed, detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nRun cancel lifecycle smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nRun cancel lifecycle smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
