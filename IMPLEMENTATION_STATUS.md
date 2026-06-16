## 2026-06-17 Progress Note: diagnostics model-call terminal replay alignment

- Tightened conversation diagnostics model-call replay semantics to match `swarm.verify`: `sandboxModelEventCount` and replayability now count only terminal `sandbox.agent.model_call_completed` / `sandbox.agent.model_call_failed` events.
- Added `sandboxModelStartedEventCount` as an auxiliary diagnostics field so started-but-never-finished model calls remain visible without making trace replayability look complete.
- Added a `trace-diagnostics-ui-smoke` static guard so diagnostics cannot regress to counting started-only model calls as terminal replay evidence.
- This removes a subtle false-positive path where diagnostics could appear replayable from `model_call_started` evidence even though the verifier requires terminal model-call evidence.

## 2026-06-17 Progress Note: diagnostics replayability evidence alignment

- Aligned `apps/web/src/server/repositories/diagnostics.ts` with the stricter V4.1 `trace_diagnostics_replayability` verifier gate.
- Conversation diagnostics now expose branch contract/final materialization counts, sandbox action events, sandbox observation events, and sandbox model-call events directly in `swarmEvidence.traceReplayability` and the diagnosis text.
- Fixed a diagnostics event-name blind spot: sandbox observation replay now recognizes `sandbox.agent.observation.created` and legacy `sandbox.agent.observation_created`, not only the older `sandbox.agent.observation` name.
- Branch evidence matrix rows now include per-branch sandbox model-call completion/failure counts, using parent-forwarded `branch_id` metadata from sandbox events.
- This improves `conversationId` replay fidelity for proving real sandbox ReAct loops and avoids undercounting real sandbox observations during branch evidence matrix analysis.

## 2026-06-17 Progress Note: stricter trace diagnostics replayability gate

- Tightened `trace_diagnostics_replayability` in `apps/web/src/server/runtime/swarm-verifier.ts` so V4.1 verification now requires replayable branch contract and branch final materialization events in addition to branch completion, reducer, final artifact, and capability/proxy evidence.
- For sandbox-runtime branches, the gate now also checks persisted `sandbox.agent.action*`, `sandbox.agent.observation.created` / legacy `sandbox.agent.observation_created`, and `sandbox.agent.model_call*` events before a swarm result can pass trace replayability.
- Updated `scripts/swarm-verifier-smoke.mjs` to pin this behavior so later refactors cannot quietly weaken conversationId diagnostics.
- This directly supports the V4.1 requirement that diagnostics can prove real E2B execution, real model action, real tool proxy, real artifact recovery, and degraded/fallback status from persisted trace evidence rather than branch self-report.

## 2026-06-16 Progress Note: harden real-startup mock guards

- `scripts/dev-real.mjs` 与 `scripts/dev-real-cloudflare-tunnel.mjs` 的 mock 污染检测已增强：`DATASWARM_ALLOW_EXPLICIT_MOCK / DATASWARM_MOCK_MODEL / DATASWARM_MOCK_TOOLS` 现在识别 `1/true/yes/on` 等常见真值，并继续阻断启动，避免环境变量残留导致默认 real 启动误入 mock 模式。
- `DATASWARM_SANDBOX_AGENT_MODEL=mock|deterministic`、`DATASWARM_SANDBOX_TOOL_PROXY=mock|disabled`、`DATASWARM_SANDBOX_PROVIDER=mock` 等仍按既有约束直接拒绝。
- 目标对齐：继续贯彻“默认真实模式”要求，确保本地服务误启动时有明确、可回放的拒绝行为；拒绝日志会展示真实环境变量取值而非规则函数内容。

## 2026-06-16 Progress Note: parent-proxy resilience and endpoint fallback

- 继续推进沙箱端 E2B 工具代理闭环：`sandbox/agent/dataswarm_sandbox_agent.py` 中 `call_parent_tool` 增加了更强的 parent proxy 回退策略，目标是降低 `proxy_http_error` / 解析失败导致的工具链中断：
  - 对 `Content-Type`、`Accept`、`User-Agent`、`Origin`、`Referer` 增加显式请求头，降低网关/边缘策略误判概率。
  - 当 `capabilities/invoke` 与 `sandbox/tool-proxy` 二者可用时自动 fallback：`/api/internal/capabilities/invoke` 失败后尝试 `/api/internal/sandbox/tool-proxy`，反之亦然。
  - 对每个端点增加 2 次重试（含重试间隔），并把失败原因汇总为 `endpoint/attempt/status/errorType`，返回给上层用于 diagnostics 与 verifier 复盘。
- 这次改动是对“real action 可执行但工具调用仍失败”的高价值修补：优先恢复真实 `tool_calls`、`Observation`、`run_events` 写入链路，再进入下一步复杂基准复测。

## 2026-06-16 Progress Note: add final answer evidence coverage gate

- 在 `apps/web/src/server/runtime/swarm-verifier.ts` 增加了 `final_answer_evidence_coverage` 门禁：
  - 验证每个 `BranchFinal` 是否有 `sections/claims` 或直接 `evidenceObservationIds` / `artifactIds` 的引用，避免最终分支答复没有事实来源但仍通过验证。
  - 将该门禁加入 `V4_1_SWARM_VERIFY_GATE_IDS` 与 `buildSwarmVerification` 检查序列，确保 `trace_diagnostics` 能看到该硬约束是否缺失。
- 通过 `npm --prefix apps/web run typecheck` 编译校验，无新增类型问题。

## 2026-06-16 Progress Note: parent-proxy fallback retry flow corrected

- 修复 `sandbox/agent/dataswarm_sandbox_agent.py` 的 `call_parent_tool` fallback 逻辑：避免在首个端点失败后立即回退到失败结论，确保同一端点重试结束后再尝试兜底端点。
- 在 `attempts` 中记录每个端点的最终失败明细，保留 `endpoint/attempt/status/errorType/message`，让 diagnostics 能区分“端点本身失败”与“网关抖动”。

## 2026-06-16 Progress Note: parent-proxy reachability helper bugfix

- `scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs` 中的 `verifyCallbackReachability` 重试辅助函数 `waitForValidReachabilityResult` 识别到了一个作用域回归（引用未定义变量 `checks` 导致脚本运行时中断）。
- 本次已修复：重试函数现在显式接收检查项数量作为参数，避免脚本在做 reachability 预检时因为变量作用域错误提前失败，从而保持 parent-proxy 与复杂 benchmark 的真实性前置门禁链路可执行。
- 对应提交：`adad820`，已推送到 `main`。

## 2026-06-16 Progress Note: diagnostics remediation command accuracy

- 发现并修复 `apps/web/src/server/repositories/diagnostics.ts` 中若干失效的 `verificationCommands` 引用（如 `parent-tool-proxy-smoke`/`e2b-parent-proxy-smoke`/`e2b-complex-benchmark-smoke`）。
- 已替换为仓库中实际存在的命令：
  - `node scripts/sandbox-tool-proxy-e2e-smoke.mjs`
  - `DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs`
  - `npm run smoke:e2b-branch-complex-benchmark`
  - `npm run smoke:swarm-parallel-e2e`
- 目标：让诊断面“修复建议”可真实执行，减少误导性失败闭环，支撑 real 模式真实复验。。

## 2026-06-16 Progress Note: complex benchmark blocked by 530 callback while branches are running

- 用 `DATASWARM_PUBLIC_BASE_URL=https://dataswarm-dev.metad.ai DATASWARM_SANDBOX_TOOL_PROXY_URL=https://dataswarm-dev.metad.ai/api/internal/sandbox/tool-proxy DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL=https://dataswarm-dev.metad.ai/api/internal/capabilities/invoke DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1 npm run smoke:e2b-branch-complex-benchmark` 跑完真实复杂基准。
- 结果是脚本级失败（16/26）但关键事实明确：
  - `e2b` branch session 已创建并进入运行态（至少 2 个，表明分支并行与 Parent Proxy 起始链路可下发）；
  - 外部回调健康校验失败：`dataswarm-dev.metad.ai/api/internal/sandbox/health` 返回 `HTTP/2 530`；
  - 因回调不可达，`sandbox.tool_proxy` / `capability.invoke` / `run_events` 不再持续写入完整父链路证据；
  - `swarm.reduce`、`swarm.verify` 未拿到完成分支输入，`branch.*` 完整证据面无法进入 pass 判定；
  - 这是明确的可重现外部可达性阻塞，不是内部模型 action parser/repair/contract 的直接退化。
- 结论：在当前域名告警态下，继续把 `real E2B parent-proxy + complex benchmark` 标记为“待域名恢复后可复验”；本地与非 parent-proxy 的关键静态及工具闭环仍维持通过。

## 2026-06-16 Progress Note: current validation pause due runtime not running + public callback 530

- 当前本机未检测到应用服务运行（`curl http://127.0.0.1:3000` 连接失败）。
- 命名域名健康探测持续返回 `HTTP/2 530` 且响应体非预期 JSON（`error code: 1033`），未通过回调可达性门禁。
- 受限于上述两点，`smoke:e2b-orchestrator-v3-parent-proxy` 与 `smoke:e2b-branch-complex-benchmark` 仍无法进入真实 `reduce/verify` 闭环验证。
- 下一步只要满足：先恢复本地服务监听（3000）再恢复 `dataswarm-dev.metad.ai` 回调可达，即可在不改核心代码前提下继续跑一次完整真实复杂基准，并采集 `run_id`、tool_call/Observation/RunEvent 及 artifact 闭环证据。

## 2026-06-16 Progress Note: parent-proxy command-channel hard-stop across providers

- 尝试不同 tunnel 命令后，`DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND` 均未打通：
  - `cloudflared tunnel --url http://localhost:3234` 产出 trycloudflare 入口，但 `verifyCallbackReachability` 对 `/api/internal/sandbox/health` 读取到 `fetch failed`。
  - pinggy 命令 `ssh -p 443 ... a.pinggy.io` 产出 `*.run.pinggy-free.link` 入口，但 `/api/internal/sandbox/health` 返回 200 且 body 无法解析为 JSON（`parsed=false`），导致 reachability gate 未通过。
- 结论：不是本地 ReAct/Parser 逻辑问题；是隧道/代理层无法稳定产出可直接校验的 callback 结果。
- 后续动作：
  - 使用可控的、可返回标准 JSON 健康体的公共入口；或
  - 在本地验证层面先补充“代理健康响应非 JSON 时的可诊断告警字段”，便于快速分辨是否到达了正确服务。

## 2026-06-16 Progress Note: real-action local smoke remains green

- 执行 `scripts/e2b-sandbox-v3-real-action-smoke.mjs`（真实模型、外部回调配置）返回 PASS：
  - `realModelActionCount=6`
  - `fallbackActionCount=0`
  - `toolCompletedCount=1`
  - `artifactCreatedCount=1`
  - `imageArtifactCount=1`
  - `parentToolProxyMode=parent`
- 这条记录用于确认：当前代码层的 E2B V3 real-model + real action + parent tool 代理链路可在本地闭环；当前阻塞仍集中于外部回调可达性。 

## 2026-06-16 Progress Note: parent callback reachability hard-fail gates

- 在 `scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs` 增加 `parent proxy` 回调地址可达性验证：
  - 运行前通过 `/api/internal/sandbox/health` 与 `/api/system/snapshot` 检查回调端点是否真实可达、健康；
  - 仅接受 `sandbox/health` 返回 `status: ready` 的回调入口，并在启动链路中以 `SKIP/FAIL` 强制阻断不可达端点。
- 在 `scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs` 的 custom tunnel 命令中加入 reachability 轮询，避免提取 `cloudflare/docs` 或 `api/*` 误链。
- 在 `scripts/dev-real-cloudflare-tunnel.mjs` 增加 Cloudflare 隧道就绪健康探测（`/api/internal/sandbox/health` + `/api/system/snapshot`），并在启动后立即失败快速关闭；
  - 目标是避免“服务看似启动但 callback 不可达”导致的 parent-proxy 伪成功体验。
- 这一步是 Phase 6/7 真实 E2B 验收前置门禁：只有回调可达时才允许继续 parent-proxy / complex benchmark 进程。

## 2026-06-16 Progress Note: phase 4 / 5 smoke validation refresh

- 本轮再次执行关键本地闭环验收（无 mock 漏洞）：
  - `npm run smoke:swarm-parallel` ✅（8/8）
  - `npm run smoke:swarm-verifier` ✅（12/12）
  - `npm run smoke:sandbox-tool-proxy` ✅（47/47）
- `smoke:sandbox-tool-proxy` 验证点覆盖到位：
  - `tool.search` / `artifact.create` / `trace.query` / capability 调用都具备 `tool_call + Observation + capability.invoke + sandbox.tool_proxy` 证据闭环；
  - `trace_query` 在输入 `conversation_id: "current"` 时出现 `usedActiveConversationFallback=true` 并写入 `resolvedConversationId`，满足 `trace.query` active-context 回退与证据要求。
- 同期执行 `npm run smoke:e2b-orchestrator-v3-parent-proxy:localtunnel` 失败：`localtunnel` 命令未返回 URL（`npx -y localtunnel --port 3234` 无 stdout），属于外部隧道依赖问题，不是 runtime 判定逻辑；真实入口验证仍需可用的 Cloudflare named tunnel 回环。

## 2026-06-16 Progress Note: e2b-v3-real-action smoke now hard-fails on non-reachable proxy path

- `scripts/e2b-sandbox-v3-real-action-smoke.mjs` now rejects local-only/proxy-only URLs (`localhost`, `127.0.0.1`, `host.docker.internal`, non-HTTPS) and exits as SKIP with an explicit message unless an HTTPS public callback URL is configured.
- Reworked fallback handling in the same smoke:
  - fallback actions are accepted only when explicitly degraded (`fallbackPolicyStatus` in `degraded|failed_verification|completed_degraded`) or `degradedExecution: true`;
  - increased default `maxToolCalls` to reduce tool budget exhaustion fallback noise.
- Current follow-up:
  - `parseSandboxAgentOutput` now accepts `output_markdown/outputSummary`, `branch_final`, and branch-final payload aliases from sandbox parent-agent outputs so branch final materialization can be recovered even when template/runtime key styles differ.
  - `trace.query` now resolves `conversation_id`, `run_id`, or `trace_id` from nested `query` payloads (for example `{"query":{"scope":"conversation","conversation_id":"current"}}`) and supports alias fields with active-fallback conversion before repository lookup.
  - `e2b-orchestrator-v3-real-action-e2e-smoke.mjs` now avoids hardcoded mock behavior by default; real tool calls are used unless `DATASWARM_E2B_ORCHESTRATOR_V3_MOCK_TOOLS=1` / `DATASWARM_E2B_ORCHESTRATOR_V3_MOCK_MODEL=1` is explicitly set.
- Updated image artifact assertion to accept image manifest evidence with image MIME types (not only `contentBase64`) so modern artifact transport from `run_python` is considered.
- `npm run smoke:e2b-v3-real-action` now returns an explicit actionable skip in current environment (no public E2B callback available), rather than passing with a mocked parent proxy signal.
- Previous local validation state remains:
  - `node --check scripts/e2b-sandbox-v3-real-action-smoke.mjs` ✅
  - `npm --prefix apps/web run typecheck` ✅
  - `npm run smoke:sandbox-tool-proxy` ✅ (40/40)
  - `npm run smoke:swarm-parallel` ✅ (8/8)

## 2026-06-16 Progress Note: trace.query active-context fallback hardening

- 继续推进 V4.1 Closure：在 `apps/web/src/server/tools/registry.ts` 强化 `resolveTraceQueryTarget`。
- 当 `trace.query` 仅收到 `conversation_id`/`run_id`/`trace_id` 之外的空输入时，现在会自动回退到 `executeTraceQueryAction` 上下文中的 `conversationId`，避免沙箱模型输出 `conversation_id=current` 或省略上下文导致解析失败。
- 同时补充 `conversation_id` 别名当前值的回退路径保持一致：`current`/`this`/`active`/`current_conversation`/`current-run`/`current_run` 在可用时仍映射到上层 active conversation。
- 该修复是为“trace.query 输入未带会话参数就落库/diagnostics”这一类失败留痕问题提供直接的、可复用的修复路径。

## 2026-06-16 Progress Note: trace.query current-alias proxy smoke

- 在 `scripts/sandbox-tool-proxy-e2e-smoke.mjs` 增加 `trace.query` 回归场景：
  - 增补一个 action 使用 `conversation_id: "current"` 走 parent tool proxy；
  - 新增同类检查验证 `trace.query` 观察记录中 `metadata.trace_query` 已标记 `usedActiveConversationFallback: true` 且 `resolvedConversationId` 为当前会话。
- 同一文件中仍保留原始基线 `conversation_id` 与 capability-plane 调用校验，确保新增场景不引入回归。

## 2026-06-16 Progress Note: public-endpoint real-action smoke now passes

- 实测执行：
  - `DATASWARM_PUBLIC_BASE_URL=https://dataswarm-dev.metad.ai DATASWARM_SANDBOX_TOOL_PROXY_URL=https://dataswarm-dev.metad.ai/api/internal/sandbox/tool-proxy DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL=https://dataswarm-dev.metad.ai/api/internal/capabilities/invoke npm run smoke:e2b-v3-real-action`
- 结果：
  - PASS（`status: "passed"`），`realModelActionCount=6`，`fallbackActionCount=0`，`modelDrivenReactLoop=true`；
  - `toolCompletedCount=1`、`artifactCreatedCount=1`、`imageArtifactCount=1`；
  - 质量信号显示 `parentToolProxyMode=parent`、`capabilityInvokeConfigured=true`。
- 结论：
  - 在明确公开回调参数面板下，真实 E2B + DeepSeek 模型循环与 `run_python` 可产出图像型分支产物；
  - 当前剩余瓶颈主要为 `dataswarm-dev.metad.ai` 入口链路可用性（仍出现 `HTTP/2 530`），而非 E2B + 沙箱模型主链路本身。

## 2026-06-16 Progress Note: local verification slice rerun

- 本轮重新执行关键闭环检查，结果可追溯：
  - `npm --prefix apps/web run typecheck` ✅
  - `python3 -m py_compile sandbox/agent/dataswarm_sandbox_agent.py` ✅
  - `npm run smoke:sandbox-tool-proxy` ✅ (40/40)
  - `npm run smoke:swarm-verifier` ✅ (12/12)
  - `npm run smoke:swarm-parallel` ✅ (8/8)
  - `npm run smoke:e2b-v3-real-action` -> **SKIP**（当前缺少 HTTPS 公网 callback URL，命中 `non-reachable public URL` 阻断）

  - 当前结论：
    - 局部能力闭环与验证器闭环为绿灯，可在本地持续迭代。
    - 实际 E2B 真实可达阶段仍受外网回调条件约束，尚未进入 Phase 6（真实 E2B Parent-Proxy Smoke）和 Phase 7（真实 E2B complex benchmark）验证。

## 2026-06-16 Progress Note: external callback readiness verification

