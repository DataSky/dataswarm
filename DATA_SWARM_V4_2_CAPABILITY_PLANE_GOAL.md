# DataSwarm V4.2 Goal: Capability Plane + Real E2B ReAct Swarm Delivery

## Goal

推进 DataSwarm V4.2，构建真实可验证的 E2B ReAct Agent Swarm，并将 orchestrator、主 agent、E2B sandbox agent 可调用的工具与 skills 统一抽象为 DataSwarm Capability Plane。

核心目标不是让代码路径“看起来存在”，而是让当前系统在真实 E2B、真实模型、真实工具代理、真实 artifact 回收、真实 trace 诊断下，能够完成一个复杂 DataAgent Swarm 任务，并能通过 `conversationId` 复现完整证据链。

## Background

当前 DataSwarm 已经推进到 V4/V4.1 阶段，但近期真实会话暴露出几个根因级问题：

1. E2B branch 可以启动，但 sandbox 内 agent 与父进程工具代理的连通性仍不稳定。
2. `host.docker.internal` 作为默认回调地址不可靠，会导致 sandbox agent 无法调用 `web.search`、`artifact.create`、`file.read`、`trace.query`、`run_python` 等能力。
3. fallback/deterministic path 曾被系统当作正常路径，导致用户误以为真实能力已经实现。
4. artifact 虽然可能存在，但没有形成稳定的生成、回收、去重、预览、source observation 关联闭环。
5. 后续对话没有主动把历史 artifacts 纳入上下文，导致复杂报告在第二轮或连续追问中被严重简化。
6. `swarm.reduce` / `swarm.verify` 对 branch final、Observation、Artifact、qualitySignals、parent-proxy coverage 的强验证还不够系统。
7. diagnostics 需要能够证明是否真实 E2B、真实模型 action、真实工具代理、真实 artifact 回收，以及是否存在 fallback 或 unsupported claims。

## North Star

DataSwarm 应该成为一个真实的 DataAgent Swarm 系统：

1. Orchestrator 不只是分发步骤，而是维护任务目标、上下文、artifact、证据链和验证 gate。
2. 每个 branch agent 在 E2B sandbox 内通过 ReAct loop 自主决定 action。
3. 所有 agent 调用同一套 Capability Plane，而不是分别拥有不一致、不可追踪、不可复用的工具逻辑。
4. 所有工具调用必须统一落盘为 `tool_call`、`Observation`、`event`，并能通过 `conversationId` 诊断复现。
5. fallback 只能作为 degraded/failed_verification 路径，不能作为成功路径。
6. 最终答案必须引用 Observation/Artifact，而不是只输出模型主观总结。

## Required Architecture

### 1. Capability Plane

实现统一的 DataSwarm Capability Plane，使 orchestrator、主 agent、sandbox agent 都通过同一套能力注册、调用协议、trace 语义和 artifact 生命周期工作。

Capability Plane 至少覆盖：

1. `web.search`
2. `artifact.create`
3. `file.read`
4. `trace.query`
5. `run_python`
6. 后续可扩展的 domain skills / data tools / browser tools / document tools

每个 capability 必须具备：

1. capability manifest
2. input schema
3. output schema
4. permission policy
5. budget policy
6. retry / repair policy
7. trace event mapping
8. Observation mapping
9. artifact mapping
10. verification hints

### 2. Public Reachable Tool Proxy

E2B sandbox 工具调用不能再默认依赖不稳定的 `host.docker.internal`。

后续真实服务启动必须默认使用公网可达或稳定内网可达的 capability endpoint：

1. Cloudflare Tunnel custom domain，例如 `https://dataswarm-dev.metad.ai`
2. 或其他稳定 HTTPS callback endpoint
3. 或 E2B 官方支持的更稳定 host callback / network bridge 方案

要求：

