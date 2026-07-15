# Work Fabric 协作对接与工作交接架构设计

- 日期：2026-07-13
- 状态：已完成方案讨论，等待书面设计最终审阅
- 定位：面向人、Agent 与工作系统的协议驱动协作互联与交接层

## 1. 摘要

Work Fabric 用统一参与协议连接人、AI Agent、Agent Runtime、传统工作系统和 AI-native 服务。它不执行参与方的专业工作，也不替代客户已有的文档、需求、代码、知识和运维系统；它负责让各方可靠地发现彼此、接受委托、传递上下文、移交责任、报告状态、返回结果并完成验收。

项目的核心由两部分组成：

1. **Unified Participation Protocol**：定义身份、能力、工作引用、协作请求、分派、交接、上下文、状态、结果和回执等共同语义。
2. **Collaboration & Handoff Exchange**：持久化协作事实，维护分派与责任迁移状态，并通过事件、订阅和通知把变化可靠地传递给人、Agent 和外部系统。

Work Graph、Context Workspace 和事件网络都是支撑协作对接与交接的能力，不是系统中心。能力匹配、目标选择和自动化规则属于通过协议接入的可选外部 Resolver 或参与服务。完全 AI 自动化来自参与端点与外部决策模块的可替换性：当人类参与端逐步被 Agent 端点替换时，协议和交接闭环保持不变。

## 2. 项目使命与设计原则

### 2.1 项目使命

> A protocol-driven collaboration interconnect for humans, agents, and work systems.

Work Fabric 将分散在飞书、CRM、项目管理、Git、知识库、Agent Runtime 和运维平台中的参与方连接成一张协作网络，帮助客户在不迁移原有业务系统的前提下，逐步实现 AI 辅助、人机协作、多 Agent 协作和更高程度的自动化。

### 2.2 设计原则

1. **执行外置**：人的工作、Agent 的规划推理、代码实施和外部系统业务逻辑都发生在 Work Fabric 之外。
2. **协议优先**：先稳定协作语义和交互状态机，再选择 API、消息队列或本地 SDK 等传输方式。
3. **交接为中心**：核心问题是“谁把什么、带着哪些上下文和权限、以什么验收条件交给了谁”。
4. **外部事实归原系统**：原始业务内容和执行事实保留在来源系统；Work Fabric 保存统一引用、协作事实和必要快照。
5. **Agent 原生友好**：Agent 与人一样具有身份、能力、责任、交接、状态回报和结果验收语义，而不是被当作一个无状态工具调用。
6. **人机同构、入口异构**：人、Agent 和系统共享协作语义，但可以通过飞书、流式协议、Webhook、消息队列或本地 IPC 等不同入口接入。
7. **事件驱动但不等同于事件总线**：事件必须关联工作、参与者、交接、上下文和因果关系。
8. **可靠而非假定 exactly-once**：跨系统采用至少一次投递、幂等处理、回执和对账来实现业务上的有效一次。
9. **逻辑图模型不绑定物理图数据库**：协作关系可投影为图，但权威事务状态可以存储在关系型数据库中。
10. **可治理的替换性**：参与端点可以从人替换为 Agent，但授权、审计、验收和风险策略始终生效。

## 3. 职责边界

### 3.1 Work Fabric 原生负责

- 统一参与协议及版本兼容规则。
- 租户内的参与者、端点、角色、能力与在线状态目录。
- 外部工作项的统一引用和跨系统身份映射。
- Collaboration Thread、Assignment 和 Handoff 的生命周期。
- 交接时的上下文、授权范围、验收条件和回传通道。
- 责任接收、状态移交、问题升级、再次交接、结果回传和验收回执。
- 协作事件、订阅、通知、确认、游标和重放。
- 将目标已经确定的 Handoff 可靠派发，并跟踪 Delivery、Ack、重试和恢复。
- 协作链路的身份、委托、权限、因果、证据和审计。
- 面向查询和透明化的资源关系图与状态投影。
- Connector、Agent 和客户端的 SDK、契约测试及一致性验证。

### 3.2 Work Fabric 明确不负责

