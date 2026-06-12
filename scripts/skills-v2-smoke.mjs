import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const dataDir = path.resolve(root, process.env.DATASWARM_DATA_DIR ?? "data");
const dbPath = path.join(dataDir, "dataswarm.sqlite");
const results = [];

const skillsRepo = readProjectFile("apps/web/src/server/repositories/skills.ts");
const skillsApi = readProjectFile("apps/web/src/app/api/skills/route.ts");
const skillApi = readProjectFile("apps/web/src/app/api/skills/[id]/route.ts");
const skillsInstallApiSmoke = readProjectFile("scripts/skills-install-api-smoke.mjs");
const page = readProjectFile("apps/web/src/app/page.tsx");
const sidebar = readProjectFile("apps/web/src/app/ui/workspace-sidebar.tsx");
const orchestrator = readProjectFile("apps/web/src/server/runtime/orchestrator.ts");

expect(
  "planner receives enabled-only skill list",
  /export async function listSkills/.test(skillsRepo) &&
    /status = 'enabled'/.test(skillsRepo) &&
    /const availableSkills = await listSkills\(\)/.test(orchestrator),
  "planner should not see disabled skills",
);

expect(
  "skills registry exposes all skills",
  /export async function listAllSkills/.test(skillsRepo) &&
    /FROM skills\s+WHERE tenant_id = \?/.test(skillsRepo) &&
    /listAllSkills/.test(skillsApi) &&
    /listAllSkills/.test(page),
  "UI registry and API should show disabled and enabled skills",
);

expect(
  "skills can be enabled or disabled through API",
  /export async function updateSkillStatus/.test(skillsRepo) &&
    /status: "enabled" \| "disabled"/.test(skillsRepo) &&
    /export async function PATCH/.test(skillApi) &&
    /normalizeSkillStatus/.test(skillApi),
  "Skills V2 needs real enable/disable management instead of static display",
);

expect(
  "skills can be installed or updated through local-first API",
  /installOrUpdateLocalSkill/.test(skillsRepo) &&
    /export async function POST/.test(skillsApi) &&
    /action === "update"/.test(skillsApi) &&
    /writeFile\(path\.join\(skillDir, "skill\.json"\)/.test(skillsRepo) &&
    /writeFile\(path\.join\(skillDir, "SKILL\.md"\)/.test(skillsRepo) &&
    /Skills install API smoke passed/.test(skillsInstallApiSmoke),
  "Skills V2 install/update should write a local skill pack, sync SQLite, and be API-verifiable",
);

expect(
  "sidebar renders manifest-backed skill details",
  /manifest\?\.purpose/.test(sidebar) &&
    /requiredTools/.test(sidebar) &&
    /preferredCapabilities/.test(sidebar) &&
    /qualityChecks/.test(sidebar) &&
    /Disable skill/.test(sidebar) &&
    /Enable skill/.test(sidebar),
  "Skills UI should expose the policy/workflow pack details that the planner sees",
);

expect(
  "sidebar exposes local skill install/update form",
  /Install \/ Update Skill/.test(sidebar) &&
    /Save Skill/.test(sidebar) &&
    /onInstallSkill/.test(sidebar) &&
    /fetch\(\"\/api\/skills\"/.test(sidebar),
  "Skills UI should allow users to add or update local skills without editing files manually",
);

expect(
  "planner-selected skills create observations",
  /const skillObservation = await recordSelectedSkill/.test(orchestrator) &&
    /sourceType: "skill"/.test(orchestrator) &&
    /selected_alternatives/.test(orchestrator) &&
    /contribution_contract/.test(orchestrator) &&
    /publishObservationEvent/.test(orchestrator) &&
    /observation_ids/.test(orchestrator),
  "A use_skill action should persist a skill Observation with selection reason, manifest context, alternatives, and replan linkage.",
);

for (const skillName of ["web-research", "data-profiling", "report-generation", "trace-diagnostics"]) {
  const manifestPath = path.join(root, "skills", skillName, "skill.json");
  expect(`${skillName} manifest exists`, existsSync(manifestPath), manifestPath);
  if (!existsSync(manifestPath)) {
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(
    `${skillName} manifest has V2 contract`,
    manifest.schemaVersion === "dataswarm.skill.v1" &&
      manifest.name === skillName &&
      typeof manifest.purpose === "string" &&
      Array.isArray(manifest.activationGuidance) &&
      manifest.activationGuidance.length > 0 &&
      Array.isArray(manifest.requiredTools) &&
      Array.isArray(manifest.preferredCapabilities) &&
      typeof manifest.inputContract === "object" &&
      typeof manifest.outputContract === "object" &&
      Array.isArray(manifest.qualityChecks) &&
      manifest.qualityChecks.length > 0,
    JSON.stringify(manifest),
  );
}

expect("sqlite database exists", existsSync(dbPath), dbPath);
if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT name, status, metadata_json
         FROM skills
         WHERE name IN ('web-research', 'data-profiling', 'report-generation', 'trace-diagnostics')
         ORDER BY name ASC`,
      )
      .all();
    expect("skills are synced into SQLite", rows.length >= 4, JSON.stringify(rows));
    const missingManifest = rows.filter((row) => !parseManifest(row.metadata_json)?.purpose);
    expect("synced skills include manifest metadata", missingManifest.length === 0, JSON.stringify(missingManifest));
  } finally {
    db.close();
  }
}

finish();

function readProjectFile(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function parseManifest(value) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed.manifest;
  } catch {
    return null;
  }
}

function expect(name, condition, detail = "") {
  results.push({ name, passed: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

function finish() {
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nSkills V2 smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nSkills V2 smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