1. `DATASWARM_PUBLIC_BASE_URL` 必须指向 sandbox 可访问的真实 URL。
2. `DATASWARM_SANDBOX_TOOL_PROXY_URL` 必须指向真实可访问的 capability/tool proxy endpoint。
3. 服务启动时必须打印并记录当前 runtime profile、sandbox provider、agent model、tool proxy URL。
4. 若真实模式下 proxy URL 不可达，启动或首次任务前必须 hard fail，不能静默降级到 mock。

### 3. Real-by-default Runtime

默认服务必须走真实环境。

默认真实配置：

```bash
DATASWARM_SANDBOX_PROVIDER=e2b
DATASWARM_SANDBOX_AGENT_MODEL=real
DATASWARM_SANDBOX_TOOL_PROXY=parent
DATASWARM_SANDBOX_ALLOW_MODEL_SECRETS=1
DATASWARM_SANDBOX_AGENT_MODEL_NAME=deepseek-v4-flash
DATASWARM_DATA_DIR=../../data
DATASWARM_WORKSPACE_ROOT=../..
DATASWARM_PUBLIC_BASE_URL=https://dataswarm-dev.metad.ai
DATASWARM_SANDBOX_TOOL_PROXY_URL=https://dataswarm-dev.metad.ai/api/internal/sandbox/tool-proxy
```

Mock 只能显式启用：

```bash
DATASWARM_ALLOW_EXPLICIT_MOCK=1
DATASWARM_RUNTIME_PROFILE=mock-dev
```

真实模式下必须禁止：

1. `DATASWARM_SANDBOX_PROVIDER=mock`
2. `DATASWARM_SANDBOX_AGENT_MODEL=mock`
3. deterministic fallback 被计为成功
4. mock web.search 被计为真实 web.search
5. mock artifact 被计为真实 artifact

### 4. Sandbox ReAct Agent

每个 E2B branch agent 必须在 sandbox 内进入 ReAct loop。

每个 branch 至少需要：

1. 接收明确 branch contract
2. 保真执行 branch instruction
3. 每轮由真实模型产生 action
4. 解析 action schema
5. repair invalid action
6. retry recoverable failure
7. 调用 capability/tool proxy
8. 记录 Observation
9. 生成 branch final
10. 上报 qualitySignals

每个真实 branch 验收标准：

1. `real_model` action count >= 3
2. `fallbackActionCount = 0`，或明确标记 `degraded`
3. 至少一次有效 tool call，除非 branch contract 明确说明不需要工具
4. branch final 引用 Observation/Artifact
5. qualitySignals 包含工具成功、失败、fallback、artifact coverage、unsupported claims 风险

### 5. Artifact Lifecycle

artifact 必须真实生成、回收、去重、预览，并关联 source observations。

必须覆盖：

1. `run_python` 生成图片 artifact
2. `artifact.create` 生成 Markdown artifact
3. `artifact.create` 生成 HTML artifact
4. artifact metadata 包含 `branchId`
5. artifact metadata 包含 `sourceObservationIds`
6. artifact metadata 包含 `createdByToolCallId`
7. artifact metadata 包含 `artifactKind`
8. artifact 可在 UI 或 diagnostics 中预览
9. duplicate artifact 可检测并去重

### 6. Context and Artifact Carry-forward

后续对话必须能够主动把历史 artifacts 纳入上下文，而不是要求用户显式复制粘贴。

Orchestrator 需要具备：

1. 对当前 conversation 的完整上下文感知
2. 对历史 artifacts 的检索和摘要能力
3. 对 artifact relevance 的选择能力
4. 对 artifact 内容的按需注入能力
5. 对第二轮、第三轮追问的上下文延续能力
6. 对“生成更详细 HTML 报告”等任务自动引用既有 deep research 产物

关键原则：

1. 不把所有 artifact 原文无脑塞进 prompt。
2. 不要求用户手工选择 artifact。
3. 由 orchestrator 基于任务意图、artifact metadata、Observation、trace、branch final 自动选择。
4. 如果 artifact 内容太大，需要生成 evidence digest / structured context pack。
5. final answer 必须说明引用了哪些 Observation/Artifact。

