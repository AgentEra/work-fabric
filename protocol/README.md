# Work Fabric Participation Protocol v1

WFPP v1 是 Work Fabric 的语言无关核心协议。它定义人、Agent 与工作系统如何声明身份与能力，如何提出、接受和转移 Handoff，如何传递受限 Context，如何报告外部执行状态、返回结果、验收结果，以及如何订阅可重放的协作事件。

协议管理协作边界，不执行专业工作。推理、编码、文档编辑、业务处理和部署始终发生在参与方或外部系统内部。

## 规范结构

- [核心语义](spec/core.md)
- [角色与责任](spec/roles.md)
- [交互与生命周期](spec/interactions.md)
- [事件](spec/events.md)
- [跨 Exchange Federation Profile](spec/federation.md)
- [订阅与投递](spec/subscriptions.md)
- [安全与授权](spec/security.md)
- [版本与兼容](spec/versioning.md)
- [机器可读 Handoff 生命周期](spec/handoff-lifecycle.json)
- [机器可读交互 Payload 映射](spec/interaction-payloads.json)
- [一致性用例](conformance/)
- [参考序列](examples/)

关键词 MUST、MUST NOT、REQUIRED、SHOULD、SHOULD NOT 和 MAY 按 RFC 2119 与 RFC 8174 解释。

## 分层与边界

WFPP Core 包含领域语义、交互语义、Canonical Message、Schema、事件和订阅语义。HTTP、SSE、Webhook、A2A、MCP、本地 IPC 与 SDK 属于 Binding 或 Adapter；它们可以承载 WFPP，但不能重定义 Handoff、责任、Receipt、AuthorityScope 或生命周期。

Authoritative Exchange 是逻辑角色，不限制单体、集群、嵌入式或联邦部署。Work Fabric Server 将作为参考实现，但不属于本协议包。

Exchange Core Phase 1 是 transport-free 的协议参考实现。它只验证身份、授权、上下文可用性和 Handoff 命令，原子记录状态移交并生成协作事件；人、Agent 与系统的实际执行不发生在 Core 或 Runtime 内。`Handoff` 是权威事实，`Assignment` 是可重建投影。

持久化同样属于可替换 Adapter：Memory 实现承载参考行为，PostgreSQL 实现通过既有 SPI 提供生产持久化、RLS、CAS、outbox 和 Context 元数据；协议语义不依赖 PostgreSQL。

Phase 4A 已实现 Endpoint Participation Binding：管理员 Provision 注册事实，外部 Runtime 通过带 fencing 的 Session/Heartbeat 声明在线能力；参与方按 Identity、Capability Summary 和 Capability Contract 渐进披露；Resolver 可以读取未排序 Discovery 事实并显式提交 Target Resolution，或由 Endpoint 在显式 `eligible_pool_claim` 模式下查询受限候选池并执行原子 Claim。Endpoint Inbox 从 committed Handoff Event 重建分区路由，Agent Gateway 再通过公共 SDK 接入候选查询和 Durable SSE。该 Binding 不包含候选排名、自动 Claim、自动 Ack、自动 Accept 或工作执行。运行说明见[Endpoint 与外部 Agent Runtime 接入](../docs/endpoint-agent-boundary.md)。

Phase 10 已实现 Network Citizen Participation Binding：模块按
`decision-body`、`capability-provider`、`channel`、`context-provider`、
`governance-provider` 或 `observer` 声明单一责任类型，并通过带 fencing 的
租约 Session 动态发布 declarations。Actor type 与 Citizen kind 正交；
Provisioning 只建立身份和安全上限，声明不授予调用 Authority。Catalog 将
列表、描述、声明摘要和完整 Contract 分层授权披露，不排名、选择或执行。
运行说明见 [Network Citizen 架构与接入](../docs/architecture/network-citizens.md)。

Phase 7 已实现独立 Federation Profile：显式 Source/Target Exchange 使用 Ed25519 签名 Offer/Receipt、严格受众与 TTL、canonical digest、重放缓存和幂等 Bridge 对接本地公共 API/SDK。每个 Exchange 只对本地 Handoff 权威；Federation 不发现或选择 Peer，不复制状态，也不执行参与方工作。运行与信任说明见[跨 Exchange Federation](../docs/federation.md)。

## Schema 索引

所有 Schema 使用 JSON Schema Draft 2020-12，稳定对象默认拒绝未知字段。扩展只能进入命名空间化 `extensions`。

### 身份与基础

- `urn:work-fabric:schema:v1:trace-context`
- `urn:work-fabric:schema:v1:actor-ref`
- `urn:work-fabric:schema:v1:endpoint-ref`
- `urn:work-fabric:schema:v1:authority-scope`

### 内容与上下文

- `urn:work-fabric:schema:v1:resource-ref`
- `urn:work-fabric:schema:v1:content-part`
- `urn:work-fabric:schema:v1:context-bundle`

### Endpoint 与能力发现

