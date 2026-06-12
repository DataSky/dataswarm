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

const verifier = readProjectFile("apps/web/src/server/runtime/swarm-verifier.ts");
const swarm = readProjectFile("apps/web/src/server/runtime/swarm.ts");
const canonicalPlan = readProjectFile("DATASWARM_CANONICAL_PLAN.md");
const executionPlan = readProjectFile("AGENTIC_LOOP_V2_EXECUTION_PLAN.md");
const implementationStatus = readProjectFile("IMPLEMENTATION_STATUS.md");
const eventProtocol = readProjectFile("EVENT_PROTOCOL.md");

expect(
  "swarm verifier is an independent runtime module",
  /export function buildSwarmVerification/.test(verifier) &&
    /export function detectContradictionSignals/.test(verifier) &&
    /export function summarizeVerificationChecks/.test(verifier),
  "Verifier logic should be reusable outside swarm.ts for diagnostics and self-improvement.",
);

expect(
  "swarm imports verifier instead of defining it inline",
  /import \{ buildSwarmVerification, type SwarmVerificationResult \} from "\.\/swarm-verifier"/.test(swarm) &&
    !/function buildSwarmVerification\(input/.test(swarm),
  "swarm.ts should call the independent verifier module.",
);

expect(
  "verifier preserves existing event check ids",
  /branch_observations_present/.test(verifier) &&
    /artifact_coverage/.test(verifier) &&
    /failed_branch_isolation/.test(verifier) &&
    /conflict_signal_scan/.test(verifier) &&
    /merge_has_branch_evidence/.test(verifier),
  "Existing Run Trace/e2e consumers depend on these check ids.",
);

expect(
  "verifier adds richer traceability and diversity checks",
  /plan_source_traceable/.test(verifier) &&
    /branch_instructions_present/.test(verifier) &&
    /branch_summary_uniqueness/.test(verifier) &&
    /runtime_fallback/.test(verifier),
  "Verifier should detect fallback plans, missing instructions, and duplicate branch outputs.",
);

expect(
  "verifier scans contradiction and unsupported-claim signals",
  /contradictionPatterns/.test(verifier) &&
    /unsupported/.test(verifier) &&
    /source_mismatch/.test(verifier) &&
    /来源不匹配/.test(verifier),
  "Verifier should surface contradiction, unsupported claim, and source mismatch signals for reducer review.",
);

expect(
  "verification summary remains deterministic",
  /failedChecks\.length > 0 \? "failed"/.test(verifier) &&
    /warningChecks\.length > 0 \? "warning"/.test(verifier) &&
    /All \$\{checks\.length\} verification checks passed/.test(verifier),
  "Verifier status should be deterministic and stable for e2e assertions.",
);

expect(
  "event protocol documents swarm.verify",
  /### 7\.\d+ `swarm\.verify`/.test(eventProtocol) &&
    /checks/.test(eventProtocol) &&
    /branch_observation_ids/.test(eventProtocol),
  "Event protocol should expose verifier output as a UI/trace contract.",
);

expect(
  "canonical plan tracks richer verifier stage",
  /richer independent verifier/i.test(canonicalPlan) &&
    /swarm-verifier-smoke/i.test(canonicalPlan),
  "Canonical gates should include the independent verifier check.",
);

expect(
  "execution plan marks contradiction verifier progress",
  /\[x\] Expand observation contradiction detection into a stronger reusable verifier/.test(executionPlan),
  "The near-term execution checklist should reflect this implemented verifier slice.",
);

expect(
  "implementation status records verifier smoke",
  /Swarm verifier smoke passed/i.test(implementationStatus),
  "Status snapshot should record the verifier evidence.",
);

const failed = results.filter((result) => !result.passed);
for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
}
if (failed.length > 0) {
  process.exitCode = 1;
  console.error(`Swarm verifier smoke failed: ${failed.length}/${results.length} checks failed.`);
} else {
  console.log(`Swarm verifier smoke passed: ${results.length}/${results.length} checks passed.`);
}
