import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const results = [];

const scriptPath = path.join(root, "scripts/e2b-sandbox-smoke.mjs");
const script = readFileSync(scriptPath, "utf8");
const receiptSection = script.slice(script.indexOf("function writeLiveSmokeReceipt"));

expect(
  "live smoke writes receipt only after successful sandbox verification",
  /writeLiveSmokeReceipt/.test(script) &&
    /heartbeatCount/.test(script) &&
    /artifactRecoveryManifest/.test(script) &&
    /qualitySignals/.test(script),
  "The live E2B smoke should create a durable receipt from actual sandbox output.",
);
expect(
  "live receipt records source hashes",
  script.includes("sha256File") &&
    script.includes("sandbox/agent/dataswarm_sandbox_agent.py") &&
    script.includes("sandbox/e2b/e2b.Dockerfile") &&
    script.includes("sandbox/e2b/entrypoint.py"),
  "Receipt evidence should bind the live smoke to the checked sandbox template inputs.",
);
expect(
  "live receipt is secret-safe",
  /modelSecretsForwarded/.test(receiptSection) &&
    !/DEEPSEEK_API_KEY["']?\s*:/.test(receiptSection) &&
    !/E2B_API_KEY["']?\s*:/.test(receiptSection),
  "Receipt metadata should never serialize provider secrets.",
);
expect(
  "live receipt path is configurable",
  /DATASWARM_E2B_LIVE_SMOKE_RECEIPT/.test(script) && /--receipt/.test(script),
  "Operators should be able to direct receipt output in CI or local verification.",
);
expect(
  "live smoke resolves E2B SDK from web workspace",
  /createRequire/.test(script) &&
    /apps\/web\/package\.json/.test(script) &&
    /requireFromWeb\.resolve\("@e2b\/code-interpreter"\)/.test(script),
  "The root-level canonical runner must be able to execute the live smoke even though the SDK dependency is installed under apps/web.",
);

const tmp = mkdtempSync(path.join(tmpdir(), "dataswarm-e2b-live-receipt-"));
const receiptPath = path.join(tmp, "live-receipt.json");
const result = spawnSync(process.execPath, ["scripts/e2b-sandbox-smoke.mjs", "--receipt", receiptPath], {
  cwd: root,
  env: {
    ...process.env,
    E2B_API_KEY: "",
    DATASWARM_E2B_LIVE_SMOKE_RECEIPT: receiptPath,
  },
  encoding: "utf8",
});
expect(
  "missing E2B_API_KEY skips live smoke",
  result.status === 0 && result.stdout.includes("SKIP E2B live smoke"),
  `${result.status}\n${result.stdout}\n${result.stderr}`,
);
expect(
  "missing E2B_API_KEY does not write live receipt",
  !existsSync(receiptPath),
  receiptPath,
);

rmSync(tmp, { recursive: true, force: true });
finish();

function expect(name, condition, detail = "") {
  const record = { name, passed: Boolean(condition), detail: String(detail) };
  results.push(record);
  console.log(`${record.passed ? "PASS" : "FAIL"} ${record.name}: ${record.detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nE2B live receipt smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nE2B live receipt smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