- Agent 的模型推理、内部计划、工具调用和长期运行时。
- 人的专业工作过程。
- 代码编写、测试、部署或运维处置本身。
- 替代飞书、CRM、Git、知识库或项目管理系统成为内容主库。
- 强制所有参与方采用同一种工作流或传输协议。
- 将所有外部内容复制为第二套完整数据仓库。
- 内置一个包办所有业务流程的通用自动化执行引擎。
- 根据能力、负载、成本或模型判断自动选择 Handoff 接收方。
- 安排 Agent、Workflow 或外部系统内部的执行步骤和资源。

### 3.3 可选支撑能力

以下能力可以作为独立模块、插件或外部服务接入，不进入稳定内核：

- 基于能力与负载的接收方推荐。
- 人工、规则或 AI Target Resolver。
- 超时提醒、简单路由规则和升级策略。
- 外部 Workflow Engine 桥接。
- Agent Runtime、模型服务和工具平台桥接。
- 知识检索、向量搜索和上下文压缩服务。
- 面向特定行业的项目模板与业务对象扩展。

## 4. 系统上下文

### 4.1 三类参与端点

#### Human Workplaces

客户、销售、产品、项目经理、开发、审批人和运维人员继续通过飞书消息、飞书文档、Web Console 或开放 API 参与。Human Channel Adapter 将通知、交互卡片、审批、回复和人工接管映射为统一参与协议。

#### Agent Brains & Runtimes

本地 Agent Runtime、Codex 和远程专业 Agent 通过 Native Agent Endpoint 接入，声明身份和能力，接受 Handoff，获取范围化上下文，回报状态并提交结果。规划、推理和执行都发生在这些外部端点内部。

Codex 可以有两种接入方式：

- 作为本地 Agent Runtime 暴露的代码实施能力或执行器。
- 在具备独立身份、交接生命周期和回调能力时，作为独立 Agent Endpoint。

#### Legacy & AI-native Systems

飞书文档、CRM、项目管理、Git、知识库、部署和监控系统通过 Connector Adapter 接入。Connector 负责资源映射、事件捕获、状态映射、动作写回和状态对账，外部系统继续拥有原始业务内容。

### 4.2 支持的协作组合

- Human ↔ Human
- Human ↔ Agent
- Agent ↔ Agent
- System ↔ Human
- System ↔ Agent
- System ↔ System

这些组合使用相同的协作与交接语义，区别仅在于端点能力、传输绑定和治理策略。

## 5. 总体架构

```text
Human Workplaces        Agent Brains/Runtimes        Work Systems
        |                        |                         |
Human Channel Adapter   Native Agent Endpoint   Connector Adapter
        \_______________________|_________________________/
                                |
              Unified Participation Protocol
                                |
              Collaboration & Handoff Exchange
       ┌────────────────────────────────────────────┐
       │ Participant Directory                     │
       │ Work Reference Registry                   │
       │ Collaboration Thread                      │
       │ Assignment & Handoff                      │
       │ Status Transfer                           │
       │ Result, Receipt & Acceptance              │
       └────────────────────────────────────────────┘
                                |
        Global Signal / Subscription / Notification
                                |
       Context | Identity/Trust | Trace | Relation Views
                                |
      Transaction Store | Event Ledger | Read Projections
```

### 5.1 Unified Participation Protocol

协议平面是系统核心产品，而不是某个 Gateway 的实现细节。它定义：

- Identity & Delegation
- Endpoint & Capability
- Work Reference & Intent
- Assignment & Handoff
- Context Exchange
- Status & Checkpoint
- Result, Receipt & Acceptance
- Event & Subscription
- Federation & Synchronization

协议分为四层：

1. **领域语义层**：Participant、Work、Handoff、Context、Status、Result 等概念及关系。
2. **交互协议层**：注册、发现、邀请、接受、续约、回报、交接、退回、验收和关闭等状态机。
3. **消息契约层**：Schema、版本、幂等键、关联 ID、因果 ID、错误、游标和扩展字段。
4. **传输绑定层**：HTTP、gRPC、WebSocket、Webhook、消息 Broker、本地 IPC 和语言 SDK。

