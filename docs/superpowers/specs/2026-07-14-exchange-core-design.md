# Work Fabric Exchange Core 架构设计

- 日期：2026-07-14
- 状态：已完成方案确认，等待书面规格最终审阅
- 范围：Exchange Core、Exchange Runtime、稳定 SPI、参考 Adapter 与 Conformance
- 前置规范：WFPP v1 Core Protocol

## 1. 摘要

Work Fabric 是面向人、Agent 与工作系统的协作对接和责任交接基础层。外部参与方通过 WFPP 交付工作引用、上下文、授权范围、验收条件、状态和结果；Work Fabric 保存权威协作事实，维护责任迁移，并把已提交事实可靠地传播给订阅方。

Exchange 不执行参与方的专业工作，不运行 Agent，不替代飞书、Jira、Git、知识库或客户项目系统。它只负责回答并证明：

- 谁把什么交给了谁；
- 接收方是否明确承担责任；
- 交接采用了哪个上下文和授权版本；
- 当前责任归谁；
- 外部执行方报告了什么；
- 返回了哪些结果和证据；
- 谁完成了验收；
- 哪个事实触发了后续协作。

本设计采用：

1. 以 `Handoff` 为唯一核心责任聚合；
2. 对 Handoff 协作事实选择性使用 Event Sourcing；
3. 命令侧强一致、查询和通知侧最终一致的 CQRS；
4. 语义化、可验证的稳定 SPI，而不是通用 CRUD Repository；
5. 具体数据库、身份系统、Context 服务和消息系统全部位于 Adapter；
6. 初期单分区可运行、终态可按租户或协作范围分区的 Journal；
7. Memory Reference Adapter 先证明正确性，PostgreSQL 后续作为首个生产 Adapter。

## 2. 与既有设计的关系

本设计建立在以下已批准文档之上：

- `2026-07-13-collaboration-handoff-fabric-design.md`：项目愿景和总体职责；
- `2026-07-13-work-fabric-participation-protocol-v1-design.md`：WFPP v1 协议设计；
- `protocol/spec/*` 与 `protocol/schemas/v1/*`：协议规范和机器可读契约。

本设计进一步收紧 Exchange 内部边界：

- `Assignment` 是从 Handoff 派生的查询视图，不是第二个权威责任模型；
- `WorkReference` 是外部工作项引用，不是 Exchange 内部 Work Item 聚合；
- `Thread` 是协作关联键和查询维度，不是 v1 的事务聚合；
- Endpoint、Subscription、Checkpoint 和配置使用普通状态存储，不强制 Event Sourcing；
- PostgreSQL 只是 Adapter 名称，不进入逻辑模块或 SPI 名称。

若早期架构文档中的内部模块描述与本设计冲突，以本设计为 Exchange Core 的实现依据；WFPP 的外部协议语义不受影响。

## 3. 设计目标与非目标

### 3.1 目标

- 人、Agent 和系统通过相同协议承担和移交责任；
- 外部系统可以保留现有主数据和工作方式；
- 所有责任变化可审计、可重放、可证明；
- 命令可以安全重试，且并发更新不会静默覆盖；
- 外部通知故障不破坏已经成立的协作事实；
- 存储、身份、Context、Signal 和 Binding 可以独立替换；
- 单进程、本地运行、标准生产集群和后续联邦部署保持相同语义；
- 为高吞吐分区、异步投影、独立扩容和故障恢复保留演进路径。

### 3.2 非目标

Exchange Core 不是：

- BPMN 或通用工作流执行引擎；
- Agent Runtime、模型调度器或代码执行沙箱；
- CRM、项目管理、文档或知识库系统；
- 参与方内部推理、工具调用和步骤记录器；
- 自动决定客户业务流程的智能调度器；
- 依赖某个数据库或消息队列的封装层。

自动化来自外部参与端可以被 Agent 替换或组合，而不是 Exchange 把外部执行吸收到内部。

