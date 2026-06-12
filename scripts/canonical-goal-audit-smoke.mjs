import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const tempRoot = mkdtempSync(path.join(tmpdir(), "dataswarm-canonical-goal-audit-"));
const dataDir = path.join(tempRoot, "data");
const verificationDir = path.join(dataDir, "verification");
const results = [];

try {
  mkdirSync(verificationDir, { recursive: true });
  writeReceiptSet({ liveStatus: "gated" });

  const gatedDefault = runAudit([]);
  expect(
    "gated audit passes as current progress audit",
    gatedDefault.status === 0 && /completion_status=incomplete_live_e2b_gated/.test(gatedDefault.output),
    gatedDefault.output,
  );

  const gatedStrict = runAudit(["--require-live-e2b"]);
  expect(
    "strict audit fails while live E2B is gated",
    gatedStrict.status === 2 && /Live E2B completion is required/.test(gatedStrict.output),
    gatedStrict.output,
  );

  writeReceiptSet({ liveStatus: "passed" });
  const liveComplete = runAudit(["--require-live-e2b"]);
  expect(
    "strict audit passes when live E2B receipt is complete",
    liveComplete.status === 0 && /completion_status=complete/.test(liveComplete.output),
    liveComplete.output,
  );

  writeReceiptSet({ liveStatus: "passed", leakSecret: true });
  const secretLeak = runAudit([]);
  expect(
    "audit fails on secret-shaped receipt leaks",
    secretLeak.status === 1 && /receipt is secret-safe/.test(secretLeak.output) && /FAILED/.test(secretLeak.output),
    secretLeak.output,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

finish();

function runAudit(args) {
  const result = spawnSync("node", ["scripts/canonical-goal-audit.mjs", ...args], {
    cwd: root,
    env: { ...process.env, DATASWARM_DATA_DIR: dataDir },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeReceiptSet({ liveStatus, leakSecret = false }) {
  const livePassed = liveStatus === "passed";
  writeJson(path.join(verificationDir, "canonical-verification-latest.json"), {
    receiptSchema: "dataswarm.canonical-verification.v1",
    mode: "dry-run",
    startedAt: "2026-06-11T00:00:00.000Z",
    completedAt: "2026-06-11T00:00:01.000Z",
    filters: { phases: [], only: [], requireLiveE2b: false, stopOnFailure: false },
    summary: { total: 43, passed: 0, failed: 0, gatedSkip: 0, notRun: 43 },
    phaseSummary: {
      phase1: { total: 7, passed: 0, failed: 0, gatedSkip: 0, notRun: 7 },
      phase2: { total: 3, passed: 0, failed: 0, gatedSkip: 0, notRun: 3 },
      phase3: { total: 13, passed: 0, failed: 0, gatedSkip: 0, notRun: 13 },
      phase4: { total: 10, passed: 0, failed: 0, gatedSkip: 0, notRun: 10 },
      phase5: { total: 10, passed: 0, failed: 0, gatedSkip: 0, notRun: 10 },
    },
    results: [
      { phase: "phase5", key: "canonical-goal-audit-smoke", command: "node scripts/canonical-goal-audit-smoke.mjs", status: "not_run" },
    ],
    metadata: leakSecret ? { bad: `e2b_${"0".repeat(40)}` } : {},
  });
  writeJson(path.join(verificationDir, "canonical-phase4-e2b-latest.json"), {
    receiptSchema: "dataswarm.canonical-verification.v1",
    mode: "run",
    startedAt: "2026-06-11T00:01:00.000Z",
    completedAt: "2026-06-11T00:01:01.000Z",
    filters: { phases: ["phase4"], only: ["e2b-readiness", "e2b-live-receipt", "e2b-live-sandbox", "e2b-orchestrator-e2e"], requireLiveE2b: false, stopOnFailure: false },
    summary: { total: 4, passed: livePassed ? 4 : 2, failed: 0, gatedSkip: livePassed ? 0 : 2, notRun: 0 },
    phaseSummary: { phase4: { total: 4, passed: livePassed ? 4 : 2, failed: 0, gatedSkip: livePassed ? 0 : 2, notRun: 0 } },
    results: [
      { phase: "phase4", key: "e2b-readiness", command: "node scripts/e2b-readiness-smoke.mjs", status: "passed" },
      { phase: "phase4", key: "e2b-live-receipt", command: "node scripts/e2b-live-receipt-smoke.mjs", status: "passed" },
      {
        phase: "phase4",
        key: "e2b-live-sandbox",
        command: "node scripts/e2b-sandbox-smoke.mjs",
        liveExternalGate: true,
        status: livePassed ? "passed" : "gated_skip",
      },
      {
        phase: "phase4",
        key: "e2b-orchestrator-e2e",
        command: "node scripts/e2b-orchestrator-e2e-smoke.mjs",
        liveExternalGate: true,
        status: livePassed ? "passed" : "gated_skip",
      },
    ],
  });
  writeJson(path.join(verificationDir, "canonical-phase4-live-required-latest.json"), {
    receiptSchema: "dataswarm.canonical-verification.v1",
    mode: "run",
    startedAt: "2026-06-11T00:02:00.000Z",
    completedAt: "2026-06-11T00:02:01.000Z",
    filters: { phases: ["phase4"], only: ["e2b-live-sandbox", "e2b-orchestrator-e2e"], requireLiveE2b: true, stopOnFailure: false },
    summary: { total: 2, passed: livePassed ? 2 : 0, failed: 0, gatedSkip: livePassed ? 0 : 2, notRun: 0 },
    phaseSummary: { phase4: { total: 2, passed: livePassed ? 2 : 0, failed: 0, gatedSkip: livePassed ? 0 : 2, notRun: 0 } },
    results: [
      {
        phase: "phase4",
        key: "e2b-live-sandbox",
        command: "node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b",
        liveExternalGate: true,
        status: livePassed ? "passed" : "gated_skip",
      },
      {
        phase: "phase4",
        key: "e2b-orchestrator-e2e",
        command: "node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b",
        liveExternalGate: true,
        status: livePassed ? "passed" : "gated_skip",
      },
    ],
  });
}

function writeJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function expect(name, condition, detail = "") {
  const record = { name, passed: Boolean(condition), detail: String(detail) };
  results.push(record);
  console.log(`${record.passed ? "PASS" : "FAIL"} ${record.name}: ${record.detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nCanonical goal audit smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nCanonical goal audit smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