协议统一语义，但不强迫所有参与端使用同一种传输方式。外部已有协议能表达的部分通过 Adapter 或 Binding 复用，Work Fabric 协议补充协作交接、上下文、责任、状态和验收语义。

### 5.2 Collaboration & Handoff Exchange

Exchange 持有 Work Fabric 的权威协作事实：

- 哪些参与端存在及其能力。
- 外部工作引用指向哪里。
- 哪次协作由什么意图发起。
- 当前责任由谁承担。
- 交接是否已投递、接受、退回或完成。
- 当前对外报告的状态是什么。
- 上下文、结果和回执分别传给了谁。
- 一次协作由哪些上游事件引起，又触发了哪些下游交接。

Exchange 不解释参与方内部如何完成工作，只处理参与边界上的事实。

### 5.3 Global Signal / Subscription / Notification

任何协作事实变化都会形成事件。信号网络负责：

- 事件标准化、校验、去重和语义关联。
- 持久化事件账本和按协作对象排序。
- 根据事件类型、工作引用、参与者、能力、状态和关系进行订阅过滤。
- 向飞书、人类 Inbox、Agent Endpoint 或外部系统可靠投递。
- 保存订阅游标、投递尝试、确认和死信。
- 支持重放、补发和状态对账。
- 维护 Correlation 和 Causation，使完整交接链可追踪。

事件负责表达已经发生的协作事实；Notification 是面向接收方的投递视图；Command 是对外部参与端的动作请求；Receipt 是投递、接收或结果验收的确认。

### 5.4 支撑服务

#### Context Exchange

Context Exchange 负责安全地传递完成当前交接所需的最小充分信息，包括外部引用、必要快照、摘要、决策、历史检查点和访问凭据。它不要求所有知识进入 Work Fabric。

#### Identity & Trust

Identity & Trust 区分认证调用者、责任主体、实际运行端和委托关系，控制一个端点可以代表谁、访问什么和执行哪些外部动作。

#### Trace & Transparency

Trace 回答：谁在何时把什么交给了谁、附带了什么、对方是否接收、当前由谁负责、报告了什么状态、结果去了哪里以及为何触发下一次交接。

#### Resource & Relation View

系统按需把工作引用、参与者、Handoff、Context 和结果关系投影为查询图。该图服务于探索和透明化，不是所有写入的唯一物理存储。

### 5.5 目标解析、交接派发与执行调度

- **Target Resolution** 由发起方或外部 Resolver 决定 Handoff 绑定到哪个 Actor/Endpoint。Resolver 可以是人工、规则服务或 AI Scheduling Brain，并通过统一协议查询候选事实、提交解析结果和证据。
- **Handoff Dispatch** 由 Work Fabric 负责，在目标确定后完成 Binding 选择、可靠投递、Delivery/Ack、重试、死信和恢复。派发只负责连接，不负责决定“谁更适合”。
- **Execution Scheduling** 由接收方外部 Runtime、Workflow 或工作系统负责，包括任务拆解、模型与工具选择、内部 Worker 安排和执行顺序。

Capability Target 在解析前不代表任何 Endpoint 已获得责任。Work Fabric 不得以内置排名、随机选择或首个响应者竞争作为默认解析策略；并发控制只保证目标绑定和责任迁移的权威写入唯一。直接 Actor/Endpoint Target 不依赖 Resolver，任何智能调度模块也必须可以移除或替换而不改变 Handoff 协议。

## 6. 核心领域模型

### 6.1 Identity 与参与端

| 对象 | 含义 |
|---|---|
| `Tenant` | 客户或组织的隔离边界 |
| `Principal` | 通过认证的调用身份 |
| `Actor` | 对协作承担责任的人、Agent 或系统主体 |
| `Endpoint` | Actor 接收和发送协议消息的具体端点 |
| `RuntimeInstance` | Agent 在某个 Endpoint 背后的在线运行实例 |
| `Capability` | Actor 或 Endpoint 声明可承担的能力及约束 |
| `Delegation` | Principal 或 Actor 代表另一主体行动的授权关系 |