## 4. 总体架构

```text
Human / Agent / Existing System / AI Service
                    |
        Protocol Bindings & Connectors
        HTTP | A2A | MCP | SDK | Feishu
                    |
             Exchange Application
        validate | identify | authorize
        deduplicate | load | decide | commit
                    |
               Handoff Domain
                    |
              Stable Exchange SPI
  persistence | identity | authority | context | signal
                    |
                  Adapters
 memory | postgres | sso | workspace | kafka | webhook
                    |
              Exchange Runtime
 projection | subscription | dispatch | retry | expiry
```

### 4.1 组件职责

#### Protocol Binding

- 把 HTTP、A2A、MCP、本地 SDK 或其他传输映射为 WFPP 命令；
- 验证传输层格式和协议版本；
- 提交由认证层产生的 Authentication Evidence；
- 不包含 Handoff 状态机、权限规则或数据库逻辑。

#### Exchange Application

- 协调 Schema 校验、Identity、Authority、幂等和领域调用；
- 加载必要事件流和可选快照；
- 调用纯领域模型决定事件；
- 通过 Persistence SPI 原子提交事件和命令结果；
- 返回 Canonical Operation Result。

#### Handoff Domain

- 实现 WFPP Handoff 生命周期和责任不变量；
- 只依赖领域值和抽象时钟、ID 等确定性输入；
- 不执行网络调用、数据库查询、Context 下载或通知；
- 相同状态与相同命令必须得到相同领域决策。

#### Exchange Runtime

- 从已提交 Journal 构建查询投影；
- 执行订阅过滤和 Signal 投递；
- 管理 checkpoint、重试、退避和 dead-letter；
- 触发到期检查等系统命令；
- 不改变已经提交的事件，也不绕过 Application 直接修改聚合。

#### Adapter

- 实现稳定 SPI；
- 声明 Capability Manifest；
- 通过相应 Conformance Profile；
- 不把具体技术类型泄漏到 Core 领域模型。

## 5. 领域模型与权威边界

### 5.1 对象分类

| 对象 | 定位 | 是否核心聚合 | 权威存储方式 |
|---|---|---:|---|
| `Handoff` | 一次责任交接 | 是 | Event Sourcing |
| `WorkReference` | 外部需求、任务、合同或文档引用 | 否，值对象 | 固化在 Handoff Package |
| `Assignment` | 当前责任视图 | 否，派生模型 | 从 Handoff 事件投影 |
| `Result` | 一次交接返回的结果 | 否，Handoff 子对象 | 固化在 Handoff 事件 |
| `Artifact` / `Evidence` | 外部产物和证据引用 | 否，值对象 | 固化在 Result |
| `ContextBundle` | 交接采用的版本化上下文 | 独立版本化资源 | Context Adapter 或 Exchange |
| `Principal` | 已认证调用身份 | 否 | Identity Adapter |
| `Actor` | 承担责任的人、Agent 或系统 | 引用/目录记录 | Identity/Directory Adapter |
| `Endpoint` | Actor 的协议入口 | 独立注册记录 | 普通状态存储 |
| `Subscription` | 事件订阅配置 | 独立运行时记录 | 普通状态存储 |
| `Receipt` | Exchange 签发的事实证明 | 否，不可变事实 | 随领域事件提交 |
| `Thread` | 多次 Handoff 的关联键 | 否 | 投影和查询维度 |

### 5.2 Handoff Aggregate

Handoff 的不可变 Package 包含：

- Work Reference；
- Initiator；
- Target；
- Intent；
- 固定版本的 Context 引用；
- Authority Scope；
- Acceptance Criteria；
- Verifier；
- `accept_by` 与 `result_due_at`；
- Parent Handoff 引用。

Handoff 的可演进状态包含：

- Lifecycle State；
- Current Responsible Actor；
- Resource Version；
- Result；
- Parent/Child 交接关系所需的最小状态。

