import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const swarm = read("apps/web/src/server/runtime/swarm.ts");
const tracePage = read("apps/web/src/app/runs/[id]/page.tsx");
const eventProtocol = read("EVENT_PROTOCOL.md");
const packageJson = JSON.parse(read("package.json"));

expect(
  "swarm branch count allows ten-way plans",
  /const SWARM_BRANCH_LIMIT = 10/.test(swarm) && /Math\.min\(SWARM_BRANCH_LIMIT, Math\.floor\(value\)\)/.test(swarm),
  "The runtime should no longer clamp a single swarm plan to six branches.",
);

expect(
  "swarm exposes configurable bounded concurrency",
  /DATASWARM_SWARM_MAX_CONCURRENCY/.test(swarm) &&
    /DEFAULT_SWARM_MAX_CONCURRENCY = 3/.test(swarm) &&
    /configuredMaxConcurrency \?\? \(explicitParallelRequest \? SWARM_BRANCH_LIMIT : DEFAULT_SWARM_MAX_CONCURRENCY\)/.test(swarm),
  "Normal swarms default to three-way concurrency while explicit ten-way requests can use ten when no hard cap is configured.",
);

expect(
  "swarm uses a settled worker pool instead of serial branch execution",
  /executeSwarmBranchesConcurrently/.test(swarm) &&
    /Promise\.allSettled\(workers\)/.test(swarm) &&
    !/for \(const branch of plan\.branches\)/.test(swarm),
  "Branch execution should run through a bounded worker pool and wait for all workers to settle.",
);

expect(
  "branch records are reduced after all branches settle",
  /aggregateBranchRecords\(plan, branchRecords\)/.test(swarm) &&
    /branchRecords\);\s*\n\s*const reduceSpan = await startTraceSpan/.test(swarm) &&
    /const reduction = buildSwarmReduction/.test(swarm),
  "Reducer inputs should be assembled after the concurrent branch queue finishes.",
);

expect(
  "branch events carry concurrency diagnostics",
  /batch_index: launch\.batchIndex/.test(swarm) &&
    /concurrency_slot: launch\.concurrencySlot/.test(swarm) &&
    /effective_concurrency: launch\.effectiveConcurrency/.test(swarm) &&
    /launch_order: launch\.launchOrder/.test(swarm) &&
    /queued_at: launch\.queuedAt/.test(swarm),
  "Run events need enough metadata to prove branch overlap and batch assignment.",
);

expect(
  "event protocol documents swarm parallel fields",
  /max_concurrency/.test(eventProtocol) &&
    /effective_concurrency/.test(eventProtocol) &&
    /batch_index/.test(eventProtocol) &&
    /concurrency_slot/.test(eventProtocol) &&
    /swarm\.reduce[\s\S]*only after every launched branch has settled/.test(eventProtocol),
  "Protocol documentation should describe the concurrency contract.",
);

expect(
  "Run Trace UI renders concurrency and branch batch details",
  /label="Concurrency"/.test(tracePage) &&
    /label="Batches"/.test(tracePage) &&
    /batch:\{Number\(branch\.batchIndex\) \+ 1\}/.test(tracePage) &&
    /slot:\{branch\.concurrencySlot\}/.test(tracePage),
  "Operators should be able to verify parallelism from the trace page.",
);

expect(
  "root package exposes swarm parallel smoke command",
  packageJson.scripts?.["smoke:swarm-parallel"] === "node scripts/swarm-parallel-execution-smoke.mjs",
  "The new verification gate should be runnable directly.",
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
    console.error(`\nSwarm parallel execution smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSwarm parallel execution smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