### 7. Swarm Reduce and Verify

`swarm.reduce` / `swarm.verify` 必须等待所有 branch settled 后再执行。

验证必须基于：

1. branch contract
2. branch final
3. Observation
4. Artifact
5. tool_call
6. sandbox.agent.* event
7. qualitySignals
8. parent-proxy coverage
9. fallback/degraded signals

必须检查：

1. evidence coverage
2. unsupported claims
3. fallback usage
4. artifact coverage
5. parent-proxy coverage
6. required tool coverage
7. branch instruction coverage
8. branch final substance
9. artifact sourceObservationIds coverage
10. final answer citation coverage

### 8. Diagnostics

给定 `conversationId`，diagnostics 必须能够复现以下证据：

1. 是否真实启动 E2B
2. 启动了几个 branch
3. 每个 branch 是否进入 sandbox ReAct loop
4. 每个 branch 的 model action 是否来自 real_model
5. 每个 branch 的 action count
6. 每个 branch 的 fallbackActionCount
7. 是否真实调用 parent/capability proxy
8. 是否真实产生 tool_call
9. 是否真实产生 Observation
10. 是否真实产生 image artifact
11. 是否真实产生 Markdown/HTML artifact
12. artifact 是否有关联 sourceObservationIds
13. `swarm.reduce` 是否等待所有 branch settled
14. `swarm.verify` 是否执行
15. final answer 是否引用 Observation/Artifact
16. 是否存在 unsupported claims
17. 是否存在 degraded 或 failed_verification

## Implementation Phases

### Phase 0: Baseline and Failure Reproduction

目标：

1. Review 当前 V4/V4.1 实现状态。
2. 复盘失败会话，例如无法真实启动 E2B、父进程工具代理不可达、HTML 报告空洞、artifact 丢失上下文的问题。
3. 建立当前 evidence baseline。

必须产出：

1. baseline diagnostics
2. failure taxonomy
3. root cause map
4. implementation status checkpoint

验证：

1. 静态检查当前配置路径
2. local mock V3/V4 smoke
3. diagnostics 对历史 conversationId 的复现能力

### Phase 1: Real-by-default Startup Hardening

目标：

1. 默认启动真实环境。
2. mock 只能显式启用。
3. 启动时输出真实 runtime profile。
4. 真实模式下发现 mock/degraded 配置直接 fail fast。

必须产出：

1. `dev:real`
2. `dev:tunnel`
3. `dev:mock`
4. runtime guard
5. startup diagnostics

验证：

1. 静态检查 env resolution
2. local real config smoke
3. mock opt-in smoke
4. 确认真实模式不会静默进入 mock

### Phase 2: Capability Plane Contract

目标：

1. 定义 capability manifest。
2. 统一 tool schema。
3. 统一 invocation result。
4. 统一 trace / Observation / Artifact mapping。
5. 把 orchestrator tools 与 sandbox tools 收敛到同一能力层。

必须产出：

1. capability manifest
2. shared invocation protocol
3. tool adapter registry
4. capability validation
5. capability diagnostics

验证：

1. 静态 schema 检查
2. local capability invocation smoke
3. parent tool proxy smoke
4. run_python artifact smoke
5. artifact.create Markdown/HTML smoke

### Phase 3: Public Tool Proxy Reliability

目标：

1. 用 Cloudflare Tunnel 或稳定公网 endpoint 替代 `host.docker.internal` 默认路径。
2. sandbox agent 能真实调用 parent/capability service。
3. 每次 proxy 调用产生 tool_call、Observation、event。

必须产出：

1. tunnel startup integration
2. capability proxy health endpoint
3. sandbox proxy preflight
4. proxy failure diagnostics
5. request correlation id

验证：

1. local tunnel smoke
2. E2B sandbox network reachability smoke
3. parent-proxied web.search smoke
4. parent-proxied artifact.create smoke
5. parent-proxied trace.query smoke
6. parent-proxied run_python smoke

