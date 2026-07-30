# Work Fabric 项目章程与不可妥协架构规则

- 文档性质：Normative / Canonical
- 适用范围：所有 Spec、计划、代码、测试、文档、插件、Citizen 和部署方案
- 当前版本：1.0
- 更新日期：2026-07-30
- 变更权限：项目 Owner

本文是 Work Fabric 项目定位、问题域、职责边界和架构底线的唯一最高优先级
规则源。[整体架构](docs/architecture.md) 和各模块设计负责解释如何实现本文，
不能修改或覆盖本文。

任何局部功能需求、交付压力、厂商限制、实验开关和实现便利都不能绕过本文。
若需求与本文冲突，必须停止实现并重新划分职责；只有项目 Owner 明确批准
项目定位变更后，才能先修改本文，再编写新的 Spec、计划和代码。

## 1. 项目定位

> **A protocol-driven collaboration interconnect for humans, agents, and work systems.**

Work Fabric 是连接人、AI Agent、传统工作系统和 AI-native 服务的协作网络。
它提供统一接入、通信、任务发布、责任交接、浅层状态透明化、可靠传播和审计，
使不同参与方能够在保留各自系统、执行环境和数据所有权的前提下协同工作。

Work Fabric 不是 Workflow Engine、Agent Brain、业务调度器、通用自动化
平台、内容主库或工具执行器。

AI 化和自动化来自网络中 Human Endpoint 逐步被 Agent Endpoint 替换，以及
外部 Decision Body 和 Capability Provider 的能力增强；不是来自 Fabric
吸收业务决策和执行流程。

## 2. 项目要解决的问题

Work Fabric 解决跨人、Agent 和系统边界的协作连接问题：

1. **接入**：一个人、Agent、Channel、Provider 或外部系统如何以明确身份
   加入网络。
2. **身份与代理**：调用者是谁、代表谁、可以代表到什么范围。
3. **能力发现**：模块如何动态声明自己能做什么、当前是否可用，以及其他
   参与方如何渐进发现这些事实。
4. **任务发布与交接**：谁发布了什么工作、携带哪些 Context 和 Authority、
   哪个参与方主动认领并接受责任。
5. **可靠传播**：任务、事件、状态和结果如何投递、确认、去重、重放和恢复。
6. **浅层透明化**：当前责任在谁、参与方声明了什么状态、结果和回执。
7. **跨系统引用**：如何引用飞书消息、文档、日程、需求、代码和部署结果，
   而不把 Fabric 变成这些资产的主库。
8. **协作审计**：谁在何时发布、接收、认领、拒绝、返回或验收，以及这些
   事实之间的 Correlation 和 Causation。
9. **可插拔演进**：Channel、Agent、Provider、Resolver 和外部系统如何独立
   替换、扩缩和演进，而不修改稳定 Core。

Work Fabric 不解决“具体业务应该怎么做”。销售流程、需求分析、日程组织、
文档编写、代码实现、模型推理和部署决策都由对应参与方完成。

## 3. Fabric 原生职责

Fabric 只原生负责：

| 领域 | 原生职责 |
|---|---|
| Participation | Actor、Endpoint、Citizen、Capability、Delegation 和可用性事实 |
| Protocol | Identity、Authority、Handoff、Event、Subscription、Receipt 和版本契约 |
| Exchange | Offer、Target Binding、Delivery、Claim、Accept、Decline、Transfer、Result 和 Verify |
| Shallow State | 当前责任、参与方声明的 Status、Correlation、Causation 和引用 |
| Reliability | 幂等、Outbox、Ack、Retry、Replay、Dead Letter、Lease 和 Fencing |
| Visibility | Inbox、责任视图、时间线、关系投影和公开查询 |
| Governance | Admission、最小授权、审计事实和证据引用 |
| Interoperability | HTTP/SDK/Channel/Connector/Federation 等协议 Binding |