- `urn:work-fabric:schema:v1:binding-descriptor`
- `urn:work-fabric:schema:v1:capability-descriptor`
- `urn:work-fabric:schema:v1:capability-summary`
- `urn:work-fabric:schema:v1:endpoint-descriptor`
- `urn:work-fabric:schema:v1:endpoint-identity-card`
- `urn:work-fabric:schema:v1:endpoint-identity-page`
- `urn:work-fabric:schema:v1:endpoint-capability-card`
- `urn:work-fabric:schema:v1:endpoint-capability-page`
- `urn:work-fabric:schema:v1:endpoint-capability-contract`
- `urn:work-fabric:schema:v1:endpoint-registration`
- `urn:work-fabric:schema:v1:endpoint-session-open`
- `urn:work-fabric:schema:v1:endpoint-session`
- `urn:work-fabric:schema:v1:endpoint-heartbeat`
- `urn:work-fabric:schema:v1:endpoint-session-close`
- `urn:work-fabric:schema:v1:endpoint-discovery-page`
- `urn:work-fabric:schema:v1:endpoint-inbox-partition-page`
- `urn:work-fabric:schema:v1:endpoint-claimable-handoff`
- `urn:work-fabric:schema:v1:endpoint-claimable-handoff-page`

### Network Citizen 与动态声明

- `urn:work-fabric:schema:v1:citizen-declaration`
- `urn:work-fabric:schema:v1:citizen-descriptor`
- `urn:work-fabric:schema:v1:citizen-provisioning`
- `urn:work-fabric:schema:v1:citizen-session-open`
- `urn:work-fabric:schema:v1:citizen-heartbeat`
- `urn:work-fabric:schema:v1:citizen-declaration-replace`
- `urn:work-fabric:schema:v1:citizen-session-close`
- `urn:work-fabric:schema:v1:citizen-discovery-page`
- `urn:work-fabric:schema:v1:citizen-declaration-page`

### Handoff、状态、结果与回执

- `urn:work-fabric:schema:v1:acceptance-criterion`
- `urn:work-fabric:schema:v1:capability-requirement`
- `urn:work-fabric:schema:v1:handoff-target`
- `urn:work-fabric:schema:v1:handoff-explicit-target`
- `urn:work-fabric:schema:v1:handoff-target-resolution`
- `urn:work-fabric:schema:v1:handoff-target-unavailable-command`
- `urn:work-fabric:schema:v1:handoff-offer`
- `urn:work-fabric:schema:v1:handoff-reference`
- `urn:work-fabric:schema:v1:handoff-claim-command`
- `urn:work-fabric:schema:v1:handoff-claim-control-command`
- `urn:work-fabric:schema:v1:handoff-claim-expire-command`
- `urn:work-fabric:schema:v1:handoff-accept-command`
- `urn:work-fabric:schema:v1:handoff-cancel-command`
- `urn:work-fabric:schema:v1:handoff-status-command`
- `urn:work-fabric:schema:v1:handoff-result-command`
- `urn:work-fabric:schema:v1:handoff-verification-command`
- `urn:work-fabric:schema:v1:handoff-rework-command`
- `urn:work-fabric:schema:v1:handoff-transfer-command`
- `urn:work-fabric:schema:v1:handoff-snapshot`
- `urn:work-fabric:schema:v1:status-update`
- `urn:work-fabric:schema:v1:artifact`
- `urn:work-fabric:schema:v1:evidence`
- `urn:work-fabric:schema:v1:result-submission`
- `urn:work-fabric:schema:v1:operation-receipt`

### 消息与错误

- `urn:work-fabric:schema:v1:resource-version-ref`
- `urn:work-fabric:schema:v1:command-envelope`
- `urn:work-fabric:schema:v1:operation-result`
- `urn:work-fabric:schema:v1:protocol-error`

### 事件与订阅

- `urn:work-fabric:schema:v1:event-data`
- `urn:work-fabric:schema:v1:protocol-event`
- `urn:work-fabric:schema:v1:subscription-filter`
- `urn:work-fabric:schema:v1:subscription`
- `urn:work-fabric:schema:v1:event-delivery`
- `urn:work-fabric:schema:v1:delivery-ack`

### 跨 Exchange Federation

- `urn:work-fabric:schema:v1:federation-envelope`
- `urn:work-fabric:schema:v1:federation-transfer-offer`
- `urn:work-fabric:schema:v1:federation-transfer-receipt`

`definitions` 是内部共享 Schema，不作为独立消息声明兼容性。

公共 `protocol-event` 是存储事件的隔离视图，不得包含内部 `domain_data`、Partition position、Commit ID、幂等记录或存储 Cursor 元数据。协议中的全局 Subscription 是逻辑消费视图；实现必须为每个 Subscription × Partition 保存独立恢复位置，因此不产生跨 Partition 的全局有序承诺。

Capability Target 的 `target_resolution_requested`、`target_resolved` 和 `target_unavailable` 都是正式公共 Protocol Event。解析成功事件必须把明确的 Actor/Endpoint 目标加入 participant audience，使对应 Endpoint 能通过同一个 Durable Subscription 收到 Handoff；事件只公开路由安全的 Target Binding 摘要，不公开候选、评分、私有约束证据或 Resolver 内部判断。

## 一致性验证

```bash
npm ci
npm run verify
npm run verify:exchange
```

`npm run conformance` 会加载全部 Schema，运行正负 Golden Fixtures、生命周期场景、Exchange Core 行为清单和覆盖检查。`npm run verify:exchange` 还会执行 Exchange packages、可恢复投影与投递，以及只依赖公共导出的 Reference Suite。实现只有在全部用例通过后，才可以声明兼容对应的 WFPP v1 Profile。

## 参考序列

- [Human → Agent](examples/human-to-agent/sequence.json)
- [Agent → Agent](examples/agent-to-agent/sequence.json)
- [System → Agent → System](examples/system-agent-system/sequence.json)

三个序列中的消息与状态迁移会在测试中使用本目录的 Canonical Schema 和状态机直接验证。
