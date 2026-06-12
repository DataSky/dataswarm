import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const page = read("apps/web/src/app/runs/[id]/page.tsx");
const systemRepository = read("apps/web/src/server/repositories/system.ts");
const sandboxProvider = read("apps/web/src/server/runtime/sandbox-provider.ts");
const readinessSmoke = read("scripts/e2b-readiness-smoke.mjs");
const status = read("IMPLEMENTATION_STATUS.md");
const plan = read("DATASWARM_CANONICAL_PLAN.md");

expect(
  "run trace loads system snapshot",
  /getSystemSnapshot/.test(page) &&
    /const \[conversation, events, spans, agentSessions, sandboxSessions, evals, approvals, improvements, systemSnapshot, logs\]/.test(page),
  "Run Trace should fetch the system snapshot alongside run-scoped trace data.",
);
expect(
  "run trace exposes system view tab",
  /"system"/.test(page) && /view === "system"/.test(page) && /<SystemReadiness snapshot=\{systemSnapshot\} \/>/.test(page),
  "Operators need a stable Run Trace tab for sandbox readiness instead of switching to a raw API.",
);
expect(
  "system view renders E2B readiness sections",
  /function SystemReadiness/.test(page) &&
    /E2B Sandbox Readiness/.test(page) &&
    /Operator Next Steps/.test(page) &&
    /System Snapshot/.test(page),
  "The page should separate readiness state, next actions, and storage counts.",
);
expect(
  "system view renders live orchestration gates",
  /Provider Selected/.test(page) &&
    /Template Verified/.test(page) &&
    /Live Smoke/.test(page) &&
    /Live Smoke Ready/.test(page) &&
    /Orchestrator Ready/.test(page) &&
    /readyForOrchestrator/.test(page),
  "E2B rollout should show the exact gates before live branch execution is enabled.",
);
expect(
  "system view renders receipt evidence",
  /templateVerificationReceiptPath/.test(page) &&
    /templateBuildId/.test(page) &&
    /templateVerifiedAt/.test(page) &&
    /liveSmokeReceiptPath/.test(page) &&
    /liveSmokeReceiptStatus/.test(page) &&
    /liveSmokeExternalSandboxId/.test(page) &&
    /liveSmokeElapsedMs/.test(page),
  "Readiness evidence should make template and live smoke receipts visible without leaking secrets.",
);
expect(
  "system view renders operator commands",
  /Verification Commands/.test(page) &&
    /verificationCommands/.test(page) &&
    /templateBuildCommand/.test(page) &&
    /liveSmokeCommand/.test(page),
  "The UI should show reproducible commands for template, readiness, live smoke, and branch checks.",
);
expect(
  "system snapshot exposes E2B readiness source",
  /sandbox:\s*\{[\s\S]*?e2b: getE2bSandboxReadiness\(\)/.test(systemRepository),
  "The Run Trace system view should be backed by the same secret-safe readiness source as the API.",
);
expect(
  "E2B readiness contract includes live smoke fields",
  /liveSmokeReceiptPath/.test(sandboxProvider) &&
    /liveSmokeVerified/.test(sandboxProvider) &&
    /liveSmokeExternalSandboxId/.test(sandboxProvider) &&
    /readyForLiveSmoke/.test(sandboxProvider) &&
    /readyForOrchestrator/.test(sandboxProvider),
  "Readiness should distinguish credentials, template verification, live smoke evidence, and orchestrator readiness.",
);
expect(
  "readiness API smoke already verifies secret-safe data",
  /snapshot reports live smoke receipt/.test(readinessSmoke) &&
    /secret/.test(readinessSmoke) &&
    /readiness includes operator action plan/.test(readinessSmoke),
  "The UI smoke should rely on the existing API smoke for payload correctness and secret-safety.",
);
expect(
  "docs list run trace system readiness smoke gate",
  /run-trace-system-readiness-smoke/.test(plan) &&
    /Run Trace system readiness smoke passed/.test(status),
  "Canonical plan and implementation status should keep the new UI readiness gate visible.",
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
    console.error(`\nRun Trace system readiness smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nRun Trace system readiness smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
