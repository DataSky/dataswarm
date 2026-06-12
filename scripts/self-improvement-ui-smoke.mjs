import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const page = read("apps/web/src/app/runs/[id]/page.tsx");
const actions = read("apps/web/src/app/runs/[id]/improvement-actions.tsx");
const api = read("apps/web/src/app/api/runs/[id]/improvements/[candidateId]/route.ts");
const status = read("IMPLEMENTATION_STATUS.md");
const plan = read("DATASWARM_CANONICAL_PLAN.md");

expect(
  "improvement action component is client-side",
  /"use client"/.test(actions) && /useRouter/.test(actions) && /router\.refresh\(\)/.test(actions),
  "Run Trace operator actions should update without leaving the trace page.",
);
expect(
  "component calls candidate action API",
  /fetch\(`\/api\/runs\/\$\{runId\}\/improvements\/\$\{candidateId\}`/.test(actions) &&
    /method: "POST"/.test(actions) &&
    /JSON\.stringify\(\{[\s\S]*?action/.test(actions),
  "Actions should reuse the canonical self-improvement API.",
);
expect(
  "component exposes lifecycle actions by status",
  /queued/.test(actions) &&
    /shadow_failed/.test(actions) &&
    /shadow_tested/.test(actions) &&
    /patch_prepared/.test(actions) &&
    /approved/.test(actions) &&
    /shadow_test/.test(actions) &&
    /prepare_patch_bundle/.test(actions) &&
    /mark_applied/.test(actions),
  "UI should make the lifecycle visible from queued through applied.",
);
expect(
  "mark applied requires explicit verification receipt",
    /buildVerificationReceipt/.test(actions) &&
    /window[\s\S]*?prompt/.test(actions) &&
    /verification_receipt: verificationReceipt/.test(actions) &&
    /const requiredCommands = stringArray\(item\.verificationPlan\.required_commands\)/.test(page) &&
    /requiredCommands=\{requiredCommands\}/.test(page) &&
    /verificationReceipt: body\.verification_receipt \?\? body\.verificationReceipt/.test(api),
  "Applied state should require an operator-submitted receipt rather than silently auto-confirming.",
);
expect(
  "component keeps human decisions available",
  /reject/.test(actions) && /defer/.test(actions) && /approve/.test(actions),
  "Human review choices should be available from the trace page.",
);
expect(
  "run trace imports action component",
  /import \{ ImprovementActions, ImprovementDiagnosticsActions \} from "\.\/improvement-actions"/.test(page) &&
    /<Improvements runId=\{run\.id\}/.test(page),
  "Run Trace improvements view should receive the run id and render operator actions.",
);
expect(
  "run trace exposes diagnostics analysis action",
  /export function ImprovementDiagnosticsActions/.test(actions) &&
    /fetch\(`\/api\/runs\/\$\{runId\}\/improvements`/.test(actions) &&
    /action: "run_diagnostics_analysis"/.test(actions) &&
    /router\.refresh\(\)/.test(actions) &&
    /<ImprovementDiagnosticsActions runId=\{runId\} \/>/.test(page),
  "Operators should be able to convert diagnostics remediation into review-gated candidates from Run Trace.",
);
expect(
  "improvement cards render action slot",
  /actions=\{[\s\S]*?<ImprovementActions[\s\S]*?runId=\{runId\}[\s\S]*?candidateId=\{item\.id\}[\s\S]*?status=\{item\.status\}/.test(page) &&
    /actions\?: React\.ReactNode/.test(page) &&
    /\{actions \? <div>\{actions\}<\/div> : null\}/.test(page),
  "Self-improvement cards should include a compact action region.",
);
expect(
  "run trace summarizes applied receipt coverage",
  /Applied Receipts/.test(page) &&
    /appliedWithReceipt/.test(page) &&
    /receiptCommandResults/.test(page) &&
    /latestAppliedVerificationReceipt/.test(page),
  "Run Trace should make applied verification receipt coverage visible without raw JSON spelunking.",
);
expect(
  "run trace summarizes verification commands",
  /Verification Commands/.test(page) &&
    /summarizeVerificationReceipt/.test(page) &&
    /requiredCommandCount/.test(page) &&
    /passedCommandCount/.test(page),
  "Run Trace should expose required command coverage for applied candidates.",
);
expect(
  "action API persists lifecycle events",
  /self_improvement\.candidate\.shadow_tested/.test(api) &&
    /self_improvement\.candidate\.patch_bundle_prepared/.test(api) &&
    /self_improvement\.candidate\.decision_recorded/.test(api),
  "UI actions must leave durable run events.",
);
expect(
  "docs list self-improvement UI smoke gate",
  /self-improvement-ui-smoke/.test(plan) && /Self-improvement UI smoke passed/.test(status),
  "Status and canonical verification gates should mention the UI smoke.",
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
    console.error(`\nSelf-improvement UI smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSelf-improvement UI smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
