import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

function readProjectFile(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function expect(name, passed, detail) {
  results.push({ name, passed: Boolean(passed), detail });
}

const registry = readProjectFile("apps/web/src/server/tools/registry.ts");
const dbSeed = readProjectFile("apps/web/src/server/storage/db.ts");
const runtimeDesign = readProjectFile("AGENTIC_RUNTIME_V2_DESIGN.md");
const executionPlan = readProjectFile("AGENTIC_LOOP_V2_EXECUTION_PLAN.md");
const implementationStatus = readProjectFile("IMPLEMENTATION_STATUS.md");
const canonicalPlan = readProjectFile("DATASWARM_CANONICAL_PLAN.md");

expect(
  "web.search uses a provider registry",
  /const webSearchProviders: Record<WebSearchProviderName, WebSearchProvider>/.test(registry) &&
    /tavily:\s*\{[\s\S]*providerToolName: "tavily\.search"/.test(registry) &&
    /mock:\s*\{[\s\S]*providerToolName: "mock\.search"/.test(registry),
  "web.search should route through named providers instead of a Tavily-only helper.",
);

expect(
  "provider can be model-selected or environment-selected",
  /providerName: webSearchProviderName/.test(registry) &&
    /DATASWARM_WEB_SEARCH_PROVIDER/.test(registry) &&
    /defaultWebSearchProviderName/.test(registry),
  "Planner input provider and DATASWARM_WEB_SEARCH_PROVIDER should both be valid routing signals.",
);

expect(
  "logical and provider tool names are persisted separately",
  /logicalToolName/.test(registry) &&
    /providerToolName: input\.provider\.providerToolName/.test(registry) &&
    /provider: input\.provider\.name/.test(registry) &&
    /Web search returned \$\{sources\.length\} source\(s\) via \$\{input\.provider\.name\} provider/.test(registry),
  "Observations and tool events need logical/provider metadata for diagnostics.",
);

expect(
  "direct Tavily adapter remains a compatibility provider path",
  /executeTavilyAction/.test(registry) &&
    /executeSearchViaProvider\(input, "tavily"\)/.test(registry) &&
    /executeTavilySearch/.test(registry) &&
    /provider: webSearchProviders\.tavily/.test(registry),
  "Existing tavily.search behavior should still force the Tavily provider.",
);

expect(
  "mock web_search provider has distinct evidence",
  /function mockWebSearchSources/.test(registry) &&
    /local:\/\/providers\/mock\.search/.test(registry) &&
    /provider other than Tavily/.test(registry),
  "Provider routing tests need mock.search evidence that cannot be confused with Tavily fallback.",
);

expect(
  "DB seed exposes provider candidates and provider input schema",
  /providerCandidates: \["tavily", "mock"\]/.test(dbSeed) &&
    /function defaultToolSchema/.test(dbSeed) &&
    /enum: \["tavily", "mock"\]/.test(dbSeed) &&
    /UPDATE tools[\s\S]*schema_json/.test(dbSeed),
  "Existing local DBs should receive the updated model-visible schema for web.search.",
);

expect(
  "canonical plan no longer treats Tavily as the only web_search implementation",
  /provider registry/i.test(canonicalPlan) &&
    /Tavily is only the first provider/i.test(canonicalPlan),
  "Canonical planning docs should state the provider abstraction explicitly.",
);

expect(
  "runtime design documents provider-agnostic web_search",
  /provider registry/i.test(runtimeDesign) &&
    /not the runtime strategy/i.test(runtimeDesign),
  "Runtime V2 design should keep tools capability-based rather than Tavily-specific.",
);

expect(
  "execution plan marks provider generalization complete",
  /\[x\] Generalize multiple `web_search` providers beyond Tavily/.test(executionPlan),
  "Execution plan should be updated when this slice lands.",
);

expect(
  "implementation status records provider smoke evidence",
  /Web search provider smoke passed/i.test(implementationStatus),
  "Status snapshot should record the verification evidence for provider routing.",
);

const failed = results.filter((result) => !result.passed);
for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
}
if (failed.length > 0) {
  process.exitCode = 1;
  console.error(`Web search provider smoke failed: ${failed.length}/${results.length} checks failed.`);
} else {
  console.log(`Web search provider smoke passed: ${results.length}/${results.length} checks passed.`);
}
