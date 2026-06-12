import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const verificationDir = path.join(dataDir, "verification");
const expectedTotalGates = 43;
const receiptFiles = {
  canonical: path.join(verificationDir, "canonical-verification-latest.json"),
  phase4E2b: path.join(verificationDir, "canonical-phase4-e2b-latest.json"),
  phase4LiveRequired: path.join(verificationDir, "canonical-phase4-live-required-latest.json"),
};

if (args.help) {
  printHelp();
  process.exit(0);
}

const checks = [];
const receipts = {
  canonical: readReceipt("canonical verification receipt", receiptFiles.canonical),
  phase4E2b: readReceipt("focused Phase 4 E2B receipt", receiptFiles.phase4E2b),
  phase4LiveRequired: readReceipt("strict live E2B receipt", receiptFiles.phase4LiveRequired),
};

auditCanonicalReceipt(receipts.canonical);
auditPhase4Receipt(receipts.phase4E2b);
const liveStatus = auditLiveCompletionReceipt(receipts.phase4LiveRequired);
auditDocuments();
auditSecretSafety();

const failed = checks.filter((check) => check.status === "failed");
const warned = checks.filter((check) => check.status === "warn");
const completionStatus =
  failed.length > 0
    ? "failed"
    : liveStatus === "complete"
      ? "complete"
      : "incomplete_live_e2b_gated";

