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

## 6. 责任迁移

- `offered`：Initiator 仍负责。
- `accepted`：Recipient 负责外部执行。
- `result_returned`：Verifier 负责验收决策。
- `rework_requested`：Verifier 等待 Recipient 重新接受。
- `verified`：Verifier 负责关闭。
- `closed`、`declined`、`expired`、`cancelled`：当前 Handoff 无活动执行责任。
- `transferred`：父 Handoff 的责任由已接受的子 Handoff 表达。

每次责任变化 MUST 产生对应 Receipt 和不可变领域事件。