`Principal` 与 `Actor` 必须分离。例如飞书机器人使用自己的 Principal 调用系统，但它代表某个 Human Actor；Agent Runtime 的 Principal 可以代表其内部某个 Agent Actor。

### 6.2 工作与协作

| 对象 | 含义 |
|---|---|
| `WorkReference` | 指向外部需求、任务、文档、代码或事件的统一引用 |
| `CollaborationThread` | 围绕一个目标或工作引用形成的持续协作上下文 |
| `Assignment` | 某 Actor 对某项责任的承担关系 |
| `Handoff` | 从一个参与方到另一个参与方的责任和上下文移交 |
| `HandoffPackage` | 一次交接的标准化信封 |
| `StatusReport` | 参与方对外报告的执行状态、进度、问题或阻塞 |
| `ContextBundle` | 当前交接允许接收方消费的上下文集合 |
| `ArtifactReference` | 外部产物、代码、文档、部署或结果的引用 |
| `Evidence` | 支撑状态声明或验收结论的证据引用 |
| `Receipt` | 投递、接收、责任承担、结果返回或验收的确认 |

`Receipt` 需要显式区分 `DELIVERED`、`RECEIVED`、`RESPONSIBILITY_ACCEPTED`、`RESULT_RECEIVED` 和 `RESULT_VERIFIED`。消息送达或被读取不等于接收方已经承担责任，收到结果也不等于结果已经通过验收。

### 6.3 HandoffPackage

一次交接至少包含：

```text
handoff_id
thread_id
work_reference
from_actor / from_endpoint
to_actor / to_endpoint / requested_capability
intent
context_bundle
authority_scope
acceptance_criteria
status_channel
deadline / expiry
correlation_id / causation_id
protocol_version
extension_fields
```

字段语义：

- `work_reference`：交接什么。
- `from` / `to`：谁交给谁；未指定具体接收方时可使用能力要求。
- `intent`：为什么交接、希望接收方完成什么。
- `context_bundle`：完成当前工作所需的输入和背景。
- `authority_scope`：允许读取、调用和写回的范围。
- `acceptance_criteria`：结果应满足的条件。
- `status_channel`：状态、问题和结果回传方式。
- `deadline` / `expiry`：责任交接和结果返回的时间边界。
- `correlation_id` / `causation_id`：所属协作链和直接上游原因。

### 6.4 Handoff 生命周期

Handoff 生命周期只表达交接边界，不试图镜像接收方内部工作流。Protocol v1 的互操作生命周期从 `OFFERED` 开始：

```text
OFFERED
  → ACCEPTED
      → RESULT_RETURNED
          → VERIFIED
              → CLOSED
```

`DRAFT` 只属于客户端或 Exchange 实现扩展，不产生权威 Handoff、责任或领域事件。

分支状态：

- `OFFERED → DECLINED`：接收方拒绝承担责任。
- `OFFERED → EXPIRED`：在有效期内未被接收。
- `OFFERED/ACCEPTED → CANCELLED`：发起方在策略允许时取消。
- `RESULT_RETURNED → REWORK_REQUESTED → ACCEPTED`：验收未通过，原接收方重新接受后继续处理。
- `ACCEPTED → TRANSFERRED`：接收方创建子 Handoff；只有子 Handoff 被接受后，父 Handoff 才进入 `TRANSFERRED`。

外部执行状态与 Handoff 生命周期分开建模。`StatusReport` 可以报告 `NOT_STARTED`、`IN_PROGRESS`、`WAITING`、`BLOCKED`、`COMPLETED` 或 `FAILED`，但这些是参与方的声明，不代表 Work Fabric 执行了工作。

责任归属按以下规则计算：

- 在 `OFFERED` 被接受前，发起方仍承担责任。
- 进入 `ACCEPTED` 后，责任转移给接收方。
- 进入 `RESULT_RETURNED` 后，执行责任已回传，验收责任转移给指定验收方。
- `REWORK_REQUESTED` 后验收方等待原接收方重新接受；重新接受后执行责任才回到原接收方。
- `TRANSFERRED` 本身不代表新接收方已承担责任；只有子 Handoff 被接受后，责任才转移成功。
- 所有责任变化都必须生成独立 Receipt 和领域事件，不能仅根据通知送达推断。