Fabric 可以持久化自己拥有的协作事实。HTTP、Worker 和 Projection 实例可以
在部署层保持无状态，通过内部技术中立 Port 使用 SQLite、PostgreSQL 或其他
Adapter。具体存储介质不向网络暴露，也不是 Citizen。

## 4. Fabric 明确不负责

以下职责永久位于 Fabric 之外：

- 理解自然语言、图片、文档或业务结果的含义；
- 模型推理、Prompt、Agent 计划、长期记忆和工具选择；
- 判断信息是否充分、谁应该参与、哪个方案更优；
- 业务任务拆解、步骤排序、分支、循环、等待、恢复和补偿策略；
- 根据内容、时间、状态或 Result 主动创建下一项业务任务；
- 主动调用、唤醒或驱动 Channel、Agent、Provider 或其他 Citizen；
- 替代飞书、CRM、Git、知识库、日历或项目系统成为内容主库；
- 执行代码、创建文档、安排日程、部署系统或处理专业工作；
- 内置按能力、成本、负载、模型或风险进行排名和目标选择的智能；
- 为单一厂商或业务场景修改 Core 责任语义。

上述能力可以由外部 Human、Agent、Decision Body、Resolver、Capability
Provider 或工作系统实现，并通过统一协议接入。

## 5. 核心运行模型：发布、传播、认领和记录

协作网络中不存在由 Fabric 发起的业务调用链。

```text
Citizen 发布 Handoff / Event / Status / Result
        ↓
Fabric 校验 Identity / Authority / Protocol
        ↓
Fabric 按 Target / Visibility / Subscription 可靠传播
        ↓
其他 Citizen 自主接收、Claim、Accept、Decline 或忽略
        ↓
Fabric 记录责任、状态、结果、回执和审计事实
```

“广播”表示受 Authority、Target、Visibility 和 Subscription 约束的发布，
不是向所有租户和模块无差别发送。直接指定 Actor/Endpoint 和面向能力的
候选发布都可以存在，但 Fabric 不替参与方作业务选择。

“可靠投递”不是业务调用。“机械重试”只能重放相同的已授权事实，不能改变
目标、生成新任务或决定下一步。

“Capability invocation”表示调用方 Citizen 发布辅助 Capability Handoff，
Provider Citizen 自主接收并承担责任，不表示 Fabric 调用 Provider 方法。

## 6. Network Citizen 与模块职责

Actor type 回答“谁参与”：

```text
human | agent | system
```

Citizen kind 回答“模块对网络承担什么责任”：

```text
decision-body | capability-provider | channel | context-provider |
governance-provider | observer
```

两者必须正交。每个 Citizen 注册只有一个 kind；一个进程可以托管多个独立
Citizen，但它们分别拥有身份、租约、声明、Authority、状态和审计。

| Citizen kind | 必须闭环的职责 | 明确不负责 |
|---|---|---|
| `decision-body` | 理解意图、作出选择、管理业务会话、发布任务、解释结果 | Fabric 投递账本、Channel 凭据、Provider 副作用 |
| `capability-provider` | 声明 Contract、验证输入、执行领域动作、管理幂等并返回类型化事实 | 决定是否应该被调用、跨能力编排、最终对话文案 |
| `channel` | 可信接入、来源、寻址、格式转换和投递 | 意图理解、业务关联和决策 |
| `context-provider` | 按 Authority 返回有界、带来源和版本的上下文 | 接受业务责任或触发副作用 |
| `governance-provider` | Identity、Admission、Authority、委托和确认事实 | 业务判断和专业审批结论 |
| `observer` | 只读查询、审计导出、Console 和指标集成 | 改写 Handoff 或代表其他参与方 |

数据库、Broker、缓存、SDK、YAML、迁移工具和内部 State Store 不是 Citizen。
当前不设通用 `storage` 或 `state-provider` Citizen。

## 7. 模块自治与可插拔底线

每个模块必须：

- 完整拥有自己的业务语义、状态、幂等、副作用和错误分类；
- 只通过 Handoff、Event、Subscription、Receipt 或稳定 SPI 交换事实；
- 自行决定是否接收、认领、拒绝或处理符合 Authority 的工作；
- 能独立测试、部署、启停、替换和扩缩；
- 只返回职责范围内的类型化事实，不替其他模块补做语义。