### Phase 4: Sandbox ReAct Agent V4.2

目标：

1. branch agent 在 E2B sandbox 内由真实模型逐步决定 action。
2. parser、repair、retry、validation、budget policy 完整。
3. deterministic fallback 只能 degraded/failed_verification。

必须产出：

1. ReAct prompt
2. action schema
3. parser
4. repair loop
5. retry policy
6. validation policy
7. budget policy
8. sandbox.agent.* events
9. branchFinal
10. qualitySignals

验证：

1. local mock V4 smoke
2. real-action local smoke
3. real model action count smoke
4. invalid action repair smoke
5. fallback degraded smoke
6. timeout/budget smoke

### Phase 5: Artifact and Context Carry-forward

目标：

1. artifact 真实生成、回收、去重、预览。
2. artifact 自动参与后续轮次上下文。
3. 第二轮追问能引用上一轮 artifacts 的实质内容。

必须产出：

1. artifact index
2. artifact digest
3. artifact relevance selector
4. context pack builder
5. sourceObservationIds linkage
6. conversation continuation policy

验证：

1. image artifact smoke
2. Markdown artifact smoke
3. HTML artifact smoke
4. duplicate artifact smoke
5. second-turn context carry-forward smoke
6. HTML report deepening smoke

### Phase 6: Swarm Reduce and Verify Gate

目标：

1. reduce/verify 等待所有 branch settled。
2. 基于完整 evidence graph 做强验证。
3. unsupported claims、fallback、artifact coverage、parent proxy coverage 都能被识别。

必须产出：

1. branch settled barrier
2. evidence graph
3. verifier checks
4. failed_verification state
5. final answer citation gate

验证：

1. swarm parallel smoke
2. branch settled barrier smoke
3. verifier unsupported claim smoke
4. verifier fallback smoke
5. verifier artifact coverage smoke
6. verifier parent-proxy coverage smoke

### Phase 7: Real E2B Complex Benchmark

目标：

运行至少一个真实 E2B complex swarm 任务，证明全链路能力。

必须满足：

1. 多个 branch 并行运行
2. 每个 branch 进入 sandbox ReAct loop
3. 每个 branch 至少 3 个 `real_model` action
4. `fallbackActionCount = 0`，或被明确 degraded
5. 至少一次真实 `web.search` 通过 parent/capability proxy 调用
6. `tool_call` 与 Observation 成功落盘
7. 至少一个图片 artifact
8. 至少一个 Markdown/HTML artifact
9. `swarm.reduce` 等待所有 branch settled
10. `swarm.verify` 完成
11. final answer 引用 Observation/Artifact
12. diagnostics 可通过 `conversationId` 复现完整证据链

验证：

1. real E2B parent-proxy smoke
2. real E2B complex benchmark
3. conversation diagnostics replay
4. artifact preview inspection
5. verifier output inspection

## Acceptance Criteria

完成条件不是代码存在，而是当前证据证明至少一个真实 E2B complex swarm 任务满足：

1. 多个 branch 并行运行。
2. 每个 branch 进入 sandbox ReAct loop。
3. 每个 branch 至少 3 个模型决策 action 来自 `real_model`。
4. `fallbackActionCount = 0`，或被明确标记 degraded。
5. 至少一次 parent/capability-proxied `web.search` 被真实调用。
6. 父进程产生对应 `tool_call`。
7. 父进程产生对应 Observation。
8. 至少一个 branch 生成图片 artifact。
9. 至少一个 branch 生成 Markdown 或 HTML artifact。
10. artifact 可回收、去重、预览，并关联 `sourceObservationIds`。
11. `swarm.reduce` 在所有 branch settled 后执行。
12. `swarm.verify` 在所有 branch settled 后执行。
13. final answer 引用 Observation/Artifact。
14. diagnostics 可通过 `conversationId` 复现上述证据。
15. 没有把 mock 结果当作 live 结果。
16. 没有把 degraded/fallback 当作成功完成。

