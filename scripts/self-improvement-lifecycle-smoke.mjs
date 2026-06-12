import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const port = Number(process.env.DATASWARM_SELF_IMPROVEMENT_LIFECYCLE_PORT ?? 3224);
const baseUrl = process.env.DATASWARM_BASE_URL ?? `http://localhost:${port}`;
const results = [];
const cleanup = [];
let server;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

const db = new DatabaseSync(dbPath);
const run = db
  .prepare("SELECT id, conversation_id FROM runs ORDER BY created_at DESC LIMIT 1")
  .get();
expect("latest run exists", Boolean(run), JSON.stringify(run ?? null));
if (!run) {
  db.close();
  finish();
}

const candidateId = `sic_smoke_${Date.now()}`;
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO self_improvement_candidates
   (id, tenant_id, project_id, run_id, conversation_id, eval_result_id, candidate_type, status, severity, title, rationale,
    evidence_json, proposal_json, verification_plan_json, trace_span_id, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  candidateId,
  "ten_default",
  "prj_default",
  run.id,
  run.conversation_id,
  null,
  "runtime_policy_patch",
  "queued",
  "low",
  "[smoke] Self-improvement lifecycle",
  "Verify shadow test and human-decision lifecycle.",
  JSON.stringify({ trace_id: "trace_smoke", eval_span_id: "span_smoke" }),
  JSON.stringify({ recommendation: "No code patch; lifecycle smoke only.", requires_human_approval: true }),
  JSON.stringify({
    required_commands: ["npm --prefix apps/web run typecheck", "node scripts/agentic-loop-v2-smoke.mjs"],
    acceptance: "Candidate lifecycle reaches applied only after shadow_tested and approved.",
  }),
  null,
  now,
  now,
);
cleanup.push(() => db.prepare("DELETE FROM self_improvement_candidates WHERE id = ?").run(candidateId));
expect("smoke candidate inserted", true, candidateId);

try {
  await ensureServer();
  const shadow = await postAction("shadow_test");
  expect("shadow_test returns shadow_tested", shadow?.candidate?.status === "shadow_tested", JSON.stringify(shadow));
  const bundle = await postAction("prepare_patch_bundle");
  expect("prepare_patch_bundle returns patch_prepared", bundle?.candidate?.status === "patch_prepared", JSON.stringify(bundle));
  const bundlePath = resolveLocalUri(bundle?.patchBundle?.storageUri);
  expect("patch bundle file exists", Boolean(bundlePath && existsSync(bundlePath)), bundlePath || "missing bundle path");
  if (bundlePath) {
    cleanup.push(() => rmSync(bundlePath, { force: true }));
  }
  const approve = await postAction("approve");
  expect("approve returns approved", approve?.candidate?.status === "approved", JSON.stringify(approve));
  const rejectedApply = await postAction("mark_applied", {});
  expect(
    "mark_applied without verification receipt is rejected",
    rejectedApply?.status === 400 && String(rejectedApply?.error ?? "").includes("verification_receipt"),
    JSON.stringify(rejectedApply),
  );
  const applied = await postAction("mark_applied", {
    verification_receipt: buildVerificationReceipt([
      "npm --prefix apps/web run typecheck",
      "node scripts/agentic-loop-v2-smoke.mjs",
    ]),
  });
  expect("mark_applied returns applied", applied?.candidate?.status === "applied", JSON.stringify(applied));
  const latestDecision = Array.isArray(applied?.candidate?.proposal?.decisions)
    ? applied.candidate.proposal.decisions.at(-1)
    : null;
  expect(
    "mark_applied records verification receipt",
    latestDecision?.verificationReceipt?.operatorConfirmed === true &&
      Array.isArray(latestDecision.verificationReceipt.requiredCommands) &&
      latestDecision.verificationReceipt.requiredCommands.includes("npm --prefix apps/web run typecheck") &&
      Array.isArray(latestDecision.verificationReceipt.commandResults) &&
      latestDecision.verificationReceipt.commandResults.every((result) => result.status === "passed" && result.summary) &&
      latestDecision.verificationReceipt.policy?.sourcePatchAppliedBySystem === false,
    JSON.stringify(latestDecision ?? null),
  );
  const fetched = await fetch(`${baseUrl}/api/runs/${run.id}/improvements/${candidateId}`).then((response) => response.json());
  expect("candidate GET reflects applied status", fetched?.candidate?.status === "applied", JSON.stringify(fetched));
} finally {
  for (const item of cleanup.reverse()) {
    item();
  }
  db.close();
  if (server) {
    server.kill("SIGTERM");
    await delay(500);
    if (!server.killed) {
      server.kill("SIGKILL");
    }
  }
}

finish();

async function postAction(action, extraBody = undefined) {
  const response = await fetch(`${baseUrl}/api/runs/${run.id}/improvements/${candidateId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, comment: "lifecycle smoke", ...(extraBody ?? {}) }),
  });
  const payload = await response.json();
  if (!response.ok) {
    return { status: response.status, ...payload };
  }
  return payload;
}

function buildVerificationReceipt(requiredCommands) {
  return {
    operatorConfirmed: true,
    submittedAt: new Date().toISOString(),
    commandResults: requiredCommands.map((command) => ({
      command,
      status: "passed",
      summary: "Lifecycle smoke verified this required command before marking applied.",
    })),
  };
}

async function ensureServer() {
  const existing = await fetch(`${baseUrl}/api/system/snapshot`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (existing?.ok) {
    expect("production server healthy", true, baseUrl);
    return;
  }
  if (process.env.DATASWARM_BASE_URL) {
    expect("production server healthy", false, `server unavailable at ${baseUrl}`);
    finish();
  }
  if (process.env.DATASWARM_SELF_IMPROVEMENT_LIFECYCLE_SKIP_BUILD !== "1") {
    await runProductionBuild();
  }
  server = spawn("npm", ["--prefix", "apps/web", "run", "start", "--", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  server.stdout.on("data", (chunk) => output.push(String(chunk)));
  server.stderr.on("data", (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/system/snapshot`).catch(() => null);
    if (response?.ok) {
      expect("production server healthy", true, baseUrl);
      return;
    }
    if (server.exitCode !== null && server.exitCode !== undefined) {
      break;
    }
    await delay(500);
  }
  expect("production server healthy", false, output.join("\n").slice(-3000));
  finish();
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

function resolveLocalUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("local://")) {
    return "";
  }
  const [kind, ...segments] = uri.slice("local://".length).split("/");
  return path.join(dataDir, kind, ...segments);
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
    console.error(`\nSelf-improvement lifecycle smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSelf-improvement lifecycle smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