永久禁止：

- 一个 Citizen 导入另一个 Citizen 的实现；
- 一个模块读取另一个模块的私有数据库、文件或进程内对象；
- Channel 替 Agent 理解意图或生成业务答复；
- Agent 持有 Channel/Provider 私有凭据并绕过 Handoff；
- Provider 根据自然语言自行决定是否应该执行；
- 一个 Provider 直接调用另一个 Provider；
- “Integration”虚拟分组拥有身份、状态、决策或执行顺序；
- 为方便单一场景在 Fabric 内建立 Citizen 调用链。

每个新增模块必须通过**移除测试**：禁用或删除该模块后，Exchange Core、
协议和无关 Citizen 仍能正常工作；仅依赖该能力的任务明确无人认领或能力
不可用，Core 不得使用隐藏替代路径。

## 8. 状态与数据所有权

| 数据类别 | 权威所有者 |
|---|---|
| Handoff、责任、Delivery、Receipt、Subscription、审计 | Work Fabric |
| 参与方主动声明的 `WAITING`、`BLOCKED`、`IN_PROGRESS` | Work Fabric 记录，声明方负责真实性 |
| Agent 任务历史、业务会话、等待条件、回复关联和恢复决策 | 对应 Agent / Decision Body |
| Provider 执行步骤、幂等记录和外部副作用状态 | 对应 Capability Provider |
| 消息、文档、日程、需求、代码和部署资产 | 对应来源系统 |
| Inbox、Timeline、Relationship 等派生视图 | Fabric Projection，可由权威事实重建 |

Fabric 记录 `WAITING`，但不管理等待；记录新的 Handoff/Event，但不判断它
是否恢复旧业务。Fabric 默认传递外部 Reference，只在协议、稳定性或审计
明确需要时保存有界快照。

存储技术不决定数据所有权。SQLite/PostgreSQL 保存 Fabric 事实，不因此成为
网络公民；Agent 自己的 State Store 保存业务会话，也不因此成为 Fabric
内部状态。

## 9. Core 中立性底线

Exchange Core、WFPP、Signal、Directory 和公共 SDK 不得出现：

- `feishu`、`calendar`、`document` 等单一厂商或业务能力条件分支；
- 某个 Agent Framework、模型、Prompt、工具或 Runtime 的专用语义；
- 具体数据库、Broker、SDK、配置文件或部署进程对象；
- 为某个业务场景新增的自动选择、等待、恢复或执行状态机。

新的厂商、Channel 和能力通过 Adapter、Provider 或外部 Decision Body 接入。
新增一个 Citizen 不得要求修改 Handoff 的责任语义。

## 10. 允许的机械行为与禁止的语义行为

| Fabric 可以做的机械行为 | Fabric 不能做的语义行为 |
|---|---|
| 验证身份、Authority、Schema 和 expected version | 理解正文、Prompt 或业务结果 |
| 保存参与方提交的 Handoff、Status 和 Result Reference | 替参与方产生 Status、Result 或下一任务 |
| 按明确 Target、Binding、Subscription 可靠传播 | 决定哪个模块更适合或下一步调用谁 |
| 对相同事实去重、重试、重放和死信 | 将失败改写为另一条业务路径 |
| 维护 Lease、Fencing、Cursor 和投影 | 用定时器推动业务流程或唤醒业务 Agent |
| 记录审计和可见性范围 | 判断回复相关性、完整性或业务验收结论 |

判断标准不是“代码放在哪个进程”，而是：

> 谁创造了业务意图？谁决定了下一步？

如果答案是 Fabric，该设计默认不合格。

## 11. 永久禁止的架构模式

- 在 Fabric 中增加根据业务条件推进流程的 `Wait`、`Resume`、`Scheduler`、
  `Planner`、`Coordinator` 或同义模块；
