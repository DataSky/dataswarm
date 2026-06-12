import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const startedAt = new Date();

const gates = [
  phaseGate("phase1", "typecheck", "npm --prefix apps/web run typecheck"),
  phaseGate("phase1", "lint", "npm --prefix apps/web run lint"),
  phaseGate("phase1", "agentic-loop-v2", "node scripts/agentic-loop-v2-smoke.mjs"),
  phaseGate("phase1", "web-search-provider", "node scripts/web-search-provider-smoke.mjs"),
  phaseGate("phase1", "web-search-provider-e2e", "node scripts/web-search-provider-e2e-smoke.mjs"),
  phaseGate("phase1", "tool-event-contract-e2e", "node scripts/tool-event-contract-e2e-smoke.mjs"),
  phaseGate("phase1", "event-protocol-e2e", "node scripts/event-protocol-e2e-smoke.mjs"),

  phaseGate("phase2", "skills-v2", "node scripts/skills-v2-smoke.mjs"),
  phaseGate("phase2", "skills-install-api", "node scripts/skills-install-api-smoke.mjs"),
  phaseGate("phase2", "skills-observation-e2e", "node scripts/skills-observation-e2e-smoke.mjs"),

  phaseGate("phase3", "sandbox-agent", "node scripts/sandbox-agent-smoke.mjs"),
  phaseGate("phase3", "sandbox-agent-model", "node scripts/sandbox-agent-model-smoke.mjs"),
  phaseGate("phase3", "sandbox-retry-policy", "node scripts/sandbox-retry-policy-smoke.mjs"),
  phaseGate("phase3", "run-cancel-lifecycle", "node scripts/run-cancel-lifecycle-smoke.mjs"),
  phaseGate("phase3", "run-cancel-api", "node scripts/run-cancel-api-smoke.mjs"),
  phaseGate("phase3", "swarm-action-plan", "node scripts/swarm-action-plan-smoke.mjs"),
  phaseGate("phase3", "swarm-reducer", "node scripts/swarm-reducer-smoke.mjs"),
  phaseGate("phase3", "swarm-verifier", "node scripts/swarm-verifier-smoke.mjs"),
  phaseGate("phase3", "swarm-review", "node scripts/swarm-review-smoke.mjs"),
  phaseGate("phase3", "sandbox-retry-e2e", "node scripts/sandbox-retry-e2e-smoke.mjs"),
  phaseGate("phase3", "swarm-trace-ui", "node scripts/swarm-trace-ui-smoke.mjs"),
  phaseGate("phase3", "approval-lifecycle", "node scripts/approval-lifecycle-smoke.mjs"),

  phaseGate("phase4", "e2b-template", "node scripts/e2b-template-smoke.mjs"),
  phaseGate("phase4", "e2b-template-receipt", "node scripts/e2b-template-receipt-smoke.mjs"),
  phaseGate("phase4", "e2b-readiness", "node scripts/e2b-readiness-smoke.mjs"),
  phaseGate("phase4", "e2b-live-receipt", "node scripts/e2b-live-receipt-smoke.mjs"),
  phaseGate("phase4", "run-trace-system-readiness", "node scripts/run-trace-system-readiness-smoke.mjs"),
  phaseGate("phase4", "e2b-preflight-e2e", "node scripts/e2b-preflight-e2e-smoke.mjs"),
  phaseGate("phase4", "e2b-template-verification-e2e", "node scripts/e2b-template-verification-e2e-smoke.mjs"),
  phaseGate("phase4", "build", "npm --prefix apps/web run build"),
  phaseGate("phase4", "e2b-live-sandbox", "node scripts/e2b-sandbox-smoke.mjs", {
    liveExternalGate: true,
  }),
  phaseGate("phase4", "e2b-orchestrator-e2e", "node scripts/e2b-orchestrator-e2e-smoke.mjs", {
    liveExternalGate: true,
  }),

  phaseGate("phase5", "self-improvement-async", "node scripts/self-improvement-async-smoke.mjs"),
  phaseGate("phase5", "self-improvement-diagnostics", "node scripts/self-improvement-diagnostics-smoke.mjs"),
  phaseGate("phase5", "self-improvement-lifecycle", "node scripts/self-improvement-lifecycle-smoke.mjs"),
  phaseGate("phase5", "self-improvement-ui", "node scripts/self-improvement-ui-smoke.mjs"),
  phaseGate("phase5", "self-improvement-summary", "node scripts/self-improvement-summary-smoke.mjs"),
  phaseGate("phase5", "self-improvement-summary-api", "node scripts/self-improvement-summary-api-smoke.mjs"),
  phaseGate("phase5", "trace-diagnostics-improvements", "node scripts/trace-diagnostics-improvements-smoke.mjs"),
  phaseGate("phase5", "trace-diagnostics-sandbox", "node scripts/trace-diagnostics-sandbox-smoke.mjs"),
  phaseGate("phase5", "canonical-verification-diagnostics", "node scripts/canonical-verification-diagnostics-smoke.mjs"),
  phaseGate("phase5", "canonical-goal-audit-smoke", "node scripts/canonical-goal-audit-smoke.mjs"),
];