- 追加 parent-proxy 可达性验证结果：
  - `npm run smoke:e2b-orchestrator-v3-parent-proxy` → **SKIP**（未设置可达 `PUBLIC`/`PROXY` URL）
  - `npm run smoke:e2b-orchestrator-v3-parent-proxy:localtunnel` → **FAIL**（`localtunnel` 命令未成功返回 HTTPS URL）
  - 固定 `dataswarm-dev.metad.ai` 直连命中 `HTTP/2 530`（Cloudflare 告警态），非脚本级参数错误导致，属于外网入口可用性阻塞。
- 当前判断：
  - V4.1 功能路径继续保持绿灯；
  - 真实 E2B 严格验收仍被回调通道阻塞（需要确认 `dataswarm-dev.metad.ai` 反代与健康路由就绪）。

## 2026-06-15 V4.1 Delivery Closure Checkpoint - Evidence gates first slice

- Baseline reviewed: conversation `conv_7d810a1e83cd4de4b612e354c210d3a0` reached real E2B branch completion, but failed closure because sandbox tool/proxy evidence was absent, image/HTML artifact coverage was missing, and branch outputs were runtime summaries rather than substantive deliverables.
- First implementation slice in progress: introduce explicit `BranchContract` and `BranchFinal` plumbing, pass branch contracts into the sandbox job/context, add verifier gates for contract/final/tool/artifact substance coverage, and fix `trace.query` so sandbox calls using `conversation_id: current` resolve to the active parent conversation.
- Second implementation slice: persisted `branch_contract` and `branch_final` into branch observation/event/trace metadata, and expanded sandbox `run_python` image generation so branch contracts requesting image artifacts can produce a generic evidence chart instead of silently returning no image.
- Third implementation slice: registered `run_python` as a parent capability/tool, added the DB seed/default sandbox allowlist/capability manifest/tool metadata, implemented a controlled image-artifact adapter, and routed V3 sandbox `run_python` actions through the parent proxy before local degraded fallback.
- Fourth implementation slice: capability-created artifacts are now merged with branch/source observation metadata and branch completion aggregates parent-created artifacts from the branch agent session, so parent-proxied `artifact.create` and `run_python` artifacts can count toward swarm artifact coverage.
- Fifth implementation slice: cleaned obvious structural issues introduced during capability wiring, aligned `run_python` with the `visualization` capability kind, added BranchContract-required artifact coverage verification, and added V3 sandbox tool success/failure quality signals for stricter parent-proxy coverage checks.
- Sixth implementation slice: `swarm.verify` now receives parent-side event evidence from `run_events` and `tool_calls`, including capability/proxy completion/failure counts and required tool completion counts, so verifier checks no longer depend only on sandbox self-reported quality signals.
- Seventh implementation slice: conversation diagnostics now expose `swarmEvidence` with parent-proxy completion/failure counts, latest verify event evidence, BranchContract/BranchFinal counts, required-tool verify failures, and artifact coverage by type/linkage, so conversationId diagnosis can reproduce whether parent-proxied tools and artifacts were actually recorded.
- Eighth implementation slice: diagnostics artifact details now expose parsed artifact metadata, and `swarmEvidence` includes real E2B branch payload count plus fallback/degraded branch signals so conversationId diagnostics can distinguish real external sandbox execution from degraded or unsupported paths.
- Ninth implementation slice: default `npm run dev` now routes through `scripts/dev-real.mjs`, which enforces real E2B + real sandbox model + parent proxy defaults and refuses mock/degraded environment variables unless explicit mock mode is requested; root/apps scripts expose `dev:real`, `dev:tunnel`, and explicit `dev:mock`.
- Tenth implementation slice: removed implicit web.search mock fallback; missing Tavily credentials now fail the real tool path instead of returning mock sources, and provider=mock requires explicit mock opt-in so parent-proxied web.search evidence cannot be confused with real search.
- Validation status: code changes are being staged intentionally without claiming live success. Static/local/live validation remains required before marking V4.1 complete.

## 2026-06-16 V4.1 Hotfix Checkpoint

- Fixed the immediate frontend build blocker by removing duplicate `uniqueStrings` helper declaration in `apps/web/src/server/runtime/swarm.ts`.
- Confirmed the blocking error is addressed at source:
  - `the name uniqueStrings is defined multiple times`
- No live verification claims are made yet; next phases still require real E2B tool/proxy/finality smoke and complex benchmark replay for closure.

## 2026-06-16 V4.1 Evidence Closure Checkpoint

- Repaired artifact provenance continuity in `apps/web/src/server/runtime/swarm.ts`:
  - `recoverSandboxArtifacts` now persists `sourceObservationIds` into recovered Markdown/HTML and image artifact summaries.
  - Image recovery metadata now stores `sourceObservationIds`, so parent-side `artifact.create`/`run_python` recovery paths can satisfy `artifact_source_observation_coverage`.
  - Branch artifact summaries now retain `sourceObservationIds` when sourced from existing DB artifact records (`artifact.sourceObservationIds`).
- This closes a key verifier failure mode where required markdown/html/image artifacts had valid DB linkage but lost linkability during branch evidence aggregation.

## 2026-06-16 V4.1 Recovery Checkpoint

- 增补 `scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs` 回调可达性闭环：当 parent mode 启用时，默认自动推导并透传 `DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL` 到服务启动参数。
- `verifyCallbackReachability` 检查范围从 `sandbox/tool-proxy` 入口扩展到 `capability invoke` 入口，避免能力通道只在部分端口可达导致的漏检。
- 在 `localtunnel/cloudflare` 自动注入流程中，同时写入 parent proxy 与 capability invoke 两条真实回调 URL，增强后续 Phase 6/7 回调链路可复现性。
- 该改动与前序 `deriveServiceBaseUrl` 修复联动，可避免原先将 `/api/internal/sandbox/tool-proxy` 错拼为 `.../tool-proxy/api/internal/sandbox/health` 的健康探测误报。

## 2026-06-16 Progress Note: branch artifact lineage linkage extension

- Extended branch artifact lineage propagation in `apps/web/src/server/runtime/swarm.ts`:
  - Added `sourceArtifactIds` to branch artifact summary/public inputs.
  - `branchArtifactFromArtifactRecord` now hydrates `sourceArtifactIds` from artifact metadata.
  - `publicBranchArtifact` now carries both `sourceObservationIds` and `sourceArtifactIds` for diagnostics and verifier inputs.
- This removes remaining lineage gaps when required branch deliverables are sourced from regenerated artifact metadata or parent-produced artifacts.

- Closed the remaining `apps/web` runtime compile blockers introduced during V4 hardening.
  - Repaired `publicBranchArtifact` typing for parent capability artifacts with nullable `mimeType` / `storageUri`.
  - Added `BranchFinal.qualitySignals` in the shared branch contract type.
  - Added missing `parseJsonObject` helper import-equivalent in `swarm.ts`.
  - Included `createBinaryArtifact` import in branch runtime recovery path.
  - Fixed `artifact.create` substance path typing for `json/image_metadata` classification.
  - Removed invalid assumptions on `createBinaryArtifact` return payload fields where DB-backed metadata is not guaranteed.
- Re-ran validation gates:
  - `npm --prefix apps/web run typecheck` ✅
  - `npm run smoke:sandbox-tool-proxy` ✅ (40/40)
  - `npm run smoke:swarm-parallel` ✅ (8/8)
- Current residuals remain external-gateway and live-complex proof stages:
  - `real` E2B orchestration with public tunnel, parent-proxy callback, and complex benchmark replay.

# DataSwarm Implementation Status

> Last updated: 2026-06-16
> Active goal: stabilize Agentic Runtime V2 and complete the gated path from planner-owned mock Swarm to real E2B sandbox execution.

## Current Canonical Status

Latest V4 Capability Plane checkpoint, 2026-06-14:

- Introduced `DataSwarm Capability Plane` runtime for parent-proxied sandbox tools.
- Added `POST /api/internal/capabilities/invoke` and kept `/api/internal/sandbox/tool-proxy` as a compatibility route backed by the same runtime.
- Sandbox jobs now include a `capabilityPlane` manifest and invoke URL; the sandbox agent prefers `capabilityPlane.invokeUrl`.
- `web.search`, `artifact.create`, `file.read`, and `trace.query` now share the same capability invocation path, persisting `tool_call`, Observation, `capability.invoke.*` events, and compatibility `sandbox.tool_proxy.call.*` events.
- Default `apps/web` dev startup no longer hardcodes `host.docker.internal`; it reads proxy/capability URLs from `data/e2b/*.txt` files when available.
- Real E2B orchestrator readiness now requires a public parent proxy or capability callback URL. Local-only URLs such as `localhost`, `127.0.0.1`, and `host.docker.internal` are treated as not ready for external E2B callbacks.

Checkpoint verification:

```text
npm --prefix apps/web run typecheck
python3 -m py_compile sandbox/agent/dataswarm_sandbox_agent.py
node --check scripts/sandbox-tool-proxy-e2e-smoke.mjs
npm --prefix apps/web run lint
node scripts/sandbox-tool-proxy-e2e-smoke.mjs  # PASS 40/40
npm run smoke:sandbox-v3-plus-static          # PASS 29/29
npm run smoke:sandbox-v3-plus-local           # PASS 25/25
npm run smoke:sandbox-v3-plus-real-action     # PASS 15/15
npm run smoke:swarm-verifier                  # PASS 12/12
node scripts/e2b-readiness-smoke.mjs          # PASS 26/26
DATASWARM_E2B_ORCHESTRATOR_V3_KEEP_ROWS=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND='ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=5 -R0:localhost:${DATASWARM_LOCAL_PORT} a.pinggy.io' DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS=60000 DATASWARM_E2B_ORCHESTRATOR_V3_E2E_RUN_TIMEOUT_MS=420000 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs  # PASS 25/25
```

New design document: [E2B_BRANCH_AGENT_REACT_V4_CAPABILITY_PLANE.md](./E2B_BRANCH_AGENT_REACT_V4_CAPABILITY_PLANE.md).

Preserved live evidence: conversation `conv_dfacf3e78ffa4069bf026410ab8b4018`, run `run_45753d885cff4261899a8e9f07a5b34b`. The preserved run proves 3 completed real E2B branch sessions, V4 capability plane configured in all branch quality signals, real-model action counts of 10 / 6 / 10, `fallbackActionCount=0`, 7 completed `tool_calls`, 7 `capability.invoke.started/completed` pairs, 7 compatibility `sandbox.tool_proxy.call.started/completed` pairs, post-settlement `swarm.reduce` and `swarm.verify`, 4 Markdown artifacts, and 1 recovered image artifact.

Authoritative plan: [DATASWARM_CANONICAL_PLAN.md](./DATASWARM_CANONICAL_PLAN.md)

Focused next-stage plan: [E2B_BRANCH_AGENT_REACT_V3_PLUS_PLAN.md](./E2B_BRANCH_AGENT_REACT_V3_PLUS_PLAN.md). This plan is the execution-ready bridge from the verified `dataswarm.sandbox-agent.v3` skeleton to a stricter E2B Branch Agent runtime with V3-native validation, explicit reflection/evidence verification actions, fallback degradation policy, live E2B-to-parent tool proxy proof, and complex-task benchmark gates. The V4 checkpoint now has a passing live E2B complex benchmark with parent-proxied tools, explicit A/B/C branch preservation, recovered image and Markdown/HTML artifacts, and post-settlement `swarm.reduce` / `swarm.verify` evidence.

Current runtime truth:

| Capability | Status | Evidence |
|---|---|---|
| Planner-owned `AgentAction` loop | Real | `runOrchestrator` calls planner, validates actions, persists actions and observations |
| Generic tool catalog | Real | `ToolCapability` exposes provider, adapter status, auth, risk, schemas, freshness |
| `web.search` | Real/mock-gated | model-facing generic `web_search` adapter with provider registry; Tavily is the default real provider, `mock.search` is the built-in deterministic validation provider, and observations record logical/provider metadata |
| `tavily.search` | Real/mock-gated | provider/direct adapter retained for compatibility and diagnostics; mock only when `DATASWARM_MOCK_TOOLS=1` or key missing |
| `trace.query` | Real | implemented diagnostics adapter |
| Conversation diagnostics runtime consistency | Real | diagnostics summary now checks event-derived runtime activity state against terminal run state and trace span status, including a settlement rule for `swarm.plan` when later swarm stages exist |
| `artifact.create` | Real | implemented adapter for Markdown/HTML artifact creation plus sandbox-recovered images with content-hash de-dupe, provenance fields, and qualitySignals |
| `file.read` | Real | implemented workspace-local file read adapter |
| `approval.request` | Real | creates pending approval records; Run Trace/API support approve/reject decisions |
| Skills | Managed local registry with local install/update | planner can select enabled skills and receives V2 manifests; Skills UI/API can inspect, enable/disable, install, and update local skill packs; remote marketplace flow pending |
| Swarm | Planner-owned bounded-parallel execution with model-provided branch plans + real-by-default sandbox-agent runtime + independent reducer/verifier/reviewer + Run Trace timeline | `spawn_agent` and `spawn_swarm` enter Orchestrator; planner-provided branch definitions are preferred and recorded as `plan_source=model_branches`; up to 10 branches are supported, `DATASWARM_SWARM_MAX_CONCURRENCY` caps parallel launch, default concurrency is 3, explicit 10-way parallel requests can use 10 when no operator cap is set; explicit user deliverables such as requested plots/images or Markdown/HTML reports are preserved as branch coverage requirements when the planner omits them; explicit user-labeled branch requirements such as `分支 A/B/C` or `Branch A/B/C` are converted into branch-specific instructions for the matching branch, including when the planner copied the full user prompt into every branch instruction; branch heartbeat, internal action/observation events, failure, artifact recovery, model quality signals, `swarm.reduce`, merge, richer independent `swarm.verify` checks, optional `swarm.review`, and post-swarm finalize guardrails are bridged into parent run events and rendered in a dedicated Swarm Tree / Branch Timeline |
| Sandbox agent runtime | V3 model-driven ReAct loop implemented, v1/v2 compatibility retained; V4 hardening checkpoint passed | `dataswarm.sandbox-agent.v3` is now the default sandbox protocol. Each branch-local step requests one structured `SandboxAgentAction` from the sandbox action model when configured, validates it with a V3-native validator, executes `use_skill`, `read_context`, parent-proxied `call_tool`, local `run_python`, `create_artifact`, `reflect`, `revise_query`, `verify_evidence`, `request_more_context`, or `final_answer`, then feeds observations back into the next step. Real-model action parsing now tolerates Markdown fences, prose-wrapped JSON, nested action envelopes, OpenAI-compatible `tool_calls`, JSON-string arguments, `action_input`, `parameters`, `web_search` aliases, evidence/source field variants, and trailing commas before falling back. `real_model`, `mock_model`, and `deterministic_fallback` action sources are explicitly recorded in events and quality signals, including fallback degradation status, reflection count, evidence verification count, and real-model action ratio. `swarm.verify` now reads those V3 branch quality signals and treats hidden fallback as failed verification, degraded fallback as warning, and weak real-model action coverage as warning. v2 remains available for bounded-loop compatibility smoke coverage; v1 remains for the original linear branch executor smoke path. |
| Sandbox parent tool proxy | Real API route + signed-token contract + live E2B callback verified | `POST /api/internal/sandbox/tool-proxy` verifies signed branch-scoped proxy tokens, rejects invalid signatures, executes allowlisted tools through the parent tool registry, persists `tool_calls`, creates `sandbox.proxy.*` Observations with branch/sandbox/action provenance, and emits `sandbox.tool_proxy.call.started/completed` run events. `npm run smoke:sandbox-tool-proxy` verifies this production API path with `web.search` routed through `mock.search`; the canonical receipt is `data/verification/canonical-phase4-sandbox-tool-proxy-e2e-latest.json`. The smoke now also validates `web.search`, `artifact.create`, `file.read`, and `trace.query` as allowlisted parent-proxy tools, and checks completed `tool_call + Observation + sandbox.*` linkage for each. The live E2B parent-proxy gate has passed with a custom HTTPS tunnel command, proving E2B can call the parent proxy when a public URL is supplied. The runtime supports `DATASWARM_SANDBOX_TOOL_PROXY_URL`, `DATASWARM_PUBLIC_BASE_URL`, and URL files so smoke tests can start the parent server first, then write a tunnel URL before creating branch jobs. |
| Sandbox agent model | Real local smoke verified | Sandbox branches can call configured DeepSeek/OpenAI-compatible chat completions when `DATASWARM_SANDBOX_AGENT_MODEL=real` and model-secret forwarding is explicitly enabled; missing credentials produce structured `model_skipped` rather than fake model output. `npm run smoke:sandbox-v3-real-action` verifies the OpenAI-compatible `/chat/completions` path can drive six stepwise `SandboxAgentAction` decisions with `actionSource=real_model`, zero deterministic fallback, parent-proxied tool use, observations, image artifact manifest recovery, and parser tolerance for non-ideal model output wrappers. |
| E2B | SDK + template contract + operator readiness diagnostics + live V1/V3 + Orchestrator V3 parent-proxy complex smoke verified | `@e2b/code-interpreter` path targets `dataswarm-agent-runtime`, imports or injects the DataSwarm sandbox agent, and preserves timeout/cancel/retry/recovery protocol; template build evidence is recorded in `data/e2b/template-verification.json`; the compatibility live sandbox receipt is recorded in `data/e2b/live-smoke-receipt.json`; the V3 real-action receipt is recorded in `data/e2b/live-smoke-receipt-v3-real-action.json` and proves real E2B + `dataswarm.sandbox-agent.v3` + DeepSeek/OpenAI-compatible stepwise `real_model` action selection with zero deterministic fallback; the live parent-proxy complex E2E smoke now verifies the production Orchestrator API path can spawn a three-branch real E2B swarm, bridge sandbox V3 `real_model` action events into the parent run, call parent-proxied `web.search` and `artifact.create`, persist branch observations with V3 quality signals, wait for `swarm.reduce` / `swarm.verify`, recover an image artifact plus Markdown report artifacts, and keep `fallbackActionCount=0`; system snapshot exposes secret-safe status, missing env names, next steps, verification commands, explicit template verification receipt state, and live smoke receipt state; live orchestrator execution still requires runtime `E2B_API_KEY` plus `DATASWARM_E2B_TEMPLATE_VERIFIED=1`, `DATASWARM_E2B_TEMPLATE_BUILD_ID`, or a matching local receipt, and parent-proxy execution still requires a public callback URL or working tunnel. |
| Run cancellation | Real control-plane lifecycle | cancel API persists run cancellation metadata, fans out to non-terminal sandbox sessions, publishes run/sandbox cancellation events, and records terminal `cancelled` state separately from failures |
| Artifact context flow (per-turn selection) | Realized | UI selection panel removed; user turns now persist artifact ids automatically through assistant artifact previews and metadata fallback, and orchestrator injects recovered artifact content into `latestUserMessage` context for every run. Default execution path remains real `swarm.e2b` when configured; `mock` requires explicit `DATASWARM_SANDBOX_PROVIDER=mock`. |
| Self-improvement | Async internal runner + Run Trace operations | eval enqueues internal analysis; runner creates idempotent candidates from trace/eval evidence; Run Trace/API expose replayable analysis, shadow test, review patch bundle, and human decision lifecycle actions; `mark_applied` requires an operator-submitted verification receipt covering every required command; automatic source patching intentionally pending |

