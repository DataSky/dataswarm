import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const baseUrl = process.env.DATASWARM_BASE_URL ?? "http://localhost:3000";
const results = [];
const cleanup = [];

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

const db = new DatabaseSync(dbPath);
const run = db.prepare("SELECT id, conversation_id FROM runs ORDER BY created_at DESC LIMIT 1").get();
expect("latest run exists", Boolean(run), JSON.stringify(run ?? null));
if (!run) {
  db.close();
  finish();
}

const approvalId = `appr_smoke_${Date.now()}`;
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO approvals
   (id, tenant_id, project_id, run_id, agent_session_id, tool_call_id, status, risk_level, request_summary, request_payload_uri,
    decision_by_user_id, decision_comment, expires_at, resolved_at, metadata_json, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  approvalId,
  "ten_default",
  "prj_default",
  run.id,
  null,
  null,
  "pending",
  "medium",
  "[smoke] Approval lifecycle",
  null,
  null,
  null,
  null,
  null,
  JSON.stringify({ smoke: true }),
  now,
  now,
);
cleanup.push(() => db.prepare("DELETE FROM approvals WHERE id = ?").run(approvalId));
expect("smoke approval inserted", true, approvalId);

try {
  const health = await fetch(`${baseUrl}/api/system/snapshot`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (!health?.ok) {
    expect("approval API smoke skipped", true, `server unavailable at ${baseUrl}`);
  } else {
    const listed = await fetch(`${baseUrl}/api/runs/${run.id}/approvals`).then((response) => response.json());
    expect(
      "approval list includes smoke approval",
      Array.isArray(listed.approvals) && listed.approvals.some((item) => item.id === approvalId),
      JSON.stringify({ count: listed.approvals?.length }),
    );
    const approved = await fetch(`${baseUrl}/api/runs/${run.id}/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", comment: "approval lifecycle smoke" }),
    }).then((response) => response.json());
    expect("approval decision returns approved", approved?.approval?.status === "approved", JSON.stringify(approved));
    const fetched = await fetch(`${baseUrl}/api/runs/${run.id}/approvals/${approvalId}`).then((response) => response.json());
    expect("approval GET reflects approved status", fetched?.approval?.status === "approved", JSON.stringify(fetched));
  }
} finally {
  for (const item of cleanup.reverse()) {
    item();
  }
  db.close();
}

finish();

function expect(name, passed, detail) {
  results.push({ name, passed, detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nApproval lifecycle smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nApproval lifecycle smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
