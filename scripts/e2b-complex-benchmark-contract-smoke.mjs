import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const targetPath = path.join(root, "scripts", "e2b-orchestrator-v3-real-action-e2e-smoke.mjs");
const source = readFileSync(targetPath, "utf8");
const results = [];

expect(
  "complex benchmark defines canonical V4.1 sandbox actions",
  source.includes('const canonicalSandboxActionTypes = new Set(["thought", "web.search", "file.read", "trace.query", "artifact.create", "run_python", "final"])'),
  "canonicalSandboxActionTypes should pin the allowed V4.1 action schema.",
);

expect(
  "complex benchmark tracks deprecated compatibility action names",
  [
    '"read_context"',
    '"call_tool"',
    '"create_artifact"',
    '"reflect"',
    '"revise_query"',
    '"verify_evidence"',
    '"final_answer"',
  ].every((needle) => source.includes(needle)),
  "legacySandboxActionTypes should include old compatibility names so live benchmark validation can reject them.",
);

expect(
  "complex benchmark requires per-branch real_model action coverage",
  source.includes("minimumRealModelActionsPerBranch = complexBenchmarkMode ? 3 : 1") &&
    source.includes("each real e2b branch records enough real_model action decisions") &&
    source.includes("countEventsByBranch(realModelActionEvents)"),
  "live benchmark must prove every branch has enough real_model decisions, not only an aggregate count.",
);

expect(
  "complex benchmark rejects non-canonical proposed actions",
  source.includes("sandbox proposed actions use canonical V4.1 schema without legacy action types") &&
    source.includes("canonicalSandboxActionTypes.has(type)") &&
    source.includes("!legacySandboxActionTypes.has(type)"),
  "proposed sandbox actions must be checked against canonical and legacy action sets.",
);

expect(
  "complex benchmark no longer positively asserts deprecated action names",
  !source.includes('sandboxActionTypes.includes("reflect")') &&
    !source.includes('sandboxActionTypes.includes("revise_query")') &&
    !source.includes('sandboxActionTypes.includes("verify_evidence")') &&
    !source.includes("在 reflect/revise_query 后") &&
    !source.includes("随后 reflect 并 verify_evidence") &&
    !source.includes("通过 create_artifact 产出"),
  "old action names may be listed as prohibited, but must not be positive success criteria or instructions.",
);

expect(
  "complex benchmark requires canonical research and deliverable actions",
  source.includes("complex live e2b V3 benchmark exercises canonical research and deliverable actions") &&
    source.includes('sandboxActionTypes.filter((type) => type === "web.search").length >= 4') &&
    source.includes('sandboxActionTypes.includes("run_python")') &&
    source.includes('sandboxActionTypes.includes("artifact.create")') &&
    source.includes('sandboxActionTypes.includes("final")'),
  "complex benchmark should force web.search, run_python, artifact.create, and final through canonical actions.",
);

expect(
  "complex benchmark requires substantive image, markdown, and html artifacts",
  source.includes("complex live e2b V3 benchmark recovers image plus substantive markdown and html artifacts") &&
    source.includes('artifact.type === "image"') &&
    source.includes('artifact.type === "markdown" && artifactHasSubstance(artifact)') &&
    source.includes('artifact.type === "html" && artifactHasSubstance(artifact)') &&
    source.includes("deliverableEligible === true") &&
    source.includes('status === "substantive"'),
  "live complex artifact coverage must reject runtime summaries and thin reports.",
);

expect(
  "complex benchmark requires parent capability completion evidence",
  source.includes('eventPayloads(db, runId, "capability.invoke.completed")') &&
    source.includes("live e2b V3 parent proxy emits capability invoke completions for required tools") &&
    source.includes('payload.capability_name === "web.search"') &&
    source.includes('payload.capability_name === "artifact.create"') &&
    source.includes('payload.capability_name === "run_python"'),
  "parent-proxy success must include capability.invoke.completed evidence for required live tools.",
);

expect(
  "complex benchmark prompt allows only canonical actions",
  source.includes("允许的 action type 只有 thought、web.search、file.read、trace.query、artifact.create、run_python、final") &&
    source.includes("不能输出 reflect/revise_query/verify_evidence/read_context/call_tool/create_artifact 等旧动作名") &&
    source.includes("在 final 中引用 Observation/Artifact ID"),
  "benchmark prompt should steer the real sandbox model toward canonical V4.1 action schema and cited finals.",
);

finish();

function expect(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail });
}

function finish() {
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error(`\nE2B complex benchmark contract smoke failed: ${failed.length}/${results.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nE2B complex benchmark contract smoke passed: ${results.length}/${results.length} check(s) passed.`);
}
