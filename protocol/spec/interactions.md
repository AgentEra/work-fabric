# WFPP v1 Interactions and Handoff Lifecycle

机器可读权威定义位于 [handoff-lifecycle.json](handoff-lifecycle.json)。本文件给出规范语义；实现 MUST 同时满足状态机和 Canonical Schema。

## Endpoint 与发现

`endpoint.register` 注册或恢复 Endpoint Descriptor。`endpoint.renew` 更新 Lease 与 Availability。`endpoint.withdraw` 停止接收新 Handoff。`endpoint.get` 和 `capability.query` 返回权限过滤后的发现结果。Core 不规定匹配、排序或调度算法。

## Handoff 交互

### `handoff.offer`

从无状态创建 `offered` Handoff。Exchange 校验 Package、目标、Authority 与时限并记录 `workfabric.handoff.offered.v1`。Offer 不转移责任。

### `handoff.accept`

允许前态为 `offered` 或 `rework_requested`。Recipient 必须被授权且能访问必要 Context。成功后进入 `accepted`，签发 `responsibility_accepted` Receipt。

### `handoff.decline`

仅允许前态 `offered`。成功后进入终态 `declined`，Recipient 从未承担执行责任。

### `handoff.expire`

仅允许前态 `offered`，并要求 `accept_by` 已过。成功后进入终态 `expired`。

### `handoff.cancel`

允许前态 `offered` 或 `accepted`，并要求策略允许。成功后进入终态 `cancelled`。取消不会自动补偿已经发生的外部副作用。

### `handoff.report_status`

仅允许前态 `accepted`。成功后生命周期仍为 `accepted`，并发布 `workfabric.handoff.status_reported.v1`。外部 `completed` 或 `failed` 状态不替代 Result Return。

### `handoff.return_result`

仅允许前态 `accepted`。Exchange 校验 Result Schema 和 Authority 后进入 `result_returned`，签发 `result_received` Receipt。

### `handoff.verify`

仅允许前态 `result_returned`。指定 Verifier 确认 Acceptance Criteria 后进入 `verified`，签发 `result_verified` Receipt。

### `handoff.close`

仅允许前态 `verified`。授权 Verifier 完成关闭后进入终态 `closed`。

### `handoff.request_rework`

仅允许前态 `result_returned`。Verifier 必须提供返工原因，状态进入 `rework_requested`。原 Recipient 需要再次执行 `handoff.accept` 才重新承担责任。

### `handoff.transfer`

仅允许前态 `accepted`。当前 Recipient 必须被授权且允许再委托。操作原子创建初始状态为 `offered` 的子 Handoff；父 Handoff 保持 `accepted`，原 Recipient 继续负责。

### `handoff.child_accepted`

这是 Exchange 在子 Handoff 成功接受时执行的关联迁移，不是独立客户端命令。子 Handoff 进入 `accepted` 的同一事务中，父 Handoff 从 `accepted` 进入终态 `transferred`。

## 非规范草稿

客户端 MAY 在本地保存尚未 Offer 的草稿，但草稿不产生 `handoff_id`、责任、Receipt 或领域事件，也不出现在 v1 生命周期枚举中。
