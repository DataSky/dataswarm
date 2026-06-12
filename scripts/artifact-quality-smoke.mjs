import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

const artifactsRepo = readProjectFile("apps/web/src/server/repositories/artifacts.ts");
const conversationUi = readProjectFile("apps/web/src/app/ui/conversation-workspace.tsx");
const swarmImageSmoke = readProjectFile("scripts/swarm-image-artifact-e2e-smoke.mjs");
const packageJson = JSON.parse(readProjectFile("package.json"));
const canonicalPlan = readProjectFile("DATASWARM_CANONICAL_PLAN.md");
const schema = readProjectFile("SCHEMA.md");
const status = readProjectFile("IMPLEMENTATION_STATUS.md");

expect(
  "artifact API record exposes normalized quality signals",
  /qualitySignals: Record<string, unknown>/.test(artifactsRepo) &&
    /qualitySignals: recordOrEmpty\(metadata\.qualitySignals\)/.test(artifactsRepo),
  "ArtifactRecord should expose qualitySignals as a first-class API field.",
);

expect(
  "artifact creation computes quality signals",
  /withArtifactQualitySignals/.test(artifactsRepo) &&
    /hasContentHash/.test(artifactsRepo) &&
    /previewReady/.test(artifactsRepo) &&
    /provenanceComplete/.test(artifactsRepo),
  "createTextArtifact/createBinaryArtifact should persist machine-readable artifact quality metadata.",
);

expect(
  "artifact provenance merges update quality counts",
  /mergeArtifactMetadata/.test(artifactsRepo) &&
    /sourceObservationCount/.test(artifactsRepo) &&
    /branchCount/.test(artifactsRepo),
  "mergeArtifactMetadata should refresh sourceObservationCount and branchCount after branch observations are known.",
);

expect(
  "artifact drawer renders quality signals",
  /function ArtifactQuality/.test(conversationUi) &&
    /<ArtifactQuality artifact=\{selectedArtifact\}/.test(conversationUi) &&
    /humanizeKey/.test(conversationUi),
  "Artifact panel should render quality signals without forcing users to inspect raw metadata JSON.",
);

expect(
  "swarm image e2e verifies quality signals through the API",
  /conversation artifacts API exposes artifact quality signals/.test(swarmImageSmoke) &&
    /sourceObservationCount === branchObservations\.length/.test(swarmImageSmoke) &&
    /branchCount === branchObservationMetadata\.length/.test(swarmImageSmoke),
  "The product E2E smoke should prove API-visible quality signals, not just source-code shape.",
);

expect(
  "root package exposes smoke:artifact",
  packageJson?.scripts?.["smoke:artifact"] === "node scripts/artifact-quality-smoke.mjs",
  JSON.stringify(packageJson?.scripts ?? {}),
);

expect(
  "canonical docs track artifact quality signals",
  /qualitySignals/.test(canonicalPlan) && /sourceObservationIds/.test(canonicalPlan),
  "DATASWARM_CANONICAL_PLAN.md should keep Artifact V2 quality/provenance in the canonical contract.",
);

expect(
  "schema docs track artifact quality signals",
  /qualitySignals/.test(schema) && /branchIds/.test(schema),
  "SCHEMA.md should document artifact metadata quality/provenance contracts.",
);

expect(
  "implementation status records artifact quality verification",
  /qualitySignals/.test(status) && /Swarm image artifact e2e smoke passed/.test(status),
  "IMPLEMENTATION_STATUS.md should record the verified artifact quality contract.",
);

finish();

function readProjectFile(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function expect(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  const prefix = condition ? "PASS" : "FAIL";
  console.log(`${prefix} ${name}${detail ? `: ${detail}` : ""}`);
}

function finish() {
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`\nArtifact quality smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nArtifact quality smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