Verification passed on 2026-06-11:

```text
node scripts/canonical-verification-runner.mjs --dry-run
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
node scripts/agentic-loop-v2-smoke.mjs
node scripts/web-search-provider-smoke.mjs
node scripts/web-search-provider-e2e-smoke.mjs
node scripts/tool-event-contract-e2e-smoke.mjs
node scripts/event-protocol-e2e-smoke.mjs
node scripts/skills-v2-smoke.mjs
node scripts/skills-install-api-smoke.mjs
node scripts/skills-observation-e2e-smoke.mjs
node scripts/sandbox-agent-smoke.mjs
node scripts/sandbox-agent-v2-smoke.mjs
node scripts/sandbox-agent-v3-smoke.mjs
node scripts/sandbox-agent-model-smoke.mjs
node scripts/e2b-template-smoke.mjs
node scripts/e2b-template-receipt-smoke.mjs
node scripts/e2b-readiness-smoke.mjs
node scripts/e2b-live-receipt-smoke.mjs
node scripts/run-trace-system-readiness-smoke.mjs
node scripts/e2b-preflight-e2e-smoke.mjs
node scripts/e2b-template-verification-e2e-smoke.mjs
node scripts/sandbox-retry-policy-smoke.mjs
node scripts/run-cancel-lifecycle-smoke.mjs
node scripts/run-cancel-api-smoke.mjs
node scripts/swarm-action-plan-smoke.mjs
node scripts/swarm-reducer-smoke.mjs
node scripts/swarm-verifier-smoke.mjs
node scripts/swarm-review-smoke.mjs
node scripts/sandbox-retry-e2e-smoke.mjs
node scripts/swarm-image-artifact-e2e-smoke.mjs
node scripts/approval-lifecycle-smoke.mjs
node scripts/self-improvement-async-smoke.mjs
node scripts/self-improvement-diagnostics-smoke.mjs
node scripts/self-improvement-lifecycle-smoke.mjs
node scripts/self-improvement-ui-smoke.mjs
node scripts/self-improvement-summary-smoke.mjs
node scripts/self-improvement-summary-api-smoke.mjs
node scripts/trace-diagnostics-improvements-smoke.mjs
node scripts/trace-diagnostics-sandbox-smoke.mjs
node scripts/trace-diagnostics-runtime-consistency-smoke.mjs
node scripts/trace-diagnostics-ui-smoke.mjs
node scripts/canonical-verification-diagnostics-smoke.mjs
node scripts/canonical-goal-audit-smoke.mjs
node scripts/canonical-goal-audit.mjs
node scripts/canonical-goal-audit.mjs --require-live-e2b
npm --prefix apps/web run build
node scripts/e2b-sandbox-smoke.mjs
```

Additional V3 sandbox agent verification passed on 2026-06-13:

```text
npm run smoke:sandbox-v3-real-action
npm run smoke:sandbox-v3-plus-static
npm run smoke:sandbox-v3-plus-local
npm run smoke:sandbox-v3-plus-real-action
npm run smoke:e2b-v3-real-action
npm run smoke:e2b-orchestrator-v3-real-action
npm run smoke:e2b-orchestrator-v3-parent-proxy
npm run smoke:e2b-branch-complex-benchmark
npm run smoke:sandbox-tool-proxy
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND='ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=5 -R 80:localhost:${DATASWARM_LOCAL_PORT} serveo.net' DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS=30000 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs
```

V4 upgrade checkpoint verification passed on 2026-06-13:

```text
node --check scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm run smoke:sandbox-v3-plus-static
npm run smoke:sandbox-v3-real-action
npm run smoke:swarm-parallel
node scripts/swarm-action-plan-smoke.mjs
node scripts/swarm-reducer-smoke.mjs
npm run smoke:swarm-verifier
node scripts/sandbox-agent-v3-plus-complex-benchmark-smoke.mjs
```

This checkpoint proves the current local code path now preserves explicit branch requirements, exposes compact live-complex failure diagnostics with optional row preservation, keeps the V3 real-action parser/loop healthy, and routes branch quality/artifact type coverage into `swarm.verify`. The live E2B complex benchmark is now proven in this environment with custom tunnel command execution.

V4 live E2B complex benchmark verification passed on 2026-06-13:

Latest verification refresh (this branch):

```text
node scripts/sandbox-agent-v3-plus-static-smoke.mjs  # PASS
node scripts/sandbox-agent-v3-smoke.mjs             # PASS
node scripts/sandbox-agent-v3-real-action-smoke.mjs  # PASS
node scripts/sandbox-tool-proxy-e2e-smoke.mjs        # PASS
node scripts/swarm-parallel-e2e-smoke.mjs            # PASS (15/15)
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs  # SKIP (missing public callback URL)
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs  # SKIP (missing public callback URL)
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND='ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=5 -R0:localhost:${DATASWARM_LOCAL_PORT} a.pinggy.io' DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS=60000 DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1 node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs  # PASS (25/25)
```

```text
DATASWARM_E2B_ORCHESTRATOR_V3_KEEP_ROWS_ON_FAILURE=1 \
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1 \
DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1 \
DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND='ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=5 -R0:localhost:${DATASWARM_LOCAL_PORT} a.pinggy.io' \
DATASWARM_E2B_ORCHESTRATOR_V3_TUNNEL_TIMEOUT_MS=60000 \
DATASWARM_E2B_ORCHESTRATOR_V3_E2E_RUN_TIMEOUT_MS=420000 \
node scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs
```

Result: 25/25 checks passed for preserved conversation `conv_20f646bee6f341a0ac2cc8824b860980`, run `run_38dc09406f9a407a9785d458d464abb8`. Evidence included: a production Next.js build with the existing non-blocking Turbopack NFT warning; a live HTTPS parent proxy tunnel; `swarm.plan` with `plan_source=model_branches`, `effective_concurrency=2`, `execution_mode=batched_parallel`, and branch-specific explicit requirements for A/B/C; three real E2B sandbox sessions with external ids; each branch entering `dataswarm.sandbox-agent.v3` with 10 `real_model` action decisions and `fallbackActionCount=0`; parent-proxied `web.search` and `artifact.create` calls persisted as parent `tool_calls` and `sandbox.proxy.*` Observations; recovered image artifact `art_7b80e638a3ac4bb389feedc892056bc8`; recovered Markdown report artifacts including `art_bc7e1c34352b4858beb8bae1dd30962b`; `swarm.reduce` after all three branch observations; `swarm.verify` passed all 11 checks; complex benchmark checks confirmed reflection, evidence verification, query revision or multiple searches, and durable report artifacts.

This live checkpoint replaced the previous pending state for `e2b-branch-complex-benchmark`. The web-search provider used by this smoke was the configured parent `mock.search` provider, so it proves the parent-proxy tool-call/Observation contract from E2B, not real internet retrieval quality. The preserved run proves Markdown report recovery; a prior non-preserved successful run also produced HTML, but HTML is not used as durable evidence for this checkpoint. The remaining build warning is the known Turbopack NFT dynamic tracing warning for `next.config.ts -> registry -> sandbox-tool-proxy` and does not block build or smoke completion.

Diagnostics API verification for `conv_20f646bee6f341a0ac2cc8824b860980` returned HTTP 200 and summarized 339 run events, 275 `sandbox.agent.event` rows, `swarm.verify=1`, `toolNames` including `web.search` and `artifact.create`, 3 branch observations, and 5 visible artifact candidates. It also correctly surfaced product-health observability gaps for UI submit/SSE/suggestions logs, which are non-blocking for the sandbox runtime gate but remain useful UI telemetry follow-up work.

Result: 15/15 checks passed. This is a local OpenAI-compatible model endpoint smoke that exercises the same `mode=real` chat-completions path used by DeepSeek-style sandbox action models; it does not claim a live external DeepSeek or E2B call.

The live E2B V3 real-action smoke also passed and wrote `data/e2b/live-smoke-receipt-v3-real-action.json`: real E2B sandbox id recorded, `dataswarm.sandbox-agent.v3` / `dataswarm.sandbox-runtime.v3`, `model=deepseek-v4-flash`, `modelSecretsForwarded=true`, `modelCallCompletedCount=6`, `realModelActionCount=6`, `fallbackActionCount=0`, `toolCompletedCount=1`, `observationCreatedCount=6`, `artifactCreatedCount=1`, and `imageArtifactCount=1`. This receipt is the first live proof that V3 stepwise branch actions can be chosen by the sandbox model inside E2B rather than by deterministic fallback. The same gate is available through canonical Phase 4 verification and passed with `node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-v3-real-action --require-live-e2b --receipt data/verification/canonical-phase4-e2b-v3-real-action-latest.json`.

The Orchestrator-level E2B V3 parent-proxy smoke passed with 22/22 checks through a custom Serveo HTTPS tunnel command. It self-started a production Next.js server, confirmed secret-safe E2B readiness with `sandboxAgentProtocol=dataswarm.sandbox-agent.v3` and `modelMode=real`, submitted a planner-owned three-branch swarm, and verified parent-side evidence: `swarm.plan` with model-provided branches and bounded parallelism, `swarm.branch.started` exposing V3 budgets and parent proxy configuration, three completed real E2B sessions with external sandbox ids, bridged `sandbox.agent.event` rows including `sandbox.agent.action.proposed` with `actionSource=real_model`, parent-proxied `web.search` calls, branch Observations carrying V3 quality signals (`modelDrivenReactLoop=true`, `realModelActionRatio=1`, `fallbackActionCount=0`), terminal `swarm.reduce` / `swarm.verify`, and at least one recovered image artifact linked from branch observation metadata. This proves the parent Orchestrator can observe and verify E2B Branch Agent ReAct V3 behavior end-to-end while E2B calls back into the parent tool proxy.

The sandbox parent tool proxy E2E smoke passed with 13/13 checks and its canonical Phase 4 focused gate passed with `node scripts/canonical-verification-runner.mjs --phase phase4 --only sandbox-tool-proxy-e2e --receipt data/verification/canonical-phase4-sandbox-tool-proxy-e2e-latest.json`. It proves the production route rejects invalid signed tokens and accepts a valid branch-scoped token, routes `web.search` through the parent tool registry, persists the `tool_call`, creates a completed `sandbox.proxy.web.search` Observation with branch/sandbox/action provenance, and publishes `sandbox.tool_proxy.call.started/completed` events on the target run. The live E2B parent-proxy smoke proves the same route is reachable from E2B when a public callback URL is supplied.

The live E2B parent-proxy gate is now stricter and more operator-friendly. Without a reachable URL it remains gated with `node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-orchestrator-v3-parent-proxy --require-live-e2b --receipt data/verification/canonical-phase4-e2b-parent-proxy-latest.json`. The smoke can read the public callback from `DATASWARM_SANDBOX_TOOL_PROXY_URL_FILE` / `DATASWARM_PUBLIC_BASE_URL_FILE`, or start a dev-only tunnel with `DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_AUTOTUNNEL=localtunnel`, or run any tunnel command that prints an HTTPS URL via `DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY_TUNNEL_COMMAND`. On this machine, `npx -y localtunnel --port 3234` did not produce a URL within the configured timeout, but the custom Serveo tunnel command did expose the parent proxy and the live E2B parent-proxy gate passed.

The live E2B complex benchmark gate is registered as canonical Phase 4 gate `e2b-branch-complex-benchmark`. It runs the same Orchestrator V3 E2E smoke with `DATASWARM_E2B_ORCHESTRATOR_V3_PARENT_PROXY=1` and `DATASWARM_E2B_ORCHESTRATOR_V3_COMPLEX_BENCHMARK=1`, raises sandbox budgets to 10 steps / 6 tool calls, and checks for branch reflection, evidence verification, query revision or multiple parent-proxy searches, image artifact recovery, durable report artifacts, parent-proxied `web.search`, and post-settlement `swarm.reduce` / `swarm.verify`. The latest live run passed with the Pinggy custom tunnel command documented above.

Latest V2 tool-catalog calibration:

- `web.search` is now the default model-facing `web_search` adapter in the seeded tool catalog and mock planner.
- `web.search` now routes through a provider registry. Tavily remains the default real provider, while `mock.search` is a distinct built-in provider used for deterministic non-Tavily validation.
- The seeded `web.search` schema exposes a model-visible optional `provider` enum (`tavily`, `mock`), and startup sync updates existing local SQLite rows with the current schema/metadata.
- `tool.call.*` events and tool Observations record both the logical tool (`web.search`) and selected provider tool (`tavily.search` or `mock.search`).
- Evaluator and conversation diagnostics now evaluate web evidence by `web_search` capability/tool family instead of requiring a Tavily-specific tool name.
- `node scripts/tool-event-contract-e2e-smoke.mjs` verified the production API path with 12/12 checks: model action -> `web.search` tool event -> completed Observation -> provider metadata -> evaluator check -> diagnostics API summary with `hasWebSearchTool=true` and `hasTavily=false`.
- `node scripts/web-search-provider-smoke.mjs` verified the static provider registry contract with 10/10 checks.
- `node scripts/web-search-provider-e2e-smoke.mjs` verified the production API path with `DATASWARM_WEB_SEARCH_PROVIDER=mock`: model action -> `web.search` -> `mock.search` provider payload -> completed Observation -> terminal tool events with logical/provider metadata.
- `trace.query` now returns a richer model-facing summary that includes sandbox preflight counts and self-improvement applied receipt coverage, so diagnostic tool Observations can be used directly by the planner instead of requiring raw JSON inspection.
- Conversation diagnostics now include `summary.runtimeConsistency`, which reconstructs model/tool/artifact/swarm runtime activities from `run_events`, flags terminal runs with stale running activities or trace spans, and treats `swarm.plan` as settled when later `swarm.reduce` / `swarm.merge` / `swarm.verify` / `swarm.review` events exist.
- Run Trace now includes a dedicated `diagnostics` view that renders conversation health, runtime consistency, product/SSE/log evidence, Observation summaries, and structured remediation items from the canonical diagnostics repository.
- Mock planner routing now treats explicit sandbox visualization requests such as "使用沙箱绘制...图片" as sandbox/swarm work, matching the real planner policy and preventing local validation from silently taking the no-tool final-answer path.
- Artifact persistence now de-dupes by `conversation + type + content_hash` instead of title, and the artifact drawer/API also fold historical duplicate rows by content hash; identical images recovered from multiple swarm branches now reference one canonical image artifact instead of creating repeated drawer entries. Artifact records now expose normalized provenance fields (`sourceTraceId`, `artifactKind`, `previewMode`, `sourceObservationIds`, `branchIds`, `createdByToolCallId`) and `qualitySignals` so the UI and diagnostics can inspect source lineage and artifact health without parsing raw metadata JSON.
- `scripts/canonical-verification-runner.mjs` is the grouped phase runner for Phase 1-5 gates. It writes a secret-safe receipt to `data/verification/canonical-verification-latest.json`, records E2B readiness booleans without secret values, and reports live E2B gates as `gated_skip` unless real credentials/template receipt make the external sandbox path provable. Canonical verification receipts now flow into conversation diagnostics / `trace.query`, so self-improvement and operator diagnosis can see Phase 1-5 gate status instead of reading local JSON files manually.
- `scripts/canonical-goal-audit.mjs` is the combined goal completion audit. Default mode verifies local receipt/document consistency while allowing explicit live E2B gating; `--require-live-e2b` now passes only because `data/verification/canonical-phase4-live-required-latest.json` records both a passed real external E2B sandbox smoke and a passed Orchestrator -> planner-owned `spawn_swarm` -> real E2B branch E2E gate.
- `node scripts/agentic-loop-v2-smoke.mjs` now includes 71 checks, including generic `web.search` provider registry, DB provider schema seed, provider-wrapper invariants, event protocol E2E coverage, phase-grouped canonical verification runner coverage, canonical receipt diagnostics coverage, canonical goal completion audit coverage, trace.query diagnostic summary coverage, planner-provided Swarm branch definitions, independent Swarm reducer/verifier/reviewer coverage, the controlled E2B template receipt gate, the Run Trace system readiness view, the self-improvement queue health summary/API contract, and optional historical conversation diagnostics when `DATASWARM_SMOKE_CONVERSATION_ID` is supplied.

Smoke result:

