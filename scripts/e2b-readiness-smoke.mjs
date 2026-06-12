import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const port = Number(process.env.DATASWARM_E2B_READINESS_PORT ?? 3222);
const baseUrl = `http://localhost:${port}`;
const results = [];
const receiptPath = path.join(root, "data", "tmp-e2b-template-verification-smoke.json");
const mismatchReceiptPath = path.join(root, "data", "tmp-e2b-template-mismatch-smoke.json");
const liveReceiptPath = path.join(root, "data", "tmp-e2b-live-smoke-receipt.json");
let server;

const provider = read("apps/web/src/server/runtime/sandbox-provider.ts");
const system = read("apps/web/src/server/repositories/system.ts");
const smoke = read("scripts/e2b-sandbox-smoke.mjs");
const packageJson = JSON.parse(read("apps/web/package.json"));

expect(
  "E2B SDK dependency is installed",
  Boolean(packageJson.dependencies?.["@e2b/code-interpreter"]),
  packageJson.dependencies?.["@e2b/code-interpreter"] ?? "missing",
);
expect(
  "provider exposes readiness without secrets",
  /export function getE2bSandboxReadiness/.test(provider) &&
    /const apiKeyConfigured = Boolean\(process\.env\.E2B_API_KEY\)/.test(provider) &&
    /apiKeyConfigured,/.test(provider) &&
    !/apiKey:\s*process\.env\.E2B_API_KEY/.test(provider.match(/getE2bSandboxReadiness[\s\S]*?}\n}/)?.[0] ?? ""),
  "readiness should expose booleans and config names, never secret values",
);
expect(
  "provider and live smoke share E2B template envs",
  /DATASWARM_E2B_TEMPLATE/.test(provider) &&
    /E2B_TEMPLATE_ID/.test(provider) &&
    /E2B_TEMPLATE/.test(provider) &&
    /DATASWARM_E2B_TEMPLATE/.test(smoke) &&
    /E2B_TEMPLATE_ID/.test(smoke) &&
    /E2B_TEMPLATE/.test(smoke),
  "template env precedence should be aligned between provider and smoke",
);
expect(
  "provider and live smoke share timeout envs",
  /DATASWARM_E2B_TIMEOUT_MS/.test(provider) &&
    /DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS/.test(provider) &&
    /DATASWARM_E2B_TIMEOUT_MS/.test(smoke) &&
    /DATASWARM_SANDBOX_BRANCH_TIMEOUT_MS/.test(smoke),
  "timeout env precedence should be aligned between provider and smoke",
);
expect(
  "readiness includes sandbox agent protocol and model secret policy",
  /dataswarm\.sandbox-agent\.v1/.test(provider) &&
    /modelSecretsForwarding/.test(provider) &&
    /DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS/.test(provider),
  "readiness should disclose model mode and whether secrets may be forwarded",
);
expect(
  "readiness includes operator action plan",
    /missingEnv/.test(provider) &&
    /nextSteps/.test(provider) &&
    /verificationCommands/.test(provider) &&
    /node scripts\/e2b-live-receipt-smoke\.mjs/.test(provider) &&
    /liveSmokeReceiptPath/.test(provider) &&
    /@e2b\/cli template create dataswarm-agent-runtime/.test(provider) &&
    /sudo \/root\/\.jupyter\/start-up\.sh/.test(provider) &&
    /localhost:49999\/health/.test(provider) &&
    /readE2bLiveSmokeReceipt/.test(provider) &&
    /readyForOrchestrator/.test(provider) &&
    /needs_credentials/.test(provider) &&
    /needs_provider_selection/.test(provider) &&
    /needs_template_verification/.test(provider),
  "readiness should tell operators what is missing and which commands verify progress",
);
expect(
  "readiness gates orchestrator on template verification",
  /templateVerified/.test(provider) &&
    /templateVerificationSource/.test(provider) &&
    /DATASWARM_E2B_TEMPLATE_VERIFIED/.test(provider) &&
    /DATASWARM_E2B_TEMPLATE_BUILD_ID/.test(provider) &&
    /DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT/.test(provider) &&
    /readE2bTemplateVerificationReceipt/.test(provider) &&
    /readyForOrchestrator = providerSelected && apiKeyConfigured && templateVerification\.templateVerified/.test(provider) &&
    /template_verified/.test(provider),
  "real orchestrator sandbox execution should require an explicit template verification receipt from env or a durable local receipt",
);
expect(
  "local template receipt must match selected template",
  /const templateMatches = template === expectedTemplate/.test(provider) &&
    /readyStatus && templateMatches && hasReceiptEvidence/.test(provider),
  "a receipt for one template must not unlock a different E2B template",
);
expect(
  "system snapshot exposes E2B readiness",
  /getE2bSandboxReadiness/.test(system) && /sandbox/.test(system) && /e2b/.test(system),
  "diagnostics should be available without creating a sandbox",
);

