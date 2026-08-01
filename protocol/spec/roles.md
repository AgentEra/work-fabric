# WFPP v1 Roles and Responsibility

## 1. Principal、Actor 与 Endpoint

Principal 是 Binding 已认证的调用身份；Actor 是承担协作责任的人、Agent 或系统；Endpoint 是 Actor 收发协议消息的入口。三者 MUST 分离建模。

Principal 不由 Payload 自报。Binding 把认证结果交给 Exchange，Exchange 校验 Actor、Endpoint 和 Delegation 声明。一个 Runtime 可以托管多个 Agent Actor，一个 Human Adapter 也可以代表多个 Human Actor，但每次命令的代表关系必须明确。

## 2. Initiator

Initiator 创建 Handoff Offer、提供 Intent、Context、Authority 和 Acceptance Criteria，并在 Offer 被接受前保留责任。Initiator MAY 取消 Handoff，但 Exchange 必须执行策略检查。

## 3. Recipient

Recipient 通过明确的 `handoff.accept` 承担责任。收到通知、读取消息或发送 Delivery Ack 都不构成接受。

Recipient 在外部环境执行工作，发布 Status，返回 Result，或在 Authority 允许时发起 Transfer。Recipient MUST NOT 将 Context 中的自然语言解释为额外授权。

## 4. Verifier

Verifier 判断 Result 是否满足 Acceptance Criteria，可以 Verify 或 Request Rework。只有指定 Verifier 或其有效 Delegation 可以执行这些操作。专业判断不属于 Exchange。

## 5. Authoritative Exchange

Exchange 持有 Handoff、Resource Version、Receipt 和 Event 的权威事实。它负责 Schema 校验、身份映射、Authority 检查、状态迁移、幂等、并发、持久化和事件发布。

Exchange 是逻辑角色，可以嵌入单进程、运行在集群中或由联邦节点承担。物理拓扑不能改变协议语义。

## 6. Target Resolver

Target Resolver 是可选外部参与角色，可以由人、规则服务或 Agent Brain 承担。它读取经过授权的 Capability 与 Endpoint 事实，并为一个 `target_resolution_pending` Handoff 提交明确 Actor/Endpoint Target，或者报告当前无法形成合格绑定。

Claimant Endpoint 是选择 `eligible_pool_claim` 时的外部参与角色。它只会看到与自身当前声明能力匹配的 `claimable` Handoff 摘要，并主动提交 Claim。Exchange 对 Claim 再做权限与资格校验；候选池不排序、不推荐，也不会自动替 Claimant 接受责任。

Resolver 的匹配、排名、推荐和选择逻辑不属于 Exchange。Resolver 发送的每个结果都必须经过 Principal、Actor、Endpoint、Delegation、Authority 和目标资格校验。直接 Actor/Endpoint Target 不依赖 Resolver。

## 7. Network Citizen

Network Citizen 是一个进入协作网络、公开声明并对外闭环某类责任的实体。
Actor type 与 Citizen kind MUST 分离：Actor type 表达 `human`、`agent` 或
`system`，Citizen kind MUST 是以下之一：

- `decision-body`
- `capability-provider`
- `channel`
- `context-provider`
- `governance-provider`
- `observer`

一个 Citizen 注册 MUST 只有一个 kind；一个物理进程 MAY 托管多个独立注册。
数据库、缓存、Broker、transport、SDK、YAML 文件和进程内队列本身不是
Citizen。

Provisioning MUST 只建立可信身份绑定、允许的声明 namespace、风险上限和
administrative state。软件 Citizen MUST 通过有界租约的单活 Session 声明
当前 descriptor、declarations 和 availability。实现 MUST 使用 registration
version、单调 fencing token、heartbeat sequence 和 declaration CAS 拒绝旧
Runtime 写入；已绑定的 Schema URI/digest MUST NOT 静默漂移。

Catalog MUST 将 Citizen 列表、Citizen descriptor、declaration summary 和
完整 declaration Contract 作为可独立授权的披露层。声明 Capability MUST
NOT 被解释为获得调用 Authority。Discovery MUST NOT 排名、推荐、选择、
Claim、Accept 或执行工作。

每个 Citizen MUST 在自身职责内闭环，只通过稳定协议或 SPI 交换事实。
Channel MUST NOT 替 Agent 生成业务答复；decision body MUST NOT 把厂商凭据
交给 Capability Provider 之外的模块；Provider MUST NOT 替 decision body
选择工具或解释结果。

## 8. 责任迁移

- `target_resolution_pending`：Initiator 仍负责，Resolver 尚未产生接收方责任。
- `claimable`：Initiator 仍负责，Handoff 可被合格 Endpoint 认领。
- `claimed`：Initiator 仍负责；某 Endpoint 持有临时、可 fencing 的 Claim，但尚未接受执行责任。
- `target_unavailable`：没有接收方获得责任，当前 Handoff 无活动执行责任。
- `offered`：Initiator 仍负责。
- `accepted`：Recipient 负责外部执行。
- `result_returned`：Verifier 负责验收决策。
- `rework_requested`：Verifier 等待 Recipient 重新接受。
- `verified`：Verifier 负责关闭。
- `closed`、`declined`、`expired`、`cancelled`：当前 Handoff 无活动执行责任。
- `transferred`：父 Handoff 的责任由已接受的子 Handoff 表达。

每次责任变化 MUST 产生对应 Receipt 和不可变领域事件。