`StatusUpdate` 形成不可变事件，但完整状态报告历史和 `latest_status` 主要由投影维护。领域只保留执行当前状态转换所必需的信息。

### 5.3 责任映射

| 生命周期状态 | 权威责任方 |
|---|---|
| `offered` | Initiator |
| `accepted` | Recipient |
| `result_returned` | Verifier |
| `verified` | Verifier |
| `rework_requested` | Verifier，直到 Recipient 再次接受 |
| `closed` | 无活动责任 |
| `declined` | 无活动责任 |
| `expired` | 无活动责任 |
| `cancelled` | 无活动责任 |
| `transferred` | 父 Handoff 无活动责任，由已接受的子 Handoff 表达 |

Assignment View 由以下信息派生：

```text
Handoff lifecycle
+ current_responsible_actor
+ work_reference
+ deadlines
+ latest external status
```

投影损坏时可以从事件重建，不能反向把投影状态当作责任事实写回聚合。

### 5.4 WorkReference

需求、项目、合同、飞书文档、GitHub Issue 或代码仓库继续由原系统拥有。Exchange 固化外部引用、版本和可选 Digest，不复制成第二套工作项主库。

若需要回写外部状态，由 Connector 订阅已提交 Handoff 事件后执行；回写失败不回滚 Handoff 事实。

### 5.5 Principal、Actor 与 Endpoint

三者必须分离：

- Principal：当前经过认证的调用身份；
- Actor：在协作中承担责任的人、Agent 或系统；
- Endpoint：Actor 收发协议消息的技术入口。

一个 Agent Runtime 可以使用一个 Principal 托管多个 Agent Actor，但每次命令代表哪个 Actor 必须由有效 Delegation 明确证明，不能由 Payload 自报。

### 5.6 Context

Context Bundle 表达“交接所采用的固定上下文版本”，不是可被无提示覆盖的共享聊天记录。Handoff 固化：

```text
context_id
context_version
digest
visibility_scope
```

Context 内容可以由 Exchange、飞书、知识库、对象存储或独立 Workspace/Context Service 保存。大内容获取不进入事件提交事务。

若 Offer 不包含 Context，则 Accept 的 `context_available` 条件视为满足；若包含必要 Context，Recipient 在接受前必须能够访问。责任已经成立后 Context 暂时不可用，不回滚历史交接，而是通过查询状态和事件暴露 `context_unavailable`。

### 5.7 Transfer

`handoff.transfer` 创建状态为 `offered` 的子 Handoff。子 Handoff 被明确接受之前，父 Handoff 保持 `accepted`，原 Recipient 继续负责。

子 Handoff 接受时必须在一个原子提交中：

1. 子 Handoff 进入 `accepted`；
2. 父 Handoff 进入 `transferred`；
3. 签发责任接受 Receipt；
4. 提交父、子 Handoff 的全部事件。

该规则防止责任真空和双重责任。内部由 `HandoffTransferCoordinator` 协调多个 Aggregate；它是领域服务，不是新的聚合，也不执行外部工作。

## 6. 命令处理链路

标准写入链路如下：

1. Binding 提交 WFPP Command Envelope 和 Authentication Evidence；
2. Application 校验 Schema、协议版本和命令结构；
3. Identity Provider 解析 Principal、Actor 与 Delegation；
4. Authority Policy 判断 Principal 是否可以代表 Actor 操作目标资源；
5. 使用 `idempotency_key` 和 Canonical Payload Digest 检查幂等；
6. 加载目标事件流和可选快照；
7. Domain 校验生命周期与责任不变量并产生待提交事件；
8. Persistence Adapter 原子提交幂等记录、事件和命令结果；
9. 提交后 Projection 和 Signal Worker 异步消费事件；
10. Binding 向调用方返回 Canonical Operation Result。

同步强一致范围：

- Schema 和权限校验；
- Handoff 状态转换；
- Resource Version；
- Command 幂等；
- Receipt 和领域事件提交；
- Transfer 多流原子性。

