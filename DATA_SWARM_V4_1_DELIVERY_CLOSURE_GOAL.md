# Goal: DataSwarm V4.1 Delivery Closure

推进 DataSwarm V4.1，修复 E2B ReAct Swarm 从“真实运行”到“真实交付”的闭环问题。

## Baseline Evidence

最近一次真实复杂任务会话：

- Conversation: `conv_7d810a1e83cd4de4b612e354c210d3a0`
- Run: `run_a4e3d84c08d647b292181ea68f679a67`

该 run 已证明：

- 6 个真实 E2B sandbox session 启动并完成。
- 6 个 branch 并行/分批执行完成。
- 每个 branch 进入 sandbox ReAct loop，并有 real model action。
- `swarm.reduce` 与 `swarm.verify` 在所有 branch settled 后执行。

但最终结果为 `VERIFICATION FAILED / DEGRADED`，暴露问题：

- 所有 artifact 都是 Markdown runtime summary，缺少真正研究内容。
- 缺少 image artifact 与 HTML report。
- 缺少可审计的 parent-proxied `web.search` / `capability.invoke` / `sandbox.tool_proxy` 成功事件链。
- sandbox action parser 出现 `unsupported action type`。
- `trace.query` 使用 `current` 导致失败。
- verifier 没有把 parent-proxy / capability coverage 缺失作为硬失败项。
- reducer 主要合并 branch summary，而不是 branch substantive final content。

## Core Objective

将 DataSwarm V4.1 升级为真实可交付的 E2B ReAct Agent Swarm，使每个 branch 不仅真实运行，还必须真实完成任务、产出实质内容、调用真实 capability、生成合规 artifact，并被硬性 verifier 证明。

## Required System Capabilities

### 1. Branch Contract Fidelity

- 在 orchestrator `spawn_swarm` 前生成结构化 `BranchContract`。
- 每个 branch 必须包含独立的 `role`、`objective`、`requiredQuestions`、`requiredTools`、`requiredArtifacts`、`minimumEvidence`、`finalOutputSchema`。
- 不允许只把总任务复制给每个 branch。
- Branch A/B/C/D/E/F 的任务要求必须完整保真传入 E2B sandbox。
- `BranchContract` 必须持久化到 trace / `run_events` / sandbox session metadata。
- diagnostics 必须能按 `conversationId` 展示每个 branch 的 contract 与实际履约情况。

Recommended schema:

```ts
type BranchContract = {
  branchId: string;
  title: string;
  role: string;
  objective: string;
  requiredQuestions: string[];
  requiredTools: string[];
  requiredArtifacts: string[];
  minimumEvidence: {
    realModelActionCount: number;
    webSearchCount?: number;
    toolCallCount?: number;
    imageArtifactCount?: number;
    htmlArtifactCount?: number;
    markdownArtifactCount?: number;
  };
  finalOutputSchema: {
    requiredSections: string[];
    mustCiteObservationIds: boolean;
    mustCiteArtifactIds: boolean;
    unsupportedClaimPolicy: "mark_assumption" | "fail_verification";
  };
};
```

### 2. Sandbox Action Schema / Parser / Repair / Retry

- 沙箱 agent 只能输出规范 action：
  - `thought`
  - `web.search`
  - `file.read`
  - `trace.query`
  - `artifact.create`
  - `run_python`
  - `final`
- 所有 action 必须满足统一 JSON schema。
- 解析失败、`unknown action`、`object action`、`read_scoped_context` 等非法 action 不能直接消耗任务预算后失败。
- 必须进入 action repair flow：

```text
invalid_action -> repair_prompt -> retry same step
```

- 每步最多 repair 2 次。
- repair 成功要记录 `repairedActionCount`。
- repair 失败要记录 `unrepairedActionCount`，并将 branch 标记 degraded。
- `sandbox.agent.*` event 必须持久化 `rawAction`、`parsedAction`、`validationResult`、`repairAttempt`、`finalAction`。
- deterministic fallback 不能作为正常路径，必须进入 degraded / `failed_verification` qualitySignals。

