import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb, defaults } from "../storage/db";
import { makeId, nowIso } from "../storage/ids";

export type SkillRecord = {
  id: string;
  name: string;
  version: string;
  path: string;
  status: string;
  description: string;
  manifest?: SkillManifest;
};

export type SkillManifest = {
  schemaVersion?: string;
  name: string;
  version: string;
  purpose: string;
  activationGuidance: string[];
  requiredTools: string[];
  preferredCapabilities: string[];
  inputContract: Record<string, unknown>;
  outputContract: Record<string, unknown>;
  qualityChecks: string[];
  riskLevel: "low" | "medium" | "high";
  tags: string[];
};

type SkillRow = {
  id: string;
  name: string;
  version: string;
  path: string;
  status: string;
  description: string | null;
  metadata_json: string | null;
};

export type InstallLocalSkillInput = {
  manifest: Partial<SkillManifest> & { name?: string; purpose?: string };
  skillMarkdown?: string;
  status?: "enabled" | "disabled";
};

export async function listSkills(): Promise<SkillRecord[]> {
  await syncLocalSkills();
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, name, version, path, status, description, metadata_json
       FROM skills
       WHERE tenant_id = ? AND status = 'enabled'
       ORDER BY name ASC`,
    )
    .all(defaults.tenantId) as SkillRow[];

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    path: row.path,
    status: row.status,
    description: row.description ?? "",
    manifest: parseManifestFromMetadata(row.metadata_json),
  }));
}

export async function listAllSkills(): Promise<SkillRecord[]> {
  await syncLocalSkills();
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT id, name, version, path, status, description, metadata_json
       FROM skills
       WHERE tenant_id = ?
       ORDER BY status DESC, name ASC`,
    )
    .all(defaults.tenantId) as SkillRow[];

  return rows.map(rowToSkillRecord);
}

export async function getSkill(skillIdOrName: string): Promise<SkillRecord | null> {
  await syncLocalSkills();
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT id, name, version, path, status, description, metadata_json
       FROM skills
       WHERE tenant_id = ? AND (id = ? OR name = ?)
       LIMIT 1`,
    )
    .get(defaults.tenantId, skillIdOrName, skillIdOrName) as SkillRow | undefined;
  return row ? rowToSkillRecord(row) : null;
}

export async function updateSkillStatus(skillIdOrName: string, status: "enabled" | "disabled") {
  await syncLocalSkills();
  const db = await getDb();
  const skill = await getSkill(skillIdOrName);
  if (!skill) {
    return null;
  }
  const now = nowIso();
  db.prepare("UPDATE skills SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(
    status,
    now,
    defaults.tenantId,
    skill.id,
  );
  return getSkill(skill.id);
}

export async function installOrUpdateLocalSkill(input: InstallLocalSkillInput) {
  const workspaceRoot = getWorkspaceRoot();
  const skillName = normalizeSkillName(input.manifest.name);
  if (!skillName) {
    throw new Error("Skill manifest requires a lowercase name using letters, numbers, and hyphens.");
  }
  const purpose = stringValue(input.manifest.purpose);
  if (!purpose) {
    throw new Error("Skill manifest requires a purpose.");
  }

  const skillDir = path.join(workspaceRoot, "skills", skillName);
  const existing = await getSkill(skillName);
  const generatedSkillMarkdown = buildSkillMarkdown(input.skillMarkdown, skillName, purpose);
  const manifest = normalizeSkillManifest(
    {
      ...input.manifest,
      name: skillName,
      purpose,
    },
    skillName,
    generatedSkillMarkdown,
  );
  if (manifest.activationGuidance.length === 0) {
    manifest.activationGuidance = [`Use ${skillName} when the user task matches this purpose: ${purpose}`];
  }
  if (manifest.qualityChecks.length === 0) {
    manifest.qualityChecks = ["Confirm the final answer follows the skill purpose and cites any required observations."];
  }

  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "skill.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(skillDir, "SKILL.md"), generatedSkillMarkdown, "utf8");
  await syncLocalSkills();

  if (input.status === "disabled") {
    await updateSkillStatus(skillName, "disabled");
  } else if (input.status === "enabled") {
    await updateSkillStatus(skillName, "enabled");
  }

  const skill = await getSkill(skillName);
  if (!skill) {
    throw new Error(`Installed skill ${skillName} could not be loaded.`);
  }

  return {
    skill,
    operation: existing ? "updated" : "installed",
  };
}

export async function syncLocalSkills() {
  const db = await getDb();
  const workspaceRoot = getWorkspaceRoot();
  const skillsRoot = path.join(workspaceRoot, "skills");
  let entries: string[] = [];
  try {
    entries = await readdir(skillsRoot);
  } catch {
    return;
  }

  for (const entry of entries) {
    const skillDir = path.join(skillsRoot, entry);
    const info = await stat(skillDir).catch(() => null);
    if (!info?.isDirectory()) {
      continue;
    }

    const skillMdPath = path.join(skillDir, "SKILL.md");
    const skillMd = await readFile(skillMdPath, "utf8").catch(() => null);
    if (!skillMd) {
      continue;
    }
    const manifest = await readSkillManifest(skillDir, entry, skillMd);

    const id = `skill_${entry.replace(/[^a-zA-Z0-9]+/g, "_")}`;
    const description = manifest.purpose || parseSkillDescription(skillMd);
    const now = nowIso();
    const existing = db.prepare("SELECT id FROM skills WHERE id = ?").get(id) as
      | { id: string }
      | undefined;

    if (existing) {
      db.prepare(
        `UPDATE skills
         SET name = ?, version = ?, path = ?, description = ?, tags_json = ?, required_tools_json = ?, permissions_json = ?, metadata_json = ?, status = CASE WHEN status = 'disabled' THEN status ELSE 'enabled' END, updated_at = ?
         WHERE id = ?`,
      ).run(
        manifest.name,
        manifest.version,
        path.relative(workspaceRoot, skillDir),
        description,
        JSON.stringify(manifest.tags),
        JSON.stringify(manifest.requiredTools),
        JSON.stringify({ riskLevel: manifest.riskLevel, preferredCapabilities: manifest.preferredCapabilities }),
        JSON.stringify({ manifest }),
        now,
        id,
      );
    } else {
      db.prepare(
        `INSERT INTO skills
         (id, tenant_id, project_id, name, version, source, path, description, tags_json, required_tools_json, permissions_json, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        defaults.tenantId,
        null,
        manifest.name,
        manifest.version,
        "local",
        path.relative(workspaceRoot, skillDir),
        description,
        JSON.stringify(manifest.tags),
        JSON.stringify(manifest.requiredTools),
        JSON.stringify({ riskLevel: manifest.riskLevel, preferredCapabilities: manifest.preferredCapabilities }),
        "enabled",
        JSON.stringify({ manifest }),
        now,
        now,
      );
    }
  }
}