异步最终一致范围：

- 查询投影；
- Participant Inbox；
- 订阅通知；
- 飞书、Webhook、Agent Runtime 投递；
- 搜索、分析和关系图。

事务中禁止调用飞书、Agent Runtime、Codex、Webhook、搜索引擎、知识库或外部 Context 服务。

## 7. 选择性 Event Sourcing 与 CQRS

### 7.1 使用 Event Sourcing 的对象

Handoff 和责任迁移事实需要：

- 完整责任历史；
- 确定性重放；
- 并发冲突检测；
- Receipt 和审计证据；
- 投影重建；
- 全局订阅和重放。

因此 Handoff 使用事件作为权威事实，当前状态和 Snapshot 是事件折叠结果。

### 7.2 不强制 Event Sourcing 的对象

以下数据使用普通状态记录：

- Endpoint Descriptor 和 Lease；
- Capability Registry；
- Subscription 配置；
- Projection Checkpoint；
- Signal Delivery State；
- Dead-letter；
- Runtime Worker Lease；
- Adapter 配置和健康状态。

这些记录的变化如果需要对外通知，应在状态事务中产生可恢复的 Canonical Event，但其当前记录仍是权威状态。

### 7.3 Snapshot

Snapshot 是可选性能优化：

- 不属于权威事实；
- 保存失败不应回滚已提交事件；
- 版本不兼容时可以删除；
- 必须能够通过 Journal 重新生成。

## 8. Persistence SPI

SPI 必须表达协作语义，不能退化为 `save(entity)`、`update(row)` 等通用 CRUD。

### 8.1 主要 Port

```text
EventJournal
├── readStream(stream_id, from_version)
├── append(stream_id, expected_version, events)
├── appendAtomically(partition_id, stream_appends, command_record)
└── readPartition(partition_id, after_position, limit)

CommandDeduplication
├── find(tenant_id, idempotency_key)
└── record(idempotency_key, payload_digest, normalized_operation_outcome)

SnapshotRepository
├── load(stream_id)
├── save(snapshot)
└── delete(stream_id)

ProjectionCheckpointStore
├── load(projector_id, partition_id)
└── advance(projector_id, partition_id, expected_position, new_position)

DeliveryStateStore
├── load(subscription_id, partition_id)
├── recordAttempt(delivery)
├── advance(subscription_id, partition_id, position)
└── deadLetter(delivery, reason)
```

`appendAtomically` 必须把 Command Deduplication 记录、规范化 Operation Outcome 和全部事件放在同一个原子事务中。Outcome 保存资源、Receipt 和错误等可重放语义，不固化响应 Envelope 的 `request_message_id`；Snapshot 不在该强制事务内。

### 8.2 Event Record 元数据

每个持久化事件至少包含：

```text
event_id
event_type
schema_version
tenant_id
partition_id
partition_position
stream_id
stream_version
commit_id
commit_ordinal
request_message_id
idempotency_key
correlation_id
causation_id
actor
occurred_at
event_data
```

客户端时间不决定权威顺序。流内顺序由 `stream_version` 决定，消费顺序由 `partition_position` 决定，同一原子提交内由 `commit_id + commit_ordinal` 表达事件顺序。

### 8.3 Partition 语义

终态架构不要求所有租户共享一个永久串行的数据库序号。

- 同一事件流严格有序；
- 同一 Partition 有稳定、可恢复的 Position；
- 不要求无关租户和无关工作项之间存在全局总顺序；
- 一个原子多流提交的全部流必须属于同一 Partition；
- 子 Handoff 继承父 Handoff 的 Partition；
- Runtime 为每个 Partition 独立维护 checkpoint。

初期可以只有一个 Partition。后续可以按租户或稳定的 Collaboration Scope 分区，而不改变领域和协议语义。

“全局事件”表示所有规范事件都可以通过统一订阅机制发现和恢复消费，不表示物理存储必须使用单一序列。

