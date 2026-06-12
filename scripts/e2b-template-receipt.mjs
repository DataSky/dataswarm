import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const template = stringArg("template") ?? selectedTemplateFromEnv();
const receiptPath = path.resolve(
  root,
  stringArg("receipt") ??
    process.env.DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT ??
    path.join(process.env.DATASWARM_DATA_DIR ?? "data", "e2b", "template-verification.json"),
);
const templateBuildId = stringArg("template-build-id") ?? process.env.DATASWARM_E2B_TEMPLATE_BUILD_ID?.trim() ?? "";
const allowLocalContractOnly = Boolean(args["allow-local-contract-only"]);
const skipTemplateSmoke = Boolean(args["skip-template-smoke"]);
const dryRun = Boolean(args["dry-run"]);

if (!templateBuildId && !allowLocalContractOnly) {
  fail(
    [
      "Refusing to write E2B template verification receipt without template build evidence.",
      "Pass --template-build-id <id>, set DATASWARM_E2B_TEMPLATE_BUILD_ID, or explicitly pass --allow-local-contract-only.",
    ].join("\n"),
  );
}

let smokeOutput = "";
if (!skipTemplateSmoke) {
  const smoke = spawnSync("node", ["scripts/e2b-template-smoke.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
    },
  });
  smokeOutput = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`.trim();
  if (smoke.status !== 0) {
    fail(`E2B template contract smoke failed; receipt was not written.\n${smokeOutput.slice(-4000)}`);
  }
}

const receipt = {
  status: "ready",
  template,
  ...(templateBuildId ? { templateBuildId } : {}),
  verifiedAt: new Date().toISOString(),
  protocolVersion: "dataswarm.sandbox-agent.v1",
  runtimeVersion: "dataswarm.sandbox-runtime.v1",
  verification: {
    generator: "scripts/e2b-template-receipt.mjs",
    localTemplateSmoke: skipTemplateSmoke ? "skipped" : "passed",
    localTemplateSmokeCommand: "node scripts/e2b-template-smoke.mjs",
    templateBuildEvidence: templateBuildId ? "templateBuildId" : "localContractOnly",
    localContractOnly: !templateBuildId,
    hashes: {
      dockerfileSha256: sha256("sandbox/e2b/e2b.Dockerfile"),
      entrypointSha256: sha256("sandbox/e2b/entrypoint.py"),
      sandboxAgentSha256: sha256("sandbox/agent/dataswarm_sandbox_agent.py"),
    },
  },
};

if (dryRun) {
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(0);
}

mkdirSync(path.dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Wrote E2B template verification receipt: ${receiptPath}`);
console.log(`Template: ${template}`);
console.log(`Build evidence: ${templateBuildId || "local-contract-only"}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      fail(`Unexpected argument: ${item}`);
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function stringArg(name) {
  const value = args[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function selectedTemplateFromEnv() {
  return (
    process.env.DATASWARM_E2B_TEMPLATE?.trim() ||
    process.env.E2B_TEMPLATE_ID?.trim() ||
    process.env.E2B_TEMPLATE?.trim() ||
    "dataswarm-agent-runtime"
  );
}

function sha256(relativePath) {
  return createHash("sha256").update(readFileSync(path.join(root, relativePath))).digest("hex");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