### 3. Capability Plane Tool Call Closure

- sandbox agent 调用 `web.search`、`artifact.create`、`file.read`、`trace.query`、`run_python` 必须走统一 capability invoke endpoint。
- 每次工具调用必须产生完整证据链：
  - `tool_calls` row
  - `observations` row
  - `run_events`: `capability.invoke.started`
  - `run_events`: `capability.invoke.completed` / `capability.invoke.failed`
  - `run_events`: `sandbox.tool_proxy.call.started`
  - `run_events`: `sandbox.tool_proxy.call.completed` / `sandbox.tool_proxy.call.failed`
  - `sandbox.agent.observation` event
- branch final 中引用工具结果时，只能引用真实 Observation ID。
- 不允许 branch 自述 `Tool web.search returned` 但数据库没有 capability/tool_call/Observation 证据。
- diagnostics 必须显示每个 branch 的 successful tool calls、failed tool calls、capability events、parent proxy events。
- parent-proxy/capability callback URL 必须来自真实公网配置，例如 Cloudflare Tunnel named domain：

```text
https://dataswarm-dev.metad.ai
```

- mock capability 只能显式启用，并必须标记 mock/degraded，不允许默认路径使用。

### 4. `run_python` Image Artifact Closure

- `run_python` 必须成为 capability plane 的一等能力。
- sandbox 可通过 `run_python` 生成图片 artifact，例如 PNG/SVG。
- `run_python` 返回值必须包含 `artifactIds`、`mimeType`、`previewUri`、`sourceObservationIds`。
- 若 `BranchContract` 要求 image artifact，则没有 `image/*` artifact 时 branch 不得正常 `completed`，只能 `completed_degraded` 或 `failed_verification`。
- Artifact recovery 必须识别 `image/png`、`image/svg+xml` 等类型。
- Artifact metadata 必须包含 `branchId`、`sourceObservationIds`、producer `actionId`、`toolCallId`、dedupe hash、`previewUri`。

### 5. `artifact.create` Substance Constraints

- `artifact.create` 必须支持 Markdown、HTML、JSON、image metadata。
- branch artifact 不能只是 runtime summary。
- 必须区分：
  - `branch_runtime_summary` artifact
  - `branch_final_report` artifact
  - `final_html_report` artifact
  - `executive_summary` artifact
  - `generated_image` artifact
- runtime summary 不能计入用户要求的 deliverable artifact coverage。
- 对 Markdown/HTML 报告类 artifact 必须做 minimum substance check：
  - section count
  - word/character count
  - required sections present
  - evidence citations present
  - not only contains `Actions emitted / Observations / Limitations`
- 如果 artifact 只有执行日志结构，verifier 必须标记 `artifact_substance_missing`。

### 6. Branch Final Content Materialization

- sandbox final action 必须输出结构化 `BranchFinal`：

```ts
type BranchFinal = {
  branchId: string;
  title: string;
  executiveSummary: string;
  sections: Array<{
    title: string;
    content: string;
    evidenceObservationIds: string[];
    evidenceArtifactIds: string[];
  }>;
  claims: Array<{
    claim: string;
    evidenceObservationIds: string[];
    evidenceArtifactIds: string[];
    confidence: "high" | "medium" | "low" | "assumption";
  }>;
  evidenceObservationIds: string[];
  artifactIds: string[];
  unsupportedClaims: string[];
  assumptions: string[];
  qualitySignals: Record<string, unknown>;
};
```

- `BranchFinal` 必须单独持久化，并作为 reducer 的主要输入。
- reducer 不允许只合并 branch runtime summary。
- 如果 `branchFinalContent` 缺失，reduce 必须标记：

```text
failed_verification: branch_final_missing
```

### 7. `swarm.reduce` Enhancement