## 7. 关键交互流程

### 7.1 端点注册与能力声明

1. Endpoint 使用认证 Principal 连接 Gateway。
2. Gateway 将 Principal 解析为 Actor，并验证 Delegation。
3. Endpoint 声明协议版本、支持的传输绑定、Capabilities、可用性和回调通道。
4. Work Fabric 返回 Endpoint ID、能力登记结果和允许的协作范围。
5. 任何变化形成 `endpoint.registered` 或 `capability.changed` 事件。

旧系统无需原生支持该流程，可以由 Connector Adapter 代表其注册和声明能力。

### 7.2 发起、接收和执行交接

1. 发起方引用外部 Work，创建 Collaboration Thread 或加入已有 Thread。
2. 发起方构造 HandoffPackage，并明确指定 Actor/Endpoint，或声明尚待解析的 Capability Requirement。
3. 对 Capability Target，外部 Resolver 查询 Endpoint/Capability 事实并通过协议提交明确目标；Exchange 校验并记录解析来源，但不参与选择算法。
4. Exchange 校验身份、委托、上下文权限、有效期和目标资格，持久化 Handoff 并发布 `handoff.offered`。
5. Handoff Dispatch 向已确定的 Endpoint 可靠投递通知或任务邀请。
6. 接收方返回 Receipt，并选择接受或拒绝；消息送达不等于责任接受。
7. 接受后责任记录切换到接收方，发布 `handoff.accepted`。
8. 接收方在 Work Fabric 外部执行工作，通过 StatusReport 回报进展、问题和阻塞。
9. 接收方提交 ArtifactReference、Evidence 和结果摘要，Handoff 进入 `RESULT_RETURNED`。
10. 发起方或指定验收方确认结果、请求返工或再次交接。

### 7.3 Agent 再次交接

Agent 在执行过程中发现需要其他能力时，不直接在 Work Fabric 内部创建执行节点，而是：

1. 在当前 Thread 中创建子 Handoff。
2. 引用上游 Handoff 作为 `causation_id`。
3. 只传递被授权的 Context 子集。
4. 子接收方返回结果后，原 Agent 再完成上游 Handoff。

这使 Agent ↔ Agent 协作与 Human ↔ Human 交接保持同构。

### 7.4 人工接管

当 Agent 报告阻塞、超出权限、失联或达到风险阈值时，外部策略或简单升级规则创建面向 Human Actor 的 Handoff。人工处理完成后，可以关闭原协作，也可以把责任重新交还 Agent。

## 8. Context Exchange

### 8.1 ContextBundle 结构

ContextBundle 由若干 ContextItem 组成。ContextItem 可以是：

- 外部文档、需求、代码、知识或事件引用。
- 在获得授权后生成的内容快照。
- 对长内容的摘要或结构化提取。
- 上游决策、检查点、问题和交接说明。
- 临时访问令牌或受限工具能力引用。

每个 ContextItem 都必须包含来源、版本、创建者、可见范围、敏感等级、有效期和完整性信息。

### 8.2 上下文原则

- 默认传引用，只有稳定性、离线执行或审计需要时才保存快照。
- 按接收 Actor、Handoff、授权范围和有效期裁剪 Context。
- 大内容存储在外部系统或对象存储中，不进入事务记录。
- Context 更新需要版本化；已经接收的 Handoff 保留当时的 Context 视图或哈希。
- 接收方无法访问引用内容时，必须返回明确的上下文不可用状态，而不是静默降级。

## 9. 事件、订阅与通知协议

### 9.1 EventEnvelope

协作事件统一包含：

```text
event_id
event_type
schema_version
tenant_id
source_endpoint
actor_id
thread_id
handoff_id
work_reference
sequence
occurred_at
recorded_at
correlation_id
causation_id
visibility_scope
payload
```

### 9.2 一致性语义

