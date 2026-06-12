import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const port = Number(process.env.DATASWARM_SKILLS_INSTALL_API_PORT ?? 3224);
const baseUrl = `http://localhost:${port}`;
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const skillName = `smoke-skill-${Date.now()}`;
const skillDir = path.join(root, "skills", skillName);
const results = [];
let server;
let db;

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (!existsSync(dbPath)) {
  finish();
}

try {
  if (process.env.DATASWARM_SKILLS_INSTALL_API_SKIP_BUILD !== "1") {
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
  await waitForHealth(output);

  const installed = await postJson("/api/skills", {
    action: "install",
    status: "enabled",
    manifest: {
      schemaVersion: "dataswarm.skill.v1",
      name: skillName,
      version: "0.1.0",
      purpose: "Smoke test skill installation and manifest synchronization.",
      activationGuidance: ["Use only for skills install smoke tests."],
      requiredTools: ["trace.query"],
      preferredCapabilities: ["trace_query"],
      inputContract: {},
      outputContract: { type: "smoke" },
      qualityChecks: ["Installed skill must be persisted to disk and SQLite."],
      riskLevel: "low",
      tags: ["smoke"],
    },
    skillMarkdown: `# ${skillName}\n\nSmoke test skill installation and manifest synchronization.\n`,
  });
  expect("install API returns skill", installed?.skill?.name === skillName, JSON.stringify(installed));
  expect("install API reports operation", installed?.operation === "installed", JSON.stringify(installed));
  expect("skill.json written", existsSync(path.join(skillDir, "skill.json")), path.join(skillDir, "skill.json"));
  expect("SKILL.md written", existsSync(path.join(skillDir, "SKILL.md")), path.join(skillDir, "SKILL.md"));

  db = new DatabaseSync(dbPath);
  const dbRow = db
    .prepare("SELECT name, version, status, metadata_json FROM skills WHERE name = ?")
    .get(skillName);
  const manifest = parseJson(dbRow?.metadata_json, {})?.manifest;
  expect(
    "installed skill synced to SQLite",
    dbRow?.status === "enabled" && manifest?.purpose === "Smoke test skill installation and manifest synchronization.",
    JSON.stringify(dbRow),
  );

  const listed = await fetchJson("/api/skills");
  expect(
    "installed skill appears in registry API",
    Array.isArray(listed.skills) && listed.skills.some((skill) => skill.name === skillName),
    JSON.stringify({ count: listed.skills?.length }),
  );

  const disabled = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skillName)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "disabled" }),
  }).then((response) => response.json());
  expect("installed skill can be disabled", disabled?.skill?.status === "disabled", JSON.stringify(disabled));

  const updated = await postJson("/api/skills", {
    action: "update",
    status: "enabled",
    manifest: {
      schemaVersion: "dataswarm.skill.v1",
      name: skillName,
      version: "0.2.0",
      purpose: "Smoke test skill update path.",
      requiredTools: ["trace.query", "file.read"],
      preferredCapabilities: ["trace_query", "file_read"],
      inputContract: {},
      outputContract: { type: "smoke" },
      riskLevel: "low",
      tags: ["smoke", "updated"],
    },
  });
  expect("update API returns updated skill", updated?.skill?.version === "0.2.0", JSON.stringify(updated));
  expect("update API re-enables skill", updated?.skill?.status === "enabled", JSON.stringify(updated));
  expect(
    "update API fills default quality checks",
    Array.isArray(updated?.skill?.manifest?.qualityChecks) && updated.skill.manifest.qualityChecks.length > 0,
    JSON.stringify(updated?.skill?.manifest),
  );
} finally {
  if (db) {
    db.prepare("DELETE FROM skills WHERE name = ? OR id = ?").run(skillName, `skill_${skillName.replace(/[^a-zA-Z0-9]+/g, "_")}`);
    db.close();
  }
  await rm(skillDir, { recursive: true, force: true }).catch(() => undefined);
  if (server) {
    server.kill("SIGTERM");
  }
}

finish();

async function runProductionBuild() {
  const result = spawnSync("npm", ["--prefix", "apps/web", "run", "build"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DATASWARM_DATA_DIR: "../../data",
      DATASWARM_WORKSPACE_ROOT: "../..",
    },
    timeout: 120000,
  });
  expect("production build refreshed", result.status === 0, `${result.stdout}\n${result.stderr}`);
  if (result.status !== 0) {
    finish();
  }
}

async function waitForHealth(output) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const response = await fetch(`${baseUrl}/api/system/snapshot`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) {
      expect("production server healthy", true, baseUrl);
      return;
    }
    await delay(500);
  }
  expect("production server healthy", false, output.join("").slice(-2000));
  finish();
}

async function postJson(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { error: `HTTP ${response.status}`, payload };
  }
  return payload;
}

async function fetchJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return response.json();
}

function parseJson(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function expect(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail });
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`\nSkills install API smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSkills install API smoke passed: ${results.length}/${results.length} check(s) passed.`);
  process.exit(0);
}