- reduce 必须等待所有 branch settled。
- reduce 输入必须包含：
  - `BranchContract`
  - `BranchFinal`
  - branch Observations
  - tool Observations
  - Artifacts
  - qualitySignals
  - unsupportedClaims
- 最终 HTML report 必须基于 branch final substantive content 生成。
- 最终回答必须列出 artifact 清单与 Observation/Artifact 引用。
- 如果实质内容不足，reduce 不能生成看似完整但无证据的报告，必须标记 degraded。

### 8. `swarm.verify` Hard Gates

必须新增并强制执行以下 verification checks：

- `branch_contract_coverage`
- `branch_final_content_present`
- `branch_final_substance`
- `successful_tool_call_coverage`
- `capability_event_coverage`
- `parent_proxy_coverage`
- `web_search_observation_coverage`
- `run_python_image_artifact_coverage`
- `html_report_artifact_coverage`
- `markdown_summary_artifact_coverage`
- `artifact_source_observation_coverage`
- `artifact_substance_coverage`
- `fallback_action_policy`
- `invalid_action_repair_policy`
- `unsupported_claim_coverage`
- `final_answer_evidence_coverage`
- `trace_diagnostics_replayability`

Hard failure examples:

- Required `web.search > 0` but `capability.invoke.completed(web.search)=0` -> `failed_verification`.
- Required image artifact but `image/* artifact=0` -> `failed_verification`.
- Required HTML report but `text/html artifact=0` -> `failed_verification`.
- Artifact is only runtime summary -> `failed_verification`.
- Branch final missing -> `failed_verification`.
- `fallbackActionCount > 0` and not marked degraded -> `failed_verification`.
- `invalidActionCount > 0` and not repaired/retried -> degraded or `failed_verification`.
- Final answer does not cite Observation/Artifact -> `failed_verification`.

### 9. `trace.query` and Diagnostics Fixes

- 修复 `trace.query` input 中 `conversation_id=current` 的问题。
- 如果 tool input 中 `conversation_id` 为 `current`，orchestrator/tool adapter 必须自动替换为 active `conversationId`。
- 如果缺少 `conversation_id` 但上下文存在 active `conversationId`，必须自动补齐。
- 禁止模型把 `"current"` 传到 repository 层。
- diagnostics by `conversationId` 必须能复现：
  - real E2B sandbox sessions
  - branch contracts
  - sandbox model actions
  - action repair events
  - tool calls
  - capability invoke events
  - parent proxy events
  - Observations
  - Artifacts
  - BranchFinal
  - reducer inputs
  - verifier checks
  - fallback / degraded / unsupported claims

### 10. Default Real Environment and Service Startup

- 默认 dev real 启动脚本必须使用 Cloudflare named tunnel：

```text
dataswarm-dev.metad.ai
```

- 服务启动时启动对应 tunnel，关闭服务时关闭 tunnel。
- 保留脚本：

```text
scripts/dev-real-cloudflare-tunnel.mjs
```

- 确保该脚本注入：

```bash
DATASWARM_SANDBOX_PROVIDER=e2b
DATASWARM_SANDBOX_AGENT_MODEL=real
DATASWARM_SANDBOX_TOOL_PROXY=parent
DATASWARM_PUBLIC_BASE_URL=https://dataswarm-dev.metad.ai
DATASWARM_SANDBOX_TOOL_PROXY_URL=https://dataswarm-dev.metad.ai/api/internal/sandbox/tool-proxy
DATASWARM_SANDBOX_CAPABILITY_INVOKE_URL=https://dataswarm-dev.metad.ai/api/internal/capabilities/invoke
```

- `mock` / `dev:mock` 只能显式启用，并必须在 UI/diagnostics 中明显标记。

## Validation Phases

### Phase 1: Static / Schema Validation

- TypeScript typecheck.
- Python sandbox agent `py_compile`.
- Action schema parser unit smoke.
- BranchContract schema smoke.