- Handoff 状态变更与 Outbox Event 在同一事务中提交。
- 事件按 Tenant 和协作对象分区；只保证单个 Handoff 或 Thread 范围内的顺序，不承诺全局顺序。
- 外部投递采用至少一次语义；消费者必须按 `event_id` 或业务幂等键去重。
- 订阅保存独立游标，允许暂停、恢复和重放。
- Notification 必须区分“已送达”“已读取”和“已接受责任”，不能把消息送达当作 Handoff 接受。
- 外部状态与内部记录发生分歧时，由 Connector 对账并产生显式 reconciliation 事件。

### 9.3 订阅模型

Subscription 可根据以下条件组合过滤：

- 事件类型或 Schema 版本。
- Tenant、WorkReference、Thread 或 Handoff。
- Actor、Endpoint、Role 或 Capability。
- Handoff 生命周期和 StatusReport。
- 资源关系、标签、优先级或风险等级。

投递目标可以是 Human Channel、Agent Endpoint、Connector、Webhook、消息主题或内部投影视图。

## 10. 身份、委托和治理

- 所有写操作必须关联 Principal、Actor 和 Endpoint。
- Adapter 必须明确声明它代表的 Actor，禁止使用共享服务身份掩盖实际责任主体。
- Delegation 包含授权范围、可访问资源、允许动作、有效期和是否允许再次委托。
- Agent 接收 Handoff 时获得与该 Handoff 绑定的最小权限，而不是租户级长期权限。
- 高风险动作仍由外部系统或 Human Handoff 完成审批；Work Fabric 负责传递和记录审批结果。
- Context、Artifact 和 Event 的可见性分别校验，不因处于同一 Thread 自动获得全部权限。
- 凭据只保存引用或加密封装，并由专用 Secret 服务管理。

## 11. 数据与扩展架构

### 11.1 物理数据模型

- **Transactional Store**：Participant、Endpoint、WorkReference、Thread、Assignment、Handoff、Receipt 和授权元数据的权威事务状态。
- **Event Ledger / Outbox**：协作事件、投递和审计轨迹。
- **Object Store**：必要内容快照、大型 Context 和附件。
- **Read Projections**：面向项目、参与者、Inbox 和状态透明化的查询视图。
- **Optional Graph Projection**：跨工作引用、Handoff、参与者和结果的关系遍历。
- **Optional Search / Vector Index**：全文搜索、语义检索和 Context 辅助组装。

初始实现应以事务一致性和协议清晰度为优先，不要求同时部署所有可选投影。

### 11.2 扩展机制

- 所有协议 Schema 使用版本号和命名空间。
- 客户自定义字段进入命名空间扩展，不直接修改稳定内核字段。
- Capability 使用可版本化描述符，包含输入、结果、限制和支持的交互模式。
- Connector 以资源映射、事件映射、状态映射、命令映射和对账策略为明确边界。
- Target Resolver 只通过候选事实查询、待解析事件和目标解析命令接入；决策逻辑不得进入 Exchange Core 事务。
- Transport Binding 与领域 Schema 分离。
- SDK 附带契约测试；Endpoint 和 Connector 必须通过一致性测试后才能声明兼容版本。

## 12. 可靠性与失败处理

| 场景 | 处理方式 |
|---|---|
| 重复事件或回调 | 使用事件 ID、Handoff 版本和业务幂等键去重 |
| Endpoint 临时离线 | 保留待投递记录，按策略退避重试并暴露投递状态 |
| Agent 接受后失联 | Endpoint 租约或心跳过期，发布失联事件并允许人工接管或重新交接 |
| Context 引用不可访问 | 返回显式错误和缺失项，阻止未满足前置条件的责任接收 |
| 外部系统限流 | Connector 执行背压、批处理和限流感知重试 |
| 外部状态漂移 | 定期或按事件触发对账，记录冲突来源并生成 reconciliation 事件 |
| Handoff 并发更新 | 使用版本号或条件写入，冲突时要求调用方刷新后重试 |
| 结果投递成功但回执丢失 | 保留结果幂等键，允许安全重放并查询最终状态 |
| 非法委托或越权 Context | 拒绝交接，记录安全事件，不向接收端泄漏受限元数据 |
| 永久投递失败 | 进入死信队列并生成可订阅的失败事件和人工处理 Handoff |