export async function createSkillUsage(input: {
  skillId: string;
  runId: string;
  agentSessionId?: string;
  status: string;
  inputSummary?: string;
  traceSpanId?: string;
}) {
  const db = await getDb();
  const now = nowIso();
  const id = makeId("sku");

  db.prepare(
    `INSERT INTO skill_usages
     (id, tenant_id, project_id, skill_id, run_id, agent_session_id, status, input_summary, output_summary, trace_span_id, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    defaults.tenantId,
    defaults.projectId,
    input.skillId,
    input.runId,
    input.agentSessionId ?? null,
    input.status,
    input.inputSummary ?? null,
    null,
    input.traceSpanId ?? null,
    "{}",
    now,
    now,
  );

  return { id };
}

function parseSkillDescription(skillMd: string) {
  const lines = skillMd
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const firstBodyLine = lines.find((line) => !line.startsWith("#"));
  return firstBodyLine?.slice(0, 500) ?? "Local DataSwarm skill";
}

function rowToSkillRecord(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    path: row.path,
    status: row.status,
    description: row.description ?? "",
    manifest: parseManifestFromMetadata(row.metadata_json),
  };
}

async function readSkillManifest(skillDir: string, fallbackName: string, skillMd: string): Promise<SkillManifest> {
  const manifestPath = path.join(skillDir, "skill.json");
  const raw = await readFile(manifestPath, "utf8").catch(() => null);
  if (raw) {
    try {
      return normalizeSkillManifest(JSON.parse(raw) as Record<string, unknown>, fallbackName, skillMd);
    } catch {
      return fallbackManifest(fallbackName, skillMd);
    }
  }
  return fallbackManifest(fallbackName, skillMd);
}

function normalizeSkillManifest(raw: Record<string, unknown>, fallbackName: string, skillMd: string): SkillManifest {
  const name = stringValue(raw.name) || fallbackName;
  return {
    schemaVersion: stringValue(raw.schemaVersion),
    name,
    version: stringValue(raw.version) || "0.1.0",
    purpose: stringValue(raw.purpose) || parseSkillDescription(skillMd),
    activationGuidance: stringArray(raw.activationGuidance),
    requiredTools: stringArray(raw.requiredTools),
    preferredCapabilities: stringArray(raw.preferredCapabilities),
    inputContract: recordValue(raw.inputContract),
    outputContract: recordValue(raw.outputContract),
    qualityChecks: stringArray(raw.qualityChecks),
    riskLevel: riskLevelValue(raw.riskLevel),
    tags: stringArray(raw.tags).length > 0 ? stringArray(raw.tags) : [name],
  };
}

function fallbackManifest(name: string, skillMd: string): SkillManifest {
  return {
    schemaVersion: "dataswarm.skill.v1",
    name,
    version: "0.1.0",
    purpose: parseSkillDescription(skillMd),
    activationGuidance: [],
    requiredTools: [],
    preferredCapabilities: [],
    inputContract: {},
    outputContract: {},
    qualityChecks: [],
    riskLevel: "low",
    tags: [name],
  };
}

function getWorkspaceRoot() {
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.env.DATASWARM_WORKSPACE_ROOT ?? ".",
  );
}

function normalizeSkillName(value: unknown) {
  const raw = stringValue(value).toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) {
    return "";
  }
  return slug;
}

function buildSkillMarkdown(markdown: string | undefined, name: string, purpose: string) {
  const trimmed = markdown?.trim();
  if (trimmed) {
    return `${trimmed}\n`;
  }
  return [
    `# ${name}`,
    "",
    purpose,
    "",
    "## Instructions",
    "",
    "- Use this skill only when its activation guidance matches the user's task.",
    "- Follow the manifest quality checks before producing final output.",
    "",
  ].join("\n");
}

function parseManifestFromMetadata(value: string | null): SkillManifest | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed) && isRecord(parsed.manifest)) {
      return parsed.manifest as SkillManifest;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : {};
}

function riskLevelValue(value: unknown): SkillManifest["riskLevel"] {
  return value === "medium" || value === "high" || value === "low" ? value : "low";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