### Phase 2: Local Mock V4.1 Smoke

- 使用 mock sandbox 但必须标记 mock。
- 验证 BranchContract 保真。
- 验证 BranchFinal materialization。
- 验证 artifact substance gate。

### Phase 3: Local Real-Action Smoke

- 不启动 E2B，仅验证 real model action parser/repair/retry。
- 必须覆盖 invalid action -> repair -> success。
- 必须覆盖 invalid action -> repair failed -> degraded。

### Phase 4: Capability Parent Proxy Smoke

- 通过 capability invoke endpoint 调用：
  - `web.search`
  - `artifact.create` markdown
  - `artifact.create` html
  - `run_python` image
  - `trace.query`
- 必须落 `tool_calls`、Observation、capability events、`sandbox.tool_proxy` events。
- 必须验证 `sourceObservationIds`。

### Phase 5: Swarm Parallel Smoke

- 至少 3 branches。
- 每个 branch 有 `BranchContract` 与 `BranchFinal`。
- 至少一个 `web.search`。
- 至少一个 image artifact。
- 至少一个 HTML artifact。
- verify 必须通过。

### Phase 6: Real E2B Parent-Proxy Smoke

- 使用真实 E2B + Cloudflare domain。
- 至少 3 E2B branches。
- 每 branch >= 3 real_model actions。
- 至少一次 parent-proxied `web.search` 成功。
- 至少一次 `run_python` image 成功。
- artifacts 可回收预览。
- diagnostics 可复现。

### Phase 7: Real E2B Complex Benchmark

使用任务类似：

```text
中国跨境电商最后一公里智能调度平台落地可行性研究
```

验收必须满足：

- 6 branches completed.
- 每 branch 进入 E2B sandbox ReAct loop.
- 每 branch >= 3 real_model decisions.
- `fallbackActionCount=0`，或明确 degraded.
- `invalidActionCount=0`，或全部 repaired.
- >= 1 successful `web.search` `capability.invoke.completed`.
- >= 1 successful `sandbox.tool_proxy.call.completed`.
- successful `tool_calls > 0`.
- >= 1 image artifact.
- >= 1 HTML report artifact.
- >= 1 Markdown executive summary artifact.
- `artifact.sourceObservationIds` 完整.
- `BranchFinal` 内容非空且有实质分析.
- final answer 引用真实 Observation/Artifact ID.
- `swarm.reduce` 等待所有 branch settled.
- `swarm.verify status=passed`.
- diagnostics by `conversationId` 能复现完整证据链.

## Documentation Requirements

持续更新：

- `IMPLEMENTATION_STATUS.md`
- `E2B_BRANCH_AGENT_REACT_V4_CAPABILITY_PLANE.md`
- 新增或更新 `E2B_BRANCH_AGENT_REACT_V4_1_DELIVERY_CLOSURE_PLAN.md`
- 记录 `conv_7d810a1e83cd4de4b612e354c210d3a0` 的失败分析作为 baseline。
- 每个 phase 保留 checkpoint、命令、结果、失败原因、下一步。

## Constraints

- 不伪造 live 结果。
- 不把 mock 当真实完成。
- 不把 runtime summary artifact 当 deliverable artifact。
- 不以 branch 自述替代 tool/capability/Observation 数据库证据。
- 不让 deterministic fallback 作为正常成功路径。
- 不在 verify failed 时声称任务成功。
- 完成后提交 git。

## Final Success Definition

DataSwarm V4.1 不再只证明“E2B 跑起来了”，而是能证明：

- E2B branch 真实运行。
- Branch contract 真实保真。
- Sandbox ReAct action 真实可解析、可修复、可审计。
- Capability/tool proxy 真实调用并落证据链。
- Artifact 真实包含用户要求的实质交付内容。
- Reducer 基于 BranchFinal 与 Observation/Artifact 做综合。
- Verifier 以硬性 gate 证明交付达标。