if (process.env.DATASWARM_E2B_READINESS_SKIP_SERVER !== "1") {
  await runProductionBuild();
  await assertMismatchedReceiptDoesNotUnlockOrchestrator();
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        status: "ready",
        template: "dataswarm-readiness-smoke",
        templateBuildId: "tmpl_build_readiness_smoke",
        verifiedAt: "2026-06-11T00:00:00.000Z",
        protocolVersion: "dataswarm.sandbox-agent.v1",
      },
      null,
      2,
    ),
  );
  writeFileSync(
    liveReceiptPath,
    JSON.stringify(
      {
        receiptSchema: "dataswarm.e2b-live-smoke-receipt.v1",
        status: "passed",
        provider: "e2b",
        template: "dataswarm-readiness-smoke",
        externalSandboxId: "e2b_live_smoke_snapshot",
        startedAt: "2026-06-11T00:00:01.000Z",
        completedAt: "2026-06-11T00:00:02.000Z",
        elapsedMs: 1000,
        protocol: {
          agent: "dataswarm.sandbox-agent.v1",
          runtime: "dataswarm.sandbox-runtime.v1",
        },
      },
      null,
      2,
    ),
  );
  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      E2B_API_KEY: "e2b_readiness_smoke_secret",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
      DATASWARM_E2B_TEMPLATE: "dataswarm-readiness-smoke",
      DATASWARM_E2B_TEMPLATE_VERIFIED: "",
      DATASWARM_E2B_TEMPLATE_BUILD_ID: "",
      DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT: receiptPath,
      DATASWARM_E2B_LIVE_SMOKE_RECEIPT: liveReceiptPath,
      DATASWARM_SANDBOX_PROVIDER: "e2b",
      DATASWARM_E2B_TIMEOUT_MS: "34567",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(String(chunk)));
  server.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(output);
    const snapshot = await fetch(`${baseUrl}/api/system/snapshot`).then((response) => response.json());
    const readiness = snapshot?.sandbox?.e2b;
    expect("snapshot includes E2B readiness object", Boolean(readiness), JSON.stringify(snapshot?.sandbox ?? null));
    expect("snapshot reports configured template", readiness?.template === "dataswarm-readiness-smoke", JSON.stringify(readiness));
    expect("snapshot reports configured template source", readiness?.templateSource === "DATASWARM_E2B_TEMPLATE", JSON.stringify(readiness));
    expect("snapshot reports configured timeout", readiness?.timeoutMs === 34567, JSON.stringify(readiness));
    expect("snapshot reports local template verification receipt", readiness?.templateVerified === true && readiness?.templateVerificationSource === "DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT" && readiness?.templateBuildId === "tmpl_build_readiness_smoke", JSON.stringify(readiness));
    expect("snapshot reports receipt path and verified timestamp", readiness?.templateVerificationReceiptPath === receiptPath && readiness?.templateVerifiedAt === "2026-06-11T00:00:00.000Z", JSON.stringify(readiness));
    expect(
      "snapshot reports live smoke receipt",
      readiness?.liveSmokeVerified === true &&
        readiness?.liveSmokeReceiptPath === liveReceiptPath &&
        readiness?.liveSmokeReceiptStatus === "passed" &&
        readiness?.liveSmokeVerifiedAt === "2026-06-11T00:00:02.000Z" &&
        readiness?.liveSmokeExternalSandboxId === "e2b_live_smoke_snapshot" &&
        readiness?.liveSmokeElapsedMs === 1000,
      JSON.stringify(readiness),
    );
    expect("snapshot reports no missing E2B env when receipt and key are present", Array.isArray(readiness?.missingEnv) && readiness.missingEnv.length === 0, JSON.stringify(readiness));
    expect("snapshot reports operator next steps", Array.isArray(readiness?.nextSteps) && readiness.nextSteps.some((step) => step.includes("e2b-sandbox-smoke")), JSON.stringify(readiness));
    expect("snapshot omits template verification next step after receipt", Array.isArray(readiness?.nextSteps) && !readiness.nextSteps.some((step) => step.includes("DATASWARM_E2B_TEMPLATE_BUILD_ID")), JSON.stringify(readiness));
    expect(
      "snapshot reports verification commands",
      Array.isArray(readiness?.verificationCommands) &&
        readiness.verificationCommands.includes("node scripts/e2b-template-smoke.mjs") &&
        readiness.verificationCommands.includes("node scripts/e2b-live-receipt-smoke.mjs") &&
        readiness.verificationCommands.includes("node scripts/e2b-sandbox-smoke.mjs"),
      JSON.stringify(readiness),
    );
    expect("snapshot reports orchestrator readiness from local receipt", readiness?.readyForOrchestrator === true && readiness?.status === "ready", JSON.stringify(readiness));
    expect("snapshot does not leak E2B secret", !JSON.stringify(readiness).includes("e2b_readiness_smoke_secret"), JSON.stringify(readiness));
  } finally {
    server.kill("SIGTERM");
    await delay(500);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
    rmSync(receiptPath, { force: true });
    rmSync(liveReceiptPath, { force: true });
  }
}