`partition_position` 是 Exchange 内部的恢复位置，不等于 WFPP CloudEvent 的 `wfsequence`。`wfsequence` 继续表达单个协议资源的顺序，Handoff 事件通常映射其 Resource Version；Subscription Cursor 是不透明值，可以封装一个或多个 Partition Position，客户端不得解析其内部格式。

### 8.4 Capability Manifest

Adapter 启动时暴露能力：

```json
{
  "profile": "exchange.persistence.v1",
  "adapter": "memory",
  "capabilities": {
    "atomic_multi_stream_append": true,
    "partitioned_journal": true,
    "snapshots": true,
    "batch_read": true,
    "tenant_isolation": true
  }
}
```

完整权威存储 Profile 的强制能力：

- expected stream version 和乐观并发；
- 同一流严格有序；
- 原子多流追加；
- Command 幂等记录和事件追加原子一致；
- Partition 内可恢复游标；
- 已提交事件不可修改；
- 失败事务不遗留部分事件。

可选能力包括 Snapshot、批量读取、原生租户隔离、只读副本、压缩归档、冷热分层和原生变更通知。Core 可以基于可选能力优化，但不能依赖它们维持正确性。

不能满足任一强制能力的 Adapter 不得以完整权威存储 Profile 启动。

## 9. 其他稳定 SPI

### 9.1 Identity SPI

```text
IdentityProvider.resolve(authentication_evidence)
    -> principal + actor/delegation claims
```

Authentication Evidence 由可信 Binding 提供，不能从 Command Payload 自报 Principal。

### 9.2 Authority SPI

```text
AuthorityPolicy.authorize(principal, represented_actor, action, resource, context)
    -> allow | deny | conditional
```

Identity 负责“你是谁”，Authority 负责“你可以做什么”，Handoff Domain 负责“当前状态下这件事能否发生”。Authority Adapter 对高风险写操作不可用时默认拒绝。

### 9.3 Context SPI

```text
ContextRepository
├── putBundle
├── getBundle(context_id, version)
├── resolveResources
└── verifyIntegrity
```

Handoff 只依赖版本、可见性、Digest 和可用性结论，不依赖飞书或某个知识库的技术类型。

### 9.4 Signal SPI

```text
SignalAdapter.deliver(canonical_event, destination)
    -> accepted | retryable_failure | permanent_failure
```

消费游标、订阅过滤、退避、重试、dead-letter 和投递状态属于 Exchange Runtime，不下放给飞书、Kafka 或 NATS Adapter。

## 10. 幂等、并发和错误恢复

### 10.1 Command 幂等

所有写命令必须携带 WFPP `idempotency_key`，`message_id` 标识本次协议消息。Exchange 使用规范化 Payload Digest 判断：

- 相同 Tenant、相同 `idempotency_key`、相同 Digest：返回第一次 Operation Result；
- 相同 Tenant、相同 `idempotency_key`、不同 Digest：返回 `idempotency_key_reused`；
- 超时和临时故障后，调用方可以使用原 `idempotency_key` 安全重试；
- 重试可以使用新的 `message_id`。Exchange 使用已保存的规范化 Outcome 构造响应，保持第一次提交的资源、Receipt 和错误语义，同时让 `request_message_id` 回显当前请求的 `message_id`。

### 10.2 乐观并发

修改既有资源的命令必须带 expected Resource Version。Adapter 以 Compare-and-Append 保证只有一个并发命令成功。冲突返回 `version_conflict`，调用方或 Application 可以重新加载后进行有限重试，但不能覆盖新状态。

### 10.3 错误分类

