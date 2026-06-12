import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const provider = read("apps/web/src/server/runtime/sandbox-provider.ts");
const swarm = read("apps/web/src/server/runtime/swarm.ts");
const status = read("IMPLEMENTATION_STATUS.md");
const plan = read("DATASWARM_CANONICAL_PLAN.md");

expect(
  "retry policy is bounded by env",
  /DATASWARM_SANDBOX_BRANCH_MAX_RETRIES/.test(provider) && /return normalizedRetries \+ 1/.test(provider),
  "provider should convert max retries into bounded max attempts",
);
expect(
  "retryable errors are explicit",
  /sandbox_timeout/.test(provider) &&
    /sandbox_execution_failed/.test(provider) &&
    /error\.status !== "cancelled"/.test(provider),
  "only timeout/execution failures should retry; cancellation should not retry",
);
expect(
  "retry events use sandbox agent protocol",
  /sandbox\.agent\.retry_scheduled/.test(provider) &&
    /failedAttempt/.test(provider) &&
    /nextAttempt/.test(provider) &&
    /maxAttempts/.test(provider),
  "retry scheduling should be visible as sandbox agent events",
);
expect(
  "attempt metadata persists to sandbox session",
  /attempt_failures/.test(provider) &&
    /retry_policy/.test(provider) &&
    /max_attempts/.test(provider) &&
    /retry_scheduled/.test(provider),
  "trace diagnostics should see retry policy and failed attempt history",
);
expect(
  "mock retry can be forced for deterministic smoke",
  /DATASWARM_SANDBOX_FAIL_FIRST_ATTEMPT/.test(provider) && /DATASWARM_SANDBOX_FAIL_ATTEMPTS/.test(provider),
  "local smoke can force retry without relying on flaky external systems",
);
expect(
  "E2B retry recreates sandbox per attempt",
  /for \(let attempt = 1; attempt <= maxAttempts/.test(provider) &&
    /Sandbox\.create/.test(provider) &&
    /sandbox\.kill/.test(provider),
  "real sandbox attempts should be isolated and cleaned up",
);
expect(
  "swarm exposes retry attempts",
  /attempt: result\.attempt/.test(swarm) && /max_attempts: result\.maxAttempts/.test(swarm),
  "branch events should expose attempts for UI and diagnostics",
);
expect(
  "docs record retry as implemented",
  /retry policy/.test(plan) && /Sandbox retry policy smoke passed/.test(status),
  "canonical docs and implementation status should mention the retry gate",
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
    console.error(`\nSandbox retry policy smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSandbox retry policy smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