系统不尝试跨所有外部服务实现分布式事务。跨边界一致性依赖持久事件、幂等、回执、补偿和对账。

## 13. 性能与伸缩策略

- 核心写路径保持为短事务：校验权限、更新协作状态、写入 Outbox。
- 事件扇出、通知、投影、索引、Context 获取和 Connector 调用全部异步执行。
- 按 Tenant、Thread 或 Handoff 分区，避免要求全局有序。
- 高频列表和项目总览使用物化读模型，不在线遍历完整协作图。
- 大型内容始终外置，协议消息只携带引用、摘要和完整性信息。
- Signal Worker、Notification Worker、Connector Worker 和 Projection Worker 可以独立横向扩容。
- 每个 Endpoint 和 Tenant 都支持限流、配额和背压。
- 协议不绑定具体数据库或消息中间件，使部署可以根据吞吐和延迟目标替换物理实现。

容量和延迟目标属于具体部署的 SLO，不写入领域协议；实现阶段必须以目标客户规模建立基准测试和容量模型。

## 14. 透明化与可观测性

Work Fabric 必须能够直接回答：

- 当前工作责任在谁手上。
- 最近一次交接发生在何时，是否已送达和接受。
- 当前报告状态是什么，多久没有更新。
- 接收方获得了哪些 Context 和权限。
- 当前结果和证据存放在哪里。
- 哪个事件或交接导致了当前状态。
- 哪个参与方或 Connector 正在等待处理。

技术可观测性包括日志、指标和分布式追踪；业务透明化包括 Thread 时间线、Handoff 因果链、责任历史、Context 版本、结果回执和验收结论。两者必须使用同一个 Correlation 体系关联。

## 15. 示例：从客户意向到交付运维

完整项目流程仍发生在外部业务系统和参与方中，Work Fabric 将阶段之间的责任交接连接起来：

1. 销售在飞书中记录客户意向，Adapter 创建 WorkReference 和面向需求人员的 Handoff。
2. 需求人员接收交接，Agent 可以作为协作者获得访谈材料并返回需求摘要。
3. 需求基线通过 Handoff 交给方案、商务和法务，各方状态及结果引用保持透明。
4. 合同确认后，项目负责人接收立项 Handoff，并把实施任务分别交给人、Agent Runtime 或系统端点。
5. 本地 Agent Runtime 接收代码任务，根据权限调用 Codex；Codex 的执行发生在外部，结果以 Git 引用和测试证据返回。
6. 阶段结果交给客户或验收人员；退回、返工和再次交接都保留因果链。
7. 已验收版本交给部署和运维系统，Connector 回传发布与运行状态。
8. 运维告警可以通过订阅形成面向人或 Agent 的新 Handoff，进入下一轮协作。

这个示例验证的是跨阶段和跨参与方交接，而不是要求 Work Fabric 内置销售、合同、研发、部署或运维流程。

## 16. 建议的产品和代码边界

第一阶段建议使用单仓库和清晰模块边界，避免过早拆分微服务：

```text
work-fabric
├── protocol       协议规范、Schema、消息信封和状态机
├── core           Participant、Thread、Assignment、Handoff 与授权
├── signal         Event Ledger、Subscription、Notification 和重放
├── context        ContextBundle、引用、快照和访问控制
├── edge
│   ├── human      Human Channel Adapter 接入框架
│   ├── agent      Agent Endpoint Gateway
│   └── connector  外部系统 Connector Gateway
├── sdk            Client、Agent、Connector SDK 与契约测试
├── projections    Inbox、状态、关系图和审计视图
└── console        运维、透明化和人工干预界面
```

部署时，事务核心可以首先作为一个模块化服务；Signal Consumer、Notification、Connector 和 Projection Worker 独立进程运行并横向扩容。模块之间只通过已定义的应用接口和协议消息交互，为未来服务化保留边界。

## 17. 测试策略