## Required Documentation Updates

全过程必须持续维护：

1. `IMPLEMENTATION_STATUS.md`
2. `E2B_BRANCH_AGENT_REACT_V3_PLUS_PLAN.md`
3. `E2B_BRANCH_AGENT_REACT_V4_1_DELIVERY_CLOSURE_PLAN.md`
4. 本文档或新的 V4.2 Capability Plane 设计文档

每个阶段必须保留 checkpoint：

1. 已完成内容
2. 修改文件
3. 验证命令
4. 验证结果
5. 真实/Mock 标记
6. 未完成风险
7. 下一步

## Non-negotiables

1. 不伪造 live 结果。
2. 不把 mock 结果当真实完成。
3. 不把 fallback 当正常成功路径。
4. 不把代码存在当作能力完成。
5. 不在 diagnostics 无法复现时声称验收通过。
6. 不默认使用 mock。
7. 不默认依赖 `host.docker.internal`。
8. 不让用户手工复制 artifact 内容来补齐上下文。
9. 不让第二轮对话丢失第一轮 artifact 的实质内容。
10. 不提交 git，直到真实验收证据满足最终标准。

## Suggested Complex Benchmark Task

用于最终全量验证的任务可以采用以下提示：

```text
请以 DataSwarm 并行 E2B ReAct Agent 模式，完成一份“跨境电商最后一公里智能调度平台在中国、东南亚、北美三地落地可行性”的深度研究与交付。

要求并行启动至少 6 个 branch：
1. 市场与需求 branch：调研中国、东南亚、北美最后一公里配送痛点、市场规模、客户类型。
2. 竞品与商业模式 branch：调研 DispatchTrack、Onfleet、Bringg、菜鸟、顺丰、Lalamove 等相关方案。
3. 技术架构 branch：设计智能调度、路径优化、ETA、司机 App、商家 API、控制塔、异常处理架构。
4. 数据与算法 branch：设计数据模型、优化目标、约束条件、调度算法、仿真评估方法。
5. 合规与风险 branch：分析数据合规、地图与定位合规、司机劳动关系、跨境部署风险。
6. 财务与落地 branch：建立 3 年成本收益模型、MVP 计划、Go-to-market、里程碑。

每个 branch 必须：
- 在 E2B sandbox 内进入 ReAct loop；
- 至少产生 3 个 real_model action；
- 至少调用一次工具；
- 记录 Observation；
- 生成 branch final；
- 引用 Observation 或 Artifact；
- 如发生 fallback 必须标记 degraded。

工具要求：
- 至少一次真实 parent/capability-proxied web.search；
- 至少一次 file.read 或 trace.query；
- 至少一个 branch 使用 run_python 生成图片 artifact，例如市场规模图、成本收益图或架构图；
- 至少一个 branch 使用 artifact.create 生成 Markdown 或 HTML artifact；
- artifact 必须关联 sourceObservationIds。

最终输出：
- 一份深度 Markdown executive report；
- 一份 HTML 可视化报告 artifact；
- 一张图表 artifact；
- 一个 evidence appendix，列出使用的 Observation、Artifact、tool_call；
- 一个 verifier summary，说明 evidence coverage、unsupported claims、fallback、artifact coverage、parent-proxy coverage。

最后请通过 diagnostics 证明：
- 是否真实 E2B；
- 是否真实模型 action；
- 是否真实 parent/capability proxy；
- 是否真实 artifact 回收；
- fallbackActionCount；
- branch settled 状态；
- swarm.reduce / swarm.verify 状态；
- final answer 引用的 Observation/Artifact。
```

## Final Instruction

按阶段推进实现与验证。每完成一个阶段，更新状态文档并保留 checkpoint。只有当真实 E2B complex benchmark 的 diagnostics 能通过 `conversationId` 复现完整证据链时，才允许标记目标完成并提交 git。