console.log("\nCanonical goal audit:");
for (const check of checks) {
  console.log(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
}
console.log(
  `\nSummary: completion_status=${completionStatus}, checks=${checks.length}, failed=${failed.length}, warnings=${warned.length}, require_live_e2b=${args.requireLiveE2b}`,
);

if (failed.length > 0) {
  process.exit(1);
}
if (args.requireLiveE2b && completionStatus !== "complete") {
  console.error("Live E2B completion is required, but the strict live sandbox receipt is still gated or missing.");
  process.exit(2);
}

function auditCanonicalReceipt(receipt) {
  if (!receipt) {
    return;
  }
  check(
    "canonical receipt schema",
    receipt.receiptSchema === "dataswarm.canonical-verification.v1",
    `schema=${receipt.receiptSchema ?? "missing"}`,
  );
  check(
    "canonical runner covers Phase 1-5 gates",
    numeric(receipt.summary?.total) >= expectedTotalGates &&
      Boolean(receipt.phaseSummary?.phase1) &&
      Boolean(receipt.phaseSummary?.phase2) &&
      Boolean(receipt.phaseSummary?.phase3) &&
      Boolean(receipt.phaseSummary?.phase4) &&
      Boolean(receipt.phaseSummary?.phase5) &&
      numeric(receipt.phaseSummary?.phase5?.total) >= 10,
    `total=${receipt.summary?.total ?? "missing"}, phase5=${receipt.phaseSummary?.phase5?.total ?? "missing"}`,
  );
  check(
    "canonical runner has no failed gates in latest receipt",
    numeric(receipt.summary?.failed) === 0,
    `failed=${receipt.summary?.failed ?? "missing"}`,
  );
}

function auditPhase4Receipt(receipt) {
  if (!receipt) {
    return;
  }
  const results = Array.isArray(receipt.results) ? receipt.results : [];
  const readiness = results.find((item) => item.key === "e2b-readiness");
  const liveReceipt = results.find((item) => item.key === "e2b-live-receipt");
  const liveSandbox = results.find((item) => item.key === "e2b-live-sandbox");
  const orchestratorE2e = results.find((item) => item.key === "e2b-orchestrator-e2e");
  check(
    "focused Phase 4 receipt has no failed gates",
    numeric(receipt.summary?.failed) === 0,
    `failed=${receipt.summary?.failed ?? "missing"}`,
  );
  check(
    "focused Phase 4 receipt verifies readiness and live receipt contracts",
    readiness?.status === "passed" && liveReceipt?.status === "passed",
    `e2b-readiness=${readiness?.status ?? "missing"}, e2b-live-receipt=${liveReceipt?.status ?? "missing"}`,
  );
  check(
    "focused Phase 4 receipt explicitly represents live sandbox status",
    liveSandbox?.status === "passed" || liveSandbox?.status === "gated_skip",
    `e2b-live-sandbox=${liveSandbox?.status ?? "missing"}`,
  );
  check(
    "focused Phase 4 receipt explicitly represents orchestrator E2B E2E status",
    orchestratorE2e?.status === "passed" || orchestratorE2e?.status === "gated_skip",
    `e2b-orchestrator-e2e=${orchestratorE2e?.status ?? "missing"}`,
  );
}

function auditLiveCompletionReceipt(receipt) {
  if (!receipt) {
    return "missing";
  }
  const strictResults = Array.isArray(receipt.results) ? receipt.results : [];
  const liveComplete =
    numeric(receipt.summary?.failed) === 0 &&
    numeric(receipt.summary?.gatedSkip) === 0 &&
    strictResults.some(
      (item) => item.key === "e2b-live-sandbox" && item.liveExternalGate === true && item.status === "passed",
    ) &&
    strictResults.some(
      (item) => item.key === "e2b-orchestrator-e2e" && item.liveExternalGate === true && item.status === "passed",
    );
  if (liveComplete) {
    check("strict live E2B completion receipt", true, "live sandbox and orchestrator E2E gates passed");
    return "complete";
  }
  const gated =
    numeric(receipt.summary?.gatedSkip) > 0 ||
    strictResults.some((item) => item.liveExternalGate === true && item.status === "gated_skip");
  if (gated) {
    warn("strict live E2B completion receipt", "live sandbox gate is explicitly gated; goal remains active");
    return "gated";
  }
  check(
    "strict live E2B completion receipt",
    false,
    `passed=${receipt.summary?.passed ?? "missing"}, failed=${receipt.summary?.failed ?? "missing"}, gated=${receipt.summary?.gatedSkip ?? "missing"}`,
  );
  return "incomplete";
}

function auditDocuments() {
  const canonicalPlan = readText(path.join(root, "DATASWARM_CANONICAL_PLAN.md"));
  const status = readText(path.join(root, "IMPLEMENTATION_STATUS.md"));
  check(
    "canonical documents expose the completion audit gate",
    /canonical-goal-audit/.test(canonicalPlan) && /canonical-goal-audit/.test(status),
    "DATASWARM_CANONICAL_PLAN.md and IMPLEMENTATION_STATUS.md should both mention canonical-goal-audit",
  );
  check(
    "status documents live E2B completion evidence or boundary",
    /Live E2B sandbox smoke passed/i.test(status) ||
      /E2B orchestrator e2e smoke passed/i.test(status) ||
      /Orchestrator E2B E2E smoke/i.test(status) ||
      /strict live E2B completion audit passed/i.test(status) ||
      /not complete without live external evidence/i.test(status) ||
      /Live E2B remains pending/i.test(status),
    "status must either cite the live receipt evidence or keep the live external evidence boundary explicit",
  );
}

function auditSecretSafety() {
  for (const [name, filePath] of Object.entries(receiptFiles)) {
    if (!existsSync(filePath)) {
      continue;
    }
    const text = readFileSync(filePath, "utf8");
    check(
      `${name} receipt is secret-safe`,
      !hasSecret(text),
      path.relative(root, filePath),
    );
  }
}

function readReceipt(label, filePath) {
  if (!existsSync(filePath)) {
    check(label, false, `missing ${path.relative(root, filePath)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    check(label, false, `invalid JSON: ${error.message}`);
    return null;
  }
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function check(name, condition, detail) {
  checks.push({ name, status: condition ? "passed" : "failed", detail: String(detail) });
}

function warn(name, detail) {
  checks.push({ name, status: "warn", detail: String(detail) });
}

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function hasSecret(value) {
  return /e2b_[a-f0-9]{40}|tvly-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}/i.test(String(value));
}

function parseArgs(rawArgs) {
  const parsed = { help: false, requireLiveE2b: false };
  for (const arg of rawArgs) {
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--require-live-e2b") {
      parsed.requireLiveE2b = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/canonical-goal-audit.mjs [options]

Options:
  --require-live-e2b   Exit 2 unless the strict live E2B sandbox receipt proves completion.
  --help               Show this help.
`);
}