finish();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

async function runProductionBuild() {
  const output = [];
  const child = spawn("npm", ["--prefix", "apps/web", "run", "build"], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  expect("production build refreshed", exitCode === 0, output.join("\n").slice(-3000));
  if (exitCode !== 0) {
    finish();
  }
}

async function assertMismatchedReceiptDoesNotUnlockOrchestrator() {
  mkdirSync(path.dirname(mismatchReceiptPath), { recursive: true });
  writeFileSync(
    mismatchReceiptPath,
    JSON.stringify(
      {
        status: "ready",
        template: "some-other-template",
        templateBuildId: "tmpl_build_wrong_template",
        verifiedAt: "2026-06-11T00:00:00.000Z",
        protocolVersion: "dataswarm.sandbox-agent.v1",
      },
      null,
      2,
    ),
  );

  const mismatchPort = port + 1;
  const child = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(mismatchPort)], {
    cwd: root,
    env: {
      ...process.env,
      E2B_API_KEY: "e2b_readiness_mismatch_secret",
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
      DATASWARM_E2B_TEMPLATE: "dataswarm-readiness-smoke",
      DATASWARM_E2B_TEMPLATE_VERIFIED: "",
      DATASWARM_E2B_TEMPLATE_BUILD_ID: "",
      DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT: mismatchReceiptPath,
      DATASWARM_SANDBOX_PROVIDER: "e2b",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForSpecificHealth(child, output, mismatchPort);
    const snapshot = await fetch(`http://localhost:${mismatchPort}/api/system/snapshot`).then((response) => response.json());
    const readiness = snapshot?.sandbox?.e2b;
    expect(
      "snapshot rejects mismatched local template receipt",
      readiness?.templateVerified === false &&
        readiness?.templateVerificationSource === "unverified" &&
        readiness?.templateVerificationReceiptPath === mismatchReceiptPath &&
        readiness?.readyForOrchestrator === false &&
        readiness?.status === "needs_template_verification" &&
        Array.isArray(readiness?.missingEnv) &&
        readiness.missingEnv.some((item) => String(item).includes("local template verification receipt")) &&
        !JSON.stringify(readiness).includes("e2b_readiness_mismatch_secret"),
      JSON.stringify(readiness),
    );
  } finally {
    child.kill("SIGTERM");
    await delay(500);
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    rmSync(mismatchReceiptPath, { force: true });
  }
}

async function waitForHealth(output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/system/snapshot`).catch(() => null);
    if (response?.ok) {
      expect("production server healthy", true, baseUrl);
      return;
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("production server healthy", false, output.join("\n").slice(-3000));
  finish();
}

async function waitForSpecificHealth(child, output, targetPort) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://localhost:${targetPort}/api/system/snapshot`).catch(() => null);
    if (response?.ok) {
      expect("mismatched receipt server healthy", true, `http://localhost:${targetPort}`);
      return;
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("mismatched receipt server healthy", false, output.join("\n").slice(-3000));
  finish();
}

function expect(name, condition, detail = "") {
  results.push({ name, passed: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nE2B readiness smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nE2B readiness smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