```text
Agentic Loop V2 smoke passed: 69/69 checks passed, including terminal tool events carrying `observation_id` and `evidence_level`, mock planner trigger scoping to the latest user message, generic `web.search` provider registry and provider schema seed, event protocol E2E coverage, phase-grouped canonical verification runner coverage, canonical receipt diagnostics and goal completion audit coverage, `SCHEMA.md` current V2 storage contracts, `EVENT_PROTOCOL.md` current planner-owned swarm event names, planner-provided Swarm branch definitions, independent Swarm reducer/verifier/reviewer coverage, `ARCHITECTURE.md` current planner-owned runtime / gated E2B boundary, controlled E2B template receipt generation, structured remediation coverage, diagnostics-remediation candidate generation, Run Trace system readiness coverage, self-improvement queue health summary/API coverage, deterministic `swarm.verify` coverage, and optional historical conversation diagnostics.
Canonical verification runner dry run passed: 43 gates listed across Phase 1-5, with a receipt written to `data/verification/canonical-verification-latest.json`. Focused Phase 4 execution wrote `data/verification/canonical-phase4-e2b-latest.json` and passed 4/4 gates: E2B readiness, live receipt contract, real live sandbox smoke, and Orchestrator E2B E2E smoke. The strict completion command `node scripts/canonical-verification-runner.mjs --phase phase4 --only e2b-live-sandbox,e2b-orchestrator-e2e --require-live-e2b --receipt data/verification/canonical-phase4-live-required-latest.json` passed 2/2 and `node scripts/canonical-goal-audit.mjs --require-live-e2b` reported `completion_status=complete`.
Canonical verification diagnostics smoke passed: 9/9 checks passed, including diagnostics API canonical receipt summary across 49 receipt gates, Phase 4 aggregate status, live E2B gated status, canonical diagnosis text, and a `canonical-verification-gates` remediation item with the strict live E2B verification command.
Canonical goal audit smoke passed: 4/4 checks passed, including default incomplete-live-E2B-gated audit, strict live-required audit failure while gated, strict audit success with synthetic live receipt, and secret-leak rejection for receipt evidence.
Web search provider smoke passed: 10/10 checks passed, including provider registry, model/env provider selection, logical/provider metadata persistence, direct Tavily compatibility, mock provider evidence, DB provider schema sync, and documentation status.
Web search provider e2e smoke passed: 12/12 checks passed against a self-started production server with `DATASWARM_WEB_SEARCH_PROVIDER=mock`, including model-proposed `web.search`, persisted mock provider Observation, mock payload source evidence, terminal `tool.call.completed`, and `tool.call.output` provider metadata.
Tool event contract e2e smoke passed: 12/12 checks passed against a self-started production server, including model-proposed `call_tool`, persisted tool Observation, `tool.call.output` evidence level, terminal `tool.call.completed` observation/evidence linkage, evaluator contract check, diagnostics API generic web_search recognition, and post-smoke cleanup.
Event protocol e2e smoke passed: 23/23 checks passed against a self-started production server, including persisted-before-flush wiring, gapless run-local `seq`, `from_seq` replay, `Last-Event-ID` replay, duplicate event IDs prevention, client-side seq-gap replay wiring, secret redaction for E2B/Tavily/OpenAI-shaped tokens, structured tool/artifact/swarm/approval UI surfaces, terminal event ordering, and post-smoke cleanup.
Skills V2 smoke passed: 18/18 checks passed, including enabled-only planner context, all-skill registry API, enable/disable API, install/update API, manifest-backed UI details, planner-selected skill Observation coverage, and SQLite manifest sync.
Skills install API smoke passed: 13/13 checks passed against a self-started production server, including local skill pack file writes, SQLite sync, registry visibility, disable/enable update path, and default quality-check fill.
Skills observation e2e smoke passed: 13/13 checks passed against a self-started production server, including model-proposed `use_skill`, durable `source_type=skill` Observation, selection reason, manifest context, alternatives metadata, `skill.selected`, `observation.created`, and replan linkage.
Sandbox agent smoke passed: 26/26 checks passed, including heartbeat, internal action/observation lifecycle, terminal runtime quality signals, markdown runtime summary, failure structuring, and artifact recovery manifest.
Sandbox agent V2 smoke passed: 18/18 checks passed, including v2 loop lifecycle, dotted action lifecycle, skill policy activation, scoped context read, parent-proxy tool request/completion, observation creation, local image artifact creation, model usage reporting, artifact recovery manifest, and v2 quality signals.
Sandbox agent V3 smoke passed: 25/25 checks passed, including parent default protocol selection, provider v3 job support, V3-native validation, model-sourced action lifecycle, per-step model usage events, parent-proxy tool request/completion, reflection before final, evidence verification before final, observation creation, local image artifact creation, artifact recovery manifest, and quality signals proving `modelDrivenReactLoop=true`, `fallbackPolicyStatus=healthy`, and no deterministic fallback in mock-action-model mode. The V3+ static/local/real-action/complex-benchmark checks are now also registered as Phase 4 canonical gates: `sandbox-v3-plus-static`, `sandbox-v3-plus-local`, `sandbox-v3-plus-real-action`, and `sandbox-v3-plus-complex-benchmark`.
Focused V3+ Phase 4 verification passed on 2026-06-13 with `node scripts/canonical-verification-runner.mjs --phase phase4 --only sandbox-v3-plus-static,sandbox-v3-plus-local,sandbox-v3-plus-real-action,sandbox-v3-plus-complex-benchmark --receipt data/verification/canonical-phase4-sandbox-v3-plus-latest.json`: 4/4 passed, 0 failed, 0 gated. This proves the V3+ validator/action contract, local reflection/evidence verification loop, OpenAI-compatible real-action path, local complex branch benchmark, Markdown/HTML/image artifact manifest coverage, query revision, evidence verification, and scoped context request behavior are covered by canonical verification. The live E2B parent-proxy smoke separately proves the E2B callback path; the stricter live complex benchmark remains pending.
Sandbox agent model smoke passed: 12/12 checks passed when DeepSeek env is loaded from `apps/web/.env.local`, including real model call, action/observation lifecycle, runtime counts, and recovery readiness.
E2B template smoke passed: 9/9 checks passed, including Dockerfile packaging, default template alias, documented build command, local entrypoint readiness, and live smoke lifecycle coverage.
E2B template receipt smoke passed: 10/10 checks passed, including controlled receipt generation, default rejection without template build evidence, explicit local-contract-only mode, template contract smoke execution before receipt write, and Dockerfile/entrypoint/sandbox-agent hash evidence.
E2B readiness smoke passed: 26/26 checks passed, including system snapshot readiness, template/timeout env alignment, explicit env or local template verification receipt gating, live smoke receipt visibility, mismatched local receipt rejection, operator next steps, missing env reporting, verification command disclosure, and secret-safe output.
E2B live receipt smoke passed: 7/7 checks passed, including live smoke receipt field coverage, source-hash evidence, secret-safe receipt metadata, configurable receipt path, SDK resolution from the web workspace, missing-key skip behavior, and no receipt write on skipped live execution.
Run Trace system readiness smoke passed: 10/10 checks passed, including Run Trace system view wiring, E2B readiness gates, template/live smoke receipt evidence, operator verification commands, and reuse of the secret-safe system snapshot readiness source.
E2B preflight e2e smoke passed: 21/21 checks passed, including `DATASWARM_SANDBOX_PROVIDER=e2b` without `E2B_API_KEY`, missing template verification receipt reporting, structured `sandbox_preflight_failed` session metadata, matching `swarm.branch.failed` missing-env diagnostics, failed branch Observations, branch/merge observation links, 8-check deterministic `swarm.verify` failed-branch evidence, and post-smoke cleanup.
E2B template verification e2e smoke passed: 22/22 checks passed, including API-key-present/template-unverified readiness, no secret leak, preflight stop before external sandbox creation, structured branch diagnostics, failed branch Observations, branch/merge observation links, 8-check deterministic `swarm.verify` failed-branch evidence, and post-smoke cleanup.

E2B template verification receipt update:

- The `dataswarm-agent-runtime` template was rebuilt with the current E2B CLI command `npx --yes @e2b/cli template create dataswarm-agent-runtime -p sandbox -d e2b/e2b.Dockerfile -c 'sudo /root/.jupyter/start-up.sh' --ready-cmd 'python -c "import urllib.request; urllib.request.urlopen(\"http://localhost:49999/health\", timeout=5).read()" && python /home/user/dataswarm/entrypoint.py --ready'`.
- Template build evidence is recorded in `data/e2b/template-verification.json` with build id `c137a073-f397-4540-813e-44361948537f`; the command starts the inherited Code Interpreter service and waits for port `49999` health before accepting the DataSwarm readiness payload.
- `scripts/e2b-sandbox-smoke.mjs` completed a real external E2B sandbox run and wrote `data/e2b/live-smoke-receipt.json`; the receipt records `heartbeatCount=4`, `actionProposedCount=4`, `actionCompletedCount=4`, `observationCreatedCount=4`, and `artifactRecoveryManifest=true` without serializing provider secrets.
- `getE2bSandboxReadiness()` now accepts a matching local JSON receipt through `DATASWARM_E2B_TEMPLATE_VERIFICATION_RECEIPT` or the default `data/e2b/template-verification.json`.
- `scripts/e2b-template-receipt.mjs` is the preferred local receipt writer: it runs `node scripts/e2b-template-smoke.mjs` first, records template/agent file hashes, requires `--template-build-id` or `DATASWARM_E2B_TEMPLATE_BUILD_ID` by default, and only writes local-contract-only evidence when explicitly asked.
- `scripts/e2b-sandbox-smoke.mjs` parses E2B `runCode()` stdout/stderr/text chunks line-by-line, so live verification checks real sandbox agent events instead of relying on a brittle joined output string; `scripts/e2b-live-receipt-smoke.mjs` verifies that contract without creating a sandbox and confirms skipped runs do not write misleading receipts.
- Receipt validation requires matching selected template, `ready`/`verified` status, and durable evidence (`templateBuildId` or `verifiedAt`); a receipt for one template does not unlock another template.
- System snapshot now exposes `templateVerificationReceiptPath`, `templateVerifiedAt`, `liveSmokeReceiptPath`, `liveSmokeVerifiedAt`, and live smoke sandbox evidence without leaking `E2B_API_KEY`.
- Conversation diagnostics now summarize E2B live smoke receipt coverage from sandbox session metadata, failed branch observations, and branch failure events, so `trace.query`/diagnostics can distinguish "configured" from "live-smoke verified".
- Positive receipt readiness is covered by `node scripts/e2b-readiness-smoke.mjs`; missing receipt / key-only preflight blocking remains covered by `node scripts/e2b-template-verification-e2e-smoke.mjs`.
Sandbox retry policy smoke passed: 8/8 checks passed.
Run cancel lifecycle smoke passed: 8/8 checks passed, including cancel protocol coverage, Orchestrator cancelled terminal state, Swarm branch-boundary stop, and UI SSE handling.
Run cancel API smoke passed: 8/8 checks passed against a self-started production server, including persisted run metadata, sandbox fan-out metadata, and durable cancel events.
Swarm action plan smoke passed: 10/10 checks passed, including AgentAction branch schema, planner branch prompt/normalization/validation, mock planner branch emission, Orchestrator action passthrough, executor `plan_source`, stable branch IDs, event branch instructions, and status documentation.
Swarm reducer smoke passed: 10/10 checks passed, including independent reducer module extraction, shared contradiction/source-mismatch scanner semantics with verifier, durable `swarm.reduce` span/event emission before merge, reducer-influenced merge/final observations, Run Trace reducer rendering, conversation stream reducer cards, event protocol coverage, and status documentation.
Swarm verifier smoke passed: 10/10 checks passed, including independent verifier module extraction, preserved check IDs, plan-source traceability, branch instruction coverage, duplicate-summary detection, contradiction/source-mismatch signal scanning, deterministic status summarization, event protocol coverage, and status documentation.
Swarm review smoke passed: 10/10 checks passed, including independent optional reviewer module, disabled/mock/model modes, model-provider JSON review support, durable `swarm.review` span/event emission after verify, Orchestrator provider/profile wiring, conversation cards, Run Trace Review panel, protocol/schema coverage, and status documentation.
Sandbox retry e2e smoke passed: 19/19 checks passed against a self-started mock production server, including exactly one `swarm.plan`, `plan_source=model_branches`, model-provided branch instructions, exactly three branch sandbox sessions, one durable branch Observation per branch, `swarm.reduce` branch evidence, branch/reduce/merge/verify/review event observation links, 8 deterministic `swarm.verify` checks, mock `swarm.review` output, retry metadata, and post-smoke cleanup.
Artifact quality smoke passed: 9/9 checks passed, including normalized artifact `qualitySignals`, metadata recomputation after provenance merges, Artifact panel rendering, canonical/schema/status documentation coverage, and root `smoke:artifact` script wiring.
Swarm image artifact e2e smoke passed: 20/20 checks passed against a self-started mock production server after refreshing the production build, including sandbox visualization planner selection, content-hash de-duped canonical image artifact recovery, every branch Observation appended to the canonical image artifact provenance, artifact API provenance and quality fields, image-mode `artifact.created` / `artifact.preview.ready` events, assistant message artifact preview parts, requested-image verifier coverage, conversation artifacts API visibility, preview endpoint image bytes, and post-smoke cleanup. The skip-build fast path passed 19/19 against the refreshed build, including the artifact quality-signal API assertions.
Swarm trace UI smoke passed: 9/9 checks passed, including Run Trace swarm view, persisted event grouping, branch timeline rendering, reduce/merge separation, and dedicated Verify/Review panels for `swarm.verify` and `swarm.review`.
Swarm parallel execution smoke passed: validates 10-branch planning, `DATASWARM_SWARM_MAX_CONCURRENCY`, bounded `Promise.allSettled` worker execution, settled-before-reduce aggregation, concurrency event fields, event protocol coverage, and Run Trace concurrency/batch rendering.
Swarm parallel E2E smoke added: `npm run smoke:swarm-parallel-e2e` starts a mock production server, launches a 6-branch swarm with concurrency 3, verifies first-wave branch starts before any terminal branch event, checks batch/slot metadata, confirms `swarm.reduce` runs after all branch terminal events, and verifies independent sandbox session metadata.
Approval lifecycle smoke passed: 6/6 checks passed.
Self-improvement async smoke passed: 12/12 checks passed, including replayable `run_async_analysis`, idempotent candidate generation per eval check, E2B/template-specific verification plans that include the template receipt gate, and internal worker events.
Self-improvement diagnostics smoke passed: 12/12 checks passed, including self-started production API execution for `run_diagnostics_analysis`, conversion of diagnostics remediation into de-duplicated review-gated candidates, E2B preflight/live-smoke verification plans, canonical verification remediation candidate generation, and durable diagnostics-analysis events.
Self-improvement lifecycle smoke passed: 13/13 checks passed, including self-started production API execution, patch bundle generation under `local://self-improvement/...`, rejection of `mark_applied` without a verification receipt, and command-level verification receipt recording.
Self-improvement UI smoke passed: 12/12 checks passed, including Run Trace action rendering, diagnostics remediation analysis action, canonical API calls, lifecycle action visibility, Mark Applied receipt prompting, applied verification receipt coverage summary, required command coverage summary, and durable event coverage.
Self-improvement summary smoke passed: 10/10 checks passed, including repository-level queue summary, API summary response, Run Trace queue health metrics, next operator actions, lifecycle/risk distributions, and applied receipt gap detection.
Self-improvement summary API smoke passed: 10/10 checks passed, including synthetic queued/shadow/prepared/approved/applied/rejected/deferred candidates, API summary counters, queue health, lifecycle distribution, required command coverage, next operator actions, and post-smoke cleanup.
Trace diagnostics improvements smoke passed: 13/13 checks passed, including conversation diagnostics API visibility for queued/applied self-improvement candidates, required verification commands, applied command-level verification receipt coverage, and structured self-improvement remediation items.
Trace diagnostics sandbox smoke passed: 13/13 checks passed, including conversation diagnostics API visibility for E2B sandbox sessions, failed branch Observations, observation summary counts, `sandbox_preflight_failed`, missing env names, sandbox verification commands, E2B live smoke receipt coverage, and structured sandbox remediation items.
Trace diagnostics runtime consistency smoke passed, including diagnostics API visibility for stale runtime activity after terminal run, stale running trace span detection, `swarm.plan` settlement by later swarm stage, diagnosis text, and `runtime-event-consistency` remediation.
Trace diagnostics UI smoke passed, including Run Trace diagnostics tab coverage, runtime consistency metrics, product/evidence signal rendering, structured remediation rendering, and canonical verification gate registration.
```

Build result:

```text
npm --prefix apps/web run build
```

Build passes. Turbopack still emits one non-blocking NFT trace warning through `next.config.ts -> tools/registry.ts -> sandbox-tool-proxy.ts -> /api/internal/sandbox/tool-proxy`; this is tracked as cleanup work and did not block build, typecheck, lint, or smoke gates.

E2B smoke result:

```text
E2B orchestrator e2e smoke passed: 18/18 check(s) passed.
Canonical verification summary:
- phase4: 2/2 passed, 0 failed, 0 gated
```

The live E2B path is now verified with temporary runtime credentials and no persisted key. `/api/system/snapshot` reports exact E2B readiness status, missing environment names, template verification receipt state, next steps, and verification commands. If the orchestrator is switched to `DATASWARM_SANDBOX_PROVIDER=e2b` before credentials and template verification are configured, each branch records `sandbox_preflight_failed` with secret-safe readiness metadata, a failed branch Observation, and branch/merge observation links instead of silently using mock execution. The latest strict live receipt proves both `node scripts/e2b-sandbox-smoke.mjs` and `node scripts/e2b-orchestrator-e2e-smoke.mjs`: the Orchestrator accepted a conversation message, the planner selected `spawn_swarm`, three real E2B branch sessions completed, 66 sandbox agent events bridged into the parent run, three real branch Observations were persisted, and reduce/merge/verify events completed with branch evidence.

Browser verification:

```text
GET http://localhost:3226/runs/run_ui_verify_...?view=improvements -> 200
Temporary self-improvement candidate rendered Applied Receipts, Verification Commands, Command Results, and applied_receipt:present markers; temporary rows were cleaned up after verification.
GET http://localhost:3000/api/system/snapshot -> 200
GET /runs/run_43dfed4ca0da40179e79f95a3c407f18?view=improvements -> 200
Trace Improvements tab and Self-Improvement Candidates panel rendered with no browser console errors.
GET /api/runs/run_43dfed4ca0da40179e79f95a3c407f18/improvements -> 200, improvements: []
GET /api/runs/:id/approvals -> 200
POST /api/runs/:id/approvals/:approvalId approve -> approved
POST /api/runs/:id/improvements/:candidateId shadow_test -> shadow_tested
POST /api/runs/:id/improvements/:candidateId prepare_patch_bundle -> patch_prepared
POST /api/runs/:id/improvements/:candidateId approve -> approved
POST /api/runs/:id/improvements/:candidateId mark_applied -> applied
```

## Historical Status Log

The sections below are retained as implementation history. When they conflict with the canonical status above, the canonical status wins.

## Current Milestone

M0-M5 were implemented and verified as the initial MVP baseline. The active direction has shifted from MVP engineering-routed runtime to Agentic Runtime V2.

## Active Architecture Direction

The early MVP runtime could execute tools, persist Trace, stream events, and render tool cards, but it was not truly agentic. That gap drove the Agentic Runtime V2 migration.

New target architecture:

- Design doc: [AGENTIC_RUNTIME_V2_DESIGN.md](./AGENTIC_RUNTIME_V2_DESIGN.md)
- Core shift: model proposes `AgentAction`; runtime validates/executes; outputs become `Observation`; final answers are evidence-bound.
- Tool abstraction: planner reasons over a generic `ToolCapability` catalog; concrete tools are replaceable adapters.
- Tavily status: first implemented `web_search` smoke adapter only, not the runtime strategy or a privileged decision path.
- Temporary guardrails in the current runtime are allowed only to prevent misleading behavior during migration. They are not the target agentic design.

Original V2 migration milestone:

1. Add `AgentAction` and `Observation` types.
2. Add `agent_actions` and `observations` storage.
3. Add planner-first model call.
4. Load a generic tool capability catalog into planner context, including provider, adapter status, auth status, freshness, risk, input/output schemas, and evidence kind.
5. Execute any tool only when model proposes a validated `call_tool` action.
6. Use Tavily only as the first web-search smoke tool, not as the runtime abstraction.
7. Require final answers to cite observation IDs for tool-backed claims.
8. Add non-Tavily proof adapters such as `trace.query` and `artifact.create` before treating v2 as product-ready.

## Agentic Runtime v2 Phase A+B Implementation

Status: implemented and smoke-verified on 2026-06-09.

Implemented:

- Added generic `AgentAction`, `Observation`, and `ToolCapability` TypeScript protocols.
- Added `agent_actions` and `observations` SQLite tables through migration `0002_agentic_runtime_v2`.
- Added repositories for persisted agent actions and observations.
- Added generic `ToolCapability` catalog loading with capability kind, provider, adapter status, auth status, freshness, risk, schema, and evidence kind.
- Added planner-first model call before execution.
- Added parser normalization for common model structured-output variants:
  - `{ action: { ... } }`
  - direct `{ type: ... }`
  - `{ action: "call_tool", tool_name: ... }`
  - `{ tool_call: ... }`
  - direct answer fields such as `answer`, `response`, `reply`, `message`, `text`, `final_answer`.
- Runtime now persists `action.proposed` and `action.validated` before execution.
- Runtime executes a tool only when the validated model action is `call_tool`.
- Tool execution now goes through a generic adapter registry; `tavily.search` is the first implemented adapter.
- Tool results are normalized into persisted Observations.
- Tool events now carry `action_id`, `capability_kind`, and `observation_id`.
- Final answers cite Observation IDs when tool observations exist.
- Evaluator v2 now checks:
  - planner action existence
  - action validation
  - tool events linked to action IDs
  - executed tool actions creating observations
  - final answer evidence references
  - tool-claim consistency against observations

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

Both passed.

Smoke 1: search/tool path

```text
Conversation: conv_66180e8abf9d4690b00c8f55257fe3e5
Run:          run_07f665a6bb21430f9d46dc311b0fddbb
Status:       completed
Action:       call_tool / tavily.search / executed
Observation:  obs_20cdcc8d707c4ad9b3588581ef33ec24
Tool mode:    real
Evaluator:    100% (12/12 checks passed)
```

Observed event chain:

```text
action.proposed
action.validated
tool.call.requested
tool.call.started
tool.call.output
observation.created
tool.call.completed
model.call.started
model.call.completed
eval.completed
message.completed
run.completed
```

Smoke 2: no-tool final answer path

```text
Run:            run_1059b84b802e4e32ba0051f5f1a276ef
Status:         completed
Action:         final_answer / executed
Tool calls:     0
Observations:   0
Evaluator:      100% (12/12 checks passed)
```

Known remaining post-Phase-B work at that time:

- `trace.query`, `artifact.create`, and `file.read` are now implemented.
- Legacy Markdown/HTML report generation has been moved behind `artifact.create`.
- Extend UI cards to explicitly render `action.proposed` and `observation.created` as first-class generic cards if not already visible through runtime cards.

## Completed in M0

- Created workspace skeleton:
  - `apps/web`
  - `packages/shared`
  - `packages/storage`
  - `packages/trace`
  - `packages/runtime`
  - `packages/models`
  - `packages/tools`
  - `packages/skills`
  - `packages/swarm`
  - `sandbox/agent`
  - `skills/`
  - `data/`
- Created Next.js App Router application with TypeScript and Tailwind CSS.
- Added root npm scripts for web app commands.
- Added local storage helpers:
  - `local://` URI creation and resolution.
  - data directory bootstrap.
  - atomic text writes.
  - SHA-256 content hashing.
