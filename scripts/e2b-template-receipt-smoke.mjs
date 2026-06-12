import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const results = [];
const failures = [];
const receiptPath = path.join(root, "data", "tmp-e2b-template-receipt-smoke.json");
const localOnlyReceiptPath = path.join(root, "data", "tmp-e2b-template-receipt-local-only-smoke.json");
const rejectedReceiptPath = path.join(root, "data", "tmp-e2b-template-receipt-rejected-smoke.json");
const script = read("scripts/e2b-template-receipt.mjs");

cleanup();

expect(
  "receipt generator requires build evidence by default",
  /Refusing to write E2B template verification receipt without template build evidence/.test(script) &&
    /--allow-local-contract-only/.test(script) &&
    /DATASWARM_E2B_TEMPLATE_BUILD_ID/.test(script),
  "operators should not accidentally unlock E2B readiness from an unreviewed hand-written receipt",
);
expect(
  "receipt generator runs the template smoke before writing",
  /scripts\/e2b-template-smoke\.mjs/.test(script) &&
    /localTemplateSmoke/.test(script) &&
    /receipt was not written/.test(script),
  "local template contract verification should be part of the receipt evidence path",
);
expect(
  "receipt generator records stable file hashes",
  /dockerfileSha256/.test(script) && /entrypointSha256/.test(script) && /sandboxAgentSha256/.test(script),
  "receipt should be auditable against the template and agent files that were checked",
);

const rejected = spawnReceipt([
  "--template",
  "dataswarm-receipt-smoke",
  "--receipt",
  rejectedReceiptPath,
  "--skip-template-smoke",
]);
expect(
  "receipt generator rejects missing build id unless explicitly overridden",
  rejected.status !== 0 && !existsSync(rejectedReceiptPath) && rejected.stderr.includes("Refusing to write"),
  rejected.stderr || rejected.stdout,
);

const generated = spawnReceipt([
  "--template",
  "dataswarm-receipt-smoke",
  "--template-build-id",
  "tmpl_receipt_smoke",
  "--receipt",
  receiptPath,
]);
expect("receipt generator exits successfully with build evidence", generated.status === 0, generated.stderr || generated.stdout);
const receipt = parseJson(readMaybe(receiptPath));
expect(
  "receipt includes selected template and build evidence",
  receipt?.status === "ready" &&
    receipt?.template === "dataswarm-receipt-smoke" &&
    receipt?.templateBuildId === "tmpl_receipt_smoke" &&
    receipt?.protocolVersion === "dataswarm.sandbox-agent.v1" &&
    receipt?.runtimeVersion === "dataswarm.sandbox-runtime.v1",
  JSON.stringify(receipt),
);
expect(
  "receipt records passed template smoke and non-local build evidence",
  receipt?.verification?.localTemplateSmoke === "passed" &&
    receipt?.verification?.templateBuildEvidence === "templateBuildId" &&
    receipt?.verification?.localContractOnly === false,
  JSON.stringify(receipt?.verification),
);
expect(
  "receipt records template file hashes",
  isSha(receipt?.verification?.hashes?.dockerfileSha256) &&
    isSha(receipt?.verification?.hashes?.entrypointSha256) &&
    isSha(receipt?.verification?.hashes?.sandboxAgentSha256),
  JSON.stringify(receipt?.verification?.hashes),
);

const localOnly = spawnReceipt([
  "--template",
  "dataswarm-local-contract-smoke",
  "--receipt",
  localOnlyReceiptPath,
  "--allow-local-contract-only",
  "--skip-template-smoke",
]);
expect("receipt generator supports explicit local contract only mode", localOnly.status === 0, localOnly.stderr || localOnly.stdout);
const localOnlyReceipt = parseJson(readMaybe(localOnlyReceiptPath));
expect(
  "local contract only receipt is explicit in verification metadata",
  localOnlyReceipt?.template === "dataswarm-local-contract-smoke" &&
    !localOnlyReceipt?.templateBuildId &&
    localOnlyReceipt?.verification?.localTemplateSmoke === "skipped" &&
    localOnlyReceipt?.verification?.localContractOnly === true,
  JSON.stringify(localOnlyReceipt?.verification),
);

cleanup();

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

for (const result of results) {
  console.log(`PASS ${result.name}: ${result.detail}`);
}
console.log(`\nE2B template receipt smoke passed: ${results.length}/${results.length} check(s) passed.`);

function spawnReceipt(args) {
  return spawnSync("node", ["scripts/e2b-template-receipt.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DATASWARM_E2B_TEMPLATE_BUILD_ID: "",
      DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT: "",
      PYTHONUTF8: "1",
    },
  });
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readMaybe(absolutePath) {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return "";
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isSha(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function cleanup() {
  rmSync(receiptPath, { force: true });
  rmSync(localOnlyReceiptPath, { force: true });
  rmSync(rejectedReceiptPath, { force: true });
}

function expect(name, passed, detail = "") {
  const record = { name, passed, detail: String(detail) };
  results.push(record);
  if (!passed) {
    failures.push(record);
  }
}