| 类型 | 示例 | 处理 |
|---|---|---|
| 业务拒绝 | 非责任方发起 Transfer | 明确拒绝，不自动重试 |
| 幂等冲突 | 同一 Idempotency Key 使用不同 Payload | 返回 `idempotency_key_reused` 并审计 |
| 并发冲突 | Resource Version 已推进 | 重新加载后有限重试 |
| 临时基础设施故障 | Store 短暂不可用 | 保持 Idempotency Key 重试 |
| 永久基础设施故障 | Adapter 不满足 Profile | 拒绝启动或停止写入 |
| 下游投递故障 | 飞书或 Agent 离线 | 不回滚事件，异步重投 |

对外错误必须使用现有 WFPP `ProtocolError`，由 `OperationResult.request_message_id` 关联请求。结构包括：

```text
code
message
retryable
retry_after_seconds
current_resource_version
field_violations
details
```

业务、并发、临时和永久基础设施等错误分类属于 Core 内部判定，用于映射 `operation_status`、`code` 和 `retryable`，不扩展一套与 ProtocolError 冲突的公开错误格式。

### 10.4 Projection 恢复

- 每个 Projector 独立维护每个 Partition 的 checkpoint；
- 处理成功后以 expected position 推进；
- 失败时不推进；
- 投影写入必须幂等；
- 投影可以删除并从 Journal 重建；
- 无法处理的事件不得静默跳过，应隔离并暴露健康告警。

### 10.5 Signal 恢复

外部投递采用 at-least-once，不承诺跨系统 exactly-once：

- Dispatcher 从已提交 Journal 读取；
- 每个订阅和 Partition 独立记录投递位置；
- 临时失败指数退避；
- 超过策略阈值进入 dead-letter；
- 消费方使用 `event_id` 去重；
- 一个订阅失败不阻塞其他订阅。

即使进程在事件提交后、通知发送前崩溃，Dispatcher 也可以从持久化位置恢复。

### 10.6 事件演进

- 已提交事件不可修改；
- 事件带 `event_type` 和 `schema_version`；
- 兼容变化优先增加可选字段；
- 旧事件通过 Upcaster 转换为当前领域输入；
- 破坏性语义变化使用新事件类型；
- Snapshot 不兼容时删除并重建。

## 11. Conformance 与验证

### 11.1 Protocol Conformance

沿用现有 WFPP Schema、生命周期和 Golden Fixture 验证，确保 Core 的输入、输出、事件和 Receipt 与协议一致。

### 11.2 Domain Tests

必须覆盖：

- 所有合法和非法生命周期迁移；
- 一个 Handoff 同一时刻只有一个明确责任状态；
- 通知送达不会被解释为责任接受；
- 非法命令不产生事件；
- 相同事件重放得到相同状态；
- 人、Agent 和系统遵守相同责任规则；
- Transfer 不产生责任真空或双重责任；
- Result Return 与 Verify 是不同事实；
- StatusUpdate 不改变 Handoff 生命周期。

### 11.3 Persistence Conformance

所有权威存储 Adapter 使用同一测试套件验证：

- expected version；
- 流内顺序；
- 多流原子追加；
- Tenant 内 Idempotency Key 唯一性；
- 幂等记录与事件原子性；
- 事务回滚无残留；
- Partition Position 恢复；
- 并发追加只有一个成功；
- 重启后语义保持；
- 事件不可变。

### 11.4 Runtime Fault Injection

至少覆盖：

- 事件写入过程中进程失败；
- 响应返回前连接中断；
- 两个 Agent 同时 Accept；
- Projection 写入成功但 checkpoint 未推进；
- Signal 已发送但 delivery position 未推进；
- Context Service 超时；
- Adapter 重启；
- 旧版本事件混合重放；
- Poison Event 隔离和恢复。

### 11.5 Benchmark

Benchmark 与正确性 Conformance 分离，统一测量：

- 单流追加延迟；
- 多流 Transfer 延迟；
- Partition 扩展后的吞吐；
- 热点 Handoff 冲突率；
- Projection 延迟和重建速度；
- Signal Backlog 恢复速度；
- Snapshot 前后的加载成本。