### 17.1 协议与契约测试

- 每个协议 Schema 的正反例和版本兼容测试。
- Agent Endpoint、Human Adapter 和 Connector 的一致性测试套件。
- 不同 Transport Binding 对同一领域语义的等价性测试。

### 17.2 领域与状态机测试

- Handoff 每个合法和非法状态迁移。
- 接收、取消、过期、返工、转交和并发冲突。
- Principal、Actor、Delegation 和 Context Scope 的权限组合。
- Correlation、Causation 和责任历史的完整性。

### 17.3 可靠性测试

- 重复、乱序、延迟和丢失消息。
- Endpoint 断线重连和租约过期。
- Outbox 故障恢复、订阅游标恢复和事件重放。
- Connector 限流、超时、部分失败和外部状态漂移。
- 通知送达但未接受责任的语义区分。

### 17.4 端到端场景

- Human → Agent：飞书发起交接，本地 Agent Runtime 接收并返回结果。
- Agent → Human：Agent 越权或阻塞，创建人工接管 Handoff。
- Agent → Agent：上游 Agent 按能力创建子 Handoff，并在结果返回后完成原任务。
- System → Agent → System：外部事件触发 Agent 协作，结果写回来源系统。
- Human → Human：传统人工分派仍使用相同协议和状态语义。

### 17.5 性能测试

- Handoff 创建和状态更新的事务延迟。
- 单 Thread 有序事件与跨 Thread 并发吞吐。
- 大规模订阅过滤和通知扇出。
- Connector Worker 背压和恢复速度。
- Inbox、项目状态和协作图投影的查询延迟。

## 18. 分阶段落地范围

本文是总体架构总纲，不应直接转化为一个覆盖全部阶段的单次实施计划。后续实施从第一阶段开始，并为每一阶段分别细化协议、验收条件和实施计划。

### 第一阶段：统一参与与交接最小闭环

- 核心协议和 Schema。
- Participant、Endpoint、WorkReference、Thread、Handoff、Receipt。
- Handoff 状态机和 Outbox Event。
- Agent Endpoint Gateway。
- 飞书通知/交互 Adapter。
- 本地 Agent Runtime 参考接入。
- 基础审计时间线。

### 第二阶段：可靠信号与上下文交换

- Subscription、Notification、游标和重放。
- ContextBundle、外部引用、权限裁剪和必要快照。
- Endpoint 租约、失联检测和人工接管。
- Inbox 和协作状态投影。

### 第三阶段：连接器与跨系统对账

- Connector SDK 和一致性测试。
- 飞书文档、Git 或需求系统连接器。
- 资源映射、状态映射、命令写回和对账事件。
- 关系图和项目级透明化视图。

### 第四阶段：可选 Target Resolver 与生态

- 通过统一协议接入的能力匹配、接收方推荐和 AI Scheduling Brain。
- 风险、超时和升级规则。
- 外部 Workflow、Agent Protocol 和模型服务 Binding。
- 行业扩展包与 Connector/Agent 生态。

这些模块都位于 Exchange Core 外部，可以独立部署、替换或移除；Work Fabric 只提供事实查询、解析结果提交、可靠派发和审计脉络。

每一阶段都增强协作互联能力，不把外部执行职责吸收到 Work Fabric 内部。

## 19. 设计验收标准

本设计在以下条件全部满足时成立：

- 人、Agent 和系统可以使用同一交接语义参与协作。
- 飞书等旧入口可以通过 Adapter 接入，无需原生实现完整协议。
- Agent 可以注册能力、接受责任、获取受限 Context、报告状态和返回结果。
- Work Fabric 可以明确回答当前责任、交接状态、结果位置和完整因果链。
- Agent 的规划和执行过程可以替换而不改变协作协议。
- 外部系统仍拥有业务内容，Work Fabric 只保存统一引用和协作事实。
- 事件支持持久投递、幂等、订阅、确认、重放和对账。
- 核心数据模型不依赖单一传输方式、数据库或消息中间件。
- 可选自动化能力可以被移除，而核心协作交接闭环仍完整工作。