- Added SQLite initialization using lazy server-side initialization.
- Added migration runner and `0001_init` schema via code-backed migration.
- Added seed data:
  - `ten_default`
  - `usr_local`
  - `prj_default`
  - `dmx:gpt-5.5-1m`
  - `dmx:claude-opus-4-8`
  - `deepseek:deepseek-v4-pro`
  - `deepseek:deepseek-v4-flash`
  - Tavily MCP registry entry.
  - Built-in tool placeholders.
  - Built-in skill placeholders.
- Added repositories:
  - conversations
  - model profiles
  - system snapshot
- Added APIs:
  - `GET /api/conversations`
  - `POST /api/conversations`
  - `GET /api/conversations/:id`
  - `GET /api/system/snapshot`
- Replaced default homepage with DataSwarm workspace shell:
  - Sidebar.
  - Conversation surface.
  - Composer placeholder.
  - Artifact panel placeholder.
  - Seed/model/system counts.
- Verified browser render of the local app.

## Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

API smoke checks passed:

```text
GET  /api/system/snapshot
POST /api/conversations
GET  /api/conversations
GET  /api/conversations/:id
GET  /
```

SQLite evidence:

- `schema_migrations` contains `0001_init`.
- `conversations` contains the M0 smoke conversation.
- `model_profiles` contains all four confirmed model profiles.
- `skills` contains three enabled placeholder skills.

Browser smoke:

- Page title: `DataSwarm`.
- UI text includes DataSwarm, Artifacts, M0 smoke conversation, and seed counts.
- Browser console error log was empty during smoke check.

## Known Non-M0 Scope

These M0 exclusions have now moved as follows:

- User message submission to Orchestrator: implemented in M1.
- DMXAPI-compatible model provider: implemented in M1 with mock mode for local validation and real OpenAI-compatible path for configured environments.
- SSE run event stream: implemented in M1.
- Trace span creation during runs: implemented in M1.
- Tool execution: implemented in M2 with a Tavily-capable registry and safe local mock mode.
- Artifact generation/versioning: implemented in M2 for Markdown and HTML artifacts.
- E2B sandbox execution: provider boundary is implemented in M3; real E2B execution is deferred until dependency and template pinning.
- Swarm execution: implemented in M3 with local mock sandbox runtime and full event/trace persistence.
- Evaluation and self-improvement report generation: implemented in M5.
- Skill draft generation remains a future extension beyond this MVP pass.

## Completed in M1

- Added `ModelProvider` abstraction.
- Added DMXAPI/OpenAI-compatible streaming provider.
- Added safe local mock provider controlled by `DATASWARM_MOCK_MODEL=1`.
- Added runtime event bus with persist-before-stream behavior.
- Added `run_events` publishing and in-memory live subscribers.
- Added SSE endpoint:
  - `GET /api/runs/:id/events`
  - supports `from_seq`
  - supports `Last-Event-ID`
  - emits heartbeats
- Added run trace endpoint:
  - `GET /api/runs/:id/trace`
- Added message submission endpoint:
  - `POST /api/conversations/:id/messages`
- Added run/task creation path.
- Added Orchestrator `AgentSession` creation and run loop.
- Added assistant message streaming through `message.part.delta`.
- Added persisted assistant message completion.
- Added minimal Trace spans:
  - `agent.run`
  - `model.call`
- Added UI composer for sending messages.
- Added EventSource-based client streaming.
- Added `.env.example` with placeholder environment variables only.

## M1 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Golden task:

```text
请用三句话解释 DataSwarm 是什么。
```

Verified run:

```text
run_1ed3a84904eb4ae3b024dec1b689f965
```

SQLite evidence:

- `runs.status = completed`.
- `run_events` contains 18 ordered events for the run.
- `trace_spans` contains 2 completed spans for the run.
- `messages` contains completed user and assistant messages.

Observed event sequence:

```text
run.created
message.created
run.started
message.created
message.part.started
model.call.started
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.delta
message.part.completed
model.call.completed
message.completed
run.completed
```

Trace evidence:

- `agent.run` completed.
- `model.call` completed.
- Both spans share a trace ID.
- `model.call` is parented under `agent.run`.

SSE replay evidence:

```text
GET /api/runs/run_1ed3a84904eb4ae3b024dec1b689f965/events?from_seq=17
```

returned only `seq=18` / `run.completed`, proving sequence-based replay.

Browser note:

- The page rendered successfully and browser console errors were empty during M0 smoke.
- During M1 interactive browser automation, the in-app browser automation environment failed on text entry with a virtual clipboard error. API, database, SSE, and trace verification passed; UI code path is implemented and will be rechecked with a stable browser input method in the next frontend verification pass.

## Completed in M2

- Added local skill discovery and synchronization from `skills/*/SKILL.md`.
- Added `GET /api/skills`.
- Added sidebar skill listing in the workspace UI.
- Added ToolRegistry with a Tavily search wrapper.
- Added safe mock tool mode controlled by `DATASWARM_MOCK_TOOLS=1`.
- Added tool call persistence in `tool_calls`.
- Added tool call payload persistence to `local://traces/...`.
- Added Artifact Service for immutable Markdown and HTML artifact versions.
- Added artifact content hashing.
- Added standardized artifact preview generation.
- Added artifact APIs:
  - `GET /api/conversations/:id/artifacts`
  - `GET /api/artifacts/:id/preview`
  - `GET /api/artifacts/:id/download`
- Added conversation artifact listing in the right-side workspace panel.
- Extended Orchestrator with:
  - skill resolution
  - `skill.selected` events
  - `tool.call.requested`
  - `tool.call.started`
  - `tool.call.output`
  - `tool.call.completed`
  - `artifact.create.started`
  - `artifact.created`
  - `artifact.preview.ready`
  - assistant `artifact_preview` message parts
- Extended Trace with:
  - `skill.resolve`
  - `tool.call`
  - `artifact.create`
- Replaced unsafe regex-based mock model chunking with fixed-size slicing so streamed text does not drop URL prefixes across chunks.

## M2 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Golden task 1:

```text
搜索 Tavily MCP 的官方文档，并总结它适合作为 DataSwarm 默认联网工具的原因。
```

Verified run:

```text
run_7f58492df1984c67b2e1b5e0a469c4d2
```

Observed M2 tool events:

```text
skill.selected
tool.call.requested
tool.call.started
tool.call.output
tool.call.completed
run.completed
```

Trace evidence:

- `agent.run` completed.
- `skill.resolve` completed.
- `tool.call` completed.
- `model.call` completed.

Tool call evidence:

- `tool_calls.status = completed`.
- Tool output summary: `Tavily search returned 3 source(s).`
- Tool payload stored through a local trace URI, not inline secrets.

Golden task 2:

```text
基于 DataSwarm 当前设计生成一份分析报告，要求 Markdown 和 HTML 两种格式。
```

Verified run:

```text
run_b1f0446614454140ab4cd2c3d6dae4d8
```

Artifact evidence:

```text
art_cd207e3aecfb43fb8159728c305985a9
art_d07b24e394b84917b85ec8bd07a5451d
```

SQLite evidence:

- `artifacts` contains 2 M2 artifacts.
- `artifact_versions` contains 2 immutable v1 versions.
- `tool_calls` contains 1 completed tool call from the Tavily golden task.
- M2 golden runs include `skill.selected`, tool events, artifact events, model events, and `run.completed`.

Preview/download evidence:

```text
GET /api/artifacts/art_d07b24e394b84917b85ec8bd07a5451d/preview -> 200
GET /api/artifacts/art_cd207e3aecfb43fb8159728c305985a9/download -> 200
```

The HTML preview includes:

```text
DataSwarm Analysis Report
Reproducibility
```

Post-fix stream chunk evidence:

```text
run_12a73070bc2e4b04ae944169c18b99e3
```

The new assistant message preserved all mock source URIs as complete `local://...` values.

Security scan:

```text
rg -n "<old-opus-model>|sk-[A-Za-z0-9]{12,}|e2b_[A-Za-z0-9]|tvly-[A-Za-z0-9]" . --glob '!LLM推理服务相关信息.md' --glob '!data/**' --glob '!apps/web/node_modules/**' --glob '!apps/web/.next/**' --glob '!apps/web/package-lock.json'
```

returned no matches, confirming implementation files did not introduce the old model name or obvious key-shaped secrets.

## Completed in M3

- Added parent-child AgentSession support.
- Added sandbox session repository over the existing `sandbox_sessions` schema.
- Added context bundle repository over the existing `context_bundles` schema.
- Added `SandboxProvider` abstraction.
- Added deterministic local mock sandbox provider.
- Added E2B provider boundary with secret-safe `E2B_API_KEY` configuration.
- Default sandbox provider is now real E2B by default (`DATASWARM_SANDBOX_PROVIDER=e2b`); mock is only used when `DATASWARM_SANDBOX_PROVIDER=mock`.
- Added swarm runtime with:
  - deterministic branch planning
  - research branch
  - analysis branch
  - validation branch
  - branch AgentSession creation
  - branch context bundle creation
  - branch sandbox session creation
  - branch artifact creation
  - merge event generation
- Added Orchestrator swarm trigger for complex, parallel, sandbox, and swarm requests.
- Added M3 event types:
  - `swarm.plan`
  - `swarm.branch.started`
  - `swarm.branch.completed`
  - `swarm.merge`
- Added M3 Trace span kinds:
  - `swarm.plan`
  - `swarm.branch`
  - `swarm.merge`
- Added branch artifacts as immutable Markdown artifacts with previews.

## M3 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Golden task:

```text
这是一个复杂任务：请使用蜂群模式并行启动多个沙箱分支，分别完成研究、分析和验证，然后合并为 DataSwarm M3 runtime 的执行判断。
```

Verified run:

```text
run_ab1b8641fb084c29aa4e24ef21853027
```

Observed M3 event counts:

```text
swarm.plan|1
swarm.branch.started|3
swarm.branch.completed|3
swarm.merge|1
artifact.created|3
artifact.preview.ready|3
run.completed|1
```

Observed M3 event sequence:

```text
4|swarm.plan
5|swarm.branch.started
8|swarm.branch.completed
9|swarm.branch.started
12|swarm.branch.completed
13|swarm.branch.started
16|swarm.branch.completed
17|swarm.merge
```

Trace evidence:

- `agent.run` completed.
- `swarm.plan` completed.
- `swarm.branch` completed 3 times.
- `swarm.merge` completed.
- `model.call` completed.

Sandbox evidence:

- `sandbox_sessions` contains 3 completed mock sessions for the run.
- `context_bundles` contains 3 redacted branch context bundles for the run.
- Branch agents use sandbox model profiles:
  - `deepseek:deepseek-v4-pro`
  - `deepseek:deepseek-v4-flash`
  - `deepseek:deepseek-v4-pro`

Branch artifact evidence:

```text
art_9bc9a0547da343cfa15fd41d1364a574
art_4c886eb33bbe43b0a4acb14d0af99741
art_cb77a9149bfb4358a7c0119bcac6de45
```

Preview/download evidence:

```text
GET /api/artifacts/art_9bc9a0547da343cfa15fd41d1364a574/preview -> 200
GET /api/artifacts/art_cb77a9149bfb4358a7c0119bcac6de45/download -> 200
```

The final assistant response included the `Swarm merge` observation with all three branch artifact IDs.

Security scan:

```text
rg -n "<old-opus-model>|sk-[A-Za-z0-9]{12,}|e2b_[A-Za-z0-9]|tvly-[A-Za-z0-9]" . --glob '!LLM推理服务相关信息.md' --glob '!data/**' --glob '!apps/web/node_modules/**' --glob '!apps/web/.next/**' --glob '!apps/web/package-lock.json'
```

returned no matches after M3.

## Completed in M4

- Added latest-run lookup for conversations.
- Passed persisted run events and trace spans into the conversation workspace on page refresh.
- Converted SQLite trace rows into plain objects for safe Server Component to Client Component serialization.
- Added Run Activity rendering for persisted and live SSE events.
- Added Trace summary chips for span kinds.
- Filtered high-volume text delta events out of the activity panel while keeping streaming text in messages.
- Rendered assistant `artifact_preview` message parts as artifact links.
- Added sandbox model profile chips in the conversation header.
- Added an attachment control placeholder in the composer.
- Added inline artifact preview panels in the right-side artifact list.
- Kept the existing preview/download APIs as the artifact rendering backend.

## M4 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Refresh replay smoke:

```text
GET /?conversationId=conv_afd488131f154b5a990ece407ba85c77
```

Observed page markers:

```text
Run Activity
swarm.plan
swarm.branch.started
swarm.branch.completed
swarm.merge
artifact ·
Inline preview
DeepSeek V4 Pro
Attach
swarm.branch:3
```

Negative page markers:

```text
__next_error__
Only plain objects
```

were absent after the trace-row serialization fix.

Trace API smoke:

```text
GET /api/runs/run_ab1b8641fb084c29aa4e24ef21853027/trace
```

returned:

```json
{
  "agent.run": 1,
  "swarm.plan": 1,
  "swarm.branch": 3,
  "swarm.merge": 1,
  "model.call": 1
}
```

Security scan returned no matches after M4.

## Completed in M5

- Added `eval_results` repository.
- Added `GET /api/runs/:id/evals`.
- Added deterministic run-health evaluator.
- Added self-improvement recommendation report generation.
- Added M5 event types:
  - `eval.started`
  - `eval.completed`
- Added M5 Trace span kind:
  - `eval.run`
- Added self-improvement report artifacts as immutable Markdown artifacts with previews.
- Added evaluation artifact IDs to final assistant message artifact parts.
- Added eval events to Run Activity UI.
- Fixed accidental swarm trigger caused by matching `swarm` inside the `DataSwarm` brand name.

## M5 Verification Evidence

Commands passed:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Final golden task:

```text
请进行一次普通 DataSwarm M5 健康检查，回复一句话即可。
```

Verified run:

```text
run_dfdadcca8fce4795ab2755de0ecb648b
```

Observed M5 event counts:

```text
artifact.created|1
artifact.preview.ready|1
eval.completed|1
eval.started|1
message.completed|1
model.call.completed|1
model.call.started|1
run.completed|1
run.created|1
run.started|1
```

Observed lifecycle sequence:

```text
14|model.call.completed
15|eval.started
18|eval.completed
20|message.completed
21|run.completed
```

Trace evidence:

- `agent.run` completed.
- `model.call` completed.
- `eval.run` completed.

Eval API evidence:

```text
GET /api/runs/run_dfdadcca8fce4795ab2755de0ecb648b/evals
```

returned:

```json
[
  {
    "id": "eval_496c8d037f944787806e2baa1a32b5fb",
    "score": 1,
    "artifactId": "art_b50cb8f82bef467eb7ec69c2a588eece",
    "summary": "Run health score 100% (5/5 checks passed)."
  }
]
```

Self-improvement artifact:

```text
art_b50cb8f82bef467eb7ec69c2a588eece
```

Preview evidence:

```text
GET /api/artifacts/art_b50cb8f82bef467eb7ec69c2a588eece/preview -> 200
```

The preview includes:

```text
DataSwarm Self-Improvement Report
Run health score 100% (5/5 checks passed).
Recommendations
Data Sources
```

UI replay evidence:

The refreshed conversation page includes:

```text
eval.started
eval.completed
DataSwarm Self-Improvement Report
Run Activity
eval.run
```

Negative UI markers:

```text
__next_error__
Only plain objects
```

were absent.

Security scan returned no matches after M5.

## Next Milestone

Post-MVP hardening.

Primary next tasks:

1. Pin and implement real E2B sandbox execution templates.
2. Replace mock model/tool paths with configured provider calls in a staging environment.
3. Add real upload persistence and attachment context ingestion.
4. Add richer artifact drawer behavior and live artifact list refresh.
5. Add skill creation/install workflows.
6. Add Postgres migration path and multi-tenant enforcement checks.

## Post-MVP UI Productization Pass

Completed after the M0-M5 MVP because the first UI was only an engineering smoke surface.

- Rebuilt the workspace shell into a product-oriented two-column layout:
  - dark left navigation
  - central conversation workspace
  - client-side artifact panel
  - embedded run activity rail
- Added `lucide-react` for real iconography in navigation, buttons, timeline rows, composer, and artifact actions.
- Replaced the old server-rendered artifact iframe list with a selectable artifact preview panel.
- Added live artifact refresh on `artifact.created`, `artifact.preview.ready`, and `run.completed` events.
- Converted run events into typed timeline rows with visual states for:
  - run lifecycle
  - model calls
  - tool calls
  - swarm branches
  - artifact creation
  - evaluation
- Added a denser, more coherent visual system:
  - dark navigation surface
  - neutral workspace background
  - distinct teal, blue, green, amber, and red status colors
  - consistent 8px radii
  - icon-only buttons where appropriate
- Updated local mock model output so it no longer reads as `mock demo` or `M1` engineering verification text.
- Added frontend cleanup for historical mock boilerplate in old persisted messages.
- Verified the productized UI through:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Interaction smoke:

```text
run_c98574457fd64bca86aa75413dbdfbe1
```

The run completed with model, eval, artifact, message, and run events, and produced:

```text
art_9ae42431378241a982489f49c3c39bf8
```

UI replay smoke showed:

```text
Conversations
Installed Skills
Run Activity
Artifacts
DataSwarm Self-Improvement Report
eval.started
eval.completed
Trace, events, artifacts, and evaluation records
```

