import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const runTracePage = read("apps/web/src/app/runs/[id]/page.tsx");
const packageJson = JSON.parse(read("package.json"));
const canonicalRunner = read("scripts/canonical-verification-runner.mjs");
const status = read("IMPLEMENTATION_STATUS.md");

expect(
  "run trace imports conversation diagnostics repository",
  /import \{ diagnoseConversation \} from "@\/server\/repositories\/diagnostics"/.test(runTracePage),
  "Run Trace should reuse the canonical diagnostics repository instead of duplicating diagnosis logic in the UI.",
);
expect(
  "run trace exposes diagnostics tab",
  /"diagnostics"/.test(runTracePage) &&
    /view === "diagnostics"/.test(runTracePage) &&
    /<Diagnostics diagnostic=\{diagnostics\} \/>/.test(runTracePage),
  "Operators should be able to open a dedicated diagnostics view from the Run Trace navigation.",
);
expect(
  "diagnostics view renders conversation health",
  /function Diagnostics/.test(runTracePage) &&
    /Panel title="Conversation Health"/.test(runTracePage) &&
    /summary\.diagnosis/.test(runTracePage) &&
    /summary\.remediation/.test(runTracePage),
  "The diagnostics tab should show interpreted health and remediation, not only raw event rows.",
);
expect(
  "diagnostics view renders runtime consistency",
  /const runtime = summary\.runtimeConsistency/.test(runTracePage) &&
    /Panel title="Runtime Consistency"/.test(runTracePage) &&
    /Stale Activities/.test(runTracePage) &&
    /Stale Spans/.test(runTracePage) &&
    /swarmPlanSettledByLaterStageCount/.test(runTracePage),
  "Runtime lifecycle checks should be visible from the product surface.",
);
expect(
  "diagnostics view renders product and evidence signals",
  /Panel title="Product And Evidence Signals"/.test(runTracePage) &&
    /productHealth/.test(runTracePage) &&
    /Observation Summary/.test(runTracePage) &&
    /hasSseOpen/.test(runTracePage) &&
    /evidenceLevels/.test(runTracePage),
  "Submit/SSE/runtime-card evidence and Observation evidence should be visible without raw database inspection.",
);
expect(
  "diagnostics view renders structured remediation",
  /Panel title="Structured Remediation"/.test(runTracePage) &&
    /recommendedAction/.test(runTracePage) &&
    /verificationCommands/.test(runTracePage),
  "Diagnostics should be actionable and verification-oriented.",
);
expect(
  "trace diagnostics smoke includes UI gate",
  /trace-diagnostics-ui-smoke/.test(packageJson.scripts["smoke:trace-diagnostics"] ?? ""),
  "The grouped diagnostics smoke should include UI coverage.",
);
expect(
  "canonical verification includes diagnostics UI gate",
  /phaseGate\("phase5", "trace-diagnostics-ui", "node scripts\/trace-diagnostics-ui-smoke\.mjs"\)/.test(canonicalRunner),
  "The canonical runner should track the diagnostics UI contract.",
);
expect(
  "implementation status records diagnostics UI gate",
  /Trace diagnostics UI smoke passed/.test(status),
  "Status should record the product-surface verification evidence.",
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
    console.error(`\nTrace diagnostics UI smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nTrace diagnostics UI smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