WFPP 不写死 TPS。部署产品可以定义 Development、Standard、High Throughput 等独立性能等级。

## 12. 包结构与依赖方向

```text
protocol/
├── schemas
├── spec
├── examples
└── conformance

packages/
├── exchange-spi
├── exchange-core
├── exchange-runtime
├── exchange-conformance
├── adapter-storage-memory
├── adapter-storage-postgres
├── adapter-identity-local
├── adapter-context-memory
└── adapter-signal-in-process
```

逻辑上的 Ports 仍属于 Exchange Core 边界；物理上发布独立 `exchange-spi`，使第三方 Adapter 只依赖稳定契约，不依赖 Aggregate 和 Application 内部实现。

依赖规则：

- `exchange-core` 依赖 WFPP 和 `exchange-spi`；
- `exchange-runtime` 依赖 `exchange-core` 与 `exchange-spi`；
- Adapter 只依赖 WFPP 公共类型和 `exchange-spi`；
- `exchange-conformance` 依赖 WFPP 与 `exchange-spi`；
- `exchange-core` 和 `exchange-spi` 不依赖任何具体 Adapter；
- 技术名只出现在 Adapter 包名中。

## 13. 部署模型

### 13.1 Embedded

Exchange Core、Memory/Embedded Store 和 In-process Signal 运行在客户进程或本地 Agent Runtime 中，适用于开发、测试、离线和小型本地场景。

### 13.2 Standard Production

```text
Stateless Exchange API x N
            |
     PostgreSQL Adapter
            |
Exchange Runtime Workers x N
            |
Feishu / Agent / Webhook Adapters
```

- API 节点无状态，可横向扩容；
- PostgreSQL 是首个生产 Adapter，不是架构边界；
- Runtime Worker 独立扩容并通过分区租约接管；
- 外部 Connector 故障与命令提交隔离；
- 查询模型可以使用独立存储和只读副本。

### 13.3 Large-scale

- Journal 按 Tenant 或 Collaboration Scope 分区；
- Projection 和 Signal 按 Partition 独立消费；
- Kafka/NATS 等可以作为高吞吐 Signal Adapter，但不成为权威事实源；
- 事件可以冷热分层和归档；
- 热点协作范围可以迁移到独立 Partition，但迁移必须保持流版本和游标语义。

### 13.4 Federation

多个 Authoritative Exchange 后续可以通过 WFPP Federation Profile 协作。跨 Exchange 责任移交需要独立的信任、Receipt、重试和对账协议，不进入第一阶段，也不能被普通 Signal 投递假装实现。

## 14. 第一阶段实施范围

第一阶段目标：

> 在无 HTTP、无飞书、无真实 Agent Binding、无 PostgreSQL 的情况下，证明 Exchange Core 协作语义正确，并证明 Adapter 可替换契约可执行。

### 14.1 必须实现

1. 修正 WFPP Context 可选性的 Schema 不一致；
2. `exchange-spi` 的 Persistence、Identity、Authority、Context、Signal 和 Capability Manifest；
3. Handoff Aggregate 和完整 WFPP 生命周期命令；
4. Handoff Transfer Coordinator；
5. Idempotency Key、Resource Version 和乐观并发；
6. Receipt、Canonical Event 和确定性重放；
7. Projection、Subscription Filter、Signal Dispatcher、checkpoint、Retry 和 Dead-letter 核心模型；
8. 支持原子多流追加和 Partition Journal 的 Memory Storage Adapter；
9. Local Identity/Authority、Memory Context 和 In-process Signal 参考 Adapter；
10. Domain、SPI、重放、并发、Transfer 原子性和 Runtime 故障恢复测试。

### 14.2 不实现

- HTTP Server；
- PostgreSQL Adapter；
- 飞书 Connector；
- A2A 或 MCP Binding；
- Agent Runtime 或 Codex 调用；
- UI Console；
- 通用 Workflow Engine；
- 智能匹配和调度算法；
- 联邦 Exchange。