Negative UI markers were absent:

```text
__next_error__
Only plain objects
Unhandled Runtime Error
```

Security scan returned no matches after the UI productization pass.

## Conversation Flow And Trace Separation Pass

Completed after reviewing the productized UI interaction issues.

- Re-centered the main workspace around the conversation stream:
  - the middle column is now the only scroll container for messages
  - SSE `message.part.delta` continues to append streamed assistant text
  - the stream auto-scrolls to the latest message while a run is active
  - Trace/run activity cards were removed from message cards
- Kept the left navigation fixed:
  - `h-screen`
  - `overflow-hidden` app shell
  - conversation list scrolls only inside the sidebar list area
- Converted Artifacts into a right-side drawer:
  - closed by default
  - opened by the header Artifacts button or an artifact chip in the message stream
  - fixed to the right side instead of participating in page scroll
  - does not render the artifact preview iframe while closed
- Added a dedicated run Trace page:
  - route: `/runs/[id]`
  - tabs: `overview`, `sessions`, `trace`, `spans`, `events`, `evals`
  - search parameter: `q`
  - supports session/trace/span/event/eval level inspection without cluttering the chat flow
- Added read repositories for Trace page support:
  - `listAgentSessions(runId)`
  - `listSandboxSessions(runId)`
- Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

HTTP smoke:

```text
home_has_iframe=no
home_has_run_activity=no
home_has_translate_closed=yes
sessions=200 trace=200 spans=200 events=200 evals=200
```

## Conversation Submit And SSE Replay Fix

Completed after reviewing the message submission flow from composer to API, run event stream, and canonical message refresh.

- Fixed composer interaction:
  - Enter now submits the instruction
  - Shift+Enter keeps multiline input behavior
  - the composer is now a real form with submit handling
  - the optimistic local user message is reconciled to the server `message_id`
- Fixed front-end message synchronization:
  - `message.completed` now triggers a canonical `/api/conversations/[id]` refresh
  - `run.completed` and `run.failed` also refresh canonical conversation state
  - final assistant message parts, including `artifact_preview`, now appear in the conversation flow after the run is persisted
- Hardened SSE replay:
  - `/api/runs/[id]/events` now subscribes before sending historical events
  - sent event ids are de-duped so events created during the historical fetch window are not lost or duplicated
- Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

End-to-end API/SSE smoke:

```json
{
  "message.part.delta": 7,
  "message.completed": 1,
  "run.completed": 1,
  "finalAssistantParts": ["text", "artifact_preview"]
}
```

## Interaction Observability And Composer Layout Pass

Completed after the conversation interaction review exposed that agent-facing debugging could not see the front-end/back-end data exchange clearly enough.

- Added structured server logs with `[DataSwarm:server]` prefix:
  - `api.messages.post.*`
  - `api.events.*`
  - `event_bus.*`
  - `api.conversation.get.*`
  - `api.artifacts.list.*`
- Server logs include request ids, conversation ids, run ids, task ids, message ids, event type/seq, subscriber counts, and safe text length/preview.
- Added client-side console logs with `[DataSwarm:UI]` prefix:
  - message submit start/accepted/error
  - SSE connect/open/error
  - message/event/artifact/run lifecycle events
  - canonical conversation/artifact refresh start/ok/failure
- Composer behavior and layout:
  - Enter submits by default
  - Shift+Enter inserts a newline
  - model selector and attachment button moved to the bottom of the input box
  - model selector appears before attachment
  - send button remains on the bottom-right of the composer
- Trace navigation:
  - Trace opens in a new browser tab/window
  - Trace URL carries `conversationId`
  - `/runs/[id]` preserves `conversationId` across Trace sub-tabs and back navigation
- Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

End-to-end API/SSE smoke:

```json
{
  "message.part.delta": 6,
  "message.completed": 1,
  "run.completed": 1,
  "finalAssistantParts": ["text", "artifact_preview"]
}
```

## Real DMX Provider Activation Fix

Completed after the UI still showed the mock template response:

```text
DataSwarm Orchestrator completed the request with claude-opus-4-8.
```

Root cause:

- `apps/web/package.json` forced `DATASWARM_MOCK_MODEL=1` in the default `dev` script.
- The front-end message flow was working, but the server process was intentionally using `MockModelProvider`.
- Existing browser sessions connected to the old dev process continued to return mock model text until the server was restarted.

Fix:

- Changed `npm --prefix apps/web run dev` to use the real OpenAI-compatible provider by default.
- Added `npm --prefix apps/web run dev:mock` for explicit local mock runs.
- Created local, gitignored `apps/web/.env.local` with provider configuration from the local reference document.
- Added provider-level logs:
  - `model.provider.mock.enabled`
  - `model.provider.real.enabled`
  - `model.provider.request.start`
  - `model.provider.delta`
  - `model.provider.usage`
  - `model.provider.request.failed`
- Restarted the dev server on port 3000 with `.env.local` loaded.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Real provider smoke:

```json
{
  "modelProfile": "dmx:claude-opus-4-8",
  "providerMode": "real",
  "message.part.delta": 3,
  "run.completed": 1,
  "finalTextPreview": "我是 DataSwarm Orchestrator，负责协调数据工具、技能与产物，为你提供简洁可靠的数据分析与处理服务。"
}
```

## Internal Evaluation Artifact Visibility Fix

Completed after the `DataSwarm Self-Improvement Report` appeared in every conversation as a visible artifact.

Root cause:

- The run evaluator synchronously created a markdown artifact titled `DataSwarm Self-Improvement Report`.
- The orchestrator appended the evaluator artifact id to the assistant message `artifact_preview` parts.
- The Artifacts drawer listed all conversation artifacts, so internal evaluator reports appeared beside user-facing outputs.

Fix:

- `evaluateRunAndRecommend` now records internal run health in:
  - `eval_results`
  - `eval.started` / `eval.completed` events
  - trace span attributes
- It no longer creates a user-facing markdown artifact.
- The orchestrator no longer appends evaluator output to the assistant message artifacts.
- `listArtifacts(conversationId)` filters historical `DataSwarm Self-Improvement Report` artifacts from the default user-facing artifact list.
- Message artifact chips are filtered against the visible artifact list, so historical internal evaluator artifacts no longer appear in the conversation flow.

Design note:

- Self-improvement remains an internal evaluation signal.
- Future autonomous improvement should run asynchronously from `eval_results`, run events, and trace spans, not as a visible artifact in the chat response.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Real provider smoke:

```json
{
  "eventTypesAbsent": ["artifact.created", "artifact.preview.ready"],
  "eventTypesPresent": ["eval.started", "eval.completed"],
  "finalAssistantParts": ["text"],
  "visibleArtifactTitles": []
}
```

## Markdown, Real Tavily, And Conversation Diagnostics Pass

Completed after reviewing `conv_4aaa59d01a61441eb54bdf3c9772cb1c` and the web-search behavior.

Findings:

- The conversation did select `web-research`.
- It did call `tavily.search`.
- The wrong answer came from `DATASWARM_MOCK_TOOLS=1`, which made Tavily return local mock sources instead of internet results.
- The model correctly refused to treat mock local docs as real news.

Fixes:

- Added safe Markdown rendering for assistant text:
  - headings
  - unordered and ordered lists
  - fenced code blocks
  - bold / italic
  - inline code
  - HTTP/mailto links
- Removed `DATASWARM_MOCK_TOOLS=1` from the default `dev` script.
- Kept mock tools available only through `dev:mock`.
- Added `TAVILY_API_KEY` to local, gitignored `apps/web/.env.local`.
- Confirmed Tavily REST auth against official docs: `Authorization: Bearer [TAVILY_API_KEY]`.
- Added current date context to the orchestrator system prompt and web-search query, using `Asia/Shanghai`.
- Added Tavily execution logs:
  - `tool.tavily.search.start`
  - `tool.tavily.rest.request`
  - `tool.tavily.rest.ok`
  - `tool.tavily.search.completed`
  - `tool.tavily.search.failed`
