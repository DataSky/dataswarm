import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const repository = read("apps/web/src/server/repositories/self-improvement.ts");
const api = read("apps/web/src/app/api/runs/[id]/improvements/route.ts");
const page = read("apps/web/src/app/runs/[id]/page.tsx");
const status = read("IMPLEMENTATION_STATUS.md");
const plan = read("DATASWARM_CANONICAL_PLAN.md");

expect(
  "repository exports queue summary contract",
  /export type SelfImprovementQueueSummary/.test(repository) &&
    /export function summarizeSelfImprovementCandidates/.test(repository),
  "Self-improvement queue health should be computed once in the repository layer.",
);
expect(
  "summary includes lifecycle and risk counters",
  /highSeverityOpen/.test(repository) &&
    /pendingShadowTest/.test(repository) &&
    /readyForPatchBundle/.test(repository) &&
    /readyForHumanDecision/.test(repository) &&
    /approvedAwaitingApplication/.test(repository) &&
    /appliedMissingReceipt/.test(repository),
  "Operators need aggregate counters for the full review-gated lifecycle.",
);
expect(
  "summary includes distributions",
  /byStatus/.test(repository) &&
    /bySeverity/.test(repository) &&
    /byType/.test(repository) &&
    /requiredCommands/.test(repository),
  "Queue analytics should show status, severity, type, and verification-command coverage.",
);
expect(
  "summary generates next operator actions",
  /nextOperatorActions/.test(repository) &&
    /triage-high-severity/.test(repository) &&
    /run-shadow-tests/.test(repository) &&
    /prepare-review-bundles/.test(repository) &&
    /record-human-decisions/.test(repository) &&
    /record-applied-receipts/.test(repository),
  "The queue should make the next human action explicit instead of requiring card-by-card inspection.",
);
expect(
  "summary flags receipt gaps as attention",
  /repair-applied-receipts/.test(repository) &&
    /queueHealth[\s\S]*?needs_attention/.test(repository) &&
    /latestAppliedVerificationReceipt/.test(repository),
  "Applied candidates without verification receipts should remain visible as a queue health issue.",
);
expect(
  "run improvements API returns summary",
  /summarizeSelfImprovementCandidates/.test(api) &&
    /return NextResponse\.json\(\{ improvements, summary: summarizeSelfImprovementCandidates\(improvements\) \}\)/.test(api),
  "API consumers should receive the same queue summary as the Run Trace page.",
);
expect(
  "run trace uses shared summary",
  /summarizeSelfImprovementCandidates/.test(page) &&
    /Queue Health/.test(page) &&
    /High Open/.test(page) &&
    /Pending Shadow/.test(page) &&
    /Ready Bundles/.test(page) &&
    /Ready Review/.test(page) &&
    /Awaiting Apply/.test(page),
  "Run Trace should render the shared queue health counters.",
);
expect(
  "run trace renders next actions and distributions",
  /Next Operator Actions/.test(page) &&
    /Queue Distribution/.test(page) &&
    /By Status/.test(page) &&
    /By Severity/.test(page) &&
    /By Type/.test(page),
  "Run Trace should expose operational summaries before individual candidate cards.",
);
expect(
  "summary smoke is allowlisted for applied receipts",
  /node scripts\/self-improvement-summary-smoke\.mjs/.test(repository),
  "Self-improvement candidates can require the queue summary smoke as a verification command.",
);
expect(
  "docs list self-improvement summary smoke gate",
  /self-improvement-summary-smoke/.test(plan) &&
    /Self-improvement summary smoke passed/.test(status),
  "Canonical plan and implementation status should keep the queue summary gate visible.",
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
    console.error(`\nSelf-improvement summary smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSelf-improvement summary smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