### 14.3 后续顺序

```text
阶段 1：Exchange Core + Memory Reference
阶段 2：PostgreSQL Production Adapter
阶段 3：HTTP / SDK Binding
阶段 4：飞书与本地 Agent Runtime 接入
阶段 5：查询、运维和可观测性
阶段 6：高吞吐 Signal 与集群分区
阶段 7：跨 Exchange Federation Profile
```

## 15. 实施前协议修订

当前 WFPP v1 存在一处需先消歧的 Schema：

- `handoff-offer.schema.json` 中 `context_bundle` 可选；
- `handoff-snapshot.schema.json` 中 `context_bundle_id` 和 `context_bundle_version` 必填且不允许 `null`；
- `core.md` 将 Context 描述为可选。

本设计决定 Context 端到端可选：

- 有 Context 时，ID 与 Version 必须同时存在；
- 无 Context 时，二者必须同时为 `null`；
- 不允许只出现其中一个。

该修订应与正负 Conformance Fixture 同步完成，并保持 Core 文档、Schema 和 Snapshot 语义一致。

## 16. 第一阶段验收标准

第一阶段完成时必须满足：

- 现有 110 个 WFPP 测试继续通过；
- 所有 Handoff 生命周期路径都有领域测试；
- 相同 Idempotency Key 重试不会产生重复事件；
- 相同 Idempotency Key 使用不同 Payload 被拒绝；
- 并发 Accept、Cancel、Result Return 和 Transfer 不会静默覆盖；
- 子 Handoff Accept 与父 Handoff Transferred 原子提交；
- Memory Storage Adapter 通过完整 Persistence Profile；
- 投影删除后可以重建为等价状态；
- Signal 在发送后崩溃的场景允许重复但不会永久丢失；
- Poison Event 不会被静默跳过；
- Core 包的依赖图不包含数据库、消息队列、HTTP、飞书或 Agent Runtime 实现；
- 所有公共 SPI 都有 Capability 和 Conformance 定义；
- 执行工作始终发生在外部测试替身中，Core 不出现内部执行器抽象。

## 17. 已否决方案

### 17.1 全部对象使用 Event Sourcing

Endpoint Lease、Subscription 配置和 Runtime Checkpoint 不需要承担完整协作历史的复杂度。全面 Event Sourcing 会增加实现和运维成本，不带来对应价值。

### 17.2 PostgreSQL 命名进入核心模块

例如 `exchange-eventstore-postgres` 作为逻辑核心会把产品边界与首个实现耦合。技术名只允许进入 Adapter 包。

### 17.3 最低共同能力的 CRUD Repository

通用 CRUD 会隐藏多流原子性、Expected Version、Idempotency Key 和恢复游标等关键语义，造成“接口可替换、行为不可替换”。本设计以能力 Profile 和 Conformance 保证行为兼容。

### 17.4 单一全局永久序号

所有租户共享一个全局写入序号会限制终态扩展。采用流内顺序、Partition Position 和 Commit Ordinal 保留重放能力，同时允许横向分区。

### 17.5 将 Assignment 作为第二权威模型

Handoff 和 Assignment 同时维护责任会产生双写和分歧。Assignment 只作为可重建投影。

### 17.6 在事务中调用外部执行或通知系统

外部调用会延长事务、放大故障并把客户系统可用性变成 Core 可用性的前提。所有外部执行和通知都在事实提交后异步发生。

## 18. 最终定位

Exchange Core 的职责可以收敛为：

> 接受来自人、Agent 和系统的统一协作命令，验证身份、权限和状态，将责任交接固化为不可变事实，并把这些事实可靠地传播给外部执行者和观察者。

它决定“协作事实是否成立”，不决定“参与方如何完成工作”。这一边界既保持 Work Fabric 的 AI Native 与 Agent Friendly，也为传统系统接入、渐进式 AI 化、高扩展和后续高性能实现保留稳定基础。
