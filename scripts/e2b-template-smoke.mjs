import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const results = [];
const failures = [];

const dockerfile = read("sandbox/e2b/e2b.Dockerfile");
const entrypoint = read("sandbox/e2b/entrypoint.py");
const templateReadme = read("sandbox/e2b/README.md");
const provider = read("apps/web/src/server/runtime/sandbox-provider.ts");
const liveSmoke = read("scripts/e2b-sandbox-smoke.mjs");
const canonicalPlan = read("DATASWARM_CANONICAL_PLAN.md");
const implementationStatus = read("IMPLEMENTATION_STATUS.md");

expect(
  "E2B template Dockerfile packages canonical sandbox agent",
  /FROM e2bdev\/code-interpreter/.test(dockerfile) &&
    /COPY agent\/dataswarm_sandbox_agent\.py/.test(dockerfile) &&
    /COPY e2b\/entrypoint\.py/.test(dockerfile) &&
    /DATASWARM_SANDBOX_TEMPLATE=dataswarm-agent-runtime/.test(dockerfile),
  "the template should install the same sandbox agent used by local mock execution",
);
expect(
  "E2B entrypoint exposes readiness and job execution",
  /--ready/.test(entrypoint) &&
    /--run-job/.test(entrypoint) &&
    /DATASWARM_AGENT_JOB_JSON/.test(entrypoint) &&
    /PROTOCOL_VERSION/.test(entrypoint) &&
    /SANDBOX_RUNTIME_VERSION/.test(entrypoint),
  "the template entrypoint should be ready-checkable and able to run the agent protocol",
);
expect(
  "E2B template build command is documented",
  /@e2b\/cli template create dataswarm-agent-runtime -p sandbox -d e2b\/e2b\.Dockerfile/.test(templateReadme) &&
    /sudo \/root\/\.jupyter\/start-up\.sh/.test(templateReadme) &&
    /localhost:49999\/health/.test(templateReadme),
  "operators should have one canonical template create command that starts and health-checks Code Interpreter",
);
expect(
  "provider pins DataSwarm template alias by default",
  /DATASWARM_E2B_TEMPLATE_ALIAS = "dataswarm-agent-runtime"/.test(provider) &&
    /DATASWARM_E2B_TEMPLATE_BUILD_COMMAND/.test(provider) &&
    /@e2b\/cli template create dataswarm-agent-runtime/.test(provider) &&
    /sudo \/root\/\.jupyter\/start-up\.sh/.test(provider) &&
    /localhost:49999\/health/.test(provider) &&
    /DATASWARM_E2B_TEMPLATE_ALIAS/.test(provider.match(/function getE2bSandboxConfig[\s\S]*?return \{ template: templateEnv\.template, templateSource: templateEnv\.templateSource, timeoutMs \};/)?.[0] ?? ""),
  "real E2B execution should target the DataSwarm runtime template unless explicitly overridden",
);
expect(
  "live E2B smoke targets DataSwarm template and validates runtime lifecycle",
  /dataswarm-agent-runtime/.test(liveSmoke) &&
    /sandbox\.agent\.action_proposed/.test(liveSmoke) &&
    /sandbox\.agent\.action_completed/.test(liveSmoke) &&
    /sandbox\.agent\.observation_created/.test(liveSmoke) &&
    /runtimeVersion/.test(liveSmoke),
  "live smoke should verify the same action/observation lifecycle as local sandbox smoke",
);

const ready = spawnSync("python3", ["sandbox/e2b/entrypoint.py", "--ready"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, PYTHONPATH: path.join(root, "sandbox/agent"), PYTHONUTF8: "1" },
});
expect("E2B entrypoint ready check exits successfully", ready.status === 0, ready.stderr || ready.stdout);
const readyJson = parseJson(ready.stdout);
expect(
  "E2B entrypoint readiness reports agent protocols",
  readyJson?.status === "ready" &&
    readyJson?.protocolVersion === "dataswarm.sandbox-agent.v1" &&
    readyJson?.runtimeVersion === "dataswarm.sandbox-runtime.v1" &&
    readyJson?.supportsJobEnv === true,
  ready.stdout,
);

expect(
  "canonical docs include E2B template smoke gate",
  /e2b-template-smoke/.test(canonicalPlan) && /dataswarm-agent-runtime/.test(canonicalPlan),
  "Phase 4 verification should include template contract checks",
);
expect(
  "implementation status records E2B template contract",
  /E2B template smoke passed/.test(implementationStatus),
  "status snapshot should reflect the new template verification gate",
);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

for (const result of results) {
  console.log(`PASS ${result.name}: ${result.detail}`);
}
console.log(`\nE2B template smoke passed: ${results.length}/${results.length} check(s) passed.`);

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function parseJson(value) {
  try {
    return JSON.parse(String(value).trim());
  } catch {
    return null;
  }
}

function expect(name, passed, detail = "") {
  const record = { name, passed, detail: String(detail) };
  results.push(record);
  if (!passed) {
    failures.push(record);
  }
}