- Fabric 收到一个 Result 后主动生成另一个 Capability Handoff；
- Fabric 根据群消息判断回复属于哪个业务任务；
- Fabric 维护参与人收集、审批会话、日程安排或文档生成流程；
- 在 Core 中为某个 Provider 不可用设计业务降级路径；
- 以“先放进 Core，以后再抽离”为理由越过模块边界；
- 用一个共享数据库或 Integration Service 耦合多个 Citizen；
- 把实现级调用伪装成 Handoff，却绕过 Claim、Accept、Authority 和 Receipt。

## 12. Architecture Boundary Check

每份新功能 Spec 和实施计划必须包含标题完全一致的
`Architecture Boundary Check`，逐项回答：

1. 新增的每份状态由谁拥有，为什么属于该领域？
2. 每个动作由哪个 Citizen 主动发起？
3. Fabric 在每条链路中只校验、传播、记录了什么？
4. 是否存在 Fabric 根据内容、时间、等待条件或 Result 主动创建下游动作？
5. 是否存在一个模块直接依赖另一个模块的实现或私有状态？
6. 新模块被禁用后，Core 和无关 Citizen 是否继续工作？
7. 是否向 Core、协议或公共 SDK 引入厂商/业务特例？
8. 决策、执行、领域资产和长期状态分别留在哪个外部模块？
9. Authority 如何限制发布、发现、认领和副作用？
10. 哪些事实进入 Fabric 审计，哪些内容明确不能进入？

出现以下任一情况时，评审必须否决当前方案：

- 第 4 项回答为“是”；
- 第 5、6 或 7 项不能明确回答“否、是、否”；
- 状态所有者或动作发起者写成 Fabric，但该状态或动作包含业务语义；
- 方案依赖“先做进 Core，以后再抽出去”；
- 只能通过修改某个既有 Citizen 才能接入另一个无关 Citizen。

所有 Spec 还必须提供：

- 状态所有权表；
- 动作发起者与消息流图；
- 模块移除测试；
- Authority 和数据可见性说明；
- 明确的“不负责”列表；
- 与本文每条底线不存在冲突的结论。

## 13. 错误方向复盘与反例

曾出现过以下错误外推：

1. 正确前提：Fabric 拥有协作事实并需要持久化。
2. 错误推论：因为“等待”与协作相关，所以 Fabric 应保存等待条件、匹配回复
   并恢复 Agent。

它混淆了两类状态：

- `Agent reports WAITING`：浅层协作事实，Fabric 可以记录；
- `waiting for whom, until when, which reply counts, what to do next`：业务会话
  和决策状态，只能由负责该任务的 Decision Body 管理。

错误的主要原因不是项目原则完全缺失，而是设计过程没有把既有原则作为否决
门禁，也没有逐条标注状态所有者和动作发起者。今后所有设计必须先完成第 12
节检查，不能只在方案完成后用原则做解释。

### 不合格的日历参与人收集

```text
Fabric Wait Module -> 匹配回复 -> 唤醒 Agent -> 调用 Calendar
```

### 合格的日历参与人收集

```text
Agent 保存排期会话
Agent 发布 Message Capability Handoff
Message Provider 自主认领并返回 message_ref
Channel 发布后续回复事实
Agent 通过 Subscription 接收并自行关联
Agent 判断充分后发布 Calendar Capability Handoff
Calendar Provider 自主认领并执行
Fabric 全程只传播和记录
```

## 14. 底线规则的变更控制

任何实现者都不能通过局部 Spec、扩展字段、实验开关或临时模块绕过本文。
若项目确实需要转型为 Workflow Engine、主动 Scheduler 或内置 Agent Brain，
必须由项目 Owner 明确批准，并按以下顺序执行：

1. 先修改本文；
2. 同步修改整体架构和协议定位；
3. 明确迁移、兼容、数据所有权与安全影响；
4. 必要时升级协议主版本；
5. 再编写新 Spec、计划和代码。

未完成上述步骤时，与本文冲突的实现一律视为架构缺陷。

