import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const runTracePage = read("apps/web/src/app/runs/[id]/page.tsx");
const canonicalPlan = read("DATASWARM_CANONICAL_PLAN.md");
const status = read("IMPLEMENTATION_STATUS.md");

expect(
  "run trace exposes swarm view",
  /"swarm"/.test(runTracePage) && /<SwarmTimeline events=\{filteredEvents\}/.test(runTracePage),
  "Run Trace should have a dedicated swarm view instead of only generic events.",
);
expect(
  "swarm timeline groups canonical events",
  /function buildSwarmTimeline/.test(runTracePage) &&
    /swarm\.plan/.test(runTracePage) &&
    /swarm\.branch\.started/.test(runTracePage) &&
    /sandbox\.agent\.event/.test(runTracePage) &&
    /swarm\.branch\.completed/.test(runTracePage) &&
    /swarm\.branch\.failed/.test(runTracePage) &&
    /swarm\.reduce/.test(runTracePage) &&
    /swarm\.merge/.test(runTracePage) &&
    /swarm\.verify/.test(runTracePage) &&
    /swarm\.review/.test(runTracePage) &&
    /swarm\.cancelled/.test(runTracePage),
  "Swarm UI should be derived from the persisted event protocol.",
);
expect(
  "swarm tree and branch timeline render separately",
  /Panel title="Swarm Tree"/.test(runTracePage) &&
    /Panel title="Branch Timeline"/.test(runTracePage) &&
    /Panel title="Reduce \/ Merge"/.test(runTracePage) &&
    /Panel title="Verify"/.test(runTracePage) &&
    /Panel title="Review"/.test(runTracePage),
  "Planning, branch execution, reduction, verification, and review should be visually separated.",
);
expect(
  "swarm verify events render as dedicated cards",
  /verifications: Array/.test(runTracePage) &&
    /event\.type === "swarm\.verify"/.test(runTracePage) &&
    /label="Verify" value=\{timeline\.verifications\.length\}/.test(runTracePage) &&
    /title="swarm\.verify"/.test(runTracePage) &&
    /checks:\$\{verification\.checkCount\}/.test(runTracePage),
  "Run Trace should expose deterministic swarm verification results without requiring raw event inspection.",
);
expect(
  "swarm review events render as dedicated cards",
  /reviews: Array/.test(runTracePage) &&
    /event\.type === "swarm\.review"/.test(runTracePage) &&
    /label="Review" value=\{timeline\.reviews\.length\}/.test(runTracePage) &&
    /title="swarm\.review"/.test(runTracePage) &&
    /findings:\$\{review\.findingCount\}/.test(runTracePage),
  "Run Trace should expose optional swarm review results without requiring raw event inspection.",
);
expect(
  "branch cards expose sandbox and artifact identifiers",
  /sandbox:\{branch\.sandboxSessionId\.slice/.test(runTracePage) &&
    /artifact:\{branch\.artifactId\.slice/.test(runTracePage) &&
    /StatusPill status=\{branch\.status\}/.test(runTracePage),
  "Branch timeline should expose sandbox status and produced artifacts.",
);
expect(
  "swarm view has empty state",
  /No swarm events/.test(runTracePage),
  "Non-swarm runs should show an explicit empty state.",
);
expect(
  "canonical plan includes swarm trace UI gate",
  /swarm-trace-ui-smoke/.test(canonicalPlan),
  "The canonical verification gate should include swarm UI coverage.",
);
expect(
  "implementation status records swarm trace UI gate",
  /Swarm trace UI smoke passed/.test(status),
  "Status should record the latest swarm trace UI verification result.",
);

finish();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function expect(name, condition, detail = "") {
  results.push({ name, passed: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nSwarm trace UI smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSwarm trace UI smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