const selectedGates = gates.filter((gate) => matchesFilters(gate, args));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (selectedGates.length === 0) {
  console.error("No canonical verification gates matched the supplied filters.");
  process.exit(1);
}

if (args.dryRun) {
  console.log("Canonical verification dry run:");
  for (const gate of selectedGates) {
    console.log(`- [${gate.phase}] ${gate.key}: ${gate.command}`);
  }
  writeReceipt({
    mode: "dry-run",
    results: selectedGates.map((gate) => ({
      ...publicGate(gate),
      status: "not_run",
      elapsedMs: 0,
    })),
  });
  process.exit(0);
}

const results = [];
for (const gate of selectedGates) {
  console.log(`\n==> [${gate.phase}] ${gate.key}`);
  console.log(`$ ${gate.command}`);
  const gateStartedAt = Date.now();
  const result = spawnSync(gate.command, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    shell: true,
    maxBuffer: 50 * 1024 * 1024,
  });
  const output = redactSecrets(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (output.trim()) {
    console.log(tail(output, 8_000));
  }
  const elapsedMs = Date.now() - gateStartedAt;
  const gatedSkip = gate.liveExternalGate && /SKIP E2B (?:live smoke|orchestrator e2e)/i.test(output);
  const status = result.status === 0 ? (gatedSkip ? "gated_skip" : "passed") : "failed";
  const publicResult = {
    ...publicGate(gate),
    status,
    exitCode: result.status,
    signal: result.signal,
    elapsedMs,
    outputTail: tail(output, 4_000),
  };
  results.push(publicResult);
  console.log(`--> ${status} (${elapsedMs}ms)`);
  if (status === "failed" && args.stopOnFailure) {
    break;
  }
}

const receipt = writeReceipt({ mode: "run", results });
printSummary(receipt);

if (receipt.summary.failed > 0) {
  process.exit(1);
}
if (args.requireLiveE2b && receipt.summary.gatedSkip > 0) {
  console.error("Live E2B verification is required, but at least one live external gate was skipped.");
  process.exit(2);
}

function phaseGate(phase, key, command, options = {}) {
  return {
    phase,
    key,
    command,
    liveExternalGate: Boolean(options.liveExternalGate),
  };
}

function matchesFilters(gate, parsedArgs) {
  if (parsedArgs.phases.length > 0 && !parsedArgs.phases.includes(gate.phase)) {
    return false;
  }
  if (parsedArgs.only.length > 0) {
    return parsedArgs.only.some((needle) => gate.key === needle || gate.key.includes(needle));
  }
  return true;
}

function publicGate(gate) {
  return {
    phase: gate.phase,
    key: gate.key,
    command: gate.command,
    liveExternalGate: gate.liveExternalGate,
  };
}

