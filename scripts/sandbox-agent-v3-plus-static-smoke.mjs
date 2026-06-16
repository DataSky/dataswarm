import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];
const failures = [];

const agentSource = readFileSync(path.join(root, "sandbox/agent/dataswarm_sandbox_agent.py"), "utf8");
const planSource = readFileSync(path.join(root, "E2B_BRANCH_AGENT_REACT_V3_PLUS_PLAN.md"), "utf8");
const eventProtocolSource = readFileSync(path.join(root, "EVENT_PROTOCOL.md"), "utf8");
const proxySource = readFileSync(path.join(root, "apps/web/src/server/runtime/sandbox-tool-proxy.ts"), "utf8");
const e2bOrchestratorSource = readFileSync(path.join(root, "scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs"), "utf8");
const canonicalSource = readFileSync(path.join(root, "scripts/canonical-verification-runner.mjs"), "utf8");

expect("v3 plus plan exists", /E2B Branch Agent ReAct V3\+ Execution Plan/.test(planSource));
expect("sandbox action prompt exposes reflect", /Valid action types:.*reflect/.test(agentSource));
expect("sandbox action prompt exposes revise_query", /Valid action types:.*revise_query/.test(agentSource));
expect("sandbox action prompt exposes verify_evidence", /Valid action types:.*verify_evidence/.test(agentSource));
expect("sandbox action prompt exposes request_more_context", /Valid action types:.*request_more_context/.test(agentSource));
expect("sandbox parser normalizes web_search aliases", /"web_search": "call_tool"/.test(agentSource) && /"web_search": "web.search"/.test(agentSource));
expect("v3 native validator exists", /def validate_v3_action\(/.test(agentSource));
expect("v3 loop uses v3 validator", /validation_error = validate_v3_action\(action, job, tool_call_count, max_tool_calls, observations, local_artifacts\)/.test(agentSource));
expect("v2 loop remains on v2 validator", /validation_error = validate_v2_action\(action, job, tool_call_count, max_tool_calls\)/.test(agentSource));
expect("validator checks final answer evidence", /final_answer[\s\S]+usedObservationIds[\s\S]+autoFilledObservationIds/.test(agentSource));
expect("validator rejects secret context requests", /request_more_context[\s\S]+cannot request secrets/.test(agentSource));
expect("runtime handles reflect action", /elif action_type == "reflect"/.test(agentSource) && /reflection_count \+= 1/.test(agentSource));
expect("runtime handles revise_query action", /elif action_type == "revise_query"/.test(agentSource) && /newQuery/.test(agentSource));
expect("runtime handles verify_evidence action", /elif action_type == "verify_evidence"/.test(agentSource) && /evidence_verification_count \+= 1/.test(agentSource));
expect("runtime handles request_more_context action", /elif action_type == "request_more_context"/.test(agentSource) && /context_request_count \+= 1/.test(agentSource));
expect("final answer records evidence fields", /usedObservationIds/.test(agentSource) && /verifiedBeforeFinal/.test(agentSource));
expect("quality signals include real model action ratio", /realModelActionRatio/.test(agentSource));
expect("quality signals include fallback policy status", /fallbackPolicyStatus/.test(agentSource) && /degradedExecution/.test(agentSource));
expect("quality signals include reflection and verification counts", /reflectionCount/.test(agentSource) && /evidenceVerificationCount/.test(agentSource));
expect("fallback reasons are recorded", /fallbackReasons/.test(agentSource) && /fallbackReason/.test(agentSource));
expect("plan documents canonical v3 plus gates", /sandbox-v3-plus-static/.test(planSource) && /sandbox-v3-plus-local/.test(planSource) && /sandbox-v3-plus-real-action/.test(planSource));
expect("event protocol still documents sandbox agent v3", /dataswarm\.sandbox-agent\.v3/.test(eventProtocolSource));
expect("parent proxy supports runtime URL file injection", /DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE/.test(proxySource) && /DATASWARM_PUBLIC_BASE_URL_FILE/.test(proxySource));
expect("e2b parent proxy smoke supports localtunnel fallback", /DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_AUTOTUNNEL/.test(e2bOrchestratorSource) && /localtunnel/.test(e2bOrchestratorSource));
expect("e2b parent proxy smoke supports custom tunnel command", /DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND/.test(e2bOrchestratorSource) && /startTunnelCommand/.test(e2bOrchestratorSource));
expect("e2b parent proxy smoke supports complex benchmark mode", /DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK/.test(e2bOrchestratorSource) && /complex live e2b V3 benchmark/.test(e2bOrchestratorSource));
expect("e2b complex benchmark can preserve rows on failure", /DATASWARM_E2B_ORCHESTRATOR_V3_KEEP_ROWS_ON_FAILURE/.test(e2bOrchestratorSource) && /Preserved smoke rows for diagnostics/.test(e2bOrchestratorSource));
expect("e2b complex benchmark logs compact branch payloads", /summarizeBranchCompletedEvents/.test(e2bOrchestratorSource) && /summarizeReducePayload/.test(e2bOrchestratorSource) && /summarizeProxyCompletedEvents/.test(e2bOrchestratorSource));
expect("canonical runner registers live complex benchmark gate", /e2b-branch-complex-benchmark/.test(canonicalSource) && /DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1/.test(canonicalSource));

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

for (const item of results) {
  console.log(`PASS ${item.name}: ${item.detail}`);
}
console.log(`\nSandbox agent V3+ static smoke passed: ${results.length}/${results.length} check(s) passed.`);

function expect(name, passed, detail = "") {
  const record = { name, passed: Boolean(passed), detail: String(detail) };
  results.push(record);
  if (!passed) {
    failures.push(record);
  }
}