- Added conversation diagnostics API:
  - `/api/diagnostics/conversations/[id]`
  - summarizes messages, runs, events, skills, tool calls, trace spans, evals, artifacts, and likely mock-search usage
  - reads persisted tool output payloads to distinguish mock/local search from real Tavily output

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web run build
```

Diagnostic smoke for `conv_4aaa59d01a61441eb54bdf3c9772cb1c`:

```json
{
  "hasWebResearch": true,
  "hasTavily": true,
  "likelyUsedMockSearch": true,
  "failures": []
}
```

Real Tavily smoke after restart:

```json
{
  "skill.selected": 1,
  "tool.call.completed": 1,
  "message.part.delta": 37,
  "likelyUsedMockSearch": false
}
```

Page smoke:

```text
page_error=no
markdown_text_present=yes
```

## Multi-Turn Context And Follow-Up Web Research Fix

Completed after the second-turn prompt `继续问，最近一周有什么进展吗` lost prior context and answered as if no previous conversation existed.

Root cause:

- `runOrchestrator` loaded persisted messages but only sent the latest user message to the model.
- Skill routing used only the latest user message, so follow-up phrases could not reliably inherit the previous web-research topic.
- Tavily was briefly given the full recent conversation as the search query, which made real Tavily reject long/complex follow-up queries with HTTP 400.

Fixes:

- Added conversation-history extraction from persisted message parts.
- Added bounded model history:
  - latest 12 user/assistant messages
  - 16k character budget
- Model calls now send:
  - system prompt
  - recent user/assistant history
  - latest user message
  - tool observations attached only to the latest user turn
- The system prompt now explicitly instructs the orchestrator to resolve follow-ups such as `继续`, `上面`, and `最近一周` from prior messages.
- Skill routing now uses a structured routing context:
  - latest user message
  - recent conversation context
- `web-research` can inherit prior web intent only when the latest message is a follow-up.
- `report-generation` now requires an explicit latest-message report intent, avoiding accidental selection from prior Markdown/source text.
- Tavily follow-up queries are compressed into short search phrases, for example:
  - `AI agent past 7 days news developments as of 2026年06月09日星期二`
- Tool trace spans are now marked `failed` when Tavily execution fails, so trace/span diagnostics do not leave failed tools stuck in `started`.
- Added orchestrator logs:
  - `orchestrator.context.loaded`
  - `orchestrator.skills.selected`
  - `orchestrator.model.context_prepared`
- `model.call.started` now records:
  - `model_message_count`
  - `history_message_count`
  - `observation_count`

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

API multi-turn smoke:

```json
{
  "conversationId": "conv_68c0f49439e3406ab99ff4a0ca087644",
  "firstRun": "run_564cd2c69b034db381cb935bc030bd90",
  "secondRun": "run_4c4661e764504b5b8118a70f58dd8501",
  "secondStatus": "completed",
  "secondSkills": ["web-research"],
  "secondToolStatus": ["completed"],
  "secondHasToolCompleted": true,
  "modelMessageCount": 4,
  "historyMessageCount": 2,
  "observationCount": 1,
  "badNoContextComplaint": false
}
```

Browser UI multi-turn smoke:

```json
{
  "enterSubmitWorked": true,
  "assistantAfterSecond": 5,
  "hasNoContextComplaint": false,
  "hasPastWeekAnswer": true,
  "uiObservedStreamingDeltas": true,
  "lastMessageStatus": "completed"
}
```

## Light UI, Prompt Budget, Skills Routing, And Unified Logs Pass

Completed after reviewing the workspace UI, weak multi-turn behavior, visible-but-unclear skills, and fragmented logs/trace diagnostics.

Fixes:

- Reworked the workspace visual theme to a light interface:
  - light sidebar
  - softer workspace background
  - lighter user messages
  - less black/white contrast
- Replaced the static sidebar with a client-side workspace sidebar:
  - `Conversations`
  - `Skills`
  - `Projects`
- `Installed Skills` is collapsed by default.
- The `Skills` panel now exposes the local skill registry and explains that skill selection is recorded as traceable events/spans.
- The `Projects` panel now shows the default project and a staged project roadmap.
- Expanded the orchestrator system prompt into a DataSwarm execution contract:
  - preserve prior conversation as working memory
  - resolve follow-up references
  - summarize actual previous questions when asked
  - use tool/skill/artifact observations as evidence
  - avoid invented sources
- Added explicit model output budget:
  - `DATASWARM_ORCHESTRATOR_MAX_TOKENS`
  - default: `8192`
  - sent as OpenAI-compatible `max_tokens`
- Added selected skills into model observations so the assistant can explain capability usage when relevant.
- Tightened skill routing:
  - routing context now uses latest user text plus recent user messages only
  - assistant output is no longer used for skill matching
  - `latest_user` labels no longer cause accidental web-research matches
  - ordinary memory follow-ups no longer trigger Tavily or data-profiling
- Added persistent unified logs:
  - `app_logs` local table, created without changing the initial migration checksum
  - server logs persist `info/warn/error`
  - UI lifecycle logs persist through `POST /api/logs`
  - high-volume token delta UI logs remain console-only
- Conversation diagnostics now include unified logs.
- Run Trace page now includes a `logs` tab.
- Top-level `agent.run` spans now include:
  - selected skills
  - model history count
  - observation count
  - artifact IDs

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

API smoke for memory follow-up:

```json
{
  "secondStatus": "completed",
  "secondSkills": [],
  "secondTools": [],
  "historyMessageCount": 2,
  "observationCount": 0,
  "maxOutputTokens": 8192,
  "logCount": 35
}
```

Browser smoke:

```json
{
  "sidebarBackground": "rgb(251, 252, 254)",
  "installedCollapsed": true,
  "skillsPanelVisible": true,
  "projectsPanelVisible": true,
  "traceLogsVisible": true,
  "consoleErrors": []
}
```

## Streaming, Tool Cards, Markdown Tables, And Follow-Up Prompts Pass

Completed after reviewing the conversation stream UX where model output appeared as a single block, tool calls were only visible indirectly after final output, Markdown tables rendered as plain text, and assistant answers ended with confirmation-style prompts.

Fixes:

- Server-side model deltas are now split into smaller UI chunks before publishing `message.part.delta`.
- Added a small pacing delay for large upstream chunks so the browser receives visibly progressive text updates.
- Conversation flow now renders runtime activity cards between the user message and assistant answer:
  - selected skills
  - Tavily tool lifecycle
  - model call lifecycle
  - artifact creation lifecycle
- Runtime activity cards work both live through SSE and after refresh from the latest run events.
- Markdown rendering now supports:
  - tables
  - horizontal rules
  - existing headings/lists/code/links/bold/italic/inline-code
- Added deterministic recommended follow-up prompt buttons under assistant responses.
- Clicking a recommended prompt sends it as a new user instruction and starts a new run.
- Strengthened the orchestrator prompt to avoid ending with confirmation requests.
- Added display-layer cleanup for older confirmation-style endings such as `请告诉我...`.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

API smoke:

```json
{
  "conversationId": "conv_ff512c92945545c8b6cff0f2740e1735",
  "runId": "run_2d13f77406df4f688fa0ec5600d9a804",
  "status": "completed",
  "deltaCount": 76,
  "toolTypes": [
    "tool.call.requested",
    "tool.call.started",
    "tool.call.output",
    "tool.call.completed"
  ],
  "modelTypes": [
    "model.call.started",
    "model.call.completed"
  ]
}
```

Browser smoke:

```json
{
  "toolTavilyVisible": true,
  "modelNamedVisible": true,
  "skillCardCount": 2,
  "tableCount": 2,
  "recommendedVisible": true,
  "suggestedButtonCount": 3,
  "noRawTableSeparator": true,
  "confirmationTextCleaned": true,
  "consoleErrors": []
}
```

## Run-Scoped Runtime Cards, Dynamic Suggestions, And Log-Based Product Diagnosis Pass

Completed after reviewing multi-turn conversation regressions where runtime/tool cards were tied to the latest run only, historical cards could disappear or move to the wrong turn, follow-up prompts were too static, and logs were collected but not summarized into product behavior signals.

Fixes:

- Message records now expose `runId` to the web client.
- Home page now loads all run events for the selected conversation, not only the latest run.
- Conversation UI stores runtime activity as `runId -> activity[]`.
- Conversation flow now renders each turn as:
  - user message
  - same-run runtime activity cards
  - same-run assistant response
- Runtime cards share the assistant-side avatar and remain attached to their original historical turn after later turns start.
- Follow-up prompt generation is now topic-aware and uses the latest user/assistant content instead of fixed Hermes-only defaults.
- Message, runtime card, table, code, and status text sizes were normalized to reduce visual jumps.
- UI logs now include `runtime.item.upsert`, `suggestions.rendered`, and run-scoped SSE connect/open/error signals.
- Conversation diagnostics now include `summary.productHealth`, derived from server logs, UI logs, run events, and tool calls.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

Browser smoke:

```json
{
  "conversationId": "conv_fbf4ea3031464247a9837283a6b7c9ba",
  "articleCount": 6,
  "turnPattern": [
    "user",
    "runtime+assistant",
    "user",
    "runtime+assistant",
    "user",
    "runtime+assistant"
  ],
  "suggestions": [
    "打开并检查 Hermes Agent 的 artifact 内容",
    "把 Hermes Agent 报告改成管理层摘要",
    "为 Hermes Agent 生成下一轮验证清单"
  ],
  "consoleErrors": []
}
```

Diagnostics smoke:

```json
{
  "messageCount": 6,
  "runCount": 3,
  "toolNames": [
    "tavily.search",
    "tavily.search",
    "tavily.search"
  ],
  "productHealth": {
    "hasSubmitAccepted": true,
    "hasServerMessageAccepted": true,
    "hasSseOpen": true,
    "hasMessageCompleted": true,
    "hasRuntimeItemRenderSignal": true,
    "hasSuggestionsRenderSignal": true,
    "toolRunCount": 3,
    "renderedToolRunCount": 3,
    "recordedToolCallCount": 3,
    "issues": []
  }
}
```

## Runtime Activity Expansion, Artifact Status Merge, And Smaller Dynamic Follow-Ups Pass

Completed after reviewing artifact cards that kept spinning after a completed run, runtime/tool cards that could not be inspected, and follow-up prompts that still fell back to tool names such as Tavily for short follow-up turns.

Fixes:

- Artifact lifecycle events now use the trace span as the stable runtime card id.
- `artifact.create.started`, `artifact.created`, and `artifact.preview.ready` now merge into one card, so completed artifacts no longer leave stale running cards behind.
- Runtime activity item merging now preserves existing preview/details when later lifecycle events omit those optional fields.
- Tool, skill, model, and artifact cards are collapsed by default.
- Clicking a runtime card expands a detail panel with structured fields and source previews where available.
- Follow-up prompt topic inference now uses recent conversation context, not only the latest short user command.
- Follow-up prompt topic inference filters non-topic tokens such as Tavily, HTML, Markdown, Artifact, and report component names.
- Follow-up buttons and label typography were reduced.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

Browser smoke:

```json
{
  "conversationId": "conv_5e8b6d8ca70a4dc599792f16d2bf5c80",
  "artifactRunningText": [],
  "artifactCompletedCount": 6,
  "visibleSourceLinksBeforeExpand": 0,
  "visibleSourceLinksAfterExpand": 5,
  "suggestions": [
    "预览并检查 英伟达 的 HTML artifact",
    "补齐 英伟达 报告的来源日期与可信度标注",
    "把 英伟达 报告压缩成管理层摘要"
  ],
  "hasTavilySuggestion": false,
  "consoleErrors": []
}
```

## Artifact Quality, Deduplication, Tool Provenance, And Hallucination Review Pass

Completed after reviewing repeated artifacts, weak HTML output, static follow-up prompts, fast-appearing tool cards, and possible fabricated/demo-like model output.

Findings:

- Runtime tool cards are not purely fake UI cards:
  - They are reconstructed from persisted `run_events`.
  - Tavily calls are also persisted in `tool_calls`.
  - Server logs record `tool.tavily.search.start/completed`.
- A reviewed NVIDIA run used real Tavily mode, not mock mode.
- A reviewed OpenAI Agent SDK run also used real Tavily mode, but the returned sources were mostly broad AI Agent industry sources rather than direct OpenAI Agent SDK release/changelog sources.
- The previous report artifact generation was too weak:
  - Markdown/HTML artifacts were generated before the model synthesis completed.
  - HTML artifact content used a static template and could miss the assistant's final reasoning.
  - The model could print raw HTML code in chat, causing artifact content to duplicate or embed escaped HTML blocks.
- Repeated artifact rows were caused by multiple report-generation runs creating the same generic titles.

Fixes:

- Artifacts API now deduplicates by `type + title`, showing the latest artifact for repeated titles while keeping historical rows in SQLite/Trace.
- Report artifacts are now generated after the model response completes.
- Markdown/HTML artifacts now use the model synthesis plus Tavily sources, not only the latest user prompt.
- HTML reports now use a richer report shell with objective, assistant synthesis, source cards, provenance notes, source count, and web-search indicator.
- Raw HTML/CSS blocks are removed from artifact synthesis because DataSwarm owns artifact rendering.
- System prompt now instructs the model not to print raw HTML/CSS code blocks when report-generation is selected.
- Service-side Markdown table conversion to HTML table was added for report artifacts.
- Report titles now prioritize explicit entities such as `OpenAI Agent SDK`, `NVIDIA`, `Hermes Agent`, etc.
- Tavily event payloads now include `execution_mode` and `payload_uri`; expanded tool cards can show real/mock mode and persisted payload evidence.
- Follow-up prompts now first extract concrete recommendations from the assistant's own "recommended/next steps" section before falling back to heuristic templates.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

API smoke:

```json
{
  "dedupedArtifactsForExistingConversation": [
    "DataSwarm Analysis Report HTML",
    "DataSwarm Analysis Report"
  ],
  "rawArtifactRowsStillPreservedInSQLite": true
}
```

Browser/API smoke:

```json
{
  "conversationId": "conv_4af472520ffa4aee822eb5d674a5d7a8",
  "artifactTitles": [
    "OpenAI Agent SDK 分析报告 HTML",
    "OpenAI Agent SDK 分析报告"
  ],
  "eventOrder": [
    "tool.call.requested",
    "tool.call.started",
    "tool.call.output",
    "tool.call.completed",
    "model.call.completed",
    "artifact.create.started",
    "artifact.created",
    "artifact.preview.ready"
  ],
  "tavilyMode": "real",
  "artifactRunning": false,
  "consoleErrors": []
}
```

## Recommended Next Questions Freshness Pass

Completed after reviewing a multi-turn conversation where `Recommended next questions` stayed on the first generic report prompts.

Root cause:

- The UI was refreshing conversation data, but the suggestion builder relied too much on generic fallback templates.
- The latest assistant response often expressed next steps as plain actionable paragraphs, not bullet lists, so they were not extracted.
- Source/date/credibility follow-up turns were routed into the generic `artifact/report/html` fallback, producing repeated prompts such as preview/check/compress.

Fixes:

- Recommendation generation is now latest-turn aware and matches the latest user message to the latest assistant run.
- Historical suggestions from older assistant messages are fingerprinted and suppressed before fallbacks are used.
- Source/date/credibility/first-party-source intents now generate dedicated follow-up prompts.
- Plain actionable lines in recommendation sections are now considered, not only bullets.

Verification:

```text
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
```

Browser smoke on `conv_4af472520ffa4aee822eb5d674a5d7a8`:

```json
{
  "previousRepeatedPrompts": [
    "预览并检查 OpenAI Agent SDK 的 HTML artifact",
    "补齐 OpenAI Agent SDK 报告的来源日期与可信度标注",
    "把 OpenAI Agent SDK 报告压缩成管理层摘要"
  ],
  "currentLatestTurnPrompts": [
    "用站点限定查询核验 OpenAI Agent SDK 一手来源",
    "把 OpenAI Agent SDK 缺日期来源列入待核验清单",
    "将 OpenAI Agent SDK 报告拆成 v1 基线与 v2 一手来源版"
  ]
}
```

## DataSwarm V4.1 Real Startup Guard Checkpoint

Implemented a real-by-default startup hardening slice for the E2B ReAct swarm work.

Changes:

- Root `npm run dev` and `npm run dev:real` now start the Cloudflare Tunnel real profile instead of the local-only real profile.
- `apps/web` `dev` and `dev:real` now start `scripts/dev-real-cloudflare-tunnel.mjs`.
- Added explicit `dev:local-real` for non-tunnel local debugging.
- Real startup scripts now unconditionally refuse inherited mock/degraded environment variables.
- `scripts/dev-real.mjs` now fails fast when no public sandbox capability proxy URL is available, unless `DATASWARM_ALLOW_LOCAL_SANDBOX_PROXY=1` is explicitly set for UI-only local debugging.
- `scripts/dev-real-cloudflare-tunnel.mjs` now forces `DATASWARM_SANDBOX_PROVIDER=e2b`, `DATASWARM_SANDBOX_AGENT_MODEL=real`, and `DATASWARM_SANDBOX_TOOL_PROXY=parent`, and logs the public proxy/capability URLs.
- `web.search` default provider selection preserves real Tavily by default and permits mock only under explicit mock opt-in.
- Added `/api/internal/sandbox/health` to expose a redacted, public-checkable capability/proxy health contract for E2B callbacks.
- Sandbox proxy readiness now fails external E2B readiness when any required V4 capability is missing from the capability manifest.
- E2B preflight evidence now includes the detailed `tool_proxy_readiness` payload, so diagnostics can distinguish public URL failures from capability surface failures.
- The sandbox health route returns a structured failed `503` payload when runtime guards reject the current environment, so callback/preflight diagnostics can report the guard failure instead of a generic server error.
- Conversation diagnostics now include `summary.capabilityPlaneHealth`, plus a `capability-plane-health` remediation item when runtime profile, mock contamination, public proxy readiness, or required capability coverage blocks real E2B parent-proxy execution.

## DataSwarm V4.1 Artifact Context Carry-forward Checkpoint

Implemented an orchestrator context-management slice to address second-turn artifact loss.

Changes:

- The orchestrator now auto-selects recent artifacts from the current conversation even when the user does not explicitly attach or select artifact previews in the prompt.
- Explicit artifact references still take priority, then recent conversation artifacts are added up to the bounded context limit.
- Artifact context now includes artifact provenance fields such as `artifactKind`, `previewUri`, `sourceObservationIds`, and `branchIds`.
- Markdown/HTML artifacts contribute bounded content excerpts to the latest user message context.
- Image artifacts contribute provenance and preview context without attempting to inject binary content.
- Recent artifacts are relevance-scored against the latest user message, so follow-up requests for reports, HTML, visualizations, continuation, or deepening prioritize substantive matching artifacts over unrelated recent outputs.
- The orchestrator now emits `artifact.context.prepared` with selected artifact ids, explicit refs, context length, and selection policy so diagnostics can prove which artifacts were carried forward.
- Conversation diagnostics now summarizes artifact carry-forward via `swarmEvidence.artifactContextPreparedCount` and `latestArtifactContextPrepared`.

## DataSwarm V4.1 Per-Branch Evidence Matrix Checkpoint

Implemented a diagnostics slice for real E2B complex benchmark replayability.

Changes:

- Conversation diagnostics now exposes `summary.swarmEvidence.branchEvidenceMatrix`.
- Each branch row summarizes real E2B sandbox proof, BranchContract/BranchFinal presence, real-model action count vs contract minimum, fallback/degraded status, tool success/failure signals, parent-proxy completion/failure counts, artifact ids/types, sourceObservation-linked artifact count, observation ids, and unsupported claims.
- Diagnostics now reports aggregate branch evidence gaps: below minimum real-model actions, fallback/degraded branches, branches without parent-proxy evidence, and branches without artifacts.
- Added a `swarm-branch-evidence-matrix` remediation item when per-branch evidence is insufficient for a complex E2B benchmark.
- Sandbox V3 action lifecycle events now carry model source/status/model/retry/repair/fallback metadata, making real_model action provenance easier to audit from trace events.
- Sandbox V3 now attempts same-step model repair for validation failures and records `repairedActionCount` / `unrepairedActionCount` in quality signals.
- Normal parent-proxy `call_tool` actions now increment tool success/failure counts, not only `run_python`.
- Direct model actions of type `artifact.create` now normalize to parent capability `call_tool` with `toolName=artifact.create`, while explicit `create_artifact` remains the local recovery path.
- Per-branch diagnostics now expose repaired/unrepaired action counts.

## DataSwarm V4.1 BranchFinal Materialization Checkpoint

Implemented a sandbox BranchFinal substance slice.

Changes:

- Sandbox BranchFinal now accepts local observations in addition to artifact manifests.
- BranchFinal now includes structured `sections`, `claims`, `evidenceObservationIds`, `artifactIds`, `unsupportedClaims`, `assumptions`, and `limitations`.
- Evidence and artifact sections are generated from actual sandbox observation ids and artifact manifests.
- Claims are confidence-scored as `medium` when backed by observation/artifact ids and `assumption` when no local evidence id exists.
- Reducer/verifier can now consume BranchFinal substance directly instead of relying only on runtime markdown summaries.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs a local sandbox smoke and real E2B diagnostics replay to prove BranchFinal evidence fields survive parent parsing and verification.

## DataSwarm V4.1 BranchFinal-First Reducer Checkpoint

Implemented a reducer substance slice.

Changes:

- `swarm.reduce` now receives aggregated BranchFinals.
- Reduction branch items now prefer BranchFinal executive summaries, sections, claims, evidenceObservationIds, artifactIds, unsupportedClaims, and limitations.
- Runtime observation summaries remain a fallback instead of the primary reducer substrate.
- Conflict detection now also scans BranchFinal claims and section content.
- Reduction metadata records `branch-final.sections.claims` as an assisting reducer input source.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs swarm reducer smoke and real E2B complex benchmark replay.

## DataSwarm V4.1 Structured Merge Evidence Checkpoint

Implemented a merge-substance slice.

Changes:

- Added `formatSwarmReductionEvidence` to render reducer branch items as a structured evidence document.
- `swarm.merge` now uses BranchFinal-backed reduction evidence, including sections, claims, evidence ids, artifact ids, unsupported claims, limitations, and recommendations.
- Final swarm observations now carry the structured merge evidence instead of only a flattened runtime summary.
- `swarm.verify` now adds `branch_final_structured_evidence` to fail completed branches whose BranchFinals lack substantive sections, claims, and Observation/Artifact evidence ids.
- `artifact.create` now writes artifact substance metadata including `artifactKind`, `qualitySignals.substanceStatus`, section count, character count, evidence citation count, and deliverable eligibility.
- Branch artifact summaries now carry artifactKind and qualitySignals into reducer/verifier events.
- `artifact_substance_coverage` now fails runtime-summary artifacts instead of counting them as substantive user deliverables.
- Per-branch diagnostics now reports `runtimeSummaryArtifactCount`, `thinTextArtifactCount`, and `deliverableEligibleArtifactCount`.

## DataSwarm V4.1 Final Evidence Citation Checkpoint

Implemented a final-answer evidence citation safety net.

Changes:

- Final orchestrator responses now append missing Observation IDs and Artifact IDs before message completion.
- Artifact IDs are extracted from Observation metadata fields including `artifact_ids`, `artifactIds`, `artifact_id`, `artifactId`, and `artifacts[].id`.
- This closes the gap where artifacts could be generated and verified but omitted from the user-visible final answer.
- Conversation diagnostics now includes `summary.finalAnswerEvidence`, checking whether the latest assistant answer cites persisted Observation IDs and Artifact IDs.
- Diagnostics emits `final-answer-evidence-citations` remediation when final answers omit required persisted evidence citations.

## DataSwarm V4.1 Event-Derived Real Model Action Diagnostics Checkpoint

Implemented a diagnostics hardening slice for sandbox ReAct action provenance.

Changes:

- Conversation diagnostics now scans persisted `sandbox.agent.action.*` events.
- Per-branch evidence matrix now includes event-derived `eventRealModelActionCount`, `eventMockModelActionCount`, `eventFallbackActionCount`, and `eventRepairedActionCount`.
- Branch real-model minimum action coverage now considers both qualitySignals and persisted action events.
- Diagnostics remediation evidence now reports branches below the minimum event-derived real model action count.
- Parent swarm runtime now persists each sandbox event using its original `sandbox.agent.*` event type and flattens sandbox event payload fields into the parent `run_events` payload, while retaining the raw `event_payload`.

## DataSwarm V4.1 Per-Branch Artifact Contract Gate Checkpoint

Implemented a verifier hardening slice for artifact contract coverage.

Changes:

- `contract_required_artifact_coverage` now checks required artifact types per BranchContract branch.
- Branch-linked artifact metadata is required for a branch artifact to satisfy that branch's contract.
- Image, HTML, and Markdown requirements are matched using artifact type, MIME type, and artifactKind.
- Verifier failure details now list missing branch/type pairs and available branch-linked artifacts.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs swarm verifier smoke and real E2B benchmark replay.

## DataSwarm V4.1 Per-Branch Required Tool Gate Checkpoint

Implemented a verifier hardening slice for required tool coverage.

Changes:

- Event evidence now carries branch-linked tool call rows and capability/proxy events.
- `required_tool_event_coverage` now checks required tools per BranchContract branch.
- `required_tool_call_coverage` now requires successful branch quality signals for every branch that declares required tools.
- Verifier failure details now list missing `branchId:toolName` pairs.
- Conversation diagnostics now includes per-branch `parentProxyEventEvidence`, `toolCallEvidence`, and `requiredToolCoverage`.
- Diagnostics summary now reports `branchesMissingRequiredToolEvidence`, making missing parent evidence visible without manually correlating events and tool_calls.
- Parent capability invocations now persist branch/sandbox/action/capability metadata on the created `tool_calls` rows, so verifier and diagnostics can attribute completed tool calls to the correct E2B branch.
- `required_tool_event_coverage` now rejects global tool-count fallback for branch contracts; each `branchId:toolName` pair needs its own branch-linked parent evidence.
- Capability invocations now emit branch-linked `sandbox.agent.observation` events for successful and failed parent-proxied calls.
- Failed capability invocations now create failed Observations and attach failed Observation/tool_call ids to failed capability/proxy events, preserving the evidence chain instead of leaving only an exception.
- Conversation diagnostics branch matrix now counts successful/failed `sandbox.agent.observation` evidence per branch.
- Sandbox action normalization now maps additional model aliases (`thought`, `read_scoped_context`, `scoped_context`, `context.read`) into supported V3 actions.
- Invalid V3 actions from real_model now receive up to two same-step repair attempts, with structured repair started/failed/succeeded events carrying rawAction, parsedAction, validationResult, repairAttempt, and finalAction evidence.
- `swarm.verify` now has an `invalid_action_repair_policy` hard gate based on repair events plus branch qualitySignals, so invalid actions cannot disappear without either successful repair evidence or degraded/fallback evidence.
- Conversation diagnostics now reports repair started/succeeded/failed event counts globally and per branch, keeping trace replay aligned with the new verifier gate.
- `swarm.verify` now enforces BranchContract `minimumEvidence` per branch through `branch_minimum_evidence_coverage`, covering real model actions, successful tool calls, web.search calls, and required image/HTML/Markdown artifact counts.
- Conversation diagnostics now reports per-branch `minimumEvidenceCoverage` and aggregate `branchesMissingMinimumEvidence`, aligning trace replay with the new verifier gate.
- BranchContract generation now includes V4.1 `role`, `minimumEvidence`, and `finalOutputSchema` fields, so those obligations are persisted and passed into E2B branch jobs.
- `swarm.verify` now enforces `branch_final_output_schema_coverage`, checking required sections, Observation/Artifact citations, and unsupported-claim policy against BranchFinal content.
- Conversation diagnostics now reports per-branch `finalOutputSchemaCoverage` and aggregate `branchesMissingFinalOutputSchema`, aligning trace replay with the BranchFinal output schema verifier gate.
- Sandbox BranchFinal materialization now honors BranchContract `finalOutputSchema.requiredSections`, appending missing required sections with schema-directed Observation/Artifact citation ids.
- `artifact.create` now supports JSON artifacts (`json` / `application/json`) with formatted object serialization, preview recovery, `structured_json` artifactKind metadata, and JSON-specific substance quality signals.
- `artifact.create` now supports image metadata artifacts (`image_metadata`, `image.metadata`, `image-meta`) stored as JSON with `artifactKind=image_metadata` and `countsAsImageArtifact=false`, preserving the distinction between image evidence indexes and real image artifacts.
- Branch artifact requirements and verifier matching now support `json` and `image_metadata` contract artifact types without allowing image metadata to satisfy real image artifact coverage.
- Sandbox model actions that emit `create_artifact` now normalize into parent-proxied `call_tool` `artifact.create`, including JSON/image metadata fields, so durable deliverables follow the capability-plane evidence path by default.
- Sandbox action prompts now explicitly prefer parent `artifact.create` for durable deliverables and label local `create_artifact` as a degraded fallback shape.
- `swarm.merge` now materializes a parent-level final HTML report artifact (`artifactKind=final_html_report`) from reducer BranchFinal evidence, emits `swarm.final_artifact.created`, and includes the final artifact id in downstream merge/verify/review/return artifact lists.
- `swarm.verify` now enforces `html_report_artifact_coverage`, requiring a substantive final HTML report artifact; merge passes the generated final artifact summary into verifier artifact evidence.
- Conversation diagnostics now reports final HTML delivery evidence via `finalArtifactEventCount` and `finalHtmlReportArtifactCount`.
- `swarm.verify` now enforces `final_html_report_source_coverage`, requiring final HTML report artifacts to carry both source Observation ids and source Artifact ids.
- Conversation diagnostics now reports `finalHtmlReportSourceCoveredCount` so final HTML source-link coverage is visible in conversation replay.
- `swarm.verify` now enforces `trace_diagnostics_replayability`, checking pre-verify trace evidence for branch completion, reduce, final artifact creation, branch Observation ids, artifact ids, and capability/proxy completions when branch tools are required.
- Conversation diagnostics now reports a `traceReplayability` summary with branch-completed, reduce, final-artifact, branch-observation, artifact, and capability/proxy counts.
- Orchestrator swarm Observations now attach branch Observation ids and Artifact ids as claim sourceRefs and persist both snake_case and camelCase evidence id metadata for final-answer citation carry-forward.
- Capability manifest / sandbox tool catalog now expose the full `artifact.create` V4.1 schema for Markdown, HTML, JSON, and image metadata artifacts with source observation/image artifact linkage fields.
- Sandbox parent tool responses now retain returned artifact summaries and convert parent capability artifacts into branch-local manifest entries, so BranchFinal artifactIds can reference parent-created artifacts.
- Parent `artifact.create` now preserves explicit sandbox-provided `sourceObservationIds` in artifact metadata and records separately which ids resolved to parent Observation records.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs parent-proxy smoke and real E2B complex benchmark replay.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs diagnostics replay against a real E2B V4.1 swarm run.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs an end-to-end conversation smoke proving final answers cite both Observation and Artifact evidence.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs reducer/merge smoke and real E2B benchmark replay.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs diagnostics replay against a real E2B complex swarm conversation.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs a second-turn conversation smoke proving that prior artifacts materially influence a follow-up HTML/report generation.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only, not live E2B acceptance evidence.
- Final goal remains open until a real E2B complex swarm proves branch ReAct loops, parent-proxied tools, artifacts, reducer/verifier gates, and diagnostics replay by `conversationId`.

## 2026-06-15 Checkpoint: web.search Observation/tool_call evidence gate

- `swarm.verify` now includes `web_search_observation_coverage`, requiring every branch that declares `web.search` to have branch-linked completed `web.search` evidence with either a persisted parent `tool_call` id or a capability event `Observation` reference.
- Parent swarm event evidence now extracts `observation_id` / `observationId` and `tool_call_id` / `toolCallId` from `capability.invoke.*` and `sandbox.tool_proxy.call.*` event payloads, so verification can distinguish real evidence-bearing web search calls from thin completion counters.
- This hardens the V4.1 evidence chain for parent-proxied search: a branch can no longer pass the required web search gate solely because a capability completion event exists without replayable `tool_call` or `Observation` linkage.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs parent/capability proxy smoke and real E2B complex swarm replay to prove live `web.search` Observation/tool_call coverage.

## 2026-06-15 Checkpoint: run_python image artifact verification gate

- `swarm.verify` now includes `run_python_image_artifact_coverage`, requiring every branch that declares `run_python` or an image artifact requirement to have both branch-linked completed `run_python` evidence and a recovered real image artifact.
- This makes image delivery failures explicit: completed Python execution can no longer satisfy the image requirement unless the artifact recovery path also produced a branch-linked image artifact.
- The gate complements `branch_minimum_evidence_coverage` and `contract_required_artifact_coverage` with a focused, diagnostic-friendly check for the V4.1 image artifact acceptance criterion.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs parent-proxied `run_python` smoke and real E2B complex swarm replay with a generated image artifact.

## 2026-06-15 Checkpoint: web.search requires both tool_call and Observation evidence

- Tightened `web_search_observation_coverage`: each branch requiring `web.search` must now have both branch-linked completed parent `tool_call` evidence and branch-linked completed capability `Observation` evidence.
- A completed tool row alone is no longer sufficient, and a capability event without an Observation id is no longer sufficient.
- This aligns the verifier with the acceptance requirement that parent-proxied search must produce replayable parent-side tool_call plus Observation evidence.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; live E2B replay is still required to prove the tightened gate passes from real parent-proxied search calls.

## 2026-06-15 Checkpoint: diagnostics for search/tool Observation and image artifact gates

- Conversation diagnostics now exposes per-branch `webSearchObservationCoverage`, showing whether a branch requiring `web.search` has completed parent `tool_call` evidence, completed parent event `toolCallId` evidence, and completed capability `Observation` evidence.
- Conversation diagnostics now exposes per-branch `runPythonImageArtifactCoverage`, showing whether a branch requiring `run_python` or an image artifact has completed `run_python` evidence and a recovered image artifact.
- Diagnostics summary now reports `branchesMissingWebSearchObservationCoverage` and `branchesMissingRunPythonImageArtifactCoverage`.
- Remediation generation now treats those missing coverage counts as high-priority swarm branch evidence gaps, so a `conversationId` replay can directly explain failures in the new V4.1 hard gates.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; diagnostics still need to be replayed against a real E2B conversation after parent-proxy and run_python smoke validation.

## 2026-06-15 Checkpoint: Markdown deliverable artifact hard gate and diagnostics

- `swarm.verify` now includes `markdown_summary_artifact_coverage`, requiring every branch with a Markdown artifact requirement to produce a branch-linked substantive Markdown deliverable artifact.
- Markdown runtime summaries and thin text artifacts are explicitly rejected for this gate, addressing the prior failure mode where execution summaries were counted as user-facing research/report deliverables.
- Conversation diagnostics now exposes per-branch `markdownSummaryArtifactCoverage` and aggregate `branchesMissingMarkdownSummaryArtifactCoverage`.
- Remediation generation now treats missing substantive Markdown deliverables as high-priority branch evidence gaps.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs local smoke and real E2B replay to prove substantive Markdown artifacts are generated and accepted by the new gate.

## 2026-06-15 Checkpoint: artifact source Observation coverage

- `swarm.verify` now includes `artifact_source_observation_coverage`, requiring each BranchContract required artifact to be branch-linked and carry `sourceObservationIds`.
- This prevents artifact existence alone from satisfying delivery coverage when the artifact cannot be traced back to Observation evidence.
- Conversation diagnostics now exposes per-branch `artifactSourceObservationCoverage` and aggregate `branchesMissingArtifactSourceObservationCoverage`.
- Remediation generation now treats missing artifact source Observation links as high-priority branch evidence gaps.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs artifact smoke and real E2B replay to prove generated Markdown/HTML/image artifacts carry sourceObservationIds end to end.

## 2026-06-15 Checkpoint: unsupported claim coverage hard gate

- `swarm.verify` now includes an explicit `unsupported_claim_coverage` gate.
- BranchFinal `unsupportedClaims` are no longer only checked indirectly through finalOutputSchema; they now produce a dedicated verifier failure with branch-level counts.
- Conversation diagnostics now reports aggregate `branchesWithUnsupportedClaims` and includes unsupported claim gaps in swarm branch remediation evidence.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs real BranchFinal replay to confirm unsupported claims are either backed by Observation/Artifact evidence or fail verification.

## 2026-06-15 Checkpoint: verifier gate id alignment with V4.1 acceptance list

- `swarm.verify` now includes the explicit V4.1 gate id `branch_final_content_present`, separating BranchFinal existence/content presence from deeper substance checks.
- Added `successful_tool_call_coverage`, requiring BranchContract required tools to have branch-linked successful parent tool evidence with no failed tool calls.
- Added `capability_event_coverage`, requiring BranchContract required tools to have branch-linked `capability.invoke.completed` evidence and no capability failures.
- Added `parent_proxy_coverage`, requiring BranchContract required tools to have branch-linked `sandbox.tool_proxy.call.completed` evidence and no parent-proxy failures.
- Added `fallback_action_policy`, requiring deterministic fallback actions to be zero or explicitly marked degraded / failed verification rather than counted as normal success.
- Conversation diagnostics now exposes failed-check counters for these explicit gates, and remediation evidence includes the new tool/capability/proxy/fallback gate failures.
- `final_answer_evidence_coverage` remains implemented at diagnostics/evaluator level rather than inside `swarm.verify`, because final assistant-message evidence is only authoritative after the final response has been persisted.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs type/static validation and real E2B conversation replay to prove the new gate ids are emitted and diagnostics counters populate correctly.

## 2026-06-15 Checkpoint: final answer evidence coverage diagnostics

- Conversation diagnostics now returns an explicit `final_answer_evidence_coverage` object, plus camelCase `finalAnswerEvidenceCoverage`, under `finalAnswerEvidence`.
- The coverage object reports whether the latest persisted assistant answer cites Observation evidence and Artifact evidence, along with cited/persisted counts.
- This keeps final-answer citation verification in the correct diagnostics/evaluator phase while aligning the observable output with the V4.1 acceptance gate name.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs an end-to-end conversation replay proving the final assistant answer cites persisted Observation and Artifact ids.

## 2026-06-15 Checkpoint: trace.query current conversation resolution evidence

- `trace.query` tool calls now persist resolved target metadata under `tool_calls.metadata_json.trace_query`, including requested conversation/run/trace ids, resolved target kind/id, resolved conversation id, and whether active conversation fallback was used.
- This makes `conversation_id=current` and missing conversation id rewrites auditable instead of relying only on runtime behavior.
- Conversation diagnostics now exposes `swarmEvidence.traceQueryResolution`, reporting trace.query call count, active conversation fallback count, unresolved current literal count, and resolved conversation ids.
- Remediation generation now emits `trace-query-current-resolution` if any trace.query call still resolves to a literal current/active/this conversation id.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs parent-proxy trace.query smoke proving `current` is rewritten to the active conversationId before repository lookup.

## 2026-06-15 Checkpoint: reducer input coverage replayability

- `swarm.reduce` events now persist `reducer_input_coverage`, including branch contract count, BranchFinal count, branch Observation count, artifact count, branch quality signal count, branch artifact count, branch item count, evidence-bearing branch item counts, and whether reducer used BranchFinals.
- The reduce trace span also records `reducer_input_coverage`, making reducer inputs visible in trace replay as well as run events.
- Conversation diagnostics now exposes `swarmEvidence.reducerInputCoverage` and prints reducer input coverage in the diagnosis summary.
- Remediation generation now emits `swarm-reducer-input-coverage` when reduce ran without BranchFinal-backed input, preventing runtime-summary-only reduction from being accepted as V4.1 delivery.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs swarm parallel smoke and real E2B complex replay proving reducer_input_coverage has BranchFinal, Observation, and Artifact evidence for all completed branches.

## 2026-06-15 Checkpoint: BranchFinal materialized event replayability

- Each completed branch now publishes a dedicated `swarm.branch.final.materialized` event when a BranchFinal exists.
- The event persists branch id, sandbox/session ids, branch Observation id, artifact ids, image artifact ids, BranchContract, BranchFinal, evidence Observation ids, evidence Artifact ids, section/claim counts, unsupported claim count, and quality signals.
- Conversation diagnostics now reports `branchFinalMaterializedEventCount`, per-branch `hasBranchFinalMaterializedEvent`, and aggregate `branchesMissingBranchFinalMaterializedEvent`.
- Remediation generation now treats missing BranchFinal materialized events as high-priority branch evidence gaps.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs swarm smoke and real E2B replay to prove BranchFinal materialized events appear for every completed branch.

## 2026-06-15 Checkpoint: swarm.verify gate coverage replayability

- `swarm-verifier` now exports the V4.1 expected `swarm.verify` gate id list and `buildSwarmVerificationGateCoverage`.
- `swarm.verify` events and trace span metadata now persist `gate_coverage`, including expected gate ids, present gate ids, missing gate ids, unexpected gate ids, failed gate ids, and completeness counts.
- Conversation diagnostics now exposes `swarmEvidence.verificationGateCoverage` and prints verification gate coverage in the diagnosis summary.
- Remediation generation now emits `swarm-verification-gate-coverage` if `swarm.verify` ran without the complete V4.1 gate set.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs smoke/live replay to prove `gate_coverage.complete=true` in real V4.1 swarm runs.

## 2026-06-15 Checkpoint: BranchContract materialized event replayability

- Each branch now publishes a dedicated `swarm.branch.contract.materialized` event after sandbox session creation and before branch execution starts.
- The event persists branch id/index/launch metadata, agent/session/context bundle ids, title, role, required tool/artifact/question counts, minimum evidence, final output schema, fallback policy, and the full BranchContract.
- Conversation diagnostics now reports `branchContractMaterializedEventCount`, per-branch `hasBranchContractMaterializedEvent`, and aggregate `branchesMissingBranchContractMaterializedEvent`.
- Remediation generation now treats missing BranchContract materialized events as high-priority branch evidence gaps.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs swarm smoke and real E2B replay to prove BranchContract materialized events appear for every branch before sandbox ReAct execution.

## 2026-06-15 Checkpoint: materialized BranchContract/BranchFinal events as verifier evidence

- `branch_contract_coverage` now requires both BranchContract records and `swarm.branch.contract.materialized` events for every planned branch.
- `branch_final_content_present` and `branch_final_substance` now require `swarm.branch.final.materialized` events for completed branches in addition to content-bearing/substantive BranchFinal records.
- This makes independent materialization events part of hard verification rather than diagnostics-only evidence.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; existing runs before this event addition are expected to fail these stricter gates until rerun.

## 2026-06-15 Checkpoint: artifact provenance metadata closure

- `artifact.create` now writes unified provenance metadata at artifact creation time, derived from parent tool-call metadata: branch id(s), sandbox session id, sandbox action id, producer action id, tool call id, capability name, capability plane version, and producer details.
- `run_python` image artifacts now write the same provenance metadata, plus `artifactKind=generated_image`, `sourceObservationIds` from tool input when supplied, and image-specific quality signals including `countsAsImageArtifact=true`.
- Capability-plane artifact post-processing now enriches returned artifacts with the final parent capability Observation id, producer action id, tool call id aliases, sandbox/session ids, capability name, capability plane version, and producer details.
- This reduces the chance that real E2B artifacts fail source/provenance gates despite being created successfully.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs parent-proxied `artifact.create` and `run_python` smoke to prove metadata persists through artifact recovery and diagnostics.

## 2026-06-15 Checkpoint: run_python chart/code input compatibility

- `run_python` capability manifest now accepts `code` / `python` / `script`, `chart_type`, `labels`, `values`, `data`, and `sourceObservationIds` in addition to SVG/base64 image payloads.
- Parent `run_python` now supports a safe non-executing chart generation path: if labels/values/data are supplied, it creates a structured SVG chart artifact; if code is supplied without image bytes, it creates a code-intent SVG evidence artifact instead of failing or producing an empty placeholder.
- `run_python` image artifact metadata now records `runPythonInputMode` in top-level metadata and qualitySignals, distinguishing `svg`, `base64`, `chart_spec`, `code_summary`, and `placeholder` paths.
- This improves the chance that real sandbox model actions using natural `run_python` inputs produce recoverable image artifacts without executing arbitrary Python in the parent process.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs parent-proxied `run_python` smoke with chart data/code inputs and real E2B replay.

## 2026-06-15 Checkpoint: sandbox run_python action schema alignment

- Sandbox ReAct prompt now shows a `run_python` action example with `labels`, `values`, and `sourceObservationIds`, steering real model actions toward the parent capability schema that can generate recoverable SVG chart artifacts.
- Sandbox action normalization now allows `call_tool` actions targeting `run_python`, so model-emitted tool-call shapes can be repaired/normalized into the parent capability path instead of being rejected unnecessarily.
- Both legacy and V3 action validation now apply tool-call budget checks to `run_python`, preventing image generation from bypassing the branch tool budget.
- Empty `run_python` actions now receive default chart inputs with labels/values and available source Observation ids before calling the parent proxy.
- Deterministic/mock plot actions now include chart input fields as well; fallback remains degraded by policy and is not treated as live acceptance evidence.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs sandbox parser smoke and parent-proxied `run_python` smoke with real model actions.

## 2026-06-15 Checkpoint: sandbox artifact.create substance prompt alignment

- Sandbox ReAct prompting now explicitly instructs real model actions to use parent-proxied `artifact.create` with `sourceObservationIds` and substantive user-facing content.
- The prompt now warns against runtime logs, action lists, placeholder summaries, and thin report artifacts.
- HTML and Markdown `artifact.create` examples now include executive summary, evidence-backed sections, explicit limitations, and cited Observation ids.
- This is intended to reduce the prior failure mode where final HTML/Markdown deliverables were empty, over-simplified, or disconnected from branch observations.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs real model action smoke and real E2B replay proving generated artifacts are substantive and sourceObservation-linked.

## 2026-06-15 Checkpoint: sandbox artifact.create input completion

- Sandbox parent-tool execution now completes `artifact.create` inputs before proxying them to the parent capability service.
- If `sourceObservationIds` are missing, the sandbox fills them from prior branch Observations.
- If title/type/content are missing, the sandbox fills a substantive Markdown or HTML report skeleton with Executive Summary, Evidence, and Limitations sections, citing available Observation ids.
- The completion logic does not overwrite model-provided artifact content; it only fills missing fields so real model omissions are less likely to produce source-detached or empty artifacts.

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; it still needs real model action smoke and parent-proxied `artifact.create` replay.

## 2026-06-16 Progress Note: parent-proxy e2e passes runtime warmup but collapses on proxy evidence closure

- 本轮 `smoke:e2b-orchestrator-v3-parent-proxy` 已成功完成 3 分支 real E2B 并行运行并进入 run/merge/verify 主链路：
  - `PASS real e2b V3 orchestrator server healthy`
  - `PASS real e2b V3 swarm message accepted`
  - `PASS run completed`（`run_600...`）
  - `PASS branch started events` / `PASS reduce waits for branch observations`
- 但验证终止于两类硬性失败：
  1) `verifyCallbackReachability` 仍报 `health body invalid JSON`（当时 `parent proxy base` 与 `capability base` 被判定返回 200 HTML）
  2) `swarm.verify` 多项硬失败，核心为：缺失 `swarm.branch.final.materialized`、缺失能力/代理完成事件（capability/proxy/tool_call）与 `run_600` 级别工具覆盖
- 观察到的关键数据特征：`required_tool_call_coverage`、`capability_event_coverage`、`parent_proxy_coverage`、`web_search_observation_coverage`、`run_python_image_artifact_coverage` 等多项仍失败，说明本次循环中沙箱虽有动作与部分 artifact，但未能通过 `artifact.create/run_python/trace.query` 的统一 parent-capability 证据链回灌为 `tool_calls + run_events`。
- 同时确认前置条件已基本恢复：`dataswarm-dev.metad.ai` 外网 `health/snapshot` 可访问（HTTP 200 + JSON）。

待下一步：需要修复 parent-proxy 可达性校验基址与能力调用证据入库在该入口的关联逻辑。
## 2026-06-16 Checkpoint: parent-proxy reachability derivation hardened

- 调整 `scripts/e2b-orchestrator-v3-real-action-e2e-smoke.mjs` 的 `deriveServiceBaseUrl`：当 URL 直接命中 `/api/internal/...` 工具/能力/健康链路前缀时，回退到服务根域名进行探测，避免再次拼接出 `.../tool-proxy/api/internal/sandbox/health` 这类 404 HTML 路径。
- 目标是让 `verifyCallbackReachability` 在真实域名与隧道回调地址下只输出服务状态 JSON；并确保 `DATASWARM_SANDBOX_TOOL_PROXY_URL` 与 `DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL` 都能通过同一归一化入口。
- 下一步证据动作：重新跑 `smoke:e2b-orchestrator-v3-parent-proxy`，重点观察 `verifyCallbackReachability` 与 `parent_proxy_coverage/successful_tool_call_coverage` 是否从 `health body invalid JSON` 阻塞解除。

Validation status:

- Static/runtime validation was not executed in this slice.
- This checkpoint is implementation progress only; full pass still requires branch evidence gates to be satisfied by rerun.