function writeReceipt({ mode, results }) {
  const completedAt = new Date();
  const summary = summarize(results);
  const receipt = {
    receiptSchema: "dataswarm.canonical-verification.v1",
    mode,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    elapsedMs: completedAt.getTime() - startedAt.getTime(),
    filters: {
      phases: args.phases,
      only: args.only,
      requireLiveE2b: args.requireLiveE2b,
      stopOnFailure: args.stopOnFailure,
    },
    environment: safeEnvironmentSnapshot(),
    summary,
    phaseSummary: summarizeByPhase(results),
    results,
  };
  const receiptPath =
    args.receipt || path.join(root, "data", "verification", "canonical-verification-latest.json");
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\nReceipt: ${path.relative(root, receiptPath)}`);
  return receipt;
}

function summarize(results) {
  return {
    total: results.length,
    passed: results.filter((item) => item.status === "passed").length,
    failed: results.filter((item) => item.status === "failed").length,
    gatedSkip: results.filter((item) => item.status === "gated_skip").length,
    notRun: results.filter((item) => item.status === "not_run").length,
  };
}

function summarizeByPhase(results) {
  const phases = {};
  for (const result of results) {
    phases[result.phase] ??= { total: 0, passed: 0, failed: 0, gatedSkip: 0, notRun: 0 };
    phases[result.phase].total += 1;
    if (result.status === "passed") {
      phases[result.phase].passed += 1;
    } else if (result.status === "failed") {
      phases[result.phase].failed += 1;
    } else if (result.status === "gated_skip") {
      phases[result.phase].gatedSkip += 1;
    } else if (result.status === "not_run") {
      phases[result.phase].notRun += 1;
    }
  }
  return phases;
}

function safeEnvironmentSnapshot() {
  const defaultTemplateReceipt = path.join(root, "data", "e2b", "template-verification.json");
  const configuredTemplateReceipt = process.env.DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT
    ? path.resolve(root, process.env.DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT)
    : defaultTemplateReceipt;
  const liveReceipt = process.env.DATASWARM_E2B_LIVE_SMOKE_RECEIPT
    ? path.resolve(root, process.env.DATASWARM_E2B_LIVE_SMOKE_RECEIPT)
    : path.join(root, "data", "e2b", "live-smoke-receipt.json");
  return {
    e2bApiKeyConfigured: Boolean(process.env.E2B_API_KEY),
    sandboxProvider: process.env.DATASWARM_SANDBOX_PROVIDER ?? "",
    e2bTemplate: process.env.DATASWARM_E2B_TEMPLATE ?? process.env.E2B_TEMPLATE_ID ?? process.env.E2B_TEMPLATE ?? "dataswarm-agent-runtime",
    e2bTemplateVerifiedEnv: process.env.DATASWARM_E2B_TEMPLATE_VERIFIED === "1",
    e2bTemplateBuildIdConfigured: Boolean(process.env.DATASWARM_E2B_TEMPLATE_BUILD_ID),
    e2bTemplateReceiptPath: path.relative(root, configuredTemplateReceipt),
    e2bTemplateReceiptExists: existsSync(configuredTemplateReceipt),
    e2bLiveSmokeReceiptPath: path.relative(root, liveReceipt),
    e2bLiveSmokeReceiptExists: existsSync(liveReceipt),
    sandboxAgentModelMode: process.env.DATASWARM_SANDBOX_AGENT_MODEL === "real" ? "real" : "deterministic",
    sandboxModelSecretsForwarding: process.env.DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS === "1" ? "enabled" : "disabled",
  };
}

function redactSecrets(value) {
  return String(value)
    .replace(/e2b_[a-f0-9]{40}/gi, "[REDACTED_E2B_KEY]")
    .replace(/tvly-[A-Za-z0-9_-]{12,}/g, "[REDACTED_TAVILY_KEY]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_SECRET]")
    .replace(/(api[_-]?key["'\s:=]+)([A-Za-z0-9_./+=-]{16,})/gi, "$1[REDACTED_SECRET]");
}

function tail(value, maxChars) {
  const text = String(value);
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function parseArgs(rawArgs) {
  const parsed = {
    dryRun: false,
    help: false,
    only: [],
    phases: [],
    receipt: "",
    requireLiveE2b: false,
    stopOnFailure: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--require-live-e2b") {
      parsed.requireLiveE2b = true;
    } else if (arg === "--stop-on-failure") {
      parsed.stopOnFailure = true;
    } else if (arg === "--phase") {
      parsed.phases = splitList(readValue(rawArgs, ++index, "--phase"));
    } else if (arg === "--only") {
      parsed.only = splitList(readValue(rawArgs, ++index, "--only"));
    } else if (arg === "--receipt") {
      parsed.receipt = path.resolve(root, readValue(rawArgs, ++index, "--receipt"));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readValue(rawArgs, index, flag) {
  const value = rawArgs[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function printSummary(receipt) {
  console.log("\nCanonical verification summary:");
  for (const [phase, summary] of Object.entries(receipt.phaseSummary)) {
    console.log(
      `- ${phase}: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.gatedSkip} gated`,
    );
  }
  console.log(
    `Total: ${receipt.summary.passed}/${receipt.summary.total} passed, ${receipt.summary.failed} failed, ${receipt.summary.gatedSkip} gated`,
  );
}

function printHelp() {
  console.log(`Usage: node scripts/canonical-verification-runner.mjs [options]

Options:
  --dry-run                 List selected gates and write a not_run receipt.
  --phase phase1,phase4     Run only selected phases.
  --only key,substring      Run gates whose key equals or contains the value.
  --receipt path            Write receipt to a custom path.
  --require-live-e2b        Exit non-zero if the live E2B smoke is gated/skipped.
  --stop-on-failure         Stop after the first failed gate.
  --help                    Show this help.

Examples:
  node scripts/canonical-verification-runner.mjs --dry-run
  node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-readiness,e2b-live-receipt,e2b-live-sandbox
  node scripts/canonical-verification-runner.mjs --require-live-e2b
`);
}
